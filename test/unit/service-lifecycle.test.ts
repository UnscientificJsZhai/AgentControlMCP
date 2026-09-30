import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceLifecycle } from '../../src/domain/service-lifecycle.js';
import { ServiceActivity } from '../../src/application/service-activity.js';
import { InteractionChannelRegistry } from '../../src/application/interaction-channel-registry.js';
import { settingsSchema } from '../../src/domain/schemas.js';
import { validateHandshake } from '../../src/infrastructure/service/protocol.js';
import { OperationService } from '../../src/application/operation-service.js';
import type { Entity, Context, WorkRecord } from '../../src/domain/models.js';
import type { SqliteStore } from '../../src/infrastructure/storage/sqlite-store.js';
import { recordingStore } from '../helpers/recording-store.js';
import { deferred } from '../helpers/deferred.js';
const row = <T extends Entity>(kind: string, data: T) => ({
  kind,
  id: data.id,
  revision: data.revision,
  data,
});

/** HTTP 提交期间断连不撤销已捕获的准入；操作结束后准入必须释放。 */
void test('Accepted HTTP interaction admission survives disconnect during commit', async () => {
  const registry = new InteractionChannelRegistry();
  const ctx: Context = {
    principalId: 'http:alice',
    mode: 'http',
    serviceId: 'service',
    connectionId: 'request',
    nativeInteraction: true,
  };
  registry.register('request', ctx.principalId);
  registry.update(ctx);
  const records: WorkRecord[] = [];
  const fixture = recordingStore({ operation: records });
  fixture.store.commit = (input) => {
    registry.remove('request');
    return Promise.resolve({ replayed: false, response: input.idempotency?.response });
  };
  const operations = new OperationService(fixture.store as SqliteStore, 'instance');
  operations.acceptRecords = (_ctx, work) => {
    records.push(work);
    return Promise.resolve({});
  };
  operations.retainInteraction = (context) => registry.retainAccepted(context);
  const entered = deferred<void>();
  const finish = deferred<void>();
  await operations.start(ctx, 'session_create', { idempotencyKey: 'create' }, async () => {
    assert.equal(registry.available(ctx), true);
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  finish.resolve();
  await operations.close();
  assert.equal(registry.available(ctx), false);
});

/** 不使用真实等待验证截止点、原子准入、重复释放与持续运行规则。 */
void test('Idle drain is atomic with admission and uses a monotonic deadline', () => {
  let time = 0;
  const service = new ServiceLifecycle(600_000, 'idle', () => time);
  service.ready();
  time = 599_999;
  assert.equal(service.beginDrain(), false);
  const work = service.acquire('work', 'task');
  time = 600_000;
  assert.equal(service.beginDrain(), false);
  work.release();
  work.release();
  time = 1_199_999;
  assert.equal(service.beginDrain(), false);
  time++;
  const connection = service.acquire('connection', 'stdio');
  assert.equal(service.beginDrain(), false);
  connection.release();
  time += 600_000;
  assert.equal(service.beginDrain(), true);
  assert.throws(() => service.acquire('work', 'late'), { code: 'SERVICE_DRAINING' });
});

/** 心跳/查询不用 touch，超时开关及接管不依赖墙上时间。 */
void test('Disabled idle timeout and successful takeover prevent automatic drain', () => {
  let time = 0;
  for (const timeout of [0, 600_000]) {
    const service = new ServiceLifecycle(timeout, 'idle', () => time);
    service.ready();
    if (timeout) service.persist();
    time += 9_000_000;
    assert.equal(service.beginDrain(), false);
    assert.equal(service.beginDrain(true), true);
  }
  const defaults = settingsSchema.parse({});
  assert.equal(defaults.serviceIdleTimeoutMs, 600_000);
  assert.equal(defaults.serviceStartupTimeoutMs, 10_000);
  assert.equal(defaults.serviceShutdownTimeoutMs, 10_000);
  for (const value of [-1, 1.5])
    assert.throws(() => settingsSchema.parse({ serviceIdleTimeoutMs: value }));
  for (const key of ['serviceStartupTimeoutMs', 'serviceShutdownTimeoutMs'])
    assert.throws(() => settingsSchema.parse({ [key]: 0 }));
});

/** 事务失败、幂等重放、排空和交互答复都不会留下虚假工作租约。 */
void test('Activity follows accepted records and releases local decided interactions', async () => {
  const activity = new ServiceActivity('instance', 600_000, 'idle');
  activity.lifecycle.ready();
  const task = {
    id: 'task',
    revision: 1,
    createdAt: '',
    instanceId: 'instance',
    state: 'accepted',
  };
  await assert.rejects(
    activity.commit({ puts: [row('task', task)] }, () => Promise.reject(new Error('rollback'))),
  );
  assert.equal(activity.lifecycle.snapshot().workCount, 0);
  await activity.commit({ puts: [row('task', task)] }, () => Promise.resolve({ replayed: true }));
  assert.equal(activity.lifecycle.snapshot().workCount, 0);
  await activity.commit({ puts: [row('task', task)] }, () => Promise.resolve({ replayed: false }));
  assert.equal(activity.lifecycle.snapshot().workCount, 1);
  const local = { ...task, id: 'local', runtimeId: 'runtime', state: 'pending' };
  await activity.commit({ puts: [row('interaction', local)] }, () =>
    Promise.resolve({ replayed: false }),
  );
  await activity.commit({ puts: [row('interaction', { ...local, state: 'decided' })] }, () =>
    Promise.resolve({ replayed: false }),
  );
  assert.equal(activity.lifecycle.snapshot().workCount, 1);
  const remote = { ...local, id: 'remote', state: 'decided', requestId: 1 };
  await activity.commit({ puts: [row('interaction', remote)] }, () =>
    Promise.resolve({ replayed: false }),
  );
  assert.equal(activity.lifecycle.snapshot().workCount, 2);
  await activity.commit(
    { puts: [row('runtime', { ...task, id: 'runtime', state: 'closed' })] },
    () => Promise.resolve({ replayed: false }),
  );
  assert.equal(activity.lifecycle.snapshot().workCount, 1);
  activity.lifecycle.beginDrain(true);
  await activity.commit({ puts: [row('task', { ...task, state: 'cancelled' })] }, () =>
    Promise.resolve({ replayed: false }),
  );
  assert.equal(activity.lifecycle.snapshot().workCount, 0);
  await assert.rejects(
    activity.commit({ puts: [row('task', { ...task, id: 'late' })] }, () =>
      Promise.resolve({ replayed: false }),
    ),
    { code: 'SERVICE_DRAINING' },
  );
});

/** 同事务创建团队、成员和排队意图时，必须先取得准入再提交。 */
void test('New team admission retains queued work without counting idle teams', async () => {
  const activity = new ServiceActivity('instance', 600_000, 'idle');
  activity.lifecycle.ready();
  const team = { id: 'team', revision: 1, createdAt: '', instanceId: 'instance' };
  const intent = { id: 'intent', revision: 1, createdAt: '', teamId: 'team', state: 'queued' };
  await activity.commit({ puts: [row('collab_team', team), row('collab_intent', intent)] }, () => {
    assert.ok(activity.lifecycle.snapshot().workCount);
    return Promise.resolve({ replayed: false });
  });
  assert.equal(activity.lifecycle.snapshot().workCount, 1);
  await activity.commit({ puts: [row('collab_intent', { ...intent, state: 'settled' })] }, () =>
    Promise.resolve({ replayed: false }),
  );
  assert.equal(activity.lifecycle.snapshot().workCount, 0);
});

/** 不接受管理员字段；连接能力撤销后，后台工作不能从历史布尔值恢复能力。 */
void test('IPC handshake rejects privilege injection and capabilities expire with connection', () => {
  const handshake = {
    version: 1,
    instanceId: 'instance',
    token: 'token',
    clientId: 'default',
    toolset: 'legacy',
    startupCwd: '/tmp',
  };
  assert.equal(validateHandshake(handshake).clientId, 'default');
  assert.throws(() => validateHandshake({ ...handshake, admin: true }), {
    code: 'IPC_HANDSHAKE_INVALID',
  });
  assert.throws(() => validateHandshake({ ...handshake, principalId: 'local_admin' }), {
    code: 'IPC_HANDSHAKE_INVALID',
  });
  assert.throws(() => validateHandshake({ ...handshake, version: 2 }), {
    code: 'IPC_VERSION_MISMATCH',
  });
  const registry = new InteractionChannelRegistry();
  const ctx = {
    principalId: 'stdio:default',
    mode: 'stdio' as const,
    serviceId: 'service',
    connectionId: 'one',
    nativeInteraction: true,
  };
  registry.register('one', ctx.principalId);
  registry.update(ctx);
  assert.equal(registry.available(ctx), true);
  registry.remove('one');
  assert.equal(registry.available(ctx), false);
  assert.equal(
    registry.available({ ...ctx, connectionId: undefined } as unknown as typeof ctx),
    false,
  );
});
