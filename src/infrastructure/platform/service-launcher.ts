import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { AppError } from '../../domain/errors.js';
import type { StoragePaths } from '../storage/paths.js';
import type { Settings } from '../../domain/schemas.js';

export function windowsNativeBinary(name: 'service-launcher' | 'process-host') {
  const paths = ['../../../', '../../../../'].map((prefix) =>
    fileURLToPath(new URL(`${prefix}native/win32-${process.arch}/${name}.exe`, import.meta.url)),
  );
  return paths.find((path) => existsSync(path)) ?? paths[0]!;
}
export const windowsServiceLauncher = () => windowsNativeBinary('service-launcher');

/** POSIX 独立会话与标准流；Windows 必须经过真正执行 breakaway 的原生程序。 */
export async function launchExecutionService(
  paths: StoragePaths,
  settings?: Settings,
  startupFile?: string,
) {
  const args = [
    fileURLToPath(new URL('../../cli/service-entry.js', import.meta.url)),
    JSON.stringify({ paths, settings, startupFile }),
  ];
  if (process.platform === 'win32') {
    const launcher = spawn(windowsServiceLauncher(), ['--launch', process.execPath, ...args], {
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    const [code] = (await once(launcher, 'exit')) as [number | null];
    if (code !== 0)
      throw new AppError(
        'SERVICE_BREAKAWAY_DENIED',
        'Windows 无法独立启动服务。请在上游进程之外手动运行 serve http。',
        { exitCode: code },
      );
    return;
  }
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', shell: false });
  await once(child, 'spawn');
  child.unref();
}

/** 由原生程序移除继承 ACL，并只授予当前用户读写权限。 */
export async function secureWindowsPath(path: string) {
  if (process.platform !== 'win32') return;
  const child = spawn(windowsServiceLauncher(), ['--private', path], {
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
  });
  const [code] = (await once(child, 'exit')) as [number | null];
  if (code !== 0) throw new AppError('STORAGE_UNSAFE', '无法建立仅当前用户可读写的凭证 ACL。');
}
