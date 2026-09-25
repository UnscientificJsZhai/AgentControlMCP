import { lstat, mkdir, mkdtemp, realpath, rm, statfs } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fail } from '../../domain/errors.js';

export interface StoragePaths {
  dataDir: string;
  configDir: string;
  stateDir: string;
  contentDir: string;
  installationsDir: string;
  stagingDir: string;
  cacheDir: string;
  databasePath: string;
  runtimeDir: string;
}

/** 只解析路径，不创建目录；测试可注入平台环境，CLI 不把默认路径误当成显式覆盖。 */
export function resolveStoragePaths(
  options: {
    dataDir?: string | undefined;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
    cwd?: string;
    temporaryDir?: string;
  } = {},
): StoragePaths {
  const platform = options.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const base = (value: string | undefined, fallback: string) =>
    value && p.isAbsolute(value) ? value : fallback;
  const override = options.dataDir ?? env.AGENT_CONTROL_MCP_DATA_DIR;
  if (override !== undefined && !override.trim()) fail('CONFIG_INVALID', '数据目录不能为空。');
  const dataDir =
    override !== undefined
      ? p.resolve(options.cwd ?? process.cwd(), override)
      : platform === 'darwin'
        ? p.join(home, 'Library/Application Support/AgentControlMCP')
        : platform === 'win32'
          ? p.join(base(env.LOCALAPPDATA, p.join(home, 'AppData/Local')), 'AgentControlMCP')
          : p.join(base(env.XDG_DATA_HOME, p.join(home, '.local/share')), 'agent-control-mcp');
  const linuxDefaults = override === undefined && platform !== 'darwin' && platform !== 'win32';
  const configDir = linuxDefaults
    ? p.join(base(env.XDG_CONFIG_HOME, p.join(home, '.config')), 'agent-control-mcp')
    : p.join(dataDir, 'config');
  const stateDir = linuxDefaults
    ? p.join(base(env.XDG_STATE_HOME, p.join(home, '.local/state')), 'agent-control-mcp')
    : p.join(dataDir, 'state');
  const cacheDir = linuxDefaults
    ? p.join(base(env.XDG_CACHE_HOME, p.join(home, '.cache')), 'agent-control-mcp')
    : override === undefined && platform === 'darwin'
      ? p.join(home, 'Library/Caches/AgentControlMCP')
      : p.join(dataDir, 'cache');
  return {
    dataDir,
    configDir,
    stateDir,
    cacheDir,
    contentDir: p.join(stateDir, 'content'),
    databasePath: p.join(stateDir, 'state.db'),
    installationsDir: p.join(dataDir, 'installations'),
    stagingDir: p.join(dataDir, 'staging'),
    runtimeDir: base(
      platform === 'linux' ? env.XDG_RUNTIME_DIR : undefined,
      options.temporaryDir ?? tmpdir(),
    ),
  };
}

/** 固定真实根目录，拒绝后续清理穿过应用目录中的符号链接。 */
export async function initializeStoragePaths(paths: StoragePaths): Promise<StoragePaths> {
  validateStorageRoots(paths);
  const legacyDatabase = path.join(paths.dataDir, 'state/state.db');
  if (
    legacyDatabase !== paths.databasePath &&
    (await lstat(legacyDatabase).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    ))
  )
    fail(
      'STORAGE_FORMAT_UNSUPPORTED',
      '发现旧目录布局，请停止实例并手动清理旧数据后重试；不会自动迁移或删除。',
      { path: legacyDatabase },
    );
  const result = { ...paths };
  for (const field of ['dataDir', 'configDir', 'stateDir', 'cacheDir'] as const) {
    await mkdir(result[field], { recursive: true, mode: 0o700 });
    result[field] = await realpath(result[field]);
  }
  result.contentDir = path.join(result.stateDir, 'content');
  result.databasePath = path.join(result.stateDir, 'state.db');
  result.installationsDir = path.join(result.dataDir, 'installations');
  result.stagingDir = path.join(result.dataDir, 'staging');
  validateStorageRoots(result);
  for (const dir of [result.installationsDir, result.stagingDir, result.contentDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await lstat(dir)).isSymbolicLink())
      fail('STORAGE_UNSAFE', '应用子目录不能是符号链接。', { path: dir });
  }
  return result;
}

function validateStorageRoots(paths: StoragePaths) {
  const roots = [
    paths.configDir,
    paths.stateDir,
    paths.cacheDir,
    paths.installationsDir,
    paths.stagingDir,
  ];
  for (let i = 0; i < roots.length; i++)
    for (const other of roots.slice(i + 1)) {
      const a = roots[i]!;
      const inside = (parent: string, child: string) => {
        const relative = path.relative(parent, child);
        return (
          relative === '' ||
          (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
        );
      };
      if (inside(a, other) || inside(other, a))
        fail('CONFIG_INVALID', '配置、状态、安装和缓存目录不能重叠。');
    }
}

/** 每个实例独享运行目录，存放 Bridge 绑定文件和 POSIX socket；无效 XDG runtime 回退。 */
export async function createRuntimeDirectory(paths: StoragePaths) {
  let base = paths.runtimeDir;
  if (process.platform === 'linux') {
    let valid = false;
    if (process.env.XDG_RUNTIME_DIR === base) {
      try {
        const info = await lstat(base);
        valid =
          info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o777) === 0o700;
      } catch {
        /* 不使用无法验证的运行目录。 */
      }
    }
    if (!valid) {
      base = tmpdir();
      process.stderr.write('XDG_RUNTIME_DIR 不可用，管理 socket 使用私有临时目录。\n');
    }
  }
  const directory = await mkdtemp(path.join(base, 'acm-'));
  if (process.platform !== 'win32' && Buffer.byteLength(path.join(directory, 'admin.sock')) > 100) {
    await rm(directory, { recursive: true, force: true });
    fail('CONFIG_INVALID', '运行目录过长，请设置较短的 TMPDIR 或 XDG_RUNTIME_DIR。');
  }
  return directory;
}

export function safeComponent(value: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) fail('STORAGE_UNSAFE', '存储对象标识无效。');
  return value;
}

/** 只删除已知根下的直接子项；根目录被替换为链接时拒绝操作，不跟随子项链接。 */
export async function removeOwnedDirectory(root: string, name: string) {
  safeComponent(name);
  await assertStorageRoot(root);
  await rm(path.join(root, name), { recursive: true, force: true });
}

export async function assertStorageRoot(root: string) {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(root)) !== root)
    fail('STORAGE_UNSAFE', '存储根目录已改变，拒绝清理。', { path: root });
}

export async function requireFreeSpace(paths: StoragePaths, minimumFreeBytes: number) {
  if (!minimumFreeBytes) return;
  for (const root of new Set([paths.dataDir, paths.cacheDir])) {
    const space = await statfs(root, { bigint: true });
    if (space.bavail * space.bsize < BigInt(minimumFreeBytes))
      fail('CAPACITY_EXCEEDED', '安装目标剩余空间不足，请手动清理存储后重试。', {
        path: root,
        minimumFreeBytes,
      });
  }
}
