import test from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryAdminService } from '../../src/application/recovery-admin-service.js';
import { isAlive, recover } from '../../src/application/recovery-service.js';
import { digest } from '../../src/domain/ids.js';
import { agentConfig } from '../../src/domain/schemas.js';
import type { InstanceRecord, SessionRecord, WorkRecord } from '../../src/domain/models.js';
import { recordingStore } from '../helpers/recording-store.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const dead: InstanceRecord = {
  id: 'dead',
  revision: 1,
  createdAt: timestamp,
  mode: 'stdio',
  serviceId: 'unit',
  pid: 101,
  state: 'active',
  nonce: 'unit',
  endpoint: '',
  heartbeat: timestamp,
};
const live: InstanceRecord = { ...dead, id: 'live', pid: 102 };
/**
 * 使用固定进程标识判断测试实例是否存活。
 *
 * @param pid - 待探测的进程标识。
 * @returns 是否属于预设的存活实例。
 */
const alive = (pid: number) => pid === live.pid;
const snapshot = agentConfig.parse({
  name: 'unit',
  origin: { kind: 'manual' },
  launch: { kind: 'command', executable: 'unit-agent', args: [] },
});
const session: SessionRecord = {
  id: 'session',
  revision: 3,
  createdAt: timestamp,
  ownerId: 'owner',
  grants: {},
  instanceId: dead.id,
  serviceId: 'unit',
  mode: 'stdio',
  configId: 'config',
  runtimeId: 'runtime',
  activationId: 'activation',
  downstreamSessionId: 'downstream',
  namespace: 'unit',
  state: 'ready',
  cwd: '/workspace',
  additionalDirectories: [],
  snapshot,
  options: [],
  modes: null,
  commands: [],
  controlVersion: 1,
};
const lease = 'session:' + digest([session.namespace, session.downstreamSessionId]);

for (const code of ['ESRCH', 'EPERM', 'EACCES']) {
  /**
   * 验证进程探测仅将 ESRCH 视为进程已退出。
   *
   * @remarks
   * 权限错误不能证明进程死亡；探测应只发送信号零且仅调用一次。
   */
  void test('Process probes treat only ESRCH as an exited process: ' + code, (t) => {
    const probe = t.mock.fn((_pid: number, _signal: 0) => {
      throw Object.assign(new Error(code), { code });
    });
    assert.equal(isAlive(101, probe), code !== 'ESRCH');
    assert.equal(probe.mock.callCount(), 1);
    assert.deepEqual(probe.mock.calls[0]!.arguments, [101, 0]);
  });
}

/**
 * 验证管理恢复拒绝处理仍存活的实例。
 *
 * @remarks
 * 冲突应在任何事务写入之前报告，避免破坏仍由原实例管理的资源。
 */
void test('Administrative recovery rejects live instances before writing', async () => {
  const { store, transactions } = recordingStore({ instance: [live] });
  const app = { store } as unknown as ConstructorParameters<typeof RecoveryAdminService>[0];
  await assert.rejects(
    new RecoveryAdminService(app, alive).resolve({
      instanceId: live.id,
      expectedRevision: live.revision,
    }),
    { code: 'RECOVERY_CONFLICT' },
  );
  assert.deepEqual(transactions, []);
});

for (const state of ['closed', 'deleted', 'interrupted', 'ready', 'creating'] as const) {
  /**
   * 验证失效实例的会话恢复遵循原有状态和租约归属。
   *
   * @remarks
   * 活跃状态应转为中断并移除当前任务，终态不重写；提交须检查实例修订并释放原租约。
   */
  void test('Recovery handles the session state: ' + state, async () => {
    const current = {
      ...session,
      state,
      ...(['ready', 'creating'].includes(state) ? { activeTaskId: 'task' } : {}),
    };
    const { store, transactions } = recordingStore({ instance: [dead], session: [current] });
    await recover(store, alive);
    const change = transactions[0]!;
    const saved = change.puts?.find((item) => item.kind === 'session')?.data as
      SessionRecord | undefined;
    if (state === 'ready' || state === 'creating') {
      assert.equal(saved?.state, 'interrupted');
      assert.equal(saved?.revision, current.revision + 1);
      assert.equal(saved?.activeTaskId, undefined);
    } else {
      assert.equal(saved, undefined, '终态会话不应重写');
    }
    assert.ok(
      change.releases?.some(
        (release) => release.key === lease && release.holder === session.runtimeId,
      ),
    );
    assert.deepEqual(change.checks, [{ kind: 'instance', id: dead.id, revision: dead.revision }]);
  });
}

/**
 * 验证恢复跳过存活实例和已停止实例。
 *
 * @remarks
 * 存活实例仅记录为待确认，不产生事务或释放其会话资源。
 */
void test('Recovery skips live or stopped instances without releasing session resources', async () => {
  const { store, transactions } = recordingStore({
    instance: [live, { ...dead, state: 'stopped' }],
    session: [{ ...session, instanceId: live.id }],
  });
  assert.deepEqual(await recover(store, alive), {
    recoveredInstances: [],
    uncertainInstances: [live.id],
  });
  assert.deepEqual(transactions, []);
});

for (const kind of ['task', 'operation'] as const) {
  /**
   * 验证未知派发结果的工作被标记中断，并保留不可重放的派发事实。
   *
   * @remarks
   * 仅释放原工作持有的租约，不改写已移交会话；协作完成记录须使用不存在时写入语义。
   */
  void test(
    'Recovery interrupts uncertain ' +
      kind +
      ' work while preserving dispatch facts and lease ownership',
    async () => {
      const work: WorkRecord = {
        id: kind,
        revision: 1,
        createdAt: timestamp,
        kind,
        ownerId: 'owner',
        instanceId: dead.id,
        type: kind === 'task' ? 'prompt' : 'session_delete',
        sessionId: session.id,
        state: 'running',
        commitState: 'pending',
        dispatchOutcome: 'unknown',
        collaboration: { teamId: 'team', agentId: 'agent', intentId: 'intent' },
      };
      const { store, transactions } = recordingStore({
        instance: [dead],
        [kind]: [work],
        session: [{ ...session, instanceId: live.id }],
      });
      await recover(store, alive);
      const change = transactions[0]!;
      const saved = change.puts?.find((item) => item.kind === kind)?.data as WorkRecord;
      assert.equal(saved.state, 'interrupted');
      assert.equal(saved.dispatchOutcome, 'unknown');
      assert.equal(saved.outputComplete, false);
      assert.equal(saved.error?.code, 'DISPATCH_OUTCOME_UNKNOWN');
      assert.ok(
        change.releases?.some(
          (release) =>
            release.key === (kind === 'task' ? 'prompt:' + session.id : lease) &&
            release.holder === work.id,
        ),
      );
      assert.ok(
        change.puts?.some((item) => item.kind === 'collab_outbox' && item.ifAbsent),
        '恢复与正常收尾竞争时不得覆盖已有完成事实',
      );
      assert.equal(
        change.puts?.some((item) => item.kind === 'session'),
        false,
      );
    },
  );
}

/**
 * 验证恢复事务的存储冲突原样传播给调用方。
 *
 * @remarks
 * 冲突不能被包装或吞掉，以便调用方识别本次恢复未完成。
 */
void test('Recovery propagates storage conflicts unchanged', async () => {
  const { store } = recordingStore({ instance: [dead] });
  const conflict = new Error('revision conflict');
  store.commit = () => Promise.reject(conflict);
  await assert.rejects(recover(store, alive), (error) => error === conflict);
});
