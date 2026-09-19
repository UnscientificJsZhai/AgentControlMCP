import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

// 此进程仅由 ProcessHost 启动。控制管道 EOF 也覆盖连接器被 SIGKILL 的场景。
const control = new Socket({ fd: 3, readable: true, writable: false });
const evidence = new Socket({ fd: 4, readable: false, writable: true });
evidence.on('error', () => close());
let child: ChildProcessWithoutNullStreams | undefined;
let closing = false;
function kill(signal: NodeJS.Signals) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    /* 进程树已经退出。 */
  }
}
function close() {
  if (closing) return;
  closing = true;
  kill('SIGTERM');
  // 清理计时器必须保持监督进程存活，直到忽略 SIGTERM 的后代也被回收。
  setTimeout(() => kill('SIGKILL'), 1000);
  setTimeout(() => process.exit(0), 1500);
}
let input = '';
control.on('data', (chunk) => {
  input += chunk.toString('utf8');
  if (child || !input.includes('\n')) return;
  const config = JSON.parse(input.slice(0, input.indexOf('\n'))) as {
    executable: string;
    args: string[];
    cwd: string;
  };
  const command =
    process.platform === 'win32'
      ? fileURLToPath(
          new URL(`../../../native/win32-${process.arch}/process-host.exe`, import.meta.url),
        )
      : config.executable;
  const args =
    process.platform === 'win32'
      ? ['--parent', String(process.pid), config.executable, ...config.args]
      : config.args;
  child = spawn(command, args, {
    cwd: config.cwd,
    env: process.env,
    stdio: 'pipe',
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  child.on('error', () => {
    evidence.end(JSON.stringify({ error: 'spawn_failed' }) + '\n');
    close();
  });
  child.on('spawn', () => evidence.write(JSON.stringify({ pid: child?.pid }) + '\n'));
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.on('error', close);
  child.on('exit', (code, signal) => {
    evidence.write(JSON.stringify({ exitCode: code, signal }) + '\n');
    close();
  });
});
control.on('end', close);
control.on('error', close);
process.on('SIGTERM', close);
process.on('SIGINT', close);
process.stdin.on('end', close);
process.stdout.on('error', close);
process.stderr.on('error', close);
