import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../../src/domain/errors.js';
import type { Context, RegistrySnapshot, RegistrySource } from '../../src/domain/models.js';
import { RegistryClient } from '../../src/infrastructure/registry/client.js';
import type { Transaction } from '../../src/infrastructure/storage/protocol.js';
import { row, SqliteStore } from '../../src/infrastructure/storage/sqlite-store.js';

const admin: Context = {
  principalId: 'registry-test',
  mode: 'cli',
  serviceId: 'registry-test',
  admin: true,
};

function gate() {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    async wait() {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('等待 Registry 测试门闩超时。')), 5_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'acm-registry-'));
  const store = await SqliteStore.open(join(root, 'state.db'));
  const source: RegistrySource = {
    id: 'source',
    revision: 1,
    createdAt: '2020-01-01T00:00:00.000Z',
    name: '旧来源',
    url: 'https://old.example/registry.json',
    enabled: true,
    snapshotId: 'snapshot',
    etag: 'old-etag',
    fetchedAt: '2020-01-01T00:00:00.000Z',
  };
  const snapshot: RegistrySnapshot = {
    id: 'snapshot',
    revision: 1,
    createdAt: source.createdAt,
    sourceId: source.id,
    url: source.url,
    digest: 'fixed-content',
    agents: [{ id: 'fixture', name: '固定 Agent', version: '1.0.0', distribution: {} }],
  };
  await store.commit({ puts: [row('source', source), row('registry_snapshot', snapshot)] });
  const configStore = await SqliteStore.open(join(root, 'state.db'));
  return {
    store,
    source,
    snapshot,
    registry: new RegistryClient(store, false),
    configRegistry: new RegistryClient(configStore, false),
    async cleanup() {
      await store.close();
      await configStore.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function assertFixedSnapshot(h: Awaited<ReturnType<typeof fixture>>) {
  assert.deepEqual(await h.store.list('registry_snapshot'), [h.snapshot]);
  assert.deepEqual(await h.registry.get(h.source.id, 'fixture', h.snapshot.id), {
    sourceId: h.source.id,
    snapshotId: h.snapshot.id,
    cachedAt: h.snapshot.createdAt,
    agent: h.snapshot.agents[0],
  });
}

void test('Registry 304 只推进来源修订与刷新时间，继续复用原 ETag 和固定快照', async (t) => {
  const h = await fixture();
  try {
    const request = t.mock.method(
      globalThis,
      'fetch',
      (url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
        assert.equal(url, h.source.url);
        assert.equal(new Headers(options?.headers).get('If-None-Match'), h.source.etag);
        return Promise.resolve(new Response(null, { status: 304 }));
      },
    );
    const startedAt = Date.now();
    assert.deepEqual(await h.registry.refresh(h.source.id, undefined, true), h.snapshot);
    const current = await h.store.get<RegistrySource>('source', h.source.id);
    assert.ok(current?.fetchedAt);
    assert.ok(Date.parse(current.fetchedAt) >= startedAt);
    assert.ok(Date.parse(current.fetchedAt) <= Date.now());
    assert.deepEqual(current, {
      ...h.source,
      revision: h.source.revision + 1,
      fetchedAt: current.fetchedAt,
    });
    await assertFixedSnapshot(h);
    assert.deepEqual(await h.registry.refresh(h.source.id), h.snapshot);
    assert.equal(request.mock.callCount(), 1);
  } finally {
    await h.cleanup();
  }
});

const changes = [
  { name: '更换 URL', patch: { name: '新来源', url: 'https://new.example/registry.json' } },
  { name: '停用来源', patch: { enabled: false } },
];

for (const change of changes)
  void test(`Registry 旧 304 响应不能覆盖并发${change.name}`, { timeout: 15_000 }, async (t) => {
    const h = await fixture();
    const entered = gate();
    const response = gate();
    let refreshing: Promise<unknown> = Promise.resolve();
    try {
      t.mock.method(globalThis, 'fetch', async () => {
        entered.release();
        await response.wait();
        return new Response(null, { status: 304 });
      });
      refreshing = h.registry
        .refresh(h.source.id, undefined, true)
        .catch((error: unknown) => error);
      await entered.wait();
      const configured = await h.configRegistry.configure(admin, {
        sourceId: h.source.id,
        expectedRevision: h.source.revision,
        patch: change.patch,
        idempotencyKey: 'configure',
      });
      const current = await h.store.get<RegistrySource>('source', h.source.id);
      assert.deepEqual(current, configured);
      assert.ok(current);
      assert.equal(current.revision, h.source.revision + 1);
      if (change.patch.url) {
        assert.equal(current.url, change.patch.url);
        assert.equal(current.snapshotId, undefined);
        assert.equal(current.etag, undefined);
        assert.equal(current.fetchedAt, undefined);
      } else {
        assert.equal(current.enabled, false);
        assert.equal(current.snapshotId, h.source.snapshotId);
      }
      response.release();
      const error = await refreshing;
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'REVISION_CONFLICT');
      assert.equal(error.details.currentRevision, current.revision);
      assert.deepEqual(await h.store.get('source', h.source.id), current);
      await assertFixedSnapshot(h);
    } finally {
      response.release();
      await refreshing;
      await h.cleanup();
    }
  });

void test('Registry 刷新失败仍记录错误并保留原缓存和固定快照', async (t) => {
  const h = await fixture();
  try {
    const failure = new Error('network fixture');
    t.mock.method(globalThis, 'fetch', () => Promise.reject(failure));
    await assert.rejects(h.registry.refresh(h.source.id, undefined, true), (error: unknown) =>
      Object.is(error, failure),
    );
    assert.deepEqual(await h.store.get('source', h.source.id), {
      ...h.source,
      revision: h.source.revision + 1,
      error: '刷新失败；保留原缓存与固定版本。',
    });
    await assertFixedSnapshot(h);
  } finally {
    await h.cleanup();
  }
});

for (const change of changes)
  void test(
    `Registry 错误记录提交期间并发${change.name}时保留新配置和原始刷新错误`,
    { timeout: 15_000 },
    async (t) => {
      const h = await fixture();
      const entered = gate();
      const record = gate();
      let refreshing: Promise<unknown> = Promise.resolve();
      try {
        const failure = new Error('network fixture');
        t.mock.method(globalThis, 'fetch', () => Promise.reject(failure));
        const commit = h.store.commit.bind(h.store);
        t.mock.method(h.store, 'commit', async (transaction: Transaction) => {
          if (
            transaction.puts?.some(
              (item) => item.kind === 'source' && Boolean((item.data as RegistrySource).error),
            )
          ) {
            // 卡住错误写回本身，覆盖先读修订再无条件写入仍会产生的竞态。
            entered.release();
            await record.wait();
          }
          return commit(transaction);
        });
        refreshing = h.registry
          .refresh(h.source.id, undefined, true)
          .catch((error: unknown) => error);
        await entered.wait();
        const configured = await h.configRegistry.configure(admin, {
          sourceId: h.source.id,
          expectedRevision: h.source.revision,
          patch: change.patch,
          idempotencyKey: 'configure',
        });
        assert.deepEqual(await h.store.get('source', h.source.id), configured);
        record.release();
        assert.equal(await refreshing, failure);
        assert.deepEqual(await h.store.get('source', h.source.id), configured);
        await assertFixedSnapshot(h);
      } finally {
        record.release();
        await refreshing;
        await h.cleanup();
      }
    },
  );
