import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { AppError, fail } from '../../domain/errors.js';
import { normalizeEnvironment, resolveEnvironment } from './environment.js';

export async function which(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const candidates =
    command.includes('/') || command.includes('\\')
      ? [command]
      : (env.PATH ?? env.Path ?? '')
          .split(delimiter)
          .flatMap((root) =>
            process.platform === 'win32'
              ? (/\.[a-z0-9]+$/i.test(command) ? [''] : ['.exe', '.com', '.cmd', '']).map((ext) =>
                  join(root, command + ext),
                )
              : [join(root, command)],
          );
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      // Python 根据调用路径识别虚拟环境，解析到符号链接目标会错误启动全局环境。
      return resolve(candidate);
    } catch {
      /* 继续检查下一个 PATH 候选。 */
    }
  }
  return fail('DEPENDENCY_MISSING', '缺少宿主可执行文件，请先安装或设置绝对路径。', {
    executable: command,
  });
}

export async function executableCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform = process.platform,
) {
  const executable = await which(command, env);
  if (platform !== 'win32' || !/\.cmd$/i.test(executable)) return { executable, args };
  // 只解析 npm 的已知 shim；绝不将任意 argv 拼接给 cmd.exe。
  const script = await readFile(executable, 'utf8');
  const match =
    /(?:%dp0%[\\/]|%~dp0[\\/]?)node_modules[\\/]npm[\\/]bin[\\/](npm-cli|npx-cli)\.js/i.exec(
      script,
    );
  if (!match) return fail('CONFIG_INVALID', '无法安全执行 .cmd；请显式指定解释器和脚本参数。');
  const entry = join(dirname(executable), 'node_modules/npm/bin', `${match[1]!.toLowerCase()}.js`);
  await access(entry, constants.R_OK).catch(() =>
    fail('DEPENDENCY_MISSING', 'npm 启动脚本对应的 JS 入口不存在。'),
  );
  return {
    executable: process.execPath,
    args: [entry, ...args],
  };
}

export interface LaunchSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * 通过独立 supervisor 持有下游进程树；连接器意外退出时，控制管道 EOF 仍能触发清理。
 * stdin/stdout/stderr 留给下游，额外的 fd 3 传启动配置，fd 4 返回进程与退出信息。
 */
export class ProcessHost {
  readonly process;
  readonly stdout: Readable;
  readonly stdin: Writable;
  readonly stderr: Readable;
  readonly closed: Promise<void>;
  pid = 0;
  exitCode: number | null = null;
  exitSignal: string | null = null;
  private readonly control: Writable;
  private readonly startup: Promise<number>;
  private stopped = false;

  private constructor(spec: LaunchSpec, supervisorEnv: NodeJS.ProcessEnv) {
    this.process = spawn(
      process.execPath,
      [fileURLToPath(new URL('./supervisor.js', import.meta.url))],
      { env: supervisorEnv, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.stdout = this.process.stdout!;
    this.stdin = this.process.stdin!;
    this.stderr = this.process.stderr!;
    this.control = this.process.stdio[3] as Writable;
    this.closed = new Promise((resolve) => {
      this.process.once('close', resolve);
      this.process.once('error', resolve);
    });
    this.control.on('error', () => {});
    this.stdin.on('error', () => {});
    let resolveStartup!: (pid: number) => void;
    let rejectStartup!: (error: unknown) => void;
    this.startup = new Promise((resolve, reject) => {
      resolveStartup = resolve;
      rejectStartup = reject;
    });
    void this.closed.then(() => rejectStartup(new Error('closed')));
    let evidenceBuffer = '';
    (this.process.stdio[4] as Readable).on('data', (chunk: Buffer) => {
      evidenceBuffer += chunk.toString('utf8');
      while (evidenceBuffer.includes('\n')) {
        const index = evidenceBuffer.indexOf('\n');
        const data = JSON.parse(evidenceBuffer.slice(0, index)) as {
          pid?: number;
          error?: string;
          exitCode?: number | null;
          signal?: string | null;
        };
        evidenceBuffer = evidenceBuffer.slice(index + 1);
        if ('exitCode' in data) {
          this.exitCode = data.exitCode ?? null;
          this.exitSignal = data.signal ?? null;
        }
        if (data.pid) resolveStartup(data.pid);
        if (data.error) rejectStartup(new Error('spawn_failed'));
      }
    });
    // 目标环境只经私有控制管道传递，不能影响 supervisor 的 Node 启动参数或动态加载。
    this.control.write(JSON.stringify(spec) + '\n');
  }

  static async start(spec: LaunchSpec) {
    const env = normalizeEnvironment(spec.env);
    const resolved = await executableCommand(spec.executable, spec.args, env);
    const supervisor = await resolveEnvironment({ values: {}, inherit: [] });
    const host = new ProcessHost({ ...spec, ...resolved, env }, supervisor.env);
    let timer: NodeJS.Timeout | undefined;
    try {
      host.pid = await Promise.race([
        host.startup,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), 5000);
        }),
      ]);
      return host;
    } catch {
      await host.stop();
      return fail('DOWNSTREAM_EXITED', '下游进程未能启动。请检查命令和平台运行依赖。');
    } finally {
      clearTimeout(timer);
    }
  }

  /** 关闭控制管道请求监督进程回收整棵树，重复调用等待同一个 close 结果。 */
  async stop() {
    if (!this.stopped) {
      this.stopped = true;
      this.control.end();
      this.stdin.end();
    }
    await this.closed;
  }
}

/** 有界执行探测或安装命令，保留有限 stdout 并排空 stderr；失败不返回原始命令输出。 */
export async function runCommand(
  spec: LaunchSpec,
  options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {},
) {
  if (options.signal?.aborted) throw new AppError('CANCELLED', '命令启动前已取消。');
  const host = await ProcessHost.start(spec);
  const chunks: Buffer[] = [];
  let size = 0;
  host.stdout.on('data', (chunk: Buffer) => {
    if (size < (options.maxBytes ?? 1024 ** 2)) {
      chunks.push(chunk);
      size += chunk.length;
    }
  });
  host.stderr.resume();
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 30_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const abort = () => {
    void host.stop();
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  await host.closed;
  signal.removeEventListener('abort', abort);
  if (signal.aborted)
    throw new AppError(options.signal?.aborted ? 'CANCELLED' : 'TIMEOUT', '子进程已停止。');
  if (host.exitCode !== 0)
    throw new AppError('PROCESS_FAILED', '命令未成功完成。', {
      exitCode: host.exitCode,
      signal: host.exitSignal,
    });
  return Buffer.concat(chunks)
    .subarray(0, options.maxBytes ?? 1024 ** 2)
    .toString('utf8');
}
