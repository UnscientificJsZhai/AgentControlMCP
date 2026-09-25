import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, until } from '../helpers/harness.js';
import { createMcpTools } from '../../src/transport/mcp/catalog.js';
import { invoke } from '../../src/transport/mcp/tools.js';
import type {
  AcceptanceResult,
  BridgeCallEvidence,
  MessageRecord,
} from '../../src/domain/collaboration.js';
import { bindingSchema, bridgeRequest } from '../../src/transport/collaboration/ipc.js';

interface Completion {
  taskId: string;
  intentId: string;
  configId: string;
  state: string;
  completionScope: string;
  acceptance: AcceptanceResult;
  result: { bridgeCalls: BridgeCallEvidence[] };
}

void test('新增注册失败不产生 profile；修正后固定 configId，旧配置不能满足新配置验收', async () => {
  const h = await harness();
  try {
    const definitions = createMcpTools(h.app);
    const original = (await h.app.configs.get(h.registered.configId)).config;
    const config = {
      name: 'extra',
      origin: { kind: 'manual' },
      launch: original.launch,
      cwd: h.path,
    };
    const failed = await invoke(h.app, definitions, h.alice, 'setup_agent', {
      action: 'register',
      arguments: {
        config: { ...config, permissionPolicy: { fallback: 'ask' } },
        idempotencyKey: 'extra',
      },
    });
    assert.equal(failed.ok, false);
    assert.equal((await h.app.configs.list()).length, 1);
    const registered = await invoke(h.app, definitions, h.alice, 'setup_agent', {
      action: 'register',
      arguments: { config, idempotencyKey: 'extra' },
    });
    assert.ok(registered.ok, JSON.stringify(registered));
    const { configId } = registered.data as { configId: string };
    assert.notEqual(configId, h.registered.configId);
    assert.equal((await h.app.configs.list()).length, 2);
    assert.equal((await h.app.configs.get(configId)).config.permissionPolicy.timeoutMs, null);
    const c = h.app.collaboration;
    const oversized = 'x'.repeat(8 * 1024 ** 2);
    await assert.rejects(
      c.spawn(h.alice, {
        requestId: 'too-large',
        taskName: 'too_large',
        message: oversized,
        completionCriteria: { requiredMessage: { target: '/root', text: oversized } },
      }),
      { code: 'CONFIG_INVALID' },
    );
    assert.equal((await h.app.store.list('collab_agent')).length, 0);
    const args = {
      requestId: 'extra',
      taskName: 'extra',
      message: 'EXTRA_READY 42',
      profile: h.registered.configId,
      completionCriteria: { configId },
    };
    await assert.rejects(c.spawn(h.alice, args), { code: 'PROFILE_MISMATCH' });
    assert.equal((await h.app.store.list('collab_agent')).length, 0);
    const spawned = await c.spawn(h.alice, { ...args, profile: configId });
    assert.equal(spawned.configId, configId);
    const state = await until(async () => {
      const value = await c.view(await c.agent(spawned.agentId));
      return value.lastRun?.acceptance ? value : null;
    });
    assert.equal(state.configId, configId);
    assert.equal(state.lastRun?.acceptance?.status, 'passed');
    await assert.rejects(
      c.followup(h.alice, {
        requestId: 'wrong-followup',
        target: spawned.agentId,
        message: '不能使用旧配置验收',
        completionCriteria: { configId: h.registered.configId },
      }),
      { code: 'PROFILE_MISMATCH' },
    );
  } finally {
    await h.cleanup();
  }
});

void test(
  '本轮 Bridge MESSAGE 才通过验收，旧轮次、原生 root 活动和最终回答均不能替代',
  { timeout: 30000 },
  async () => {
    const h = await harness('http', { FIXTURE_BRIDGE: '1' });
    try {
      const c = h.app.collaboration;
      const criteria = {
        configId: h.registered.configId,
        requiredMessage: { target: '/root' as const, text: 'READY 42' },
      };
      const spawned = await c.spawn(h.alice, {
        requestId: 'send',
        taskName: 'sender',
        message: 'bridge-message READY 42',
        completionCriteria: criteria,
      });
      const first = await until(async () => {
        const page = await c.wait(h.alice, { teamId: spawned.teamId, timeoutMs: 0 });
        return page.messages.some((m) => m.type === 'FINAL_ANSWER') ? page : null;
      });
      const message = first.messages.find((m) => m.type === 'MESSAGE')!;
      const final = first.messages.find((m) => m.type === 'FINAL_ANSWER') as unknown as Completion;
      assert.equal(message.channel, 'agent_collaboration');
      assert.equal(message.taskId, final.taskId);
      assert.equal(message.intentId, final.intentId);
      assert.equal(final.acceptance.status, 'passed');
      assert.equal(final.configId, h.registered.configId);
      const output = (await c.list(h.alice, {
        target: spawned.agentId,
        detail: 'output',
      })) as unknown as {
        acceptance: AcceptanceResult;
        result: { bridgeCalls: BridgeCallEvidence[] };
      };
      assert.equal(output.acceptance.status, 'passed');
      assert.ok(
        output.result.bridgeCalls.some(
          (call) =>
            call.tool === 'acm_send_message' &&
            call.outcome === 'succeeded' &&
            call.messageId === message.messageId,
        ),
      );
      let cursor = first.nextCursor;
      for (const [requestId, text] of [
        ['native', 'native-message READY 42'],
        ['text', 'READY 42'],
      ] as const) {
        await c.followup(h.alice, {
          requestId,
          target: spawned.agentId,
          message: text,
          completionCriteria: criteria,
        });
        const page = await until(async () => {
          const value = await c.wait(h.alice, { teamId: spawned.teamId, cursor, timeoutMs: 0 });
          return value.messages.some((m) => m.type === 'RUN_FAILED') ? value : null;
        });
        const failed = page.messages.find((m) => m.type === 'RUN_FAILED') as unknown as Completion;
        assert.equal(failed.state, 'completed');
        assert.equal(failed.completionScope, 'acp_turn');
        assert.equal(failed.acceptance.status, 'failed');
        assert.deepEqual((failed.result as { bridgeCalls: unknown[] }).bridgeCalls, []);
        assert.equal((await c.view(await c.agent(spawned.agentId))).queuePaused, true);
        cursor = page.nextCursor;
      }
      const audit = await readFile(join(h.path, 'audit.jsonl'), 'utf8');
      assert.match(audit, /agent_collaboration\.acm_send_message/);
      assert.match(audit, /外部上游调用者/);
      assert.match(audit, /acm_list_agents/);
    } finally {
      await h.cleanup();
    }
  },
);

void test('仅连接 Bridge 并输出 READY 的完成轮次仍然验收失败', async () => {
  const h = await harness('http', { FIXTURE_BRIDGE: '1' });
  try {
    const c = h.app.collaboration;
    const spawned = await c.spawn(h.alice, {
      requestId: 'connected',
      taskName: 'connected',
      message: 'READY',
      completionCriteria: { requiredMessage: { target: '/root', text: 'READY' } },
    });
    const page = await until(async () => {
      const value = await c.wait(h.alice, { teamId: spawned.teamId, timeoutMs: 0 });
      return value.messages.some((m) => m.type === 'RUN_FAILED') ? value : null;
    });
    assert.equal((await c.agent(spawned.agentId)).bridge, 'connected');
    assert.equal(page.messages.filter((m) => m.type === 'MESSAGE').length, 0);
    assert.equal((page.messages[0] as unknown as Completion).acceptance.status, 'failed');
  } finally {
    await h.cleanup();
  }
});

void test('迟到的 Bridge 调用固定归属原轮次，不能借下一轮的 activeTaskId 通过验收', async () => {
  const h = await harness();
  let release = () => {};
  let finishFirst = () => {};
  let finishSecond = () => {};
  try {
    const c = h.app.collaboration;
    // 显式控制两轮终态，避免依赖 fixture 的短时延或机器运行速度。
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    const finish = h.app.tasks.finish.bind(h.app.tasks);
    let firstTaskId: string | undefined;
    h.app.tasks.finish = async (taskId, patch) => {
      firstTaskId ??= taskId;
      await (taskId === firstTaskId ? firstGate : secondGate);
      return finish(taskId, patch);
    };
    const spawned = await c.spawn(h.alice, {
      requestId: 'first',
      taskName: 'delayed',
      message: 'first',
    });
    const first = await until(async () => {
      const view = await c.view(await c.agent(spawned.agentId));
      return view.state === 'running' ? view.lastRun : null;
    });
    const binding = bindingSchema.parse(
      JSON.parse(
        await readFile(join(h.app.paths.runtimeDir, `member-${spawned.agentId}.json`), 'utf8'),
      ) as unknown,
    );
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived = () => {};
    const captured = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const send = c.send.bind(c);
    c.send = async (ctx, args) => {
      arrived();
      await gate;
      return send(ctx, args);
    };
    const pending = bridgeRequest(binding, 'send_message', {
      requestId: 'late',
      target: '/root',
      message: 'READY',
    });
    await captured;
    await c.followup(h.alice, {
      requestId: 'second',
      target: spawned.agentId,
      message: 'next',
      completionCriteria: { requiredMessage: { target: '/root', text: 'READY' } },
    });
    finishFirst();
    const second = await until(async () => {
      const view = await c.view(await c.agent(spawned.agentId));
      return view.state === 'running' && view.lastRun?.intentId !== first.intentId
        ? view.lastRun
        : null;
    });
    release();
    assert.equal(((await pending) as { ok: boolean }).ok, true);
    const sent = (await h.app.store.list<MessageRecord>('collab_message')).find(
      (m) => m.type === 'MESSAGE',
    )!;
    assert.equal(sent.taskId, first.taskId);
    assert.equal(sent.intentId, first.intentId);
    finishSecond();
    const page = await until(async () => {
      const value = await c.wait(h.alice, { teamId: spawned.teamId, timeoutMs: 0 });
      return value.messages.some((m) => m.intentId === second.intentId && m.type === 'RUN_FAILED')
        ? value
        : null;
    });
    const failed = page.messages.find(
      (m) => m.intentId === second.intentId,
    ) as unknown as Completion;
    assert.equal(failed.acceptance.status, 'failed');
    assert.deepEqual(failed.result.bridgeCalls, []);
  } finally {
    release();
    finishFirst();
    finishSecond();
    await h.cleanup();
  }
});

void test('过期大消息释放 messageId 附件和验收原文，墓碑保留验收结论', async () => {
  const h = await harness('http', { FIXTURE_BRIDGE: '1' });
  try {
    const c = h.app.collaboration;
    const text = 'x'.repeat(80 * 1024);
    const spawned = await c.spawn(h.alice, {
      requestId: 'large-message',
      taskName: 'retention',
      message: `bridge-message ${text}`,
      completionCriteria: { requiredMessage: { target: '/root', text } },
    });
    const page = await until(async () => {
      const value = await c.wait(h.alice, { teamId: spawned.teamId, timeoutMs: 0 });
      return value.messages.some((m) => m.type === 'FINAL_ANSWER') ? value : null;
    });
    const records = (await h.app.store.list<MessageRecord>('collab_message')).filter(
      (m) => m.teamId === spawned.teamId,
    );
    const sent = records.find((m) => m.type === 'MESSAGE')!;
    const contentId = (sent.body as { contentId: string }).contentId;
    assert.ok(contentId);
    // 外部根没有 ManagedAgentRecord；下游应能以自身 target 读取收到的大消息。
    const incoming = await c.send(h.alice, {
      requestId: 'root-large',
      target: spawned.agentId,
      message: 'incoming'.repeat(12 * 1024),
    });
    const binding = bindingSchema.parse(
      JSON.parse(
        await readFile(join(h.app.paths.runtimeDir, `member-${spawned.agentId}.json`), 'utf8'),
      ) as unknown,
    );
    const incomingPage = (await bridgeRequest(binding, 'list_agents', {
      target: spawned.agentId,
      detail: 'output',
      messageId: incoming.messageId,
    })) as { ok: boolean; data: { data: string } };
    assert.equal(incomingPage.ok, true, JSON.stringify(incomingPage));
    assert.match(Buffer.from(incomingPage.data.data, 'base64').toString(), /incoming/);
    const read = (await c.list(h.alice, {
      target: spawned.agentId,
      detail: 'output',
      messageId: sent.id,
    })) as { data: string };
    assert.ok(Buffer.from(read.data, 'base64').toString().includes('xxxx'));
    await c.wait(h.alice, { teamId: spawned.teamId, cursor: page.nextCursor, timeoutMs: 0 });
    for (const record of records)
      await h.app.store.put('collab_message', { ...record, createdAt: '2020-01-01T00:00:00.000Z' });
    await c.storage.serial.run(spawned.teamId, () => c.storage.retain(spawned.teamId, 30));
    const units = await h.app.store.list<{ unitId: string }>('content_unit');
    assert.equal(
      units.some((unit) => unit.unitId === sent.id),
      false,
    );
    assert.equal(await h.app.store.get('content_ref', `${sent.id}:${contentId}`), null);
    await assert.rejects(stat(join(h.app.paths.contentDir, contentId)), { code: 'ENOENT' });
    const intent = (await c.storage.intents(spawned.agentId))[0]!;
    assert.equal(intent.message, '');
    assert.equal(intent.completionCriteria, undefined);
    const view = await c.view(await c.agent(spawned.agentId));
    assert.equal(view.lastRun?.acceptance?.status, 'passed');
  } finally {
    await h.cleanup();
  }
});
