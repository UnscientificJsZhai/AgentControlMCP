import test from 'node:test';
import assert from 'node:assert/strict';
import type { Container } from '../../src/bootstrap/container.js';
import { AgentSetupService } from '../../src/application/agent-setup-service.js';
import type { AgentAvailabilityService } from '../../src/application/agent-availability-service.js';
import type { IdentityService } from '../../src/application/identity-service.js';
import type { InstallationService } from '../../src/application/installation-service.js';
import type { LocalPlanService } from '../../src/application/local-plan-service.js';
import type { Context } from '../../src/domain/models.js';
import { RegistryClient, officialSourceId } from '../../src/infrastructure/registry/client.js';
import { SqliteStore } from '../../src/infrastructure/storage/sqlite-store.js';
import { createMcpTools, toolAnnotations } from '../../src/transport/mcp/catalog.js';
import { invoke } from '../../src/transport/mcp/tools.js';
import { deferred } from '../helpers/deferred.js';

const ctx: Context = { principalId: 'alice', mode: 'stdio', serviceId: 'integration' };
const manifest = (id: string) => ({
  agents: [{ id, name: id, version: '1.0.0', distribution: { npx: {} } }],
});

/** 真实 SQLite 加固定 HTTP 响应，验证默认发现和管理搜索共用冷启动缓存。 */
void test('Cold discovery populates Registry while installations stay empty', async (t) => {
  const store = await SqliteStore.open(':memory:');
  t.after(() => store.close());
  const registry = new RegistryClient(store, false);
  await registry.initialize();
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', () => {
    fetches++;
    return Promise.resolve(Response.json(manifest('agent-a')));
  });
  const availability = {
    snapshot: () => Promise.resolve({ profiles: [], installations: [], recordOwners: [] }),
    phase: () => 'bootstrap',
  } as unknown as AgentAvailabilityService;
  const setup = new AgentSetupService(
    { registry } as InstallationService,
    availability,
    {} as LocalPlanService,
    {} as IdentityService,
  );
  const app = {
    identities: { check: () => Promise.resolve() },
    registry,
    setup,
  } as unknown as Container;
  const tools = createMcpTools(app);
  assert.equal(
    toolAnnotations(tools.find((tool) => tool.name === 'discover_agents')!).openWorldHint,
    true,
  );

  const discovered = await invoke(app, tools, ctx, 'discover_agents', {});
  assert.equal(discovered.ok, true);
  if (!discovered.ok) return;
  const data = discovered.data as Awaited<ReturnType<AgentSetupService['discover']>>;
  assert.deepEqual(data.installations, []);
  assert.equal(data.candidates.items[0]?.registryAgentId, 'agent-a');
  assert.deepEqual(data.refreshErrors, []);
  assert.ok(data.sources.find((source) => source.id === officialSourceId)?.snapshotId);

  const searched = await invoke(app, createMcpTools(app, 'management'), ctx, 'management_read', {
    action: 'registry_search',
    arguments: { query: 'no match' },
  });
  assert.equal(searched.ok, true);
  if (searched.ok)
    assert.deepEqual(searched.data, {
      items: [],
      hasMore: false,
      nextCursor: null,
      refreshErrors: [],
    });
  assert.equal(fetches, 1);
});

/** 某来源失败时保留其他候选，下一次无快照查询立即重试。 */
void test('Cold search returns partial candidates and retries failed sources', async (t) => {
  const store = await SqliteStore.open(':memory:');
  t.after(() => store.close());
  for (const [id, enabled] of [
    ['good', true],
    ['bad', true],
    ['disabled', false],
  ] as const)
    await store.put('source', {
      id,
      revision: 1,
      createdAt: new Date().toISOString(),
      name: id,
      url: `https://${id}.example.test/registry.json`,
      enabled,
    });
  const registry = new RegistryClient(store, false);
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.includes('bad') && calls.filter((item) => item.includes('bad')).length === 1)
      return Promise.resolve(new Response('', { status: 503 }));
    return Promise.resolve(
      Response.json(manifest(url.includes('good') ? 'agent-good' : 'agent-bad')),
    );
  });

  const first = await registry.search();
  assert.deepEqual(
    first.items.map((item) => item.registryAgentId),
    ['agent-good'],
  );
  assert.equal(first.refreshErrors.length, 1);
  assert.equal(first.refreshErrors[0]?.sourceId, 'bad');
  assert.equal(first.refreshErrors[0]?.error.code, 'REGISTRY_UNAVAILABLE');
  assert.equal(first.refreshErrors[0]?.error.retryable, true);
  assert.ok((await registry.sources()).find((source) => source.id === 'bad')?.error);

  const second = await registry.search();
  assert.deepEqual(
    second.items.map((item) => item.registryAgentId),
    ['agent-bad', 'agent-good'],
  );
  assert.deepEqual(second.refreshErrors, []);
  assert.equal(calls.filter((url) => url.includes('good')).length, 1);
  assert.equal(calls.filter((url) => url.includes('bad')).length, 2);
  assert.equal(
    calls.some((url) => url.includes('disabled')),
    false,
  );
});

/** 并发首次查询等待同一来源锁，后续调用复用已提交快照。 */
void test('Concurrent cold searches download each source once', async (t) => {
  const store = await SqliteStore.open(':memory:');
  t.after(() => store.close());
  const registry = new RegistryClient(store, false);
  await registry.initialize();
  const entered = deferred<void>();
  const waiting = deferred<void>();
  const release = deferred<void>();
  let fetches = 0;
  let lockCalls = 0;
  const locked = store.locked.bind(store);
  t.mock.method(store, 'locked', <T>(key: string, action: () => Promise<T>, waitMs?: number) => {
    if (++lockCalls === 2) waiting.resolve();
    assert.ok(waitMs && waitMs > 60_000);
    return locked(key, action, waitMs);
  });
  t.mock.method(globalThis, 'fetch', async () => {
    fetches++;
    entered.resolve();
    await release.promise;
    return Response.json(manifest('agent-a'));
  });

  const first = registry.search();
  await entered.promise;
  const second = registry.search();
  await waiting.promise;
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(fetches, 1);
  for (const result of results) {
    assert.equal(result.items[0]?.registryAgentId, 'agent-a');
    assert.deepEqual(result.refreshErrors, []);
  }
});

/** 同时等待的查询共享原始错误；下一次独立查询仍能重试。 */
void test('Concurrent cold search failure is shared before a later retry', async (t) => {
  const store = await SqliteStore.open(':memory:');
  t.after(() => store.close());
  const registry = new RegistryClient(store, false);
  await registry.initialize();
  const entered = deferred<void>();
  const waiting = deferred<void>();
  const release = deferred<void>();
  const locked = store.locked.bind(store);
  let lockCalls = 0;
  let fetches = 0;
  t.mock.method(store, 'locked', <T>(key: string, action: () => Promise<T>, waitMs?: number) => {
    if (++lockCalls === 2) waiting.resolve();
    return locked(key, action, waitMs);
  });
  t.mock.method(globalThis, 'fetch', async () => {
    fetches++;
    if (fetches === 1) {
      entered.resolve();
      await release.promise;
      return Response.json({
        agents: [manifest('duplicate').agents[0], manifest('duplicate').agents[0]],
      });
    }
    return Response.json(manifest('agent-a'));
  });

  const first = registry.search();
  await entered.promise;
  const second = registry.search();
  await waiting.promise;
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(fetches, 1);
  for (const result of results) {
    assert.deepEqual(result.items, []);
    assert.equal(result.refreshErrors[0]?.sourceId, officialSourceId);
    assert.equal(result.refreshErrors[0]?.error.code, 'CONFIG_INVALID');
  }
  assert.deepEqual(results[0]?.refreshErrors, results[1]?.refreshErrors);

  const retried = await registry.search();
  assert.equal(fetches, 2);
  assert.equal(retried.items[0]?.registryAgentId, 'agent-a');
  assert.deepEqual(retried.refreshErrors, []);
});
