import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppError, fail } from '../../domain/errors.js';
import { id, now } from '../../domain/ids.js';
import type { Distribution, InstallationRecord } from '../../domain/models.js';
import { archivePath, extractArchive } from './archive-reader.js';
import { npmLaunch } from './npm-entry.js';
import { fetchBytes, validateUrl } from '../registry/client.js';
import { resolveEnvironment } from '../platform/environment.js';
import { runCommand, which } from '../platform/process-host.js';
import type { StoragePaths } from '../storage/paths.js';
import {
  initializeStoragePaths,
  removeOwnedDirectory,
  requireFreeSpace,
  resolveStoragePaths,
  safeComponent,
} from '../storage/paths.js';

/** 将 Node 的平台和架构名称映射为 Registry 分发清单使用的键。 */
export const platformKey = () =>
  `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch}`;

export interface InstallTarget {
  sourceId: string;
  registryAgentId: string;
  targetVersion: string;
  distribution: 'binary' | 'npx' | 'uvx';
  snapshotId?: string | undefined;
}

/** 负责下载、展开和包运行器准备；安装去重、锁与配置切换由应用层协调。 */
export class Installer {
  paths: StoragePaths;
  run = runCommand;
  remove = removeOwnedDirectory;

  constructor(
    paths: StoragePaths | string,
    readonly allowInsecure: boolean,
    readonly minimumFreeBytes = 0,
  ) {
    this.paths = typeof paths === 'string' ? resolveStoragePaths({ dataDir: paths }) : paths;
  }

  locations(key: string, jobId: string) {
    return {
      installation: join(this.paths.installationsDir, safeComponent(key)),
      staging: join(this.paths.stagingDir, safeComponent(jobId)),
      cache: join(this.paths.cacheDir, safeComponent(key)),
    };
  }

  checkSpace() {
    return requireFreeSpace(this.paths, this.minimumFreeBytes);
  }

  async cleanup(key: string, jobId?: string) {
    if (jobId) await this.remove(this.paths.stagingDir, jobId);
    await this.remove(this.paths.installationsDir, key);
    await this.remove(this.paths.cacheDir, key);
  }

  /** 将包版本表达式解析为具体版本，拒绝任意 URL/本地路径形式的包来源。 */
  async resolve(target: InstallTarget, manifest: Distribution, signal: AbortSignal) {
    if (target.distribution === 'binary') return target.targetVersion;
    const spec = manifest.package;
    if (!spec) fail('CONFIG_INVALID', '包分发缺少 package。');
    if (target.distribution === 'npx') {
      await which('npm');
      const match = /^(@[^/\s]+\/[^@\s]+|[^@/\s]+)(?:@([^\s]+))?$/.exec(spec);
      if (!match || /[:\\]/.test(spec))
        fail('CONFIG_INVALID', 'npx package 必须是 npm 包名和版本。');
      if (match[2] && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(match[2])) return match[2];
      const { env } = await resolveEnvironment({ values: {}, inherit: [] });
      const requested = `${match[1]}@${match[2] ?? target.targetVersion}`;
      const cache = await mkdtemp(join(tmpdir(), 'acm-resolve-'));
      let output: string;
      try {
        output = await this.run(
          {
            executable: 'npm',
            args: ['view', requested, 'version', '--json', '--fetch-retries=0', '--cache', cache],
            cwd: cache,
            env,
          },
          { signal },
        );
      } finally {
        await rm(cache, { recursive: true, force: true });
      }
      const version = JSON.parse(output) as unknown;
      if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version))
        fail('VERSION_UNRESOLVABLE', '无法确定 npm 精确版本。');
      return version;
    }
    await which('uv');
    const match = /^([\w.-]+)(\[[\w,.-]+\])?(?:==([^\s]+))?$/.exec(spec);
    if (!match) fail('CONFIG_INVALID', 'uvx package 必须是包名、可选 extras 和精确版本。');
    if (match[3]) return match[3];
    const fetched = await fetchBytes(
      `https://pypi.org/pypi/${encodeURIComponent(match[1]!)}/${encodeURIComponent(target.targetVersion)}/json`,
      { signal },
    );
    const data = JSON.parse(fetched.bytes.toString()) as { info: { version: string } };
    return data.info.version;
  }

  /** 包环境在固定路径构建；只有完整产物才交给应用层发布 ready 记录。 */
  async install(
    target: InstallTarget,
    manifest: Distribution,
    resolvedVersion: string,
    key: string,
    signal: AbortSignal,
    progress: (step: string) => Promise<void>,
    jobId = id('job'),
  ): Promise<InstallationRecord> {
    this.paths = await initializeStoragePaths(this.paths);
    const locations = this.locations(key, jobId);
    const { installation: path, staging, cache } = locations;
    let ownsTarget = false;
    let ownsStaging = false;
    let ownsCache = false;
    const capacity = new AbortController();
    const combined = AbortSignal.any([signal, capacity.signal]);
    let pending: Promise<void> | undefined;
    const monitor = setInterval(() => {
      pending ??= this.checkSpace()
        .catch((error: unknown) => {
          capacity.abort(error);
        })
        .finally(() => {
          pending = undefined;
        });
    }, 500);
    monitor.unref();
    const record: InstallationRecord = {
      id: id('ins'),
      revision: 1,
      createdAt: now(),
      key,
      sourceId: target.sourceId,
      registryAgentId: target.registryAgentId,
      version: target.targetVersion,
      resolvedPackageVersion: resolvedVersion,
      distribution: target.distribution,
      manifest,
      platform: platformKey(),
      path,
      executable: '',
      prefixArgs: [],
      args: manifest.args ?? [],
      env: manifest.env ?? {},
      integrity: 'not_provided',
      state: 'ready',
    };
    try {
      await this.checkSpace();
      combined.throwIfAborted();
      await progress('preparing');
      // 独占创建，绝不覆盖无记录的既有目录；由手动清理处理崩溃遗留。
      if (
        await lstat(path).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        )
      )
        fail('STORAGE_CLEANUP_REQUIRED', '目标目录已有未发布产物，请先运行 storage cleanup。');
      await mkdir(staging, { mode: 0o700 });
      ownsStaging = true;
      try {
        await mkdir(cache, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          fail('STORAGE_CLEANUP_REQUIRED', '此目标已有缓存残留，请先运行 storage cleanup。');
        throw error;
      }
      ownsCache = true;
      if (target.distribution === 'binary') {
        if (!manifest.archive || !manifest.cmd) fail('CONFIG_INVALID', 'binary 缺少 archive/cmd。');
        validateUrl(manifest.archive, this.allowInsecure);
        if (/\.(dmg|pkg|deb|rpm|msi|appimage)$/i.test(new URL(manifest.archive).pathname))
          fail('PLATFORM_UNSUPPORTED', '不执行系统安装器格式。');
        await progress('downloading');
        const response = await fetch(manifest.archive, {
          signal: AbortSignal.any([combined, AbortSignal.timeout(300_000)]),
        });
        if (!response.ok || !response.body)
          fail('INSTALL_FAILED', '下载失败。', { status: response.status });
        const download = join(staging, '.download');
        const file = await open(download, 'wx', 0o600);
        const hash = createHash('sha256');
        let size = 0;
        try {
          for await (const value of response.body) {
            combined.throwIfAborted();
            const chunk = value as Uint8Array;
            size += chunk.length;
            if (size > 1024 ** 3) fail('CAPACITY_EXCEEDED', '下载超过 1 GiB。');
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.length)
              offset += (await file.write(chunk.subarray(offset))).bytesWritten;
          }
          await file.sync();
        } finally {
          await file.close();
        }
        if (manifest.sha256 && hash.digest('hex') !== manifest.sha256.toLowerCase())
          fail('INTEGRITY_MISMATCH', 'SHA-256 校验失败，拒绝安装。');
        record.integrity = manifest.sha256 ? 'verified' : 'not_provided';
        await progress('extracting');
        if (/\.(zip|tar\.gz|tgz|tar\.bz2|tbz2)$/i.test(new URL(manifest.archive).pathname)) {
          await extractArchive(download, manifest.archive, staging, size, combined);
          await rm(download);
        } else {
          const cmd = archivePath(manifest.cmd, staging);
          await mkdir(join(cmd, '..'), { recursive: true, mode: 0o700 });
          await rename(download, cmd);
        }
        const executable = archivePath(manifest.cmd, staging);
        if (!(await stat(executable)).isFile()) fail('INSTALL_FAILED', '分发 cmd 不是可执行文件。');
        await chmod(executable, 0o700);
        record.executable = archivePath(manifest.cmd, path);
      } else {
        await mkdir(path, { mode: 0o700 });
        ownsTarget = true;
        const { env } = await resolveEnvironment({ values: {}, inherit: [] });
        if (target.distribution === 'npx') {
          const packageName = /^(@[^/]+\/[^@]+|[^@]+)(?:@.*)?$/.exec(manifest.package!)?.[1];
          if (!packageName) fail('CONFIG_INVALID', 'npm 包名无效。');
          const pinned = `${packageName}@${resolvedVersion}`;
          await writeFile(
            join(path, 'package.json'),
            JSON.stringify({ name: `acp-${key.slice(0, 12)}`, version: '1.0.0', private: true }),
            { mode: 0o600 },
          );
          await progress('npm_install');
          await this.run(
            {
              executable: 'npm',
              args: [
                'install',
                '--prefix',
                path,
                '--save-exact',
                '--no-audit',
                '--no-fund',
                '--cache',
                cache,
                pinned,
              ],
              cwd: path,
              env,
            },
            { signal: combined, timeoutMs: 600_000 },
          );
          const packageRoot = join(path, 'node_modules', packageName);
          const metadata = JSON.parse(
            await readFile(join(packageRoot, 'package.json'), 'utf8'),
          ) as { version: string; bin?: string | Record<string, string> };
          if (metadata.version !== resolvedVersion)
            fail('INTEGRITY_MISMATCH', '实际安装包版本与固定目标不符。');
          const bins =
            typeof metadata.bin === 'string'
              ? { [basename(packageName)]: metadata.bin }
              : (metadata.bin ?? {});
          const command =
            manifest.command ??
            (Object.keys(bins).length === 1 ? Object.keys(bins)[0] : basename(packageName));
          const bin = command ? bins[command] : undefined;
          if (!bin) fail('CONFIG_INVALID', '包入口不唯一或缺少 bin，请指定 command。');
          const executable = archivePath(bin, packageRoot);
          await chmod(executable, 0o700);
          // npm bin 可以是 Node 脚本或原生程序；Windows 不执行任意 cmd 包装器。
          const entry = await open(executable, 'r');
          const header = Buffer.alloc(4096);
          let bytesRead: number;
          try {
            ({ bytesRead } = await entry.read(header, 0, header.length, 0));
          } finally {
            await entry.close();
          }
          const text = header.subarray(0, bytesRead).toString();
          if (text.startsWith('#!') && bytesRead === header.length && !text.includes('\n'))
            fail('CONFIG_INVALID', 'npm 入口 shebang 过长。');
          Object.assign(record, npmLaunch(executable, text));
          record.binDir = join(path, 'node_modules/.bin');
        } else {
          const match = /^([\w.-]+)(\[[\w,.-]+\])?(?:==.*)?$/.exec(manifest.package!)!;
          const packageName = match[1]!;
          const pinned = `${packageName}${match[2] ?? ''}==${resolvedVersion}`;
          const venv = join(path, 'venv');
          const bins = join(venv, process.platform === 'win32' ? 'Scripts' : 'bin');
          const python = join(bins, process.platform === 'win32' ? 'python.exe' : 'python');
          const toolEnv = {
            ...env,
            UV_CACHE_DIR: cache,
            UV_PYTHON_DOWNLOADS: 'never',
            UV_NO_MANAGED_PYTHON: '1',
            UV_LINK_MODE: 'copy',
          };
          await progress('uvx_prepare');
          await this.run(
            {
              executable: 'uv',
              args: ['--no-config', 'venv', '--no-python-downloads', '--no-managed-python', venv],
              cwd: path,
              env: toolEnv,
            },
            { signal: combined, timeoutMs: 600_000 },
          );
          await this.run(
            {
              executable: 'uv',
              args: [
                '--no-config',
                'pip',
                'install',
                '--python',
                python,
                '--link-mode',
                'copy',
                pinned,
              ],
              cwd: path,
              env: toolEnv,
            },
            { signal: combined, timeoutMs: 600_000 },
          );
          const probe = `import importlib.metadata as m,json; d=m.distribution(${JSON.stringify(packageName)}); print(json.dumps({'version':d.version,'bins':[e.name for e in d.entry_points if e.group=='console_scripts']}))`;
          const raw = await this.run(
            { executable: python, args: ['-c', probe], cwd: path, env: toolEnv },
            { signal: combined },
          );
          const metadata = JSON.parse(raw) as { version: string; bins: string[] };
          if (metadata.version !== resolvedVersion)
            fail('INTEGRITY_MISMATCH', 'Python 环境版本与目标不符。');
          const command =
            manifest.command ??
            (metadata.bins.length === 1
              ? metadata.bins[0]
              : metadata.bins.find((bin) => bin === packageName));
          if (!command || !metadata.bins.includes(command))
            fail('CONFIG_INVALID', 'Python 包入口不唯一或不存在，请指定 command。');
          record.executable = archivePath(
            command + (process.platform === 'win32' ? '.exe' : ''),
            bins,
          );
          if (!(await stat(record.executable)).isFile())
            fail('INSTALL_FAILED', 'Python 入口不存在。');
          record.binDir = bins;
          record.env = { ...record.env, VIRTUAL_ENV: venv };
        }
      }
      await this.checkSpace();
      combined.throwIfAborted();
      await writeFile(
        join(target.distribution === 'binary' ? staging : path, 'installation.json'),
        JSON.stringify(record),
        { mode: 0o600, flush: true },
      );
      if (target.distribution === 'binary') {
        await rename(staging, path);
        ownsTarget = true;
      } else await this.remove(this.paths.stagingDir, jobId);
      await progress('ready');
      return record;
    } catch (error) {
      try {
        if (ownsStaging) await this.remove(this.paths.stagingDir, jobId);
        if (ownsTarget) await this.remove(this.paths.installationsDir, key);
        if (ownsCache) await this.remove(this.paths.cacheDir, key);
      } catch {
        throw new AppError(
          'INSTALL_CLEANUP_PENDING',
          '安装未完成且存在待清理产物，请运行 storage cleanup。',
        );
      }
      if (capacity.signal.aborted) throw capacity.signal.reason;
      if (error instanceof AppError) throw error;
      throw new AppError(
        signal.aborted ? 'CANCELLED' : 'INSTALL_FAILED',
        '安装未完成，已有安装保持有效。',
      );
    } finally {
      clearInterval(monitor);
      await pending;
    }
  }
}
