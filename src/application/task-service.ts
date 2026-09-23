import { statfs } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { bytes, id, now } from '../domain/ids.js';
import { AppError, errorDetail, fail } from '../domain/errors.js';
import type { Context, WorkRecord, SessionRecord } from '../domain/models.js';
import { terminalStates } from '../domain/models.js';
import type { SqliteStore } from '../infrastructure/storage/sqlite-store.js';
import { row } from '../infrastructure/storage/sqlite-store.js';
import { validatePrompt } from '../infrastructure/acp/capability-gate.js';
import type { SessionService } from './session-service.js';
import { idem } from './common.js';
import type { Transaction, Row } from '../infrastructure/storage/protocol.js';

/** 将一次 prompt 转为持久化任务；请求返回任务 ID 后，下游执行由本实例继续持有。 */
export class TaskService {
  acceptRecords: (ctx: Context, task: WorkRecord) => Promise<Transaction> = () =>
    Promise.resolve({});
  terminalRecords: (task: WorkRecord) => Row[] = () => [];
  private readonly active = new Map<string, Promise<void>>();
  cancelInteractions: (runtimeId: string, taskId?: string) => Promise<void> = async () => {};
  capacityCleanup: () => Promise<void> = async () => {};
  capacityUsage: () => Promise<number> = async () =>
    (await this.store.call<{ bytes: number }>('usage', {})).bytes;

  constructor(
    readonly store: SqliteStore,
    readonly sessions: SessionService,
  ) {}

  async get(ctx: Context, taskId: string, control = false) {
    const task = await this.store.get<WorkRecord & { purged?: boolean }>('task', taskId);
    if (!task?.sessionId) return fail('OBJECT_NOT_FOUND', '任务不存在。');
    await this.sessions.get(ctx, task.sessionId, control ? 'control' : 'read');
    return task;
  }

  /** 在会话串行区内完成幂等检查、容量准入和 prompt 租约，再安排实际派发。 */
  async submit(
    ctx: Context,
    args: { sessionId: string; prompt: ContentBlock[]; idempotencyKey: string },
  ) {
    return this.sessions.serial.run(args.sessionId, async () => {
      const previous = await this.store.replay<{ taskId: string }>(
        idem(ctx, 'task_submit', args, null),
      );
      if (previous) {
        const task = await this.get(ctx, previous.taskId);
        if (task.purged) fail('RESULT_PURGED', '此幂等请求的历史已清理，不会重新执行。');
        return { taskId: task.id, state: task.state, revision: task.revision };
      }
      const { session, record, handle } = await this.sessions.runtime(ctx, args.sessionId);
      if (session.activeTaskId)
        fail('SESSION_BUSY', '当前会话已有活动任务。', { taskId: session.activeTaskId });
      if (this.sessions.runtimes.lifecycle.has(record.id))
        fail('SESSION_BUSY', 'Runtime 正在认证或关闭。');
      if (!args.prompt.length || bytes(args.prompt) > 16 * 1024 ** 2)
        fail('CONFIG_INVALID', 'prompt 必须非空且不超过 16 MiB。');
      validatePrompt(handle.client.initialize.agentCapabilities ?? {}, args.prompt);
      const settings = this.sessions.runtimes.settings;
      await this.capacityCleanup();
      const space = await statfs(this.sessions.events.paths.stateDir);
      if (space.bavail * space.bsize < settings.minimumFreeBytes)
        fail('STORAGE_FULL', '磁盘可用空间不足，拒绝接受新任务。');
      if ((await this.capacityUsage()) >= settings.historyMaxBytes)
        fail('STORAGE_FULL', '历史容量已满且没有足够的可清理记录。');
      const task: WorkRecord = {
        id: id('tsk'),
        revision: 1,
        createdAt: now(),
        kind: 'task',
        ownerId: ctx.principalId,
        instanceId: this.sessions.runtimes.instanceId,
        type: 'prompt',
        state: 'accepted',
        commitState: 'committed',
        sessionId: session.id,
        runtimeId: record.id,
        ...(ctx.collaborationIntent
          ? {
              collaboration: {
                teamId: ctx.collaborationIntent.teamId,
                agentId: ctx.collaborationIntent.agentId,
                intentId: ctx.collaborationIntent.intentId,
              },
            }
          : {}),
      };
      const acceptedRecords = await this.acceptRecords(ctx, task);
      const response = { taskId: task.id, state: 'accepted', revision: 1 };
      // 任务、会话占用和幂等响应必须同事务保存，重试才不会创建第二次 prompt。
      await this.store.commit({
        checks: [
          { kind: 'session', id: session.id, revision: session.revision },
          ...(acceptedRecords.checks ?? []),
        ],
        puts: [
          row('task', task),
          row('task_slot', {
            id: task.id,
            revision: 1,
            createdAt: now(),
            instanceId: task.instanceId,
          }),
          row('session', { ...session, revision: session.revision + 1, activeTaskId: task.id }),
          ...(acceptedRecords.puts ?? []),
        ],
        claims: [{ key: `prompt:${session.id}`, holder: task.id }],
        limits: [
          { kind: 'task_slot', path: 'instanceId', value: task.instanceId, max: settings.maxTasks },
        ],
        idempotency: idem(ctx, 'task_submit', args, response),
      });
      // 先返回 accepted；真正发送前再次检查状态，让尚未派发的取消可以直接撤销任务。
      const pending = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
        try {
          const dispatched = await this.sessions.serial.run(session.id, async () => {
            const current = await this.store.get<WorkRecord>('task', task.id);
            if (!current || current.state !== 'accepted') return null;
            // 发往下游前记录 unknown；此后崩溃无法证明副作用未发生，恢复时不能重放。
            await this.store.commit({
              checks: [{ kind: 'task', id: task.id, revision: current.revision }],
              puts: [
                row('task', {
                  ...current,
                  state: 'running',
                  dispatchOutcome: 'unknown',
                  revision: current.revision + 1,
                }),
              ],
            });
            return {
              response: handle.client.request('session/prompt', {
                sessionId: session.downstreamSessionId,
                prompt: args.prompt,
              }),
            };
          });
          if (!dispatched) return;
          const result = await dispatched.response;
          await handle.client.barrier();
          await this.finish(task.id, {
            state: result.stopReason === 'cancelled' ? 'cancelled' : 'completed',
            result: await this.sessions.events.externalize(task.id, result),
            dispatchOutcome: 'confirmed',
          });
        } catch (error) {
          let outputComplete = true;
          try {
            await handle.client.barrier();
          } catch {
            outputComplete = false;
          }
          const latest = await this.store.get<WorkRecord>('task', task.id);
          if (latest && !terminalStates.has(latest.state))
            await this.finish(task.id, {
              state:
                latest.state === 'cancelling'
                  ? 'cancelled'
                  : errorDetail(error).code === 'DOWNSTREAM_EXITED'
                    ? 'interrupted'
                    : 'failed',
              error: errorDetail(error),
              outputComplete,
            });
        } finally {
          await this.cancelInteractions(record.id, task.id);
          this.active.delete(task.id);
        }
      });
      this.active.set(task.id, pending);
      void pending.catch(() => {});
      return response;
    });
  }

  async update(taskId: string, patch: Partial<WorkRecord>) {
    const record = await this.store.get<WorkRecord>('task', taskId);
    if (!record?.sessionId) return;
    return this.sessions.serial.run(record.sessionId, async () => {
      const task = await this.store.get<WorkRecord>('task', taskId);
      if (!task || terminalStates.has(task.state)) return;
      const next = { ...task, ...patch, revision: task.revision + 1 };
      await this.store.commit({
        checks: [{ kind: 'task', id: taskId, revision: task.revision }],
        puts: [row('task', next)],
      });
      return next;
    });
  }

  /** 终态只提交一次；释放会话 prompt 租约和容量名额时同时清除 activeTaskId。 */
  async finish(taskId: string, patch: Partial<WorkRecord>) {
    const record = await this.store.get<WorkRecord>('task', taskId);
    if (!record?.sessionId) return;
    return this.sessions.serial.run(record.sessionId, async () => {
      const task = await this.store.get<WorkRecord>('task', taskId);
      const session = await this.store.get<SessionRecord>('session', record.sessionId!);
      if (!task || !session || terminalStates.has(task.state)) return;
      const next = { ...task, ...patch, endedAt: now(), revision: task.revision + 1 };
      await this.sessions.events.append(session, 'task_state', { taskId, state: next.state });
      const updatedSession = { ...session, revision: session.revision + 1 };
      if (updatedSession.activeTaskId === taskId) delete updatedSession.activeTaskId;
      await this.store.commit({
        checks: [
          { kind: 'task', id: taskId, revision: task.revision },
          { kind: 'session', id: session.id, revision: session.revision },
        ],
        puts: [row('task', next), row('session', updatedSession), ...this.terminalRecords(next)],
        releases: [{ key: `prompt:${session.id}`, holder: taskId }],
        deletes: [{ kind: 'task_slot', id: taskId }],
      });
    });
  }

  /** 等待修订变化、交互或终态；客户端停止等待不会取消后台任务，返回前重新授权。 */
  async wait(
    ctx: Context,
    args: { taskId: string; afterRevision?: number | undefined; timeoutMs?: number | undefined },
  ) {
    const deadline = Date.now() + (args.timeoutMs ?? 10_000);
    const first = await this.get(ctx, args.taskId);
    let current = first;
    while (
      !terminalStates.has(current.state) &&
      current.state !== 'waiting_interaction' &&
      current.revision <= (args.afterRevision ?? first.revision) &&
      Date.now() < deadline &&
      !ctx.signal?.aborted
    ) {
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
      current = await this.get(ctx, args.taskId);
    }
    await this.sessions.get(ctx, current.sessionId!);
    return {
      ...current,
      taskId: current.id,
      timedOut: !terminalStates.has(current.state) && Date.now() >= deadline,
    };
  }

  /** 未发送任务直接结束；已发送任务先通知 ACP 取消，五秒后仍未结束则回收 Runtime。 */
  async cancel(ctx: Context, taskId: string) {
    const task = await this.get(ctx, taskId, true);
    let downstreamSessionId = '';
    const state = await this.sessions.serial.run(task.sessionId!, async () => {
      downstreamSessionId = (await this.sessions.get(ctx, task.sessionId!, 'control'))
        .downstreamSessionId;
      const current = await this.get(ctx, taskId, true);
      if (terminalStates.has(current.state)) return current.state;
      if (current.instanceId !== this.sessions.runtimes.instanceId)
        fail('INSTANCE_MISMATCH', '请连接任务所属实例。');
      if (current.state === 'accepted') {
        const session = await this.sessions.get(ctx, task.sessionId!, 'control');
        const next = { ...session, revision: session.revision + 1 };
        delete next.activeTaskId;
        const ended: WorkRecord = {
          ...current,
          state: 'cancelled',
          endedAt: now(),
          dispatchOutcome: 'not_sent',
          revision: current.revision + 1,
        };
        await this.store.commit({
          checks: [
            { kind: 'task', id: taskId, revision: current.revision },
            { kind: 'session', id: session.id, revision: session.revision },
          ],
          puts: [row('task', ended), row('session', next), ...this.terminalRecords(ended)],
          releases: [{ key: `prompt:${session.id}`, holder: taskId }],
          deletes: [{ kind: 'task_slot', id: taskId }],
        });
        return 'cancelled';
      }
      await this.store.commit({
        checks: [{ kind: 'task', id: taskId, revision: current.revision }],
        puts: [row('task', { ...current, state: 'cancelling', revision: current.revision + 1 })],
      });
      return 'cancelling';
    });
    if (terminalStates.has(state)) return { accepted: true, state };
    await this.cancelInteractions(task.runtimeId!, taskId);
    const handle = this.sessions.runtimes.live.get(task.runtimeId!);
    if (handle) {
      await handle.client.cancel(downstreamSessionId).catch(() => {});
      const timer = setTimeout(() => {
        void this.store
          .get<WorkRecord>('task', taskId)
          .then(async (latest) => {
            if (latest && !terminalStates.has(latest.state))
              await this.sessions.runtimes.closeNow(task.runtimeId!);
          })
          .catch(() => {});
      }, 5000);
      timer.unref();
    } else await this.finish(taskId, { state: 'cancelled' });
    return {
      accepted: true,
      state: (await this.store.get<WorkRecord>('task', taskId))?.state ?? state,
    };
  }

  /** 进程退出只能证明执行被中断，不能把尚未确认的副作用改写为未发送。 */
  async exited(runtimeId: string, outputComplete = false) {
    for (const task of await this.store.list<WorkRecord>('task'))
      if (task.runtimeId === runtimeId && !terminalStates.has(task.state))
        await this.finish(task.id, {
          state: task.state === 'cancelling' ? 'cancelled' : 'interrupted',
          error: errorDetail(new AppError('DOWNSTREAM_EXITED', '下游进程已退出。')),
          outputComplete,
        });
  }

  async close() {
    await Promise.allSettled([...this.active.values()]);
  }
}
