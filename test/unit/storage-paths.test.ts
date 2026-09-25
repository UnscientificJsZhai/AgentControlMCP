import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStoragePaths } from '../../src/infrastructure/storage/paths.js';

for (const value of [undefined, '', 'relative']) {
  /**
   * 验证 Linux 的 XDG 变量缺失、为空或为相对路径时回退到默认目录。
   *
   * @remarks
   * 数据、配置、状态和缓存目录均须独立遵循各自的默认路径。
   */
  void test('Linux falls back from invalid XDG values: ' + String(value), () => {
    const paths = resolveStoragePaths({
      platform: 'linux',
      home: '/home/test',
      env: {
        XDG_DATA_HOME: value,
        XDG_CONFIG_HOME: value,
        XDG_STATE_HOME: value,
        XDG_CACHE_HOME: value,
      },
      temporaryDir: '/tmp',
    });
    assert.equal(paths.dataDir, '/home/test/.local/share/agent-control-mcp');
    assert.equal(paths.configDir, '/home/test/.config/agent-control-mcp');
    assert.equal(paths.stateDir, '/home/test/.local/state/agent-control-mcp');
    assert.equal(paths.cacheDir, '/home/test/.cache/agent-control-mcp');
  });

  /**
   * 验证 Windows 的 LOCALAPPDATA 无效时回退到用户目录。
   *
   * @remarks
   * 缺失、空值和相对路径都不能被用作有效的应用数据根目录。
   */
  void test('Windows falls back from invalid LOCALAPPDATA values: ' + String(value), () => {
    const paths = resolveStoragePaths({
      platform: 'win32',
      home: 'C:\\Users\\test',
      env: { LOCALAPPDATA: value },
    });
    assert.equal(paths.dataDir, 'C:\\Users\\test\\AppData\\Local\\AgentControlMCP');
  });
}

/**
 * 验证自定义 XDG 路径分别控制配置、状态、缓存和安装目录。
 *
 * @remarks
 * 内容位于状态目录，安装位于数据目录，不能将所有产物混入同一根目录。
 */
void test('Custom Linux XDG paths separate configuration, state, cache, and installations', () => {
  const paths = resolveStoragePaths({
    platform: 'linux',
    home: '/home/test',
    env: {
      XDG_DATA_HOME: '/data',
      XDG_CONFIG_HOME: '/config',
      XDG_STATE_HOME: '/state',
      XDG_CACHE_HOME: '/cache',
    },
  });
  assert.equal(paths.contentDir, '/state/agent-control-mcp/content');
  assert.equal(paths.installationsDir, '/data/agent-control-mcp/installations');
  assert.equal(paths.configDir, '/config/agent-control-mcp');
  assert.equal(paths.cacheDir, '/cache/agent-control-mcp');
});

/**
 * 验证 macOS 将持久状态和缓存放入对应系统目录。
 *
 * @remarks
 * 数据库保存在应用支持目录下，缓存独立放入用户缓存目录。
 */
void test('macOS separates application support and cache directories', () => {
  const paths = resolveStoragePaths({ platform: 'darwin', home: '/Users/test', env: {} });
  assert.equal(paths.cacheDir, '/Users/test/Library/Caches/AgentControlMCP');
  assert.equal(
    paths.databasePath,
    '/Users/test/Library/Application Support/AgentControlMCP/state/state.db',
  );
});

/**
 * 验证 Windows 接受绝对 LOCALAPPDATA 作为数据目录根路径。
 *
 * @remarks
 * 环境指定的盘符和目录应优先于用户目录默认值。
 */
void test('Windows uses an absolute LOCALAPPDATA path', () => {
  assert.equal(
    resolveStoragePaths({
      platform: 'win32',
      home: 'C:\\Users\\test',
      env: { LOCALAPPDATA: 'D:\\Local' },
    }).dataDir,
    'D:\\Local\\AgentControlMCP',
  );
});

/**
 * 验证显式数据目录覆盖环境配置，并相对于给定工作目录解析。
 *
 * @remarks
 * 缓存也应落入显式数据目录，避免被平台环境变量分流到其他位置。
 */
void test('Explicit dataDir overrides environment settings and keeps cache data under the same root', () => {
  const paths = resolveStoragePaths({
    dataDir: 'my data',
    cwd: '/work',
    platform: 'linux',
    env: { AGENT_CONTROL_MCP_DATA_DIR: '/ignored', XDG_CACHE_HOME: '/ignored-cache' },
  });
  assert.equal(paths.dataDir, '/work/my data');
  assert.equal(paths.cacheDir, '/work/my data/cache');
});

/**
 * 验证数据目录环境变量优先于平台默认路径。
 *
 * @remarks
 * 配置目录应从覆盖后的数据根目录派生。
 */
void test('The data directory environment override takes precedence over platform defaults', () => {
  assert.equal(
    resolveStoragePaths({
      platform: 'linux',
      env: { AGENT_CONTROL_MCP_DATA_DIR: '/override' },
    }).configDir,
    '/override/config',
  );
});

for (const options of [{ dataDir: '' }, { env: { AGENT_CONTROL_MCP_DATA_DIR: ' ' } }]) {
  /**
   * 验证显式或环境来源的空白数据目录被拒绝。
   *
   * @remarks
   * 空白覆盖值应作为配置错误报告，不能静默回退到其他目录。
   */
  void test('Blank data directory overrides are rejected: ' + JSON.stringify(options), () => {
    assert.throws(() => resolveStoragePaths(options), { code: 'CONFIG_INVALID' });
  });
}
