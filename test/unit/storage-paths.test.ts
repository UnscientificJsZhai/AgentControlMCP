import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  resolveStoragePaths,
  initializeStoragePaths,
} from '../../src/infrastructure/storage/paths.js';
import { SqliteStore } from '../../src/infrastructure/storage/sqlite-store.js';

void test('存储目录按平台分类，XDG 空值和相对路径回退，显式覆盖保持隔离', () => {
  for (const value of [undefined, '', 'relative']) {
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
  }
  const linux = resolveStoragePaths({
    platform: 'linux',
    home: '/home/test',
    env: {
      XDG_DATA_HOME: '/data',
      XDG_CONFIG_HOME: '/config',
      XDG_STATE_HOME: '/state',
      XDG_CACHE_HOME: '/cache',
    },
  });
  assert.equal(linux.contentDir, '/state/agent-control-mcp/content');
  assert.equal(linux.installationsDir, '/data/agent-control-mcp/installations');
  const mac = resolveStoragePaths({ platform: 'darwin', home: '/Users/test', env: {} });
  assert.equal(mac.cacheDir, '/Users/test/Library/Caches/AgentControlMCP');
  assert.equal(
    mac.databasePath,
    '/Users/test/Library/Application Support/AgentControlMCP/state/state.db',
  );
  for (const value of [undefined, '', 'relative']) {
    const windows = resolveStoragePaths({
      platform: 'win32',
      home: 'C:\\Users\\test',
      env: { LOCALAPPDATA: value },
    });
    assert.equal(windows.dataDir, 'C:\\Users\\test\\AppData\\Local\\AgentControlMCP');
  }
  const override = resolveStoragePaths({
    dataDir: 'my data',
    cwd: '/work',
    platform: 'linux',
    env: { AGENT_CONTROL_MCP_DATA_DIR: '/ignored', XDG_CACHE_HOME: '/ignored-cache' },
  });
  assert.equal(override.dataDir, '/work/my data');
  assert.equal(override.cacheDir, '/work/my data/cache');
  assert.equal(
    resolveStoragePaths({ platform: 'linux', env: { AGENT_CONTROL_MCP_DATA_DIR: '/override' } })
      .configDir,
    '/override/config',
  );
  assert.throws(() => resolveStoragePaths({ dataDir: '' }), { code: 'CONFIG_INVALID' });
  assert.throws(() => resolveStoragePaths({ env: { AGENT_CONTROL_MCP_DATA_DIR: ' ' } }), {
    code: 'CONFIG_INVALID',
  });
});

void test('拒绝缓存与安装根重叠，旧格式只报错而不迁移', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acm-layout-'));
  try {
    const paths = resolveStoragePaths({ dataDir: root });
    await assert.rejects(initializeStoragePaths({ ...paths, cacheDir: paths.dataDir }), {
      code: 'CONFIG_INVALID',
    });
    const file = join(await realpath(root), 'old.db');
    const old = new DatabaseSync(file);
    old.exec(
      "PRAGMA user_version=1; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('keep');",
    );
    old.close();
    await assert.rejects(SqliteStore.open(file), { code: 'STORAGE_FORMAT_UNSUPPORTED' });
    const after = new DatabaseSync(file, { readOnly: true });
    assert.equal(after.prepare('PRAGMA user_version').get()?.user_version, 1);
    assert.equal(after.prepare('SELECT value FROM sentinel').get()?.value, 'keep');
    after.close();
    await mkdir(join(root, 'state'));
    await writeFile(join(root, 'state/state.db'), 'old-layout');
    await assert.rejects(
      initializeStoragePaths({
        ...paths,
        stateDir: join(root, 'new-state'),
        contentDir: join(root, 'new-state/content'),
        databasePath: join(root, 'new-state/state.db'),
      }),
      { code: 'STORAGE_FORMAT_UNSUPPORTED' },
    );
    assert.equal(await readFile(join(root, 'state/state.db'), 'utf8'), 'old-layout');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
