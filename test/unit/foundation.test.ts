import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore, row } from '../../src/infrastructure/storage/sqlite-store.js';
import {
  resolveEnvironment,
  parseEnvFile,
  redact,
} from '../../src/infrastructure/platform/environment.js';
import { readText, writeText } from '../../src/infrastructure/platform/file-callbacks.js';
import { archivePath } from '../../src/infrastructure/installers/archive-reader.js';
import { requireCapability, validatePrompt } from '../../src/infrastructure/acp/capability-gate.js';
import { validateHttpOptions } from '../../src/transport/mcp/serve.js';
import { ClientRuntime } from '../../src/infrastructure/acp/client-runtime.js';
import { id, now } from '../../src/domain/ids.js';

void test('多连接 SQLite CAS、幂等冲突与持久化重开', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acm-store-'));
  const path = join(dir, 'db');
  const a = await SqliteStore.open(path);
  const b = await SqliteStore.open(path);
  try {
    await a.put('config', { id: 'c', revision: 1, createdAt: now() });
    const tx = {
      checks: [{ kind: 'config', id: 'c', revision: 1 }],
      puts: [row('config', { id: 'c', revision: 2, createdAt: now() })],
    };
    const outcomes = await Promise.allSettled([a.commit(tx), b.commit(tx)]);
    assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
    const idem = {
      principal: 'a',
      method: 'test',
      key: 'k',
      digest: 'x',
      response: { id: id('x') },
    };
    await a.commit({ idempotency: idem });
    assert.equal((await b.commit({ idempotency: idem })).replayed, true);
    await assert.rejects(b.commit({ idempotency: { ...idem, digest: 'different' } }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
  } finally {
    await a.close();
    await b.close();
  }
  const reopened = await SqliteStore.open(path);
  assert.equal((await reopened.get<{ revision: number }>('config', 'c'))?.revision, 2);
  await reopened.close();
  await rm(dir, { recursive: true });
});

void test('环境文件仅作数据解析，引用缺失失败，敏感值脱敏', async () => {
  const parsed = parseEnvFile('KEY="$(touch /tmp/never)"\nSECOND=value # literal\n');
  assert.equal(parsed.KEY, '$(touch /tmp/never)');
  await assert.rejects(
    resolveEnvironment({
      values: { TEST: { kind: 'host_env', name: 'ABSENT_ACM_TEST_ENV' } },
      inherit: [],
    }),
    { code: 'ENV_REFERENCE_UNRESOLVED' },
  );
  const value = await resolveEnvironment({
    values: { TEST: { kind: 'literal', value: 'hello' } },
    inherit: [],
  });
  assert.equal(value.env.TEST, 'hello');
  assert.deepEqual(redact({ text: 'token=secret' }, ['secret']), { text: 'token=[REDACTED]' });
});

void test('文件回调拒绝目录越界和符号链接逃逸，不截断外部文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acm-files-'));
  const outside = join(dir, 'outside');
  const root = join(dir, 'root');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(root);
  await writeFile(outside, 'untouched');
  try {
    await writeText(join(root, 'safe'), 'a\nb\nc', [root]);
    assert.deepEqual(await readText(join(root, 'safe'), [root], 2, 1), { content: 'b' });
    await assert.rejects(writeText(outside, 'bad', [root]));
    await symlink(outside, join(root, 'escape'));
    await assert.rejects(writeText(join(root, 'escape'), 'bad', [root]));
    assert.equal(await readFile(outside, 'utf8'), 'untouched');
  } finally {
    await rm(dir, { recursive: true });
  }
});

void test('分发路径、能力缺省、HTTP 匿名监听均失败关闭', () => {
  for (const path of ['../escape', '/root/escape', 'C:\\escape', 'CON', 'a/../../b'])
    assert.throws(() => archivePath(path, '/tmp/root'));
  assert.throws(() => requireCapability({}, 'load'), { code: 'CAPABILITY_UNSUPPORTED' });
  assert.throws(
    () => validatePrompt({}, [{ type: 'image', data: 'eA==', mimeType: 'image/png' }]),
    { code: 'CAPABILITY_UNSUPPORTED' },
  );
  assert.throws(() => validateHttpOptions({ host: '0.0.0.0', port: 7331, noAuth: true }));
});

void test('已取消请求不会发送任何 ACP 副作用', async () => {
  let calls = 0;
  const fake = {
    connection: {
      agent: {
        request: () => {
          calls++;
          return Promise.resolve({});
        },
      },
    },
  };
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    ClientRuntime.prototype.request.call(
      fake as unknown as ClientRuntime,
      'session/new',
      { cwd: '/tmp', mcpServers: [] },
      100,
      abort.signal,
    ),
    { code: 'CANCELLED' },
  );
  assert.equal(calls, 0);
});
