import { setTimeout as delay } from 'node:timers/promises';
import { id, now } from '../domain/ids.js';
import { errorDetail, fail } from '../domain/errors.js';
import { terminalStates } from '../domain/models.js';
import type { Context, WorkRecord } from '../domain/models.js';
import type { SqliteStore } from '../infrastructure/storage/sqlite-store.js';
import { row } from '../infrastructure/storage/sqlite-store.js';
import { idem, Serial } from './common.js';

/** 为安装、认证、恢复等长操作提供统一的持久化状态、幂等受理和实例内取消句柄。 */
export class OperationService {
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  readonly serial = new Serial();
  authorize: (ctx: Context, record: WorkRecord, control: boolean) => Promise<void> = (
    ctx,
    record,
  ) => {
    if (!ctx.admin && record.ownerId !== ctx.principalId)
      fail('OBJECT_NOT_FOUND', '操作不存在或不可见。');
    return Promise.resolve();
  };

  constructor(
    readonly store: SqliteStore,
    readonly instanceId: string,
  ) {}

  async get(ctx: Context, operationId: string, control = false) {
    const record = await this.store.get<WorkRecord>('operation', operationId);
    if (!record) return fail('OBJECT_NOT_FOUND', '操作不存在。');
    await this.authorize(ctx, record, control);
    return record;
  }

  /** 先保存受理结果，再异步执行 action；幂等重放只返回原 operation，不启动新工作。 */
  async start(
    ctx: Context,
    type: string,
    args: { idempotencyKey: string },
    action: (operationId: string, signal: AbortSignal) => Promise<unknown>,
    target: { sessionId?: string; runtimeId?: string } = {},
  ) {
    const record: WorkRecord = {
      id: id('op'),
      revision: 1,
      createdAt: now(),
      kind: 'operation',
      ownerId: ctx.principalId,
      instanceId: this.instanceId,
      type,
      state: 'accepted',
      commitState: 'pending',
      ...target,
    };
    const response = { operationId: record.id, state: 'accepted' };
    const committed = await this.store.commit({
      puts: [row('operation', record)],
      idempotency: idem(ctx, type, args, response),
    });
    const accepted = committed.response as typeof response;
    if (committed.replayed) {
      await this.get(ctx, accepted.operationId);
      return accepted;
    }
    const abort = new AbortController();
    const done = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
      await this.update(record.id, { state: 'running' });
      try {
        abort.signal.throwIfAborted();
        const result = await action(record.id, abort.signal);
        const current = await this.store.get<WorkRecord>('operation', record.id);
        if (current && !terminalStates.has(current.state))
          await this.update(record.id, {
            state:
              abort.signal.aborted && current.commitState !== 'committed'
                ? 'cancelled'
                : 'completed',
            result,
            endedAt: now(),
          });
      } catch (error) {
        await this.update(record.id, {
          state: abort.signal.aborted ? 'cancelled' : 'failed',
          error: errorDetail(error),
          endedAt: now(),
        });
      } finally {
        this.active.delete(record.id);
      }
    });
    this.active.set(record.id, { abort, done });
    void done.catch(() => {});
    return accepted;
  }

  /** 保持终态不可逆，也不允许迟到的 running 更新覆盖 cancelling。 */
  async update(operationId: string, patch: Partial<WorkRecord>) {
    return this.serial.run(operationId, async () => {
      const record = await this.store.get<WorkRecord>('operation', operationId);
      if (!record) return;
      if (terminalStates.has(record.state)) return record;
      if (
        record.state === 'cancelling' &&
        (patch.state === 'running' || patch.state === 'waiting_interaction')
      )
        return record;
      const next = { ...record, ...patch, revision: record.revision + 1 };
      await this.store.commit({
        checks: [{ kind: 'operation', id: record.id, revision: record.revision }],
        puts: [row('operation', next)],
      });
      await this.store.appendEvent({
        streamId: operationId,
        kind: 'operation_update',
        payload: { state: next.state, step: next.step, revision: next.revision },
      });
    });
  }

  /** 长轮询在状态变化或需要用户交互时返回，每轮及返回前都使用当前权限。 */
  async wait(
    ctx: Context,
    args: {
      operationId: string;
      afterRevision?: number | undefined;
      timeoutMs?: number | undefined;
    },
  ) {
    const deadline = Date.now() + (args.timeoutMs ?? 10_000);
    const first = await this.get(ctx, args.operationId);
    let current = first;
    while (
      !terminalStates.has(current.state) &&
      current.state !== 'waiting_interaction' &&
      current.revision <= (args.afterRevision ?? first.revision) &&
      Date.now() < deadline &&
      !ctx.signal?.aborted
    ) {
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
      current = await this.get(ctx, args.operationId);
    }
    await this.authorize(ctx, current, false);
    return { ...current, timedOut: !terminalStates.has(current.state) && Date.now() >= deadline };
  }

  /** 取消仅作用于本调用的 operation；跨过业务提交点后不回滚，合并的安装工作可继续。 */
  async cancel(ctx: Context, operationId: string) {
    return this.serial.run(operationId, async () => {
      const current = await this.get(ctx, operationId, true);
      if (!terminalStates.has(current.state) && current.commitState !== 'committed') {
        if (current.instanceId !== this.instanceId)
          fail('INSTANCE_MISMATCH', '请连接操作所属实例。');
        await this.store.commit({
          checks: [{ kind: 'operation', id: operationId, revision: current.revision }],
          puts: [
            row('operation', { ...current, state: 'cancelling', revision: current.revision + 1 }),
          ],
        });
        this.active.get(operationId)?.abort.abort();
      }
      return {
        accepted: true,
        state: (await this.get(ctx, operationId)).state,
        cancelScope: 'operation',
        sharedWorkMayContinue: true,
        commitState: current.commitState,
      };
    });
  }

  async close() {
    for (const entry of this.active.values()) entry.abort.abort();
    await Promise.allSettled([...this.active.values()].map((item) => item.done));
  }
}
