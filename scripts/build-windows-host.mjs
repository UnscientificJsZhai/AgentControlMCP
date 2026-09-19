import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') throw new Error('必须在配置 MSVC 的 Windows 构建机上执行');
const arch = process.argv[2] ?? process.arch;
if (!['x64', 'arm64'].includes(arch)) throw new Error('进程宿主只支持 x64 和 arm64');
const dir = `native/win32-${arch}`;
await mkdir(dir, { recursive: true });
const result = spawnSync(
  'cl.exe',
  [
    '/nologo',
    '/W4',
    '/WX',
    '/O2',
    '/MT',
    '/utf-8',
    'native/windows/process-host.c',
    `/Fo${dir}/process-host.obj`,
    `/Fe${dir}/process-host.exe`,
  ],
  { stdio: 'inherit', shell: false },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
