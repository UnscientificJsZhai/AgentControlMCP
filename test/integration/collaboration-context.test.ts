import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, until } from '../helpers/harness.js';
import { bindingSchema, bridgeRequest } from '../../src/transport/collaboration/ipc.js';

void test('委托冻结父 profile，禁止跨 profile、自己审批及代批父成员未获准的操作', async () => {
  const h = await harness();
  try {
    const c = h.app.collaboration;
    const parent = await c.spawn(h.alice, {
      requestId: 'parent',
      taskName: 'parent',
      message: 'facts',
    });
    await until(async () => (await c.view(await c.agent(parent.agentId))).state === 'idle');
    const config = await h.app.configs.get(h.registered.configId);
    const other = await h.app.configs.register(h.alice, {
      config: { ...config.config, name: '另一权限环境' },
      idempotencyKey: 'other-profile',
    });
    await h.app.configs.update(h.alice, {
      configId: config.id,
      expectedRevision: config.revision,
      patch: { name: '较新版本' },
      idempotencyKey: 'new-revision',
    });
    const caller = {
      ...h.alice,
      collaborationMember: { teamId: parent.teamId, agentId: parent.agentId },
    };
    await assert.rejects(
      c.spawn(caller, {
        requestId: 'denied',
        taskName: 'denied',
        message: 'facts',
        profile: other.configId,
      }),
      { code: 'ACCESS_DENIED' },
    );
    const child = await c.spawn(caller, {
      requestId: 'child',
      taskName: 'child',
      message: 'permission',
    });
    assert.equal((await c.agent(child.agentId)).configRevision, config.revision);
    const pending = await until(async () => {
      const state = await c.view(await c.agent(child.agentId));
      return (state.pending as { interactionId: string }[])[0];
    });
    const reply = {
      requestId: 'approve',
      target: child.agentId,
      action: 'reply' as const,
      interactionId: pending.interactionId,
      decision: { kind: 'acp_option' as const, optionId: 'once' },
    };
    await assert.rejects(c.respond(caller, reply), { code: 'ACCESS_DENIED' });
    const childCaller = {
      ...h.alice,
      collaborationMember: { teamId: parent.teamId, agentId: child.agentId },
    };
    await assert.rejects(c.respond(childCaller, reply), { code: 'ACCESS_DENIED' });
    const runtime = await c.runtimeFor(await c.agent(child.agentId));
    await assert.rejects(h.app.runtimes.get(h.bob, runtime!.id, true), {
      code: 'SESSION_NOT_FOUND',
    });
    await assert.rejects(h.app.runtimes.get(h.alice, runtime!.id, true), { code: 'AGENT_MANAGED' });
    await c.respond(h.alice, reply);
    await until(async () => (await c.storage.intents(child.agentId))[0]?.state === 'settled');
  } finally {
    await h.cleanup();
  }
});

void test(
  'ACP fixture 实际连接 MCP Bridge，创建子孙并发送消息，父历史不自动复制',
  { timeout: 30000 },
  async () => {
    const h = await harness('http', { FIXTURE_BRIDGE: '1' });
    try {
      const c = h.app.collaboration;
      const root = await c.spawn(h.alice, {
        requestId: 'root',
        taskName: 'parent',
        message: 'bridge-spawn-parent PARENT_HISTORY_MARKER_ONLY',
      });
      const members = await until(async () => {
        const members = await c.members(root.teamId);
        return members.length === 3 &&
          (await Promise.all(members.map((a) => c.view(a)))).every((a) => a.state === 'idle')
          ? members
          : null;
      });
      assert.ok(members.every((a) => a.bridge === 'used' || a.bridge === 'connected'));
      const audit = (await readFile(join(h.path, 'audit.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s) as { method?: string; params?: { prompt?: { text: string }[] } });
      const prompts = audit
        .filter((r) => r.method === 'session/prompt')
        .map((r) => r.params!.prompt!.map((b) => b.text).join('\n'));
      assert.equal(prompts.length, 3);
      assert.equal(prompts.filter((s) => s.includes('PARENT_HISTORY_MARKER_ONLY')).length, 1);
      assert.ok(prompts.some((s) => s.startsWith('grandchild explicit facts')));
      const mailbox = await c.wait(h.alice, { teamId: root.teamId, timeoutMs: 0 });
      assert.equal(mailbox.messages.filter((m) => m.type === 'MESSAGE').length, 2);
      const child = members.find((a) => a.parentId === root.agentId)!;
      const binding = bindingSchema.parse(
        JSON.parse(
          await readFile(join(h.app.paths.runtimeDir, `member-${child.id}.json`), 'utf8'),
        ) as unknown,
      );
      const denied = (await bridgeRequest(binding, 'interrupt_agent', {
        requestId: 'self',
        target: child.id,
      })) as { ok: boolean };
      assert.equal(denied.ok, false);
      const other = await c.spawn(h.alice, {
        requestId: 'other',
        taskName: 'same',
        message: 'other team',
      });
      const forbidden = (await bridgeRequest(binding, 'list_agents', { teamId: other.teamId })) as {
        ok: boolean;
      };
      assert.equal(forbidden.ok, false);
      await c.stop(h.alice, { requestId: 'close', target: root.agentId }, true);
      await until(async () => (await c.agent(root.agentId)).lifecycle === 'closed');
      for (const member of await c.members(root.teamId)) assert.equal(member.lifecycle, 'closed');
      const revoked = (await bridgeRequest(binding, 'list_agents', {})) as { ok: boolean };
      assert.equal(revoked.ok, false);
    } finally {
      await h.cleanup();
    }
  },
);

void test('失败轮次也等候尾部通知持久化，明确可见输出范围', async () => {
  const h = await harness();
  try {
    const c = h.app.collaboration;
    const root = await c.spawn(h.alice, {
      requestId: 'error',
      taskName: 'error',
      message: 'prompt-error',
    });
    const mailbox = await until(async () => {
      const page = await c.wait(h.alice, { teamId: root.teamId, timeoutMs: 0 });
      return page.messages.length ? page : null;
    });
    const message = mailbox.messages[0] as unknown as {
      type: string;
      result: { text: string; contentComplete: boolean };
    };
    assert.equal(message.type, 'RUN_FAILED');
    assert.equal(message.result.text, 'firstsecond');
    assert.equal(message.result.contentComplete, true);
  } finally {
    await h.cleanup();
  }
});
