import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Container } from '../../src/bootstrap/container.js';
import { AppError } from '../../src/domain/errors.js';
import { digest, id } from '../../src/domain/ids.js';
import { terminalStates } from '../../src/domain/models.js';
import type { SessionRecord } from '../../src/domain/models.js';
import { harness, until } from '../helpers/harness.js';

function gate() {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

const leaseKey = (session: SessionRecord) =>
  `session:${digest([session.namespace, session.downstreamSessionId])}`;

async function closedSession(h: Awaited<ReturnType<typeof harness>>) {
  const created = await h.session();
  const session = await h.app.sessions.get(h.alice, created.sessionId);
  await h.operation(
    h.app.sessions.close(h.alice, {
      sessionId: session.id,
      expectedRevision: session.revision,
      idempotencyKey: id('close'),
    }),
  );
  return h.app.sessions.get(h.alice, session.id);
}

async function operationDone(h: Awaited<ReturnType<typeof harness>>, operationId: string) {
  return until(async () => {
    const operation = await h.app.operations.get(h.alice, operationId);
    return terminalStates.has(operation.state) ? operation : null;
  });
}

async function auditMethods(h: Awaited<ReturnType<typeof harness>>) {
  return (await readFile(join(h.path, 'audit.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { method?: string }).method);
}

void test('删除准备前持有跨实例租约，阻止恢复并保留幂等结果', { timeout: 30_000 }, async (t) => {
  const h = await harness();
  const entered = gate();
  const resume = gate();
  let peer: Container | undefined;
  try {
    const session = await closedSession(h);
    peer = await Container.create({ dataDir: h.app.dataDir, mode: 'cli' });
    const plan = (await peer.sessions.restore(h.alice, 'load', {
      phase: 'prepare',
      sessionId: session.id,
      idempotencyKey: id('plan'),
    })) as { restorePlanId: string; environmentDigest: string };
    const prepare = h.app.runtimes.prepareNow.bind(h.app.runtimes);
    t.mock.method(h.app.runtimes, 'prepareNow', async (...args: Parameters<typeof prepare>) => {
      entered.release();
      await resume.wait;
      return prepare(...args);
    });
    const args = {
      sessionId: session.id,
      expectedRevision: session.revision,
      idempotencyKey: id('delete'),
    };
    const deleting = await h.call<{ operationId: string }>('session_delete', args);
    await entered.wait;
    assert.equal(await peer.store.claim(leaseKey(session)), deleting.operationId);
    assert.deepEqual(await h.call('session_delete', args), deleting);
    const restoring = await peer.sessions.restore(h.alice, 'load', {
      phase: 'apply',
      sessionId: session.id,
      restorePlanId: plan.restorePlanId,
      acceptEnvironmentDigest: plan.environmentDigest,
      idempotencyKey: id('restore'),
    });
    const rejected = await operationDone(h, (restoring as { operationId: string }).operationId);
    assert.equal(rejected.state, 'failed');
    assert.equal(rejected.error?.code, 'RESOURCE_CONFLICT');
    assert.equal(peer.runtimes.live.size, 0);
    assert.equal(await peer.store.claim(leaseKey(session)), deleting.operationId);

    resume.release();
    await h.operation(deleting);
    const operation = await h.app.operations.get(h.alice, deleting.operationId);
    assert.equal(operation.commitState, 'committed');
    assert.equal(operation.dispatchOutcome, 'confirmed');
    assert.equal((await peer.sessions.get(h.alice, session.id)).state, 'deleted');
    assert.equal(await peer.store.claim(leaseKey(session)), null);
    assert.equal(h.app.runtimes.live.size, 0);
    assert.deepEqual(await h.call('session_delete', args), deleting);
    for (const method of ['load', 'resume'] as const)
      for (const phase of ['prepare', 'apply'] as const)
        await assert.rejects(
          peer.sessions.restore(h.alice, method, {
            phase,
            sessionId: session.id,
            restorePlanId: plan.restorePlanId,
            acceptEnvironmentDigest: plan.environmentDigest,
            idempotencyKey: id('deleted'),
          }),
          { code: 'RECOVERY_CONFLICT' },
        );
    const methods = await auditMethods(h);
    assert.equal(methods.filter((method) => method === 'session/delete').length, 1);
    assert.equal(methods.includes('session/load'), false);
  } finally {
    resume.release();
    await peer?.close();
    await h.cleanup();
  }
});

void test(
  '恢复先占用跨实例租约时删除失败，绑定后 prompt 可以正常运行',
  { timeout: 30_000 },
  async (t) => {
    const h = await harness();
    const entered = gate();
    const resume = gate();
    let peer: Container | undefined;
    try {
      const session = await closedSession(h);
      peer = await Container.create({ dataDir: h.app.dataDir, mode: 'cli' });
      const plan = (await peer.sessions.restore(h.alice, 'resume', {
        phase: 'prepare',
        sessionId: session.id,
        idempotencyKey: id('plan'),
      })) as { restorePlanId: string; environmentDigest: string };
      const prepare = peer.runtimes.prepareNow.bind(peer.runtimes);
      t.mock.method(peer.runtimes, 'prepareNow', async (...args: Parameters<typeof prepare>) => {
        entered.release();
        await resume.wait;
        return prepare(...args);
      });
      const restoring = (await peer.sessions.restore(h.alice, 'resume', {
        phase: 'apply',
        sessionId: session.id,
        restorePlanId: plan.restorePlanId,
        acceptEnvironmentDigest: plan.environmentDigest,
        idempotencyKey: id('restore'),
      })) as { operationId: string };
      await entered.wait;
      assert.equal(await h.app.store.claim(leaseKey(session)), restoring.operationId);
      const deleting = await h.app.sessions.delete(h.alice, {
        sessionId: session.id,
        expectedRevision: session.revision,
        idempotencyKey: id('delete'),
      });
      const rejected = await operationDone(h, deleting.operationId);
      assert.equal(rejected.state, 'failed');
      assert.equal(rejected.error?.code, 'RESOURCE_CONFLICT');
      assert.equal(h.app.runtimes.live.size, 0);
      assert.equal(await h.app.store.claim(leaseKey(session)), restoring.operationId);

      resume.release();
      await h.operation(restoring);
      const restored = await peer.sessions.get(h.alice, session.id);
      assert.equal(restored.state, 'ready');
      assert.equal(await h.app.store.claim(leaseKey(session)), restored.runtimeId);
      const task = await peer.tasks.submit(h.alice, {
        sessionId: session.id,
        prompt: [{ type: 'text', text: 'slow' }],
        idempotencyKey: id('task'),
      });
      await until(async () => (await h.app.tasks.get(h.alice, task.taskId)).state === 'running');
      assert.equal((await h.app.sessions.get(h.alice, session.id)).activeTaskId, task.taskId);
      assert.equal((await auditMethods(h)).includes('session/delete'), false);
    } finally {
      resume.release();
      await peer?.close();
      await h.cleanup();
    }
  },
);

for (const method of ['delete', 'load'] as const)
  for (const failure of ['prepare', 'capability', 'cancel'] as const)
    void test(
      `${method} ${failure} 失败释放操作占用和临时 Runtime`,
      { timeout: 30_000 },
      async (t) => {
        const h = await harness('http', failure === 'capability' ? { FIXTURE_NO_CAPS: '1' } : {});
        const entered = gate();
        const resume = gate();
        try {
          const session = await closedSession(h);
          const prepare = h.app.runtimes.prepareNow.bind(h.app.runtimes);
          if (failure !== 'capability')
            t.mock.method(
              h.app.runtimes,
              'prepareNow',
              async (...args: Parameters<typeof prepare>) => {
                entered.release();
                await resume.wait;
                if (failure === 'prepare') throw new AppError('CONFIG_INVALID', '注入准备失败。');
                return prepare(...args);
              },
            );
          const plan = (await h.app.sessions.restore(h.alice, 'load', {
            phase: 'prepare',
            sessionId: session.id,
            idempotencyKey: id('plan'),
          })) as { restorePlanId: string; environmentDigest: string };
          const accepted = (await (method === 'delete'
            ? h.app.sessions.delete(h.alice, {
                sessionId: session.id,
                expectedRevision: session.revision,
                idempotencyKey: id('delete'),
              })
            : h.app.sessions.restore(h.alice, 'load', {
                phase: 'apply',
                sessionId: session.id,
                restorePlanId: plan.restorePlanId,
                acceptEnvironmentDigest: plan.environmentDigest,
                idempotencyKey: id('restore'),
              }))) as { operationId: string };
          if (failure !== 'capability') {
            await entered.wait;
            assert.equal(await h.app.store.claim(leaseKey(session)), accepted.operationId);
            if (failure === 'cancel') await h.app.operations.cancel(h.alice, accepted.operationId);
            resume.release();
          }
          const operation = await operationDone(h, accepted.operationId);
          assert.equal(operation.state, failure === 'cancel' ? 'cancelled' : 'failed');
          if (failure !== 'cancel')
            assert.equal(
              operation.error?.code,
              failure === 'prepare' ? 'CONFIG_INVALID' : 'CAPABILITY_UNSUPPORTED',
            );
          assert.equal(await h.app.store.claim(leaseKey(session)), null);
          assert.deepEqual(await h.app.sessions.get(h.alice, session.id), session);
          assert.equal(h.app.runtimes.live.size, 0);
          assert.equal((await h.app.store.list('runtime_slot')).length, 0);
          assert.equal((await auditMethods(h)).includes(`session/${method}`), false);
        } finally {
          resume.release();
          await h.cleanup();
        }
      },
    );

void test(
  '恢复参数在绑定后失败也关闭 Runtime 并释放转交后的租约',
  { timeout: 30_000 },
  async (t) => {
    const h = await harness();
    try {
      const session = await closedSession(h);
      const plan = (await h.app.sessions.restore(h.alice, 'load', {
        phase: 'prepare',
        sessionId: session.id,
        idempotencyKey: id('plan'),
      })) as { restorePlanId: string; environmentDigest: string };
      t.mock.method(h.app.sessions, 'params', () => {
        throw new AppError('CONFIG_INVALID', '注入恢复参数失败。');
      });
      const accepted = (await h.app.sessions.restore(h.alice, 'load', {
        phase: 'apply',
        sessionId: session.id,
        restorePlanId: plan.restorePlanId,
        acceptEnvironmentDigest: plan.environmentDigest,
        idempotencyKey: id('restore'),
      })) as { operationId: string };
      const operation = await operationDone(h, accepted.operationId);
      assert.equal(operation.error?.code, 'CONFIG_INVALID');
      assert.equal((await h.app.sessions.get(h.alice, session.id)).state, 'closed');
      assert.equal(await h.app.store.claim(leaseKey(session)), null);
      assert.equal(h.app.runtimes.live.size, 0);
      assert.equal((await auditMethods(h)).includes('session/load'), false);
    } finally {
      await h.cleanup();
    }
  },
);

for (const outcome of ['unknown', 'cancelled_after_response', 'changed_generation'] as const)
  void test(`删除派发后 ${outcome} 不伪造或覆写会话状态`, { timeout: 30_000 }, async (t) => {
    const h = await harness();
    const responded = gate();
    const resume = gate();
    try {
      const session = await closedSession(h);
      const prepare = h.app.runtimes.prepareNow.bind(h.app.runtimes);
      t.mock.method(h.app.runtimes, 'prepareNow', async (...args: Parameters<typeof prepare>) => {
        const runtime = await prepare(...args);
        const client = h.app.runtimes.handle(runtime).client;
        const request = client.request.bind(client);
        t.mock.method(client, 'request', async (...params: Parameters<typeof request>) => {
          const result = await request(...params);
          responded.release();
          await resume.wait;
          if (outcome === 'unknown') throw new AppError('TIMEOUT', '注入响应丢失。');
          return result;
        });
        return runtime;
      });
      const accepted = await h.app.sessions.delete(h.alice, {
        sessionId: session.id,
        expectedRevision: session.revision,
        idempotencyKey: id('delete'),
      });
      await responded.wait;
      assert.equal(await h.app.store.claim(leaseKey(session)), accepted.operationId);
      if (outcome === 'cancelled_after_response')
        await h.app.operations.cancel(h.alice, accepted.operationId);
      const replacement: SessionRecord = {
        ...session,
        revision: session.revision + 1,
        state: 'ready',
        runtimeId: 'replacement-runtime',
        activationId: 'replacement-activation',
        activeTaskId: 'replacement-task',
      };
      if (outcome === 'changed_generation') await h.app.store.put('session', replacement);
      resume.release();
      const operation = await operationDone(h, accepted.operationId);
      const current = await h.app.sessions.get(h.alice, session.id);
      if (outcome === 'cancelled_after_response') {
        assert.equal(operation.state, 'completed');
        assert.equal(operation.commitState, 'committed');
        assert.equal(operation.dispatchOutcome, 'confirmed');
        assert.equal(current.state, 'deleted');
      } else {
        assert.equal(operation.state, 'failed');
        assert.equal(operation.commitState, 'pending');
        assert.equal(operation.dispatchOutcome, 'unknown');
        assert.equal(
          operation.error?.code,
          outcome === 'unknown' ? 'TIMEOUT' : 'REVISION_CONFLICT',
        );
        assert.deepEqual(current, outcome === 'unknown' ? session : replacement);
      }
      assert.equal(await h.app.store.claim(leaseKey(session)), null);
      assert.equal(h.app.runtimes.live.size, 0);
      assert.equal(
        (await auditMethods(h)).filter((method) => method === 'session/delete').length,
        1,
      );
    } finally {
      resume.release();
      await h.cleanup();
    }
  });
