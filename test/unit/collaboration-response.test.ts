import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { CollaborationController } from '../../src/application/collaboration/controller.js';
import type {
  CollaborationDependencies,
  RespondInput,
} from '../../src/application/collaboration/controller.js';
import { InteractionService } from '../../src/application/interaction-service.js';
import type {
  InteractionRecord,
  RuntimeRecord,
  Context,
  WorkRecord,
} from '../../src/domain/models.js';
import type { ManagedAgentRecord, TeamRecord } from '../../src/domain/collaboration.js';
import { permissionResolutionChoices } from '../../src/application/collaboration/actions.js';
import type { Idempotency, Transaction } from '../../src/infrastructure/storage/protocol.js';
import type { SqliteStore } from '../../src/infrastructure/storage/sqlite-store.js';
import { AppError } from '../../src/domain/errors.js';

const root: Context = { principalId: 'owner', serviceId: 'test', mode: 'stdio' };
const team: TeamRecord = {
  id: 'team',
  revision: 1,
  createdAt: '2026-01-01T00:00:00Z',
  schemaVersion: 1,
  ownerId: 'owner',
  instanceId: 'instance',
  cwd: '/tmp',
  sequence: '0',
  context: root,
};
const member = (id: string, parentId: string, path: string): ManagedAgentRecord => ({
  id,
  revision: 1,
  createdAt: team.createdAt,
  teamId: team.id,
  parentId,
  path,
  configId: 'config',
  configRevision: 1,
  cwd: '/tmp',
  lifecycle: 'active',
  mailAfter: '0',
  bridge: 'connected',
  runtimeId: `runtime-${id}`,
});

/** 内存记录只替代持久化端口；审批、成员范围和恢复分支调用真实应用实现。 */
function fixture(t: test.TestContext) {
  const data = new Map<string, unknown>();
  const transactions: Transaction[] = [];
  const replays = new Map<string, Idempotency>();
  const key = (kind: string, id: string) => `${kind}:${id}`;
  const idemKey = (value: Idempotency) => `${value.principal}:${value.method}:${value.key}`;
  const store = {
    get: <T>(kind: string, id: string) =>
      Promise.resolve(structuredClone(data.get(key(kind, id)) ?? null) as T | null),
    list: <T>(kind: string) =>
      Promise.resolve(
        [...data.entries()]
          .filter(([id]) => id.startsWith(kind + ':'))
          .map(([, value]) => structuredClone(value)) as T[],
      ),
    listMatching: async <T>(kind: string, field: string, values: string[]) =>
      (await store.list<Record<string, string>>(kind)).filter((row) =>
        values.includes(row[field]!),
      ) as T[],
    put: <T extends { id: string }>(kind: string, row: T) => {
      data.set(key(kind, row.id), structuredClone(row));
      return Promise.resolve();
    },
    replay: (value: Idempotency) => {
      const prior = replays.get(idemKey(value));
      if (prior && prior.digest !== value.digest)
        throw new AppError('IDEMPOTENCY_CONFLICT', '请求已改变');
      return Promise.resolve(prior?.response ?? null);
    },
    commit: (transaction: Transaction) => {
      for (const check of transaction.checks ?? []) {
        const row = data.get(key(check.kind, check.id)) as { revision?: number } | undefined;
        assert.equal(row?.revision, check.revision);
      }
      for (const row of transaction.puts ?? [])
        data.set(key(row.kind, row.id), structuredClone(row.data));
      for (const replay of [transaction.idempotency, ...(transaction.idempotencyAliases ?? [])])
        if (replay) replays.set(idemKey(replay), replay);
      transactions.push(transaction);
      return Promise.resolve({ replayed: false });
    },
  };
  const parent = member('parent', 'root', '/root/parent');
  const child = member('child', parent.id, '/root/parent/child');
  const sibling = member('sibling', 'root', '/root/sibling');
  data.set(key('collab_team', team.id), structuredClone(team));
  for (const agent of [parent, child, sibling]) {
    data.set(key('collab_agent', agent.id), agent);
    data.set(key('runtime', agent.runtimeId!), {
      id: agent.runtimeId,
      ownerId: 'owner',
      instanceId: 'instance',
      revision: 1,
      connectionGeneration: 2,
      state: 'bound',
      snapshot: { permissionPolicy: { timeoutMs: null } },
    });
  }
  const runtimes = {
    live: new Map([[child.runtimeId!, { secrets: [], channel: 'mcp_native' }]]),
    get: (_ctx: Context, id: string) => store.get<RuntimeRecord>('runtime', id),
  };
  const sessions = { runtimes, events: {}, operations: {} };
  const interactions = new InteractionService(
    store as unknown as SqliteStore,
    runtimes as unknown as ConstructorParameters<typeof InteractionService>[1],
    { sessions } as unknown as ConstructorParameters<typeof InteractionService>[2],
  );
  const controller = new CollaborationController({
    store,
    tasks: { sessions },
    interactions,
    identities: { check: () => Promise.resolve() },
    instanceId: 'instance',
  } as unknown as CollaborationDependencies);
  t.mock.method(controller.scheduler, 'wake', () => {});
  const parentContext = { ...root, collaborationMember: { teamId: team.id, agentId: parent.id } };
  let delegated = true;
  // 策略计算另有独立测试；此处改变授权结果，验证提交时重新调用委托检查。
  t.mock.method(interactions as unknown as { policy: () => Promise<string> }, 'policy', () =>
    Promise.resolve(delegated ? 'allow_once' : 'ask'),
  );
  async function open(type: InteractionRecord['type'] = 'permission') {
    const response = interactions.open(
      child.runtimeId!,
      type,
      {
        toolCall: { kind: 'read', locations: [{ path: '/tmp/file' }] },
        options: [
          { kind: 'allow_once', optionId: 'original-allow', name: '允许' },
          { kind: 'reject_once', optionId: 'original-reject', name: '拒绝' },
        ],
      },
      new AbortController().signal,
      'request',
    );
    await setImmediate();
    const record = (await store.list<InteractionRecord>('interaction')).find(
      (item) => item.state === 'pending',
    )!;
    t.after(async () => {
      await interactions.end(record.id, 'cancelled');
      await response;
    });
    return {
      record,
      response,
      choices: permissionResolutionChoices(child.id, record, 'respond_agent'),
    };
  }
  return {
    controller,
    interactions,
    store,
    transactions,
    data,
    parent,
    child,
    sibling,
    parentContext,
    open,
    revoke: () => {
      delegated = false;
    },
  };
}

void test('A stale permission template is rejected after expiry, connection replacement or delegation revocation', async (t) => {
  for (const boundary of ['expired', 'generation', 'delegation', 'self', 'sibling'] as const) {
    const env = fixture(t);
    const { record, choices } = await env.open();
    const args = choices.find((choice) => choice.kind === 'allow_once')!.call.arguments;
    let ctx = root;
    let code = 'INTERACTION_EXPIRED';
    if (boundary === 'expired')
      await env.store.put('interaction', { ...record, expiresAt: '2000-01-01T00:00:00Z' });
    if (boundary === 'generation') {
      const runtime = (await env.store.get<RuntimeRecord>('runtime', record.runtimeId))!;
      await env.store.put('runtime', { ...runtime, connectionGeneration: 3 });
      code = 'RUNTIME_GENERATION_CONFLICT';
    }
    if (boundary === 'delegation') {
      env.revoke();
      ctx = env.parentContext;
      code = 'ACCESS_DENIED';
    }
    if (boundary === 'self' || boundary === 'sibling') {
      ctx = {
        ...root,
        collaborationMember: {
          teamId: team.id,
          agentId: boundary === 'self' ? env.child.id : env.sibling.id,
        },
      };
      code = 'ACCESS_DENIED';
    }
    await assert.rejects(env.controller.respond(ctx, args), { code });
    assert.equal(
      (await env.store.get<InteractionRecord>('interaction', record.id))!.state,
      'pending',
    );
    assert.equal(env.transactions.length, 0);
  }
});

void test('Original reject and cancel templates resolve once and retain the supervision action on replay', async (t) => {
  for (const kind of ['reject_once', 'cancel'] as const) {
    const env = fixture(t);
    const { record, choices, response } = await env.open();
    const args = choices.find((choice) => choice.kind === kind)!.call.arguments;
    const result = await env.controller.respond(env.parentContext, args);
    assert.equal('state' in result && result.state, 'decided');
    assert.equal(result.teamId, team.id);
    assert.equal(
      'nextAction' in result &&
        typeof result.nextAction === 'object' &&
        result.nextAction !== null &&
        'tool' in result.nextAction &&
        result.nextAction.tool,
      'acm_wait_agent',
    );
    assert.deepEqual(await response, {
      outcome:
        kind === 'cancel'
          ? { outcome: 'cancelled' }
          : { outcome: 'selected', optionId: 'original-reject' },
    });
    await env.interactions.responded(record.runtimeId, 'request');
    assert.deepEqual(await env.controller.respond(env.parentContext, args), result);
    assert.equal(
      env.transactions.filter((transaction) =>
        transaction.puts?.some((row) => row.kind === 'interaction'),
      ).length,
      1,
    );
    await assert.rejects(
      env.controller.respond(env.parentContext, { ...args, requestId: 'another-request' }),
      { code: 'INTERACTION_ALREADY_RESOLVED' },
    );
  }
});

void test('Restore preparation, digest confirmation and replay retain their original states', async (t) => {
  const env = fixture(t);
  const agent = { ...env.child, sessionId: 'session', lifecycle: 'paused' as const };
  await env.store.put('collab_agent', agent);
  await env.store.put('session', { id: 'session', runtimeId: agent.runtimeId });
  const runtime = (await env.store.get<RuntimeRecord>('runtime', agent.runtimeId!))!;
  await env.store.put('runtime', {
    ...runtime,
    initialize: { agentCapabilities: { loadSession: true } },
  });
  const restore = t.mock.fn(async (ctx: Context, _method: string, input: { phase: string }) => {
    if (input.phase === 'prepare')
      return {
        restorePlanId: 'plan',
        environmentDigest: 'confirmed-digest',
        expiresAt: '2099-01-01T00:00:00Z',
        targetSnapshot: {},
      };
    const accepted = await env.controller.acceptOperation(ctx, {
      id: 'restore-operation',
      type: 'session_load',
    } as WorkRecord);
    await env.store.commit(accepted);
    return { operationId: 'restore-operation' };
  });
  Object.assign(env.controller.sessions, { restore });
  const prepare: RespondInput = {
    requestId: 'prepare',
    target: agent.id,
    action: 'prepare_restore',
  };
  const plan = await env.controller.respond(root, prepare);
  assert.ok('nextAction' in plan && typeof plan.nextAction === 'string');
  assert.match(plan.nextAction, /acceptEnvironmentDigest/);
  assert.deepEqual(await env.controller.respond(root, prepare), plan);
  const apply = {
    requestId: 'restore',
    target: agent.id,
    action: 'reply' as const,
    planId: 'recovery_plan',
    acceptEnvironmentDigest: 'wrong-digest',
  };
  await assert.rejects(env.controller.respond(root, apply), { code: 'PLAN_CHANGED' });
  apply.acceptEnvironmentDigest = 'confirmed-digest';
  const result = await env.controller.respond(root, apply);
  assert.equal('state' in result && result.state, 'starting');
  assert.deepEqual(await env.controller.respond(root, apply), result);
  assert.equal(restore.mock.callCount(), 2);
  assert.equal(
    (await env.store.get<ManagedAgentRecord>('collab_agent', agent.id))!.operationId,
    'restore-operation',
  );
});
