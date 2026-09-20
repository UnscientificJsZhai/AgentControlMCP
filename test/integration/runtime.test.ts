import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, until, completed } from '../helpers/harness.js';
import { id } from '../../src/domain/ids.js';
import type { RuntimeRecord, SessionRecord, WorkRecord } from '../../src/domain/models.js';

void test(
  'AC-002/003/009/010/023 REV-002: 全部稳定更新、幂等、并发控制与真实取消',
  { timeout: 40_000 },
  async () => {
    const h = await harness();
    try {
      const session = await h.session();
      const args = {
        sessionId: session.sessionId,
        prompt: [{ type: 'text' as const, text: 'slow large' }],
        idempotencyKey: id('submit'),
      };
      const accepted = await h.app.tasks.submit(h.alice, args);
      const same = await h.app.tasks.submit(h.alice, args);
      assert.equal(same.taskId, accepted.taskId);
      await assert.rejects(
        h.app.tasks.submit(h.alice, { ...args, idempotencyKey: id('different') }),
        { code: 'SESSION_BUSY' },
      );
      await until(
        async () => (await h.app.sessions.get(h.alice, session.sessionId)).commands.length > 0,
      );
      const waiting = await h.app.tasks.wait(h.alice, { taskId: accepted.taskId, timeoutMs: 10 });
      assert.equal(waiting.timedOut, true);
      let current = await h.app.sessions.get(h.alice, session.sessionId);
      await h.app.sessions.setMode(h.alice, {
        sessionId: current.id,
        modeId: 'code',
        expectedRevision: current.revision,
        idempotencyKey: id('mode'),
      });
      current = await h.app.sessions.get(h.alice, current.id);
      await h.app.sessions.setOption(h.alice, {
        sessionId: current.id,
        optionId: 'thinking',
        value: true,
        expectedRevision: current.revision,
        idempotencyKey: id('option'),
      });
      const cancel = await h.app.tasks.cancel(h.alice, accepted.taskId);
      assert.ok(['cancelling', 'cancelled'].includes(cancel.state));
      assert.equal((await h.taskDone(accepted.taskId)).state, 'cancelled');
      const events = await h.app.events.read(session.sessionId, { taskId: accepted.taskId });
      for (const kind of [
        'user_message_chunk',
        'agent_message_chunk',
        'agent_thought_chunk',
        'tool_call',
        'tool_call_update',
        'plan',
        'available_commands_update',
        'current_mode_update',
        'config_option_update',
        'session_info_update',
        'usage_update',
      ])
        assert.ok(
          events.items.some((event) => event.kind === kind),
          kind,
        );
      assert.ok(
        events.items.some(
          (event) => (event.payload as { representation?: string }).representation === 'resource',
        ),
      );
      assert.equal(
        (
          await h.app.events.read(session.sessionId, {
            cursor: events.nextCursor,
            taskId: accepted.taskId,
          })
        ).items.length,
        0,
      );
      const log = await readFile(join(h.path, 'audit.jsonl'), 'utf8');
      assert.equal(
        log.split('\n').filter((line) => line.includes('"method":"session/prompt"')).length,
        1,
      );
      await h.app.configs.update(h.alice, {
        configId: h.registered.configId,
        expectedRevision: 1,
        patch: { name: '新配置' },
        idempotencyKey: id('update'),
      });
      assert.equal(
        (await h.app.sessions.get(h.alice, session.sessionId)).snapshot.name,
        '独立 ACP fixture',
      );
    } finally {
      await h.cleanup();
    }
  },
);

void test(
  'AC-007/018/020/026: 待审批移交、迟到答复拒绝、并发幂等答复',
  { timeout: 35_000 },
  async () => {
    const h = await harness();
    try {
      const session = await h.session();
      const task = await h.app.tasks.submit(h.alice, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'permission' }],
        idempotencyKey: id('task'),
      });
      const permission = await until(
        async () => (await h.app.interactions.list(h.alice, { taskId: task.taskId }, true))[0],
      );
      await assert.rejects(h.app.tasks.get(h.bob, task.taskId), { code: 'SESSION_NOT_FOUND' });
      // 审批回调可先于前面的通知落盘；等通知更新完会话修订后再准备移交，避免误用旧修订。
      const runtime = await h.app.runtimes.get(h.alice, session.runtimeId);
      await h.app.runtimes.handle(runtime).client.barrier();
      const before = await h.app.sessions.get(h.alice, session.sessionId);
      await h.app.sessions.ownership(h.alice, 'transfer', {
        sessionId: before.id,
        targetPrincipalId: h.bob.principalId,
        expectedRevision: before.revision,
        idempotencyKey: id('transfer'),
      });
      const args = {
        interactionId: permission.id,
        expectedRevision: permission.revision,
        idempotencyKey: id('permission'),
        decision: { kind: 'acp_option' as const, optionId: 'once' },
      };
      await assert.rejects(h.app.interactions.respondPermission(h.alice, args), {
        code: 'SESSION_NOT_FOUND',
      });
      const responses = await Promise.all([
        h.app.interactions.respondPermission(h.bob, args),
        h.app.interactions.respondPermission(h.bob, args),
      ]);
      assert.deepEqual(responses[0], responses[1]);
      completed(await h.taskDone(task.taskId, h.bob));
      assert.equal((await h.app.sessions.get(h.bob, before.id)).runtimeId, before.runtimeId);
      const issued = await h.app.identities.create('auth');
      const auth = await h.app.identities.authenticate(`Bearer ${issued.token}`);
      assert.equal(auth.principalId, issued.principalId);
      await h.app.identities.revoke(issued.credentialId);
      await assert.rejects(h.app.identities.check(auth), { code: 'UNAUTHENTICATED' });
    } finally {
      await h.cleanup();
    }
  },
);

void test('REV-001: 连接内认证复用和 bound 后取消仲裁', { timeout: 35_000 }, async () => {
  const h = await harness('http', { FIXTURE_REQUIRE_AUTH: '1' });
  try {
    h.app.attachedChannels.add(h.alice.principalId);
    const runtime = await h.operation<RuntimeRecord & { runtimeId: string }>(
      h.app.runtimes.prepare(h.alice, {
        configId: h.registered.configId,
        interactionChannel: 'local_cli',
        idempotencyKey: id('prep'),
      }),
    );
    const failed = await h.app.sessions.create(h.alice, {
      runtimeId: runtime.id,
      expectedRuntimeRevision: runtime.revision,
      expectedConnectionGeneration: 1,
      idempotencyKey: id('unauth'),
    });
    const failure = await until(async () => {
      const op = await h.app.operations.get(h.alice, failed.operationId);
      return op.state === 'failed' ? op : null;
    });
    assert.equal(failure.error?.code, 'AUTH_REQUIRED');
    let current = await h.app.runtimes.get(h.alice, runtime.id);
    const pid = current.pid;
    await h.operation(
      h.app.auth.authenticate(h.alice, {
        runtimeId: current.id,
        expectedRevision: current.revision,
        expectedConnectionGeneration: 1,
        methodId: 'memory',
        interactionChannel: 'local_cli',
        idempotencyKey: id('auth'),
      }),
    );
    current = await h.app.runtimes.get(h.alice, current.id);
    const created = await h.app.sessions.create(h.alice, {
      runtimeId: current.id,
      expectedRuntimeRevision: current.revision,
      expectedConnectionGeneration: 1,
      idempotencyKey: id('created'),
    });
    const bound = await h.operation<SessionRecord & { sessionId: string }>(created);
    assert.equal((await h.app.runtimes.get(h.alice, current.id)).pid, pid);
    const cancelled = await h.app.operations.cancel(h.alice, created.operationId);
    assert.equal(cancelled.commitState, 'committed');
    assert.equal(cancelled.state, 'completed');
    const task = await h.app.tasks.submit(h.alice, {
      sessionId: bound.id,
      prompt: [{ type: 'text', text: 'ok' }],
      idempotencyKey: id('test'),
    });
    completed(await h.taskDone(task.taskId));
  } finally {
    await h.cleanup();
  }
});

void test('AC-004/025: 只读自动批准，文件和终端真实回调', { timeout: 35_000 }, async () => {
  const h = await harness();
  try {
    const policy = {
      rules: [
        {
          id: 'test-explicit',
          effect: 'allow_once' as const,
          operations: ['write' as const, 'read' as const],
          roots: [h.path],
        },
        {
          id: 'test-node',
          effect: 'allow_once' as const,
          operations: ['execute' as const],
          roots: [h.path],
          command: { executable: process.execPath, args: ['-e', 'console.log("terminal-ok")'] },
        },
      ],
      fallback: 'ask' as const,
      timeoutMs: null,
    };
    await h.app.configs.update(h.alice, {
      configId: h.registered.configId,
      expectedRevision: 1,
      patch: { permissionPolicy: policy },
      idempotencyKey: id('policy'),
    });
    const session = await h.session();
    const task = await h.app.tasks.submit(h.alice, {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'files terminal read-auto' }],
      idempotencyKey: id('task'),
    });
    completed(await h.taskDone(task.taskId));
    assert.equal(
      await readFile(join(h.path, 'output.txt'), 'utf8'),
      await readFile(join(h.path, 'input.txt'), 'utf8'),
    );
    assert.equal((await h.app.interactions.list(h.alice, {}, true)).length, 0);
    const events = await h.app.events.read(session.sessionId, {});
    assert.ok(JSON.stringify(events).includes('terminal-ok'));
  } finally {
    await h.cleanup();
  }
});

void test(
  'REV-004/AC-008/021: load 重放分段清理保留恢复关联并报告游标缺口',
  { timeout: 40_000 },
  async () => {
    const h = await harness();
    try {
      const session = await h.session();
      let current = await h.app.sessions.get(h.alice, session.sessionId);
      await h.operation(
        h.app.sessions.close(h.alice, {
          sessionId: current.id,
          expectedRevision: current.revision,
          idempotencyKey: id('close'),
        }),
      );
      const plan = (await h.app.sessions.restore(h.alice, 'load', {
        phase: 'prepare',
        sessionId: current.id,
        idempotencyKey: id('plan'),
      })) as { restorePlanId: string; environmentDigest: string };
      await h.operation(
        h.app.sessions.restore(h.alice, 'load', {
          phase: 'apply',
          sessionId: current.id,
          restorePlanId: plan.restorePlanId,
          acceptEnvironmentDigest: plan.environmentDigest,
          idempotencyKey: id('restore'),
        }),
      );
      const events = await h.app.events.read(current.id, {});
      assert.equal(events.items.length, 4);
      const replay = events.items[0]!.segmentId!;
      current = await h.app.sessions.get(h.alice, current.id);
      await h.operation(
        h.app.sessions.close(h.alice, {
          sessionId: current.id,
          expectedRevision: current.revision,
          idempotencyKey: id('close'),
        }),
      );
      const cleanup = await h.app.history.plan(h.alice, {
        scope: {
          kind: 'session_events',
          sessionId: current.id,
          selector: { segmentIds: [replay] },
        },
      });
      await h.app.history.apply(h.alice, cleanup.cleanupPlanId, cleanup.planDigest);
      const after = await h.app.events.read(current.id, {});
      assert.equal(after.cursorStatus, 'expired');
      assert.equal(after.missingRanges.length, 1);
      assert.equal(
        (await h.app.sessions.get(h.alice, current.id)).downstreamSessionId,
        current.downstreamSessionId,
      );
      const all = await h.app.store.list<WorkRecord>('task');
      assert.equal(all.length, 0);
    } finally {
      await h.cleanup();
    }
  },
);
