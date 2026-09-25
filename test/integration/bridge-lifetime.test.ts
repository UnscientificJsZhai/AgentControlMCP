import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, until } from '../helpers/harness.js';
import type { Principal, WorkRecord } from '../../src/domain/models.js';
import type { TeamRecord } from '../../src/domain/collaboration.js';
import { bindingSchema, bridgeRequest } from '../../src/transport/collaboration/ipc.js';

async function readBinding(path: string) {
  return bindingSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

async function assertBridgeAccess(
  binding: ReturnType<typeof bindingSchema.parse>,
  allowed: boolean,
) {
  const response = (await bridgeRequest(binding, 'list_agents', {})) as {
    ok: boolean;
    error?: { code: string };
  };
  assert.equal(response.ok, allowed);
  if (!allowed) assert.equal(response.error?.code, 'UNAUTHENTICATED');
}

void test(
  '空闲超过三十分钟后，既有 ACP 会话继续通过原 MCP Bridge 完成后续任务',
  { timeout: 30_000 },
  async (t) => {
    const h = await harness('http', { FIXTURE_BRIDGE: '1' });
    try {
      const c = h.app.collaboration;
      const spawned = await c.spawn(h.alice, {
        requestId: 'before-idle',
        taskName: 'idle',
        message: 'first',
      });
      await until(async () => (await c.storage.intents(spawned.agentId))[0]?.state === 'settled');
      const before = await c.agent(spawned.agentId);
      assert.ok(before.sessionId);
      assert.equal(before.bridge, 'connected');
      const path = join(h.app.paths.runtimeDir, `member-${before.id}.json`);
      const binding = await readBinding(path);
      await assertBridgeAccess(binding, true);

      // 保留时钟持续流逝，轮询仍有可靠的超时边界。
      const realNow = Date.now;
      t.mock.method(Date, 'now', () => realNow() + 31 * 60_000);
      const followup = (await c.followup(h.alice, {
        requestId: 'after-idle',
        target: before.id,
        message: 'bridge-message READY',
        completionCriteria: { requiredMessage: { target: '/root', text: 'READY' } },
      })) as { intentId: string };
      const intent = await until(async () => {
        const intent = (await c.storage.intents(before.id)).find(
          (value) => value.id === followup.intentId,
        );
        return intent?.state === 'settled' ? intent : null;
      });
      assert.ok(intent.taskId);
      const task = await h.app.store.get<WorkRecord>('task', intent.taskId);
      assert.equal(task?.state, 'completed');
      assert.equal((await c.agent(before.id)).sessionId, before.sessionId);
      const page = await until(async () => {
        const page = await c.wait(h.alice, { teamId: spawned.teamId, timeoutMs: 0 });
        return page.messages.some(
          (message) => message.intentId === intent.id && message.type === 'FINAL_ANSWER',
        )
          ? page
          : null;
      });
      const message = page.messages.find(
        (value) => value.intentId === intent.id && value.type === 'MESSAGE',
      );
      assert.equal((message as { text?: string } | undefined)?.text, 'READY');
      assert.equal(message?.channel, 'agent_collaboration');
      assert.equal(message?.taskId, intent.taskId);
      const view = await c.view(await c.agent(before.id));
      assert.equal(view.lastRun?.acceptance?.status, 'passed');
      assert.equal(view.queuePaused, false);
      await assertBridgeAccess(binding, true);

      const audit = (await readFile(join(h.path, 'audit.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              params?: { sessionId?: string };
              bridgeConnected?: string;
            },
        );
      assert.equal(audit.filter((entry) => entry.method === 'session/new').length, 1);
      assert.equal(audit.filter((entry) => entry.bridgeConnected).length, 1);
      const prompts = audit.filter((entry) => entry.method === 'session/prompt');
      assert.equal(prompts.length, 2);
      assert.equal(prompts[0]!.params?.sessionId, prompts[1]!.params?.sessionId);

      await c.stop(h.alice, { requestId: 'close', target: before.id }, true);
      await until(async () => (await c.agent(before.id)).lifecycle === 'closed');
      await assertBridgeAccess(binding, false);
      await assert.rejects(readFile(path), { code: 'ENOENT' });
    } finally {
      t.mock.restoreAll();
      await h.cleanup();
    }
  },
);

void test('替换、换代、撤销和 Runtime 关闭均使旧 Bridge 凭据失效', async () => {
  const h = await harness();
  try {
    const c = h.app.collaboration;
    const spawned = await c.spawn(h.alice, {
      requestId: 'lifetime',
      taskName: 'member',
      message: 'first',
    });
    await until(async () => (await c.storage.intents(spawned.agentId))[0]?.state === 'settled');
    const agent = await c.agent(spawned.agentId);
    const runtime = await c.runtimeFor(agent);
    assert.ok(runtime);
    const ctx = { ...h.alice, managedAgentId: agent.id };
    const path = join(h.app.paths.runtimeDir, `member-${agent.id}.json`);
    const original = await readBinding(path);
    await assertBridgeAccess(original, true);

    await h.app.collaborationIpc.bind(ctx, runtime);
    const replacement = await readBinding(path);
    await assertBridgeAccess(original, false);
    await assertBridgeAccess(replacement, true);

    const nextRuntime = await h.app.runtimes.update(runtime.id, {
      connectionGeneration: runtime.connectionGeneration + 1,
    });
    await assertBridgeAccess(replacement, false);
    await h.app.collaborationIpc.bind(ctx, nextRuntime);
    const nextGeneration = await readBinding(path);
    await assertBridgeAccess(nextGeneration, true);

    await h.app.collaborationIpc.revoke(agent.id);
    await assertBridgeAccess(nextGeneration, false);
    await assert.rejects(readFile(path), { code: 'ENOENT' });

    await h.app.collaborationIpc.bind(ctx, nextRuntime);
    const beforeClose = await readBinding(path);
    await assertBridgeAccess(beforeClose, true);
    await h.app.runtimes.closeNow(runtime.id);
    await assertBridgeAccess(beforeClose, false);
    assert.equal(h.app.runtimes.live.has(runtime.id), false);
  } finally {
    await h.cleanup();
  }
});

void test('Bridge 每次调用仍拒绝其他实例的团队、停用身份和已撤销的上游凭据', async () => {
  const h = await harness();
  try {
    const issued = await h.app.identities.create('Bridge 身份');
    const ctx = await h.app.identities.authenticate(`Bearer ${issued.token}`);
    const c = h.app.collaboration;
    const spawned = await c.spawn(ctx, {
      requestId: 'identity',
      taskName: 'member',
      message: 'first',
    });
    await until(async () => (await c.storage.intents(spawned.agentId))[0]?.state === 'settled');
    const binding = await readBinding(
      join(h.app.paths.runtimeDir, `member-${spawned.agentId}.json`),
    );
    await assertBridgeAccess(binding, true);

    const setInstance = (instanceId: string) =>
      c.storage.serial.run(spawned.teamId, async () => {
        const team = await h.app.store.get<TeamRecord>('collab_team', spawned.teamId);
        assert.ok(team);
        await h.app.store.put('collab_team', {
          ...team,
          instanceId,
          revision: team.revision + 1,
        });
      });
    await setInstance('other-instance');
    await assertBridgeAccess(binding, false);
    await setInstance(h.app.instanceId);
    await assertBridgeAccess(binding, true);

    const principal = await h.app.store.get<Principal>('principal', issued.principalId);
    assert.ok(principal);
    await h.app.store.put('principal', {
      ...principal,
      enabled: false,
      revision: principal.revision + 1,
    });
    await assertBridgeAccess(binding, false);
    await h.app.store.put('principal', { ...principal, revision: principal.revision + 2 });
    await assertBridgeAccess(binding, true);
    await h.app.identities.revoke(issued.credentialId);
    await assertBridgeAccess(binding, false);
  } finally {
    await h.cleanup();
  }
});
