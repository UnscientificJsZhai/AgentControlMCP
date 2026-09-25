import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Container } from '../../src/bootstrap/container.js';
import type {
  AcceptanceResult,
  CompletionRecord,
  MessageRecord,
  TaskIntentRecord,
  TeamRecord,
} from '../../src/domain/collaboration.js';
import { row } from '../../src/infrastructure/storage/sqlite-store.js';
import { harness, until } from '../helpers/harness.js';

function gate() {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

for (const change of ['close', 'intent'] as const)
  void test(
    change === 'close'
      ? '跨实例完成交付不能覆盖已受理的关闭，原请求重试可收敛且只通知一次'
      : '跨实例完成交付遇到 intent 修订冲突后整笔回滚，重试按最新条件重新验收',
    { timeout: 30_000 },
    async (t) => {
      const h = await harness();
      const finishGate = gate();
      const deliveryGate = gate();
      let peer: Container | undefined;
      let delivery: Promise<unknown> = Promise.resolve();
      t.signal.addEventListener(
        'abort',
        () => {
          finishGate.release();
          deliveryGate.release();
        },
        { once: true },
      );
      try {
        const c = h.app.collaboration;
        await c.scheduler.stop();
        peer = await Container.create({ dataDir: h.app.dataDir, mode: 'cli' });
        await peer.collaboration.scheduler.stop();
        assert.notEqual(peer.instanceId, h.app.instanceId);
        assert.notEqual(peer.store, h.app.store);

        // 两个调度器均由测试推进；终态门闩保证首次交付前没有后台 tick 抢先消费。
        const finish = h.app.tasks.finish.bind(h.app.tasks);
        t.mock.method(h.app.tasks, 'finish', async (...args: Parameters<typeof finish>) => {
          await finishGate.wait;
          return finish(...args);
        });
        const spawned = await c.spawn(h.alice, {
          requestId: 'completion',
          taskName: 'completion',
          message: 'complete once',
        });
        const intent = await until(async () => {
          await c.scheduler.tick();
          return (await c.storage.intents(spawned.agentId)).find(
            (item) => item.state === 'dispatched',
          );
        });
        const runtime = await c.runtimeFor(await c.agent(spawned.agentId));
        assert.ok(runtime);
        const host = h.app.runtimes.live.get(runtime.id)!.client.host;
        finishGate.release();
        const completion = await until(() =>
          h.app.store.get<CompletionRecord>('collab_outbox', intent.id),
        );
        assert.equal(completion.delivered, false);
        assert.equal(completion.work.state, 'completed');
        assert.equal(completion.work.dispatchOutcome, 'confirmed');
        assert.equal(intent.mailAfter, '0');
        const team = (await h.app.store.get<TeamRecord>('collab_team', spawned.teamId))!;

        let attempts = 0;
        const append = peer.collaboration.storage.append.bind(peer.collaboration.storage);
        t.mock.method(
          peer.collaboration.storage,
          'append',
          async (...args: Parameters<typeof append>) => {
            if (args[1].some((message) => message.id === `msg_${intent.id}`)) {
              attempts++;
              await deliveryGate.wait;
            }
            return append(...args);
          },
        );
        // 立即接住失败，避免门闩等待期间出现未处理拒绝；放行后仍断言 tick 成功。
        delivery = peer.collaboration.scheduler.tick().catch((error: unknown) => error);
        await until(() => attempts === 1);
        const closeArgs = { requestId: 'close', target: spawned.agentId };
        let accepted: unknown;
        if (change === 'close') {
          accepted = await c.stop(h.alice, closeArgs, true);
          assert.deepEqual(accepted, {
            accepted: true,
            agentId: spawned.agentId,
            state: 'closing',
          });
        } else {
          // 单独推进 intent 修订，成员和团队均不变化，证明冲突检查覆盖 intent。
          await h.app.store.commit({
            checks: [{ kind: 'collab_intent', id: intent.id, revision: intent.revision }],
            puts: [
              row('collab_intent', {
                ...intent,
                completionCriteria: { requiredMessage: { target: '/root', text: 'MISSING' } },
                message: '并发保留的任务正文',
                revision: intent.revision + 1,
              }),
            ],
          });
        }
        const currentAgent = await c.agent(spawned.agentId);
        const currentIntent = (await h.app.store.get<TaskIntentRecord>(
          'collab_intent',
          intent.id,
        ))!;
        deliveryGate.release();
        assert.equal(await delivery, undefined);

        // 冲突事务不得只保存部分结果，也不能消耗邮箱序号。
        assert.deepEqual(await c.agent(spawned.agentId), currentAgent);
        assert.deepEqual(await h.app.store.get('collab_intent', intent.id), currentIntent);
        assert.deepEqual(await h.app.store.get('collab_outbox', intent.id), completion);
        assert.equal(await h.app.store.get('collab_message', `msg_${intent.id}`), null);
        assert.deepEqual(await h.app.store.get('collab_team', team.id), team);
        if (change === 'close') {
          assert.equal(currentAgent.lifecycle, 'closing');
          assert.deepEqual(await c.stop(h.alice, closeArgs, true), accepted);
          assert.deepEqual(await c.agent(spawned.agentId), currentAgent);
        }

        await peer.collaboration.scheduler.tick();
        assert.equal(attempts, 2);
        const settledIntent = {
          ...currentIntent,
          state: 'settled',
          endedAt: completion.work.endedAt,
          revision: currentIntent.revision + 1,
        };
        const delivered = { ...completion, delivered: true, revision: completion.revision + 1 };
        assert.deepEqual(await h.app.store.get('collab_intent', intent.id), settledIntent);
        assert.deepEqual(await h.app.store.get('collab_outbox', intent.id), delivered);
        assert.deepEqual(await c.agent(spawned.agentId), {
          ...currentAgent,
          ...(change === 'intent' ? { queuePaused: true } : {}),
          mailAfter: currentIntent.mailAfter,
          revision: currentAgent.revision + 1,
        });
        const message = (await h.app.store.get<MessageRecord>(
          'collab_message',
          `msg_${intent.id}`,
        ))!;
        assert.equal(message.seq, String(BigInt(team.sequence) + 1n));
        assert.equal(message.type, change === 'close' ? 'FINAL_ANSWER' : 'RUN_FAILED');
        assert.equal(
          (message.body as { acceptance: AcceptanceResult }).acceptance.status,
          change === 'close' ? 'not_requested' : 'failed',
        );

        await c.scheduler.tick();
        if (change === 'close') {
          assert.equal((await c.agent(spawned.agentId)).lifecycle, 'closed');
          assert.equal((await c.runtimeFor(await c.agent(spawned.agentId)))?.state, 'closed');
          assert.equal(h.app.runtimes.live.has(runtime.id), false);
          await host.closed;
          assert.ok(host.exitCode !== null || host.exitSignal !== null);
          assert.deepEqual(await c.stop(h.alice, closeArgs, true), accepted);
          assert.equal((await c.agent(spawned.agentId)).lifecycle, 'closed');
        }
        await peer.collaboration.scheduler.tick();
        await c.scheduler.tick();
        assert.equal(attempts, 2);
        assert.deepEqual(await h.app.store.list<MessageRecord>('collab_message'), [message]);
        assert.deepEqual(await h.app.store.get('collab_intent', intent.id), settledIntent);
        assert.deepEqual(await h.app.store.get('collab_outbox', intent.id), delivered);
        assert.equal(
          (await h.app.store.get<TeamRecord>('collab_team', team.id))?.sequence,
          message.seq,
        );
      } finally {
        finishGate.release();
        deliveryGate.release();
        await delivery;
        try {
          await peer?.close();
        } finally {
          await h.cleanup();
        }
      }
    },
  );
