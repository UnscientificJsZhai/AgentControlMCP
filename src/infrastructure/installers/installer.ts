import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { AppError, fail } from '../../domain/errors.js';
import { id, now } from '../../domain/ids.js';
import type { Distribution, InstallationRecord } from '../../domain/models.js';
import { archivePath, extractArchive } from './archive-reader.js';
import { fetchBytes, validateUrl } from '../registry/client.js';
import { resolveEnvironment } from '../platform/environment.js';
import { runCommand, which } from '../platform/process-host.js';

export const platformKey = () =>
  `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch}`;
export interface InstallTarget {
  sourceId: string;
  registryAgentId: string;
  targetVersion: string;
  distribution: 'binary' | 'npx' | 'uvx';
  snapshotId?: string | undefined;
}
export class Installer {
  constructor(
    readonly dataDir: string,
    readonly allowInsecure: boolean,
  ) {}
  async resolve(target: InstallTarget, manifest: Distribution, signal: AbortSignal) {
    if (target.distribution === 'binary') return target.targetVersion;
    const spec = manifest.package;
    if (!spec) fail('CONFIG_INVALID', '包分发缺少 package。');
    if (target.distribution === 'npx') {
      await which('npm');
      await which('npx');
      const match = /^(@[^/\s]+\/[^@\s]+|[^@/\s]+)(?:@([^\s]+))?$/.exec(spec);
      if (!match || /[:\\]/.test(spec))
        fail('CONFIG_INVALID', 'npx package 必须是 npm 包名和版本。');
      if (match[2] && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(match[2])) return match[2];
      const { env } = await resolveEnvironment({ values: {}, inherit: [] });
      const requested = `${match[1]}@${match[2] ?? target.targetVersion}`;
      const output = await runCommand(
        {
          executable: 'npm',
          args: ['view', requested, 'version', '--json', '--fetch-retries=0'],
          cwd: this.dataDir,
          env,
        },
        { signal },
      );
      const version = JSON.parse(output) as unknown;
      if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version))
        fail('VERSION_UNRESOLVABLE', '无法确定 npm 精确版本。');
      return version;
    }
    await which('uvx');
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
  async install(
    target: InstallTarget,
    manifest: Distribution,
    resolvedVersion: string,
    key: string,
    signal: AbortSignal,
    progress: (step: string) => Promise<void>,
  ): Promise<InstallationRecord> {
    const installationId = id('ins');
    const path = join(this.dataDir, 'installations', key);
    const staging = join(this.dataDir, 'staging', id('job'));
    const cache = join(this.dataDir, 'tool-cache', key);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await mkdir(join(this.dataDir, 'installations'), { recursive: true, mode: 0o700 });
    const record: InstallationRecord = {
      id: installationId,
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
      await progress('preparing');
      if (target.distribution === 'binary') {
        if (!manifest.archive || !manifest.cmd) fail('CONFIG_INVALID', 'binary 缺少 archive/cmd。');
        validateUrl(manifest.archive, this.allowInsecure);
        if (/\.(dmg|pkg|deb|rpm|msi|appimage)$/i.test(new URL(manifest.archive).pathname))
          fail('PLATFORM_UNSUPPORTED', '不执行系统安装器格式。');
        await progress('downloading');
        const response = await fetch(manifest.archive, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
        });
        if (!response.ok || !response.body)
          fail('INSTALL_FAILED', '下载失败。', { status: response.status });
        const download = join(staging, '.download');
        const file = await open(download, 'wx', 0o600);
        const hash = createHash('sha256');
        let size = 0;
        try {
          for await (const value of response.body) {
            const chunk = value as Uint8Array;
            size += chunk.length;
            if (size > 1024 ** 3) fail('CAPACITY_EXCEEDED', '下载超过 1 GiB。');
            hash.update(chunk);
            await file.write(chunk);
          }
          await file.sync();
        } finally {
          await file.close();
        }
        const actual = hash.digest('hex');
        if (manifest.sha256 && actual !== manifest.sha256.toLowerCase())
          fail('INTEGRITY_MISMATCH', 'SHA-256 校验失败，拒绝安装。');
        record.integrity = manifest.sha256 ? 'verified' : 'not_provided';
        await progress('extracting');
        if (/\.(zip|tar\.gz|tgz|tar\.bz2|tbz2)$/i.test(new URL(manifest.archive).pathname)) {
          await extractArchive(download, manifest.archive, staging, size, signal);
          await rm(download);
        } else {
          const cmd = archivePath(manifest.cmd, staging);
          await mkdir(join(cmd, '..'), { recursive: true });
          await rename(download, cmd);
        }
        const executable = archivePath(manifest.cmd, staging);
        if (!(await stat(executable)).isFile()) fail('INSTALL_FAILED', '分发 cmd 不是可执行文件。');
        await chmod(executable, 0o700);
        record.executable = archivePath(manifest.cmd, path);
      } else {
        await mkdir(cache, { recursive: true, mode: 0o700 });
        const { env } = await resolveEnvironment({ values: {}, inherit: [] });
        if (target.distribution === 'npx') {
          const packageName = /^(@[^/]+\/[^@]+|[^@]+)(?:@.*)?$/.exec(manifest.package!)?.[1];
          if (!packageName) fail('CONFIG_INVALID', 'npm 包名无效。');
          const pinned = `${packageName}@${resolvedVersion}`;
          await writeFile(
            join(cache, 'package.json'),
            JSON.stringify({ name: `acp-${key.slice(0, 12)}`, version: '1.0.0', private: true }),
            { mode: 0o600 },
          );
          await progress('npm_install');
          await runCommand(
            {
              executable: 'npm',
              args: [
                'install',
                '--prefix',
                cache,
                '--save-exact',
                '--no-audit',
                '--no-fund',
                '--cache',
                join(cache, '.cache'),
                pinned,
              ],
              cwd: cache,
              env,
            },
            { signal, timeoutMs: 600_000 },
          );
          const metadata = JSON.parse(
            await readFile(join(cache, 'node_modules', packageName, 'package.json'), 'utf8'),
          ) as { name: string; version: string; bin?: string | Record<string, string> };
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
          if (!bin)
            fail('CONFIG_INVALID', '包有多个入口或缺少 bin，请在 Registry 中明确 command。');
          const executable = archivePath(bin, join(cache, 'node_modules', packageName));
          await chmod(executable, 0o700);
          record.executable = await which('npx');
          record.prefixArgs = [
            '--offline',
            '--yes',
            '--prefix',
            cache,
            '--cache',
            join(cache, '.cache'),
            `--package=${pinned}`,
            '--',
            executable,
          ];
        } else {
          const match = /^([\w.-]+)(\[[\w,.-]+\])?(?:==.*)?$/.exec(manifest.package!)!;
          const packageName = match[1]!;
          const pinned = `${packageName}${match[2] ?? ''}==${resolvedVersion}`;
          const toolEnv = {
            ...env,
            UV_CACHE_DIR: join(cache, 'cache'),
            UV_TOOL_DIR: join(cache, 'tools'),
            UV_PYTHON_DOWNLOADS: 'never',
            UV_NO_MANAGED_PYTHON: '1',
          };
          const probe = `import importlib.metadata as m,json; d=m.distribution(${JSON.stringify(packageName)}); print(json.dumps({'version':d.version,'bins':[e.name for e in d.entry_points if e.group=='console_scripts']}))`;
          await progress('uvx_prepare');
          const base = ['--no-env-file', '--no-python-downloads', '--from', pinned];
          const raw = await runCommand(
            { executable: 'uvx', args: [...base, 'python', '-c', probe], cwd: cache, env: toolEnv },
            { signal, timeoutMs: 600_000 },
          );
          const metadata = JSON.parse(raw) as { version: string; bins: string[] };
          if (metadata.version !== resolvedVersion)
            fail('INTEGRITY_MISMATCH', 'uvx 实际版本与目标不符。');
          const command =
            manifest.command ??
            (metadata.bins.length === 1
              ? metadata.bins[0]
              : metadata.bins.find((bin) => bin === packageName));
          if (!command) fail('CONFIG_INVALID', 'uvx 包入口不唯一，请指定 command。');
          await runCommand(
            {
              executable: 'uvx',
              args: ['--offline', ...base, 'python', '-c', probe],
              cwd: cache,
              env: toolEnv,
            },
            { signal, timeoutMs: 30_000 },
          );
          record.executable = await which('uvx');
          record.prefixArgs = ['--offline', ...base, command];
          record.env = {
            ...record.env,
            UV_CACHE_DIR: toolEnv.UV_CACHE_DIR,
            UV_TOOL_DIR: toolEnv.UV_TOOL_DIR,
            UV_PYTHON_DOWNLOADS: 'never',
            UV_NO_MANAGED_PYTHON: '1',
          };
        }
      }
      signal.throwIfAborted();
      await writeFile(join(staging, 'installation.json'), JSON.stringify(record), {
        mode: 0o600,
        flush: true,
      });
      await rename(staging, path);
      await progress('ready');
      return record;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (error instanceof AppError) throw error;
      throw new AppError(
        signal.aborted ? 'CANCELLED' : 'INSTALL_FAILED',
        '安装未完成，原配置和已有安装保持有效。',
      );
    }
  }
}
