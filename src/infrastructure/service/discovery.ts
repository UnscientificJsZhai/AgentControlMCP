import { lstat, readFile, writeFile, rename, realpath, rm, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { digest, id } from '../../domain/ids.js';
import { AppError, fail } from '../../domain/errors.js';
import { isAlive } from '../../application/recovery-service.js';
import { settingsSchema } from '../../domain/schemas.js';
import type { Settings } from '../../domain/schemas.js';
import type { StoragePaths } from '../storage/paths.js';
import { initializeStoragePaths, resolveStoragePaths } from '../storage/paths.js';
import { descriptorSchema } from './protocol.js';
import type { ServiceDescriptor } from './protocol.js';
import { launchExecutionService, secureWindowsPath } from '../platform/service-launcher.js';
import { adminRequest } from '../../transport/admin/ipc.js';
import { connectMcpIpc } from '../../transport/mcp/ipc.js';

const credentialSchema = z.strictObject({ token: z.string(), nonce: z.string() });
export const discoveryPath = (paths: StoragePaths) =>
  join(paths.stateDir, 'execution-service.json');

export async function canonicalServicePaths(dataDir?: string) {
  const paths = await initializeStoragePaths(resolveStoragePaths({ dataDir }));
  try {
    paths.databasePath = await realpath(paths.databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return paths;
}

/** 相同安装内容可复用服务；不同构建的活动服务拒绝混用。 */
let buildId: Promise<string> | undefined;
export function serviceBuildId() {
  buildId ??= (async () => {
    try {
      const manifest = JSON.parse(
        await readFile(new URL('../../service-build.json', import.meta.url), 'utf8'),
      ) as { buildId: string };
      if (!/^[0-9a-f]{64}$/.test(manifest.buildId))
        fail('SERVICE_VERSION_CONFLICT', '执行服务构建摘要无效，请重新构建。');
      return manifest.buildId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // 开发 watch 尚未生成 manifest 时仍校验全部 JS 与锁文件。
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const files = (await readdir(root, { recursive: true }))
      .filter((file) => file.endsWith('.js'))
      .sort();
    const bytes = await Promise.all(
      files.map(async (file) => [file, await readFile(join(root, file), 'utf8')]),
    );
    let lock: string;
    try {
      lock = await readFile(new URL('../../../package-lock.json', import.meta.url), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      lock = await readFile(new URL('../../../../package-lock.json', import.meta.url), 'utf8');
    }
    return digest([bytes, lock]);
  })();
  return buildId;
}

export async function readPrivateJson(path: string) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 64 * 1024 ||
    (process.platform !== 'win32' && (info.uid !== process.getuid?.() || info.mode & 0o077))
  )
    fail('STORAGE_UNSAFE', '服务发现信息或凭证文件不是当前用户的私有文件。');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
export async function serviceCredentials(descriptor: ServiceDescriptor) {
  const dir = await lstat(dirname(descriptor.credentialPath));
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    (process.platform !== 'win32' && (dir.uid !== process.getuid?.() || dir.mode & 0o077))
  )
    fail('STORAGE_UNSAFE', '服务凭证目录不安全。');
  return credentialSchema.parse(await readPrivateJson(descriptor.credentialPath));
}
export async function readDescriptor(paths: StoragePaths) {
  try {
    return descriptorSchema.parse(await readPrivateJson(discoveryPath(paths)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof z.ZodError)
      fail('IPC_VERSION_MISMATCH', '服务发现版本不兼容，请先停止旧服务。');
    throw error;
  }
}
export async function publishDescriptor(
  paths: StoragePaths,
  descriptor: ServiceDescriptor,
  token: string,
  nonce: string,
) {
  await secureWindowsPath(dirname(descriptor.credentialPath));
  await writeFile(descriptor.credentialPath, JSON.stringify({ token, nonce }), {
    mode: 0o600,
    flag: 'wx',
  });
  await secureWindowsPath(descriptor.credentialPath);
  const temp = `${discoveryPath(paths)}.${id('tmp')}`;
  try {
    await writeFile(temp, JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
    await secureWindowsPath(temp);
    await rename(temp, discoveryPath(paths));
  } finally {
    await rm(temp, { force: true });
  }
}
export async function removeDescriptor(paths: StoragePaths, instanceId: string) {
  const current = await readDescriptor(paths);
  if (current?.instanceId === instanceId) await rm(discoveryPath(paths), { force: true });
}
export function descriptorInstance(d: ServiceDescriptor, nonce: string) {
  return {
    id: d.instanceId,
    revision: 1,
    createdAt: '',
    mode: 'http' as const,
    role: 'execution_service' as const,
    serviceId: d.serviceId,
    pid: d.pid,
    state: 'active' as const,
    endpoint: d.adminEndpoint,
    nonce,
    heartbeat: '',
  };
}

/** 发现只读文件，代理不打开 SQLite；存活 PID 的失联端点绝不触发接管。 */
export async function findExecutionService(
  paths: StoragePaths,
  settings?: Settings,
  deadline?: number,
) {
  const d = await readDescriptor(paths);
  if (!d || !isAlive(d.pid)) return undefined;
  if (d.databasePath !== paths.databasePath)
    fail('SERVICE_IDENTITY_MISMATCH', '发现的服务状态路径不匹配。');
  if (d.buildId !== (await serviceBuildId()))
    fail('SERVICE_VERSION_CONFLICT', '活动服务构建版本不同，请先停止旧服务。');
  if (settings && d.settingsDigest !== digest(settings))
    fail('SERVICE_SETTINGS_CONFLICT', '显式 --settings 与活动服务设置不一致，请先停止服务。');
  const credentials = await serviceCredentials(d);
  const response = await adminRequest(
    descriptorInstance(d, credentials.nonce),
    '_service_status',
    {},
    false,
    undefined,
    deadline === undefined
      ? (settings?.serviceStartupTimeoutMs ??
          settingsSchema.parse(d.settings).serviceStartupTimeoutMs)
      : Math.max(1, deadline - performance.now()),
  );
  const status = response.data as { id: string; phase: string };
  if (status.id !== d.instanceId) fail('SERVICE_IDENTITY_MISMATCH', '活动服务响应的实例身份不符。');
  if (status.phase !== 'ready') fail('SERVICE_DRAINING', '活动服务正在排空，请稍后重试。');
  return d;
}
async function withinDeadline<T>(action: Promise<T>, deadline: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AppError('SERVICE_STARTUP_TIMEOUT', '执行服务启动超过配置期限。')),
          Math.max(1, deadline - performance.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function ensureExecutionService(paths: StoragePaths, settings?: Settings) {
  const startupTimeout =
    settings?.serviceStartupTimeoutMs ?? settingsSchema.parse({}).serviceStartupTimeoutMs;
  const deadline = performance.now() + startupTimeout;
  let launched = false;
  const startupFile = join(paths.stateDir, `.service-start-${id('request')}.json`);
  try {
    for (;;) {
      const descriptor = await withinDeadline(
        findExecutionService(paths, settings, deadline),
        deadline,
      );
      if (descriptor) {
        const credentials = await serviceCredentials(descriptor);
        if (performance.now() >= deadline)
          fail('SERVICE_STARTUP_TIMEOUT', '执行服务启动超过配置期限。');
        return { descriptor, credentials, deadline };
      }
      if (!launched) {
        launched = true;
        await writeFile(startupFile, '{}', { mode: 0o600, flag: 'wx' });
        await secureWindowsPath(startupFile);
        await withinDeadline(launchExecutionService(paths, settings, startupFile), deadline);
      }
      const failure = (await readPrivateJson(startupFile)) as {
        error?: { code: string; message: string };
      };
      if (failure.error) throw new AppError(failure.error.code, failure.error.message);
      if (performance.now() >= deadline)
        throw new AppError(
          'SERVICE_STARTUP_TIMEOUT',
          '执行服务未在期限内就绪；可能存在存活但失联的实例，请检查 service status。',
        );
      await delay(Math.min(25, Math.max(1, deadline - performance.now())));
    }
  } finally {
    await rm(startupFile, { force: true });
  }
}

export async function connectExecutionService(
  paths: StoragePaths,
  clientId: string,
  toolset: 'collaboration' | 'legacy' | 'management',
  startupCwd: string,
  settings?: Settings,
) {
  const { descriptor, credentials, deadline } = await ensureExecutionService(paths, settings);
  const socket = await connectMcpIpc(
    descriptor,
    credentials.token,
    clientId,
    toolset,
    startupCwd,
    Math.max(1, deadline - performance.now()),
  );
  return socket;
}
