import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, until } from '../helpers/harness.js';
import { createCollaborationTools } from '../../src/transport/mcp/collaboration-tools.js';
import { invoke } from '../../src/transport/mcp/tools.js';
import type { ManagedAgentRecord } from '../../src/domain/collaboration.js';

async function prompts(path: string) {
  const records = (await readFile(join(path, 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          method?: string;
          params?: { sessionId: string; prompt?: { text?: string }[] };
        },
    );
  return records.filter((r) => r.method === 'session/prompt');
}

void test('协作创建、幂等、FIFO 后续任务和结果邮箱走真实 ACP 进程', async () => {
  const h = await harness();
  try {
    const c = h.app.collaboration;
    const args = { requestId: 'spawn-1', taskName: 'review', message: 'first slow' };
    const spawned = await c.spawn(h.alice, args);
    const agentId = spawned.agentId;
    assert.deepEqual(await c.spawn(h.alice, args), spawned);
    await assert.rejects(c.spawn(h.alice, { ...args, message: 'different' }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await until(async () => (await c.view(await c.agent(agentId))).state === 'running');
    await c.followup(h.alice, { requestId: 'follow-1', target: agentId, message: 'second' });
    await c.followup(h.alice, { requestId: 'follow-2', target: agentId, message: 'third' });
    assert.equal((await prompts(h.path)).length, 1);
    await c.stop(h.alice, { requestId: 'interrupt-1', target: agentId });
    await until(async () => (await c.view(await c.agent(agentId))).state === 'idle');
    await c.followup(h.alice, {
      requestId: 'follow-3',
      target: agentId,
      message: 'after interrupt',
    });
    const mail = await until(async () => {
      const page = await c.wait(h.alice, { teamId: spawned.teamId, timeoutMs: 0 });
      return page.messages.some((m) => m.type === 'FINAL_ANSWER') ? page : null;
    });
    assert.equal((await prompts(h.path)).length, 2);
    const reread = await c.wait(h.alice, { teamId: spawned.teamId, timeoutMs: 0 });
    assert.deepEqual(
      reread.messages.map((m) => m.messageId),
      mail.messages.map((m) => m.messageId),
    );
    assert.ok(mail.messages.some((m) => m.type === 'INTERRUPTED'));
    const final = mail.messages.find((m) => m.type === 'FINAL_ANSWER') as unknown as {
      result: { text: string };
    };
    assert.equal(final.result.text, 'fixture:after interrupt');
    const next = await c.wait(h.alice, {
      teamId: spawned.teamId,
      cursor: mail.nextCursor,
      timeoutMs: 0,
    });
    assert.equal(next.messages.length, 0);
    await assert.rejects(c.wait(h.bob, { teamId: spawned.teamId, timeoutMs: 0 }), {
      code: 'OBJECT_NOT_FOUND',
    });
  } finally {
    await h.cleanup();
  }
});

void test('普通消息不启动空闲成员；下一轮携带消息并继续自身会话', async () => {
  const h = await harness();
  try {
    const c = h.app.collaboration;
    const spawned = await c.spawn(h.alice, {
      requestId: 'spawn',
      taskName: 'one',
      message: 'hello',
    });
    await until(async () => (await c.view(await c.agent(spawned.agentId))).state === 'idle');
    const agent = await c.agent(spawned.agentId);
    await c.send(h.alice, { requestId: 'message', target: agent.id, message: 'explicit context' });
    await c.scheduler.tick();
    assert.equal((await prompts(h.path)).length, 1);
    await c.followup(h.alice, { requestId: 'next', target: agent.id, message: 'continue' });
    await until(
      async () =>
        (await c.storage.intents(agent.id)).filter((i) => i.state === 'settled').length === 2,
    );
    const sent = await prompts(h.path);
    assert.equal(sent.length, 2);
    assert.equal(sent[0]!.params?.sessionId, sent[1]!.params?.sessionId);
    assert.match(JSON.stringify(sent[1]), /explicit context/);
    await assert.rejects(
      h.app.tasks.submit(h.alice, {
        sessionId: agent.sessionId!,
        prompt: [{ type: 'text', text: 'bypass' }],
        idempotencyKey: 'bypass',
      }),
      { code: 'AGENT_MANAGED' },
    );
  } finally {
    await h.cleanup();
  }
});

void test('协作工具拒绝空消息输入，团队游标隔离', async () => {
  const h = await harness();
  try {
    const definitions = createCollaborationTools(h.app);
    const response = await invoke(h.app, definitions, h.alice, 'spawn_agent', {
      requestId: 'bad',
      taskName: 'one',
      message: '   ',
    });
    assert.equal(response.ok, false);
    const first = await h.app.collaboration.spawn(h.alice, {
      requestId: 'a',
      taskName: 'same',
      message: 'first team',
    });
    const second = await h.app.collaboration.spawn(h.alice, {
      requestId: 'b',
      taskName: 'same',
      message: 'second team',
    });
    assert.notEqual(first.teamId, second.teamId);
    const mail = await h.app.collaboration.wait(h.alice, { teamId: first.teamId, timeoutMs: 0 });
    await assert.rejects(
      h.app.collaboration.wait(h.alice, {
        teamId: second.teamId,
        cursor: mail.nextCursor,
        timeoutMs: 0,
      }),
      { code: 'CURSOR_EXPIRED' },
    );
  } finally {
    await h.cleanup();
  }
});

void test('大结果只包含可见回答，分页能完整还原', async () => {
  const h = await harness();
  try {
    const c = h.app.collaboration;
    const spawned = await c.spawn(h.alice, {
      requestId: 'large',
      taskName: 'large_result',
      message: 'large output',
    });
    await until(async () => (await c.storage.intents(spawned.agentId))[0]?.state === 'settled');
    let cursor: string | undefined;
    const chunks: Buffer[] = [];
    let completed = false;
    for (let step = 0; step < 100; step++) {
      const page = (await c.list(h.alice, {
        target: spawned.agentId,
        detail: 'output',
        cursor,
      })) as { data: string; nextCursor: string; eof: boolean };
      chunks.push(Buffer.from(page.data, 'base64'));
      if (page.eof) {
        completed = true;
        break;
      }
      cursor = page.nextCursor;
    }
    assert.ok(completed, '分页应当在保护轮次内正常到达 EOF');
    const result = JSON.parse(Buffer.concat(chunks).toString()) as {
      text: string;
      contentComplete: boolean;
    };
    assert.ok(result.text.length > 50000);
    assert.ok(result.text.includes('大'));
    assert.equal(result.contentComplete, true);
  } finally {
    await h.cleanup();
  }
});

void test('原连接认证完成后创建会话，取消强杀后显式恢复不会重放旧 prompt', async () => {
  const h = await harness('http', { FIXTURE_REQUIRE_AUTH: '1', FIXTURE_IGNORE_CANCEL: '1' });
  try {
    const c = h.app.collaboration;
    const spawned = await c.spawn(h.alice, {
      requestId: 'auth',
      taskName: 'auth',
      message: 'slow task',
    });
    await until(async () => (await c.agent(spawned.agentId)).authRequired);
    await c.respond(h.alice, {
      requestId: 'login',
      target: spawned.agentId,
      action: 'reply',
      authMethodId: 'memory',
    });
    await until(async () => (await c.view(await c.agent(spawned.agentId))).state === 'running');
    await c.stop(h.alice, { requestId: 'stop', target: spawned.agentId });
    await until(
      async () => (await c.view(await c.agent(spawned.agentId))).state === 'needs_recovery',
    );
    const plan = (await c.respond(h.alice, {
      requestId: 'prepare',
      target: spawned.agentId,
      action: 'prepare_restore',
    })) as { planId: string; environmentDigest: string };
    await c.respond(h.alice, {
      requestId: 'apply',
      target: spawned.agentId,
      action: 'reply',
      planId: plan.planId,
      acceptEnvironmentDigest: plan.environmentDigest,
    });
    await until(async () => (await c.agent(spawned.agentId)).authRequired);
    assert.equal((await prompts(h.path)).length, 1);
    const agent = await h.app.store.get<ManagedAgentRecord>('collab_agent', spawned.agentId);
    assert.ok(agent?.runtimeId);
    await c.respond(h.alice, {
      requestId: 'login-again',
      target: spawned.agentId,
      action: 'reply',
      authMethodId: 'memory',
    });
    await until(
      async () => (await c.view(await c.agent(spawned.agentId))).state === 'needs_recovery',
    );
    const second = (await c.respond(h.alice, {
      requestId: 'prepare-again',
      target: spawned.agentId,
      action: 'prepare_restore',
    })) as { planId: string; environmentDigest: string };
    await c.respond(h.alice, {
      requestId: 'apply-again',
      target: spawned.agentId,
      action: 'reply',
      planId: second.planId,
      acceptEnvironmentDigest: second.environmentDigest,
    });
    await until(async () => (await c.view(await c.agent(spawned.agentId))).state === 'idle');
    assert.equal((await prompts(h.path)).length, 1);
    await c.followup(h.alice, {
      requestId: 'fresh-task',
      target: spawned.agentId,
      message: 'new explicit work',
    });
    await until(async () => (await prompts(h.path)).length === 2);
  } finally {
    await h.cleanup();
  }
});

void test('忙碌成员的两个后续轮次严格 FIFO，后续会话不会合并 prompt', async () => {
  const h = await harness();
  try {
    const c = h.app.collaboration;
    const member = await c.spawn(h.alice, {
      requestId: 'fifo',
      taskName: 'fifo',
      message: 'brief first',
    });
    await until(async () => (await c.view(await c.agent(member.agentId))).state === 'running');
    await c.followup(h.alice, { requestId: 'two', target: member.agentId, message: 'second' });
    await c.followup(h.alice, { requestId: 'three', target: member.agentId, message: 'third' });
    await until(
      async () =>
        (await c.storage.intents(member.agentId)).filter((i) => i.state === 'settled').length === 3,
    );
    assert.deepEqual(
      (await prompts(h.path)).map((p) => p.params?.prompt?.[0]?.text),
      ['brief first', 'second', 'third'],
    );
  } finally {
    await h.cleanup();
  }
});
