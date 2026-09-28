import test from 'node:test';
import assert from 'node:assert/strict';
import { CollaborationController } from '../../src/application/collaboration/controller.js';
import type { CollaborationDependencies } from '../../src/application/collaboration/controller.js';
import type {
  ManagedAgentRecord,
  TaskIntentRecord,
  TeamRecord,
} from '../../src/domain/collaboration.js';
import type { Context, InteractionRecord, RuntimeRecord } from '../../src/domain/models.js';

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
  context: { principalId: 'owner', serviceId: 'test', mode: 'stdio' },
};
const agent = (id: string, path: string, parentId = 'root'): ManagedAgentRecord => ({
  id,
  path,
  parentId,
  revision: 1,
  createdAt: team.createdAt,
  teamId: team.id,
  configId: 'config',
  configRevision: 1,
  cwd: '/tmp',
  lifecycle: 'active',
  mailAfter: '0',
  bridge: 'connected',
  runtimeId: `runtime-${id}`,
});
const intent = (
  id: string,
  agentId: string,
  state: TaskIntentRecord['state'],
): TaskIntentRecord => ({
  id,
  agentId,
  teamId: team.id,
  revision: 1,
  createdAt: team.createdAt,
  order: '1',
  message: 'work',
  state,
});
const runtime = (id: string): RuntimeRecord => ({
  id: `runtime-${id}`,
  revision: 1,
  createdAt: team.createdAt,
  instanceId: 'instance',
  ownerId: 'owner',
  configId: 'config',
  configRevision: 1,
  snapshot: {} as RuntimeRecord['snapshot'],
  cwd: '/tmp',
  state: 'bound',
  connectionGeneration: 2,
  authState: 'ready',
  expiresAt: '2099-01-01T00:00:00Z',
});
const interaction = (id: string): InteractionRecord => ({
  id,
  revision: 1,
  createdAt: team.createdAt,
  ownerId: 'owner',
  instanceId: 'instance',
  runtimeId: 'runtime-a',
  connectionGeneration: 2,
  type: 'permission',
  state: 'pending',
  request: {
    toolCall: { kind: 'read', locations: [{ path: '/tmp/file' }] },
    options: [
      { optionId: 'approve', kind: 'allow_once' },
      { optionId: 'reject', kind: 'reject_once' },
    ],
  },
  expiresAt: '2099-01-01T00:00:00Z',
  channel: 'mcp_native',
});

function fixture(records: Record<string, unknown[]> = {}, delegateHost = false) {
  let stamp = 0;
  const data = {
    collab_team: [team],
    collab_agent: [] as unknown[],
    collab_intent: [] as unknown[],
    runtime: [] as unknown[],
    interaction: [] as unknown[],
    ...records,
  };
  const store = {
    get: <T>(kind: string, id: string) =>
      Promise.resolve(
        (data[kind as keyof typeof data]?.find((item) => (item as { id: string }).id === id) ??
          null) as T | null,
      ),
    list: <T>(kind: string) => Promise.resolve((data[kind as keyof typeof data] ?? []) as T[]),
    listMatching: <T>(kind: string, field: string, values: string[]) =>
      Promise.resolve(
        (data[kind as keyof typeof data] ?? []).filter((item) =>
          values.includes((item as Record<string, string>)[field]!),
        ) as T[],
      ),
    changeStamp: () => Promise.resolve(String(stamp)),
  };
  const controller = new CollaborationController({
    store,
    tasks: { sessions: { events: {} } },
    identities: { check: () => Promise.resolve() },
    interactions: {
      mayDelegateApproval: (
        _id: string,
        _record: InteractionRecord,
        decision: { kind: string; optionId?: string; allow?: boolean },
      ) =>
        Promise.resolve(decision.kind === 'host' ? delegateHost : decision.optionId === 'reject'),
    },
    instanceId: 'instance',
  } as unknown as CollaborationDependencies);
  let messages: unknown[] = [];
  controller.storage.mailbox = () =>
    Promise.resolve({
      messages: messages as Awaited<ReturnType<typeof controller.storage.mailbox>>['messages'],
      nextCursor: 'cursor',
      hasMore: false,
      after: '0',
    });
  controller.storage.acknowledge = async () => {};
  return {
    controller,
    data,
    advanceStamp: () => {
      stamp++;
    },
    setMessages: (next: unknown[]) => {
      messages = next;
    },
  };
}

void test('Empty supervision settles and active work times out without cancelling it', async () => {
  const { controller, data } = fixture();
  const empty = await controller.wait(root, { teamId: team.id, timeoutMs: 0 });
  assert.equal(empty.reason, 'settled');
  assert.equal(empty.timedOut, false);
  data.collab_agent.push(agent('a', '/root/a'));
  data.collab_intent.push(intent('task-a', 'a', 'queued'));
  const pending = await controller.wait(root, { teamId: team.id, timeoutMs: 0 });
  assert.equal(pending.reason, 'timeout');
  assert.equal(pending.timedOut, true);
  assert.equal(pending.supervision.queuedTasks.length, 1);
  assert.equal((data.collab_intent[0] as TaskIntentRecord).state, 'queued');
});

void test('Abort takes priority over interaction, message and blocked state', async () => {
  const a = { ...agent('a', '/root/a'), lifecycle: 'paused' as const };
  const { controller, setMessages } = fixture({
    collab_agent: [a],
    runtime: [runtime('a')],
    interaction: [interaction('approval')],
  });
  setMessages([{ id: 'message', body: {}, agentId: 'a', type: 'MESSAGE' }]);
  const abort = new AbortController();
  abort.abort();
  const result = await controller.wait(
    { ...root, signal: abort.signal },
    { teamId: team.id, timeoutMs: 0 },
  );
  assert.equal(result.reason, 'aborted');
  assert.equal(result.timedOut, false);
  assert.equal(result.pendingInteractions.length, 1);
  assert.equal(result.messages.length, 1);
});

void test('An unresolved approval survives cursor advancement and disappears on resolution or expiry', async () => {
  const approval = interaction('approval');
  const { controller, data, setMessages } = fixture({
    collab_agent: [agent('a', '/root/a')],
    runtime: [runtime('a')],
    interaction: [approval],
    collab_intent: [intent('task-a', 'a', 'queued')],
  });
  setMessages([{ id: 'notice', body: { interactionId: approval.id }, type: 'INPUT_REQUIRED' }]);
  const first = await controller.wait(root, { teamId: team.id, timeoutMs: 0 });
  assert.equal(first.reason, 'input_required');
  setMessages([]);
  const afterCursor = await controller.wait(root, {
    teamId: team.id,
    cursor: first.nextCursor,
    timeoutMs: 0,
  });
  assert.equal(afterCursor.reason, 'input_required');
  assert.equal(afterCursor.pendingInteractions[0]?.interactionId, approval.id);
  approval.state = 'responded';
  assert.equal((await controller.wait(root, { teamId: team.id, timeoutMs: 0 })).reason, 'timeout');
  approval.state = 'pending';
  approval.expiresAt = '2000-01-01T00:00:00Z';
  assert.deepEqual(
    (await controller.wait(root, { teamId: team.id, timeoutMs: 0 })).pendingInteractions,
    [],
  );
  approval.expiresAt = '2099-01-01T00:00:00Z';
  approval.connectionGeneration = 1;
  assert.deepEqual(
    (await controller.wait(root, { teamId: team.id, timeoutMs: 0 })).pendingInteractions,
    [],
  );
  assert.equal(data.interaction.length, 1);
});

void test('Root, parent and sibling receive only their visible current approvals', async () => {
  const a = agent('a', '/root/a');
  const sibling = agent('b', '/root/b');
  const child = agent('child', '/root/a/child', a.id);
  const approval = { ...interaction('approval'), runtimeId: 'runtime-child' };
  const { controller } = fixture({
    collab_agent: [a, sibling, child],
    runtime: [runtime('a'), runtime('b'), runtime('child')],
    interaction: [approval],
    collab_intent: [intent('child-task', child.id, 'queued')],
  });
  const parent = { ...root, collaborationMember: { teamId: team.id, agentId: a.id } };
  const brother = { ...root, collaborationMember: { teamId: team.id, agentId: sibling.id } };
  assert.equal(
    (await controller.wait(root, { teamId: team.id, timeoutMs: 0 })).pendingInteractions.length,
    1,
  );
  const parentResult = await controller.wait(parent, { timeoutMs: 0 });
  assert.equal(parentResult.pendingInteractions.length, 1);
  assert.deepEqual(parentResult.pendingInteractions[0]?.delegableOptionIds, ['reject']);
  assert.match(
    parentResult.pendingInteractions[0].nextAction.instruction,
    /批准超出委托范围.*外部 root/,
  );
  assert.equal(parentResult.supervision.unfinishedTasks.length, 1);
  const siblingResult = await controller.wait(brother, { timeoutMs: 0 });
  assert.equal(siblingResult.reason, 'settled');
  assert.deepEqual(siblingResult.pendingInteractions, []);
  assert.deepEqual(siblingResult.supervision.unfinishedTasks, []);
});

void test('A member excludes its own work and cannot read a grandchild approval body', async () => {
  const a = agent('a', '/root/a');
  const child = agent('child', '/root/a/child', a.id);
  const grandchild = agent('grandchild', '/root/a/child/grandchild', child.id);
  const own = interaction('own');
  const distant = { ...interaction('distant'), runtimeId: 'runtime-grandchild' };
  const { controller } = fixture({
    collab_agent: [a, child, grandchild],
    collab_intent: [
      intent('own-task', a.id, 'queued'),
      intent('grandchild-task', grandchild.id, 'queued'),
    ],
    runtime: [runtime('a'), runtime('child'), runtime('grandchild')],
    interaction: [own, distant],
  });
  const result = await controller.wait(
    { ...root, collaborationMember: { teamId: team.id, agentId: a.id } },
    { timeoutMs: 0 },
  );
  assert.deepEqual(result.pendingInteractions, []);
  assert.deepEqual(
    result.supervision.unfinishedTasks.map((task) => task.intentId),
    ['grandchild-task'],
  );
});

void test('Host permission guidance names the permitted decision for either delegation result', async () => {
  const parent = agent('a', '/root/a');
  const child = agent('child', '/root/a/child', parent.id);
  const host = {
    ...interaction('host'),
    type: 'host_permission' as const,
    runtimeId: 'runtime-child',
    request: { operation: 'execute' },
  };
  const ctx = { ...root, collaborationMember: { teamId: team.id, agentId: parent.id } };
  const records = {
    collab_agent: [parent, child],
    runtime: [runtime('a'), runtime('child')],
    interaction: [host],
  };
  const denied = await fixture(records).controller.wait(ctx, { timeoutMs: 0 });
  assert.ok(denied.pendingInteractions[0]);
  assert.equal(denied.pendingInteractions[0].mayApproveHost, false);
  assert.match(denied.pendingInteractions[0].nextAction.instruction, /allow:false.*外部 root/);
  const allowed = await fixture(records, true).controller.wait(ctx, { timeoutMs: 0 });
  assert.ok(allowed.pendingInteractions[0]);
  assert.equal(allowed.pendingInteractions[0].mayApproveHost, true);
  assert.match(allowed.pendingInteractions[0].nextAction.instruction, /allow:true\|false/);
});

void test('A new message precedes settled and preserves pagination state', async () => {
  const { controller, setMessages } = fixture();
  setMessages([{ id: 'message', body: { text: 'hello' }, type: 'MESSAGE' }]);
  const result = await controller.wait(root, { teamId: team.id, timeoutMs: 0 });
  assert.equal(result.reason, 'message');
  assert.equal(result.timedOut, false);
  assert.equal(result.nextCursor, 'cursor');
  assert.equal((result.messages[0] as unknown as { text: string }).text, 'hello');
});

void test('A concurrent state change rebuilds the reason and returned supervision together', async () => {
  const task = intent('changing', 'a', 'queued');
  const { controller, data, advanceStamp } = fixture({
    collab_agent: [agent('a', '/root/a')],
    collab_intent: [task],
    collab_outbox: [{ id: task.id, work: { state: 'completed' } }],
  });
  const mailbox = controller.storage.mailbox.bind(controller.storage);
  let changed = false;
  controller.storage.mailbox = (...args) => {
    if (!changed) {
      changed = true;
      task.state = 'settled';
      advanceStamp();
    }
    return mailbox(...args);
  };
  const result = await controller.wait(root, { teamId: team.id, timeoutMs: 0 });
  assert.equal(result.reason, 'settled');
  assert.deepEqual(result.supervision.unfinishedTasks, []);
  assert.equal(result.supervision.completedTasks, 1);
  assert.equal(data.collab_intent.length, 1);
});

void test('Partial completion, pause, task failure and acceptance failure remain visible', async () => {
  const a = agent('a', '/root/a');
  const b = { ...agent('b', '/root/b'), lifecycle: 'paused' as const, queuePaused: true };
  const finished = intent('done', a.id, 'settled');
  const failed = intent('failed', a.id, 'settled');
  const waiting = intent('waiting', b.id, 'queued');
  const { controller } = fixture({
    collab_agent: [a, b],
    collab_intent: [finished, failed, waiting],
    collab_outbox: [
      { id: 'done', work: { state: 'completed' } },
      { id: 'failed', work: { state: 'failed' } },
    ],
    collab_message: [{ id: 'msg_done', body: { acceptance: { status: 'failed', checks: [] } } }],
  });
  const result = await controller.wait(root, { teamId: team.id, timeoutMs: 0 });
  assert.equal(result.reason, 'blocked');
  assert.equal(result.supervision.queuedTasks.length, 1);
  assert.deepEqual(
    result.supervision.failedTasks.map((task) => task.intentId),
    ['done', 'failed'],
  );
  assert.equal(result.timedOut, false);
});
