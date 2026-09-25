import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Container } from '../../src/bootstrap/container.js';
import { harness, until } from '../helpers/harness.js';
import { completionRows } from '../../src/application/collaboration/store.js';
import type { WorkRecord } from '../../src/domain/models.js';
import type { Transaction } from '../../src/infrastructure/storage/protocol.js';
import type { CompletionRecord, MessageRecord } from '../../src/domain/collaboration.js';

void test('恢复受理原子保存公开响应，失败可重试且不同请求不能重复恢复', async (t) => {
  const h = await harness();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const c = h.app.collaboration;
    const member = await c.spawn(h.alice, {
      requestId: 'member',
      taskName: 'restore',
      message: 'once',
    });
    await until(async () =>
      (await c.storage.intents(member.agentId)).some((intent) => intent.state === 'settled'),
    );
    await h.app.runtimes.closeNow((await c.agent(member.agentId)).runtimeId!);
    await until(
      async () => (await c.view(await c.agent(member.agentId))).state === 'needs_recovery',
    );
    const plan = (await c.respond(h.alice, {
      requestId: 'plan',
      target: member.agentId,
      action: 'prepare_restore',
    })) as { planId: string; environmentDigest: string };
    const args = {
      requestId: 'apply',
      target: member.agentId,
      action: 'reply' as const,
      planId: plan.planId,
      acceptEnvironmentDigest: plan.environmentDigest,
    };
    const prepare = h.app.runtimes.prepareNow.bind(h.app.runtimes);
    t.mock.method(h.app.runtimes, 'prepareNow', async (...params: Parameters<typeof prepare>) => {
      await gate;
      return prepare(...params);
    });
    const commit = h.app.store.commit.bind(h.app.store);
    let failOnce = true;
    t.mock.method(h.app.store, 'commit', (transaction: Transaction) => {
      if (failOnce && transaction.idempotencyAliases?.length) {
        failOnce = false;
        return commit({
          ...transaction,
          checks: [...(transaction.checks ?? []), { kind: 'missing', id: 'injected-conflict' }],
        });
      }
      return commit(transaction);
    });
    await assert.rejects(c.respond(h.alice, args), { code: 'REVISION_CONFLICT' });
    assert.equal((await c.agent(member.agentId)).operationId, undefined);
    assert.equal(await c.replayResponse(h.alice, args), null);
    const accepted = await c.respond(h.alice, args);
    assert.deepEqual(await c.respond(h.alice, args), accepted);
    await assert.rejects(c.respond(h.alice, { ...args, requestId: 'duplicate' }), {
      code: 'RECOVERY_CONFLICT',
    });
    const operations = (await h.app.store.list<WorkRecord>('operation')).filter((op) =>
      ['session_load', 'session_resume'].includes(op.type),
    );
    assert.equal(operations.length, 1);
    assert.equal((await c.agent(member.agentId)).operationId, operations[0]!.id);
    release();
    await until(async () => (await c.view(await c.agent(member.agentId))).state === 'idle');
    assert.deepEqual(await c.respond(h.alice, args), accepted);
    const audit = (await readFile(join(h.path, 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string });
    assert.equal(
      audit.filter((r) => ['session/load', 'session/resume'].includes(r.method)).length,
      1,
    );
    assert.equal(audit.filter((r) => r.method === 'session/prompt').length, 1);
  } finally {
    release();
    await h.cleanup();
  }
});

void test('首个终态 outbox 不被取消与恢复竞争覆盖，协作记录计入容量', async () => {
  const h = await harness();
  try {
    const work: WorkRecord = {
      id: 'work',
      revision: 1,
      createdAt: new Date().toISOString(),
      ownerId: h.alice.principalId,
      instanceId: h.app.instanceId,
      kind: 'task',
      type: 'prompt',
      state: 'cancelled',
      commitState: 'committed',
      collaboration: { agentId: 'agent', intentId: 'intent', teamId: 'team' },
    };
    await h.app.store.commit({ puts: completionRows(work) });
    const first = (await h.app.store.get<CompletionRecord>('collab_outbox', 'intent'))!;
    await h.app.store.put('collab_outbox', { ...first, revision: 2, delivered: true });
    await h.app.store.commit({ puts: completionRows({ ...work, state: 'interrupted' }) });
    const final = (await h.app.store.get<CompletionRecord>('collab_outbox', 'intent'))!;
    assert.equal(final.revision, 2);
    assert.equal(final.delivered, true);
    assert.equal(final.work.state, 'cancelled');
    const before = await h.app.store.call<{ bytes: number }>('logicalUsage', {});
    await h.app.store.put('collab_message', {
      id: 'large-record',
      revision: 1,
      createdAt: new Date().toISOString(),
      text: '中'.repeat(10000),
    });
    const after = await h.app.store.call<{ bytes: number }>('logicalUsage', {});
    assert.ok(after.bytes > before.bytes);
    await assert.rejects(h.app.collaboration.storage.capacity(1, before.bytes + 1000, 0), {
      code: 'STORAGE_FULL',
    });
  } finally {
    await h.cleanup();
  }
});

for (const point of ['terminal', 'running'])
  void test(`宿主在 ${point} 崩溃后恢复邮箱，实际 prompt 不重发`, { timeout: 30000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acm-collab-recovery-'));
    let app: Container | undefined;
    let runtimePid: number | undefined;
    const child = spawn(
      process.execPath,
      [resolve('.test-dist/test/fixtures/collaboration-host.js'), dir, point],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      const [code] = (await once(child, 'exit')) as [number | null];
      assert.equal(code, point === 'terminal' ? 27 : 29, stderr);
      const records = stdout
        .trim()
        .split('\n')
        .map(
          (line) => JSON.parse(line) as { agentId?: string; teamId?: string; runtimePid?: number },
        );
      const member = records.find((r) => r.agentId)!;
      runtimePid = records.find((r) => r.runtimePid)?.runtimePid;
      if (runtimePid)
        try {
          process.kill(runtimePid, 'SIGKILL');
        } catch {
          /* 子进程可能已因管道关闭退出。 */
        }
      app = await Container.create({
        dataDir: join(dir, 'data'),
        mode: 'stdio',
        settings: { minimumFreeBytes: 0 },
      });
      const ctx = {
        principalId: 'stdio:collaboration-recovery',
        serviceId: app.serviceId,
        mode: 'stdio' as const,
      };
      const current = app;
      const mailbox = await until(async () => {
        const page = await current.collaboration.wait(ctx, {
          teamId: member.teamId!,
          timeoutMs: 0,
        });
        return page.messages.length ? page : null;
      });
      assert.equal(mailbox.messages.length, 1);
      assert.equal(
        mailbox.messages[0]!.type,
        point === 'terminal' ? 'FINAL_ANSWER' : 'INTERRUPTED',
      );
      const reread = await app.collaboration.wait(ctx, { teamId: member.teamId!, timeoutMs: 0 });
      assert.equal(reread.messages[0]!.messageId, mailbox.messages[0]!.messageId);
      const intents = await app.collaboration.storage.intents(member.agentId!);
      if (point === 'running') assert.equal(intents.filter((i) => i.state === 'queued').length, 1);
      await app.collaboration.scheduler.tick();
      const audit = (await readFile(join(dir, 'audit.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method: string });
      assert.equal(audit.filter((r) => r.method === 'session/prompt').length, 1);
      assert.equal(app.runtimes.live.size, 0);
    } finally {
      child.kill('SIGKILL');
      if (runtimePid)
        try {
          process.kill(runtimePid, 'SIGKILL');
        } catch {
          /* 已退出。 */
        }
      await app?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

void test('未确认消费的完成结果受保护；过期且已确认的邮箱保留墓碑和原游标', async () => {
  const h = await harness();
  try {
    const c = h.app.collaboration;
    const spawned = await c.spawn(h.alice, {
      requestId: 'retention',
      taskName: 'result',
      message: 'hello',
    });
    const mailbox = await until(async () => {
      const page = await c.wait(h.alice, { teamId: spawned.teamId, timeoutMs: 0 });
      return page.messages.length ? page : null;
    });
    const intent = (await c.storage.intents(spawned.agentId))[0]!;
    const work = (await h.app.store.get<WorkRecord>('task', intent.taskId!))!;
    assert.equal(await c.storage.protectedWork(work), true);
    await c.wait(h.alice, { teamId: spawned.teamId, cursor: mailbox.nextCursor, timeoutMs: 0 });
    assert.equal(await c.storage.protectedWork(work), false);
    const message = (await h.app.store.list<MessageRecord>('collab_message'))[0]!;
    await h.app.store.put('collab_message', { ...message, createdAt: '2020-01-01T00:00:00.000Z' });
    await c.storage.serial.run(spawned.teamId, () => c.storage.retain(spawned.teamId, 30));
    const reread = await c.wait(h.alice, { teamId: spawned.teamId, timeoutMs: 0 });
    assert.equal(reread.messages[0]!.messageId, message.id);
    assert.equal((reread.messages[0] as unknown as { purged: boolean }).purged, true);
  } finally {
    await h.cleanup();
  }
});
