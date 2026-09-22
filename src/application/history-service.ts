import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { access } from '../domain/access-control.js';
import { bytes, digest, id, now } from '../domain/ids.js';
import { fail } from '../domain/errors.js';
import { terminalStates } from '../domain/models.js';
import type {
  ActivationRecord,
  Context,
  InteractionRecord,
  RuntimeRecord,
  SegmentRecord,
  SessionRecord,
  WorkRecord,
} from '../domain/models.js';
import type { Check } from '../infrastructure/storage/protocol.js';
import type { EventService } from './event-service.js';
import type { OperationService } from './operation-service.js';
import type { RuntimeService } from './runtime-service.js';

export type CleanupScope =
  | { kind: 'all' }
  | { kind: 'tasks'; sessionId?: string | undefined }
  | { kind: 'operations' }
  | {
      kind: 'session_events';
      sessionId: string;
      selector?:
        | { segmentIds?: string[] | undefined; endedActivationIds?: string[] | undefined }
        | undefined;
    };
type HistoryItem = (WorkRecord | SegmentRecord) & { purged?: boolean };

interface Candidate {
  kind: 'task' | 'operation' | 'segment';
  id: string;
  revision: number;
  sessionId?: string;
  bytes: number;
  endedAt: string;
}

interface CleanupPlan {
  id: string;
  revision: number;
  createdAt: string;
  ownerId: string;
  planDigest: string;
  expiresAt: string;
  candidates: Candidate[];
  scope: CleanupScope;
}

/** 按当前对象归属查询历史，并通过带版本和摘要的清理方案回收已结束且无活动引用的数据。 */
export class HistoryService {
  constructor(
    readonly events: EventService,
    readonly operations: OperationService,
    readonly runtimes: RuntimeService,
  ) {}

  private get store() {
    return this.events.store;
  }

  private async authorized(
    ctx: Context,
    kind: Candidate['kind'],
    item: HistoryItem,
    owner = false,
  ) {
    if (ctx.admin) return;
    if (kind === 'operation' && !(owner && item.sessionId)) {
      await this.operations.authorize(ctx, item as WorkRecord, owner);
      return;
    }
    const sessionId = item.sessionId;
    const session = sessionId ? await this.store.get<SessionRecord>('session', sessionId) : null;
    if (!session) return fail('OBJECT_NOT_FOUND', '历史对象不存在。');
    access(ctx, session, owner ? 'owner' : 'read');
  }

  async list(
    ctx: Context,
    args: {
      kind?: 'task' | 'operation' | 'session_event_segment' | undefined;
      sessionId?: string | undefined;
      activationId?: string | undefined;
      state?: string | undefined;
      before?: string | undefined;
    },
  ) {
    const items: (HistoryItem & { historyKind: string })[] = [];
    for (const kind of ['task', 'operation', 'segment'] as const) {
      if (args.kind && (args.kind === 'session_event_segment' ? 'segment' : args.kind) !== kind)
        continue;
      for (const item of await this.store.list<HistoryItem>(kind)) {
        if (
          (args.sessionId && item.sessionId !== args.sessionId) ||
          (args.activationId &&
            (!('activationId' in item) || item.activationId !== args.activationId)) ||
          (args.state && item.state !== args.state) ||
          (args.before && item.createdAt >= args.before)
        )
          continue;
        try {
          await this.authorized(ctx, kind, item);
          items.push({ ...item, historyKind: kind === 'segment' ? 'session_event_segment' : kind });
        } catch {
          /* 按当前归属过滤。 */
        }
      }
    }
    return items;
  }

  async get(ctx: Context, kind: 'task' | 'operation' | 'session_event_segment', objectId: string) {
    const key = kind === 'session_event_segment' ? 'segment' : kind;
    const item = await this.store.get<HistoryItem>(key, objectId);
    if (!item) fail('OBJECT_NOT_FOUND', '历史对象不存在。');
    await this.authorized(ctx, key, item);
    if (item.purged) return { id: item.id, purged: true, error: 'RESULT_PURGED' };
    return item;
  }

  /** 任务和操作须已终结；事件段还需封口，且所属会话无任务、交互或生命周期操作占用。 */
  private async eligible(kind: Candidate['kind'], item: HistoryItem): Promise<boolean> {
    if (item.purged) return false;
    if (kind !== 'segment') return terminalStates.has((item as WorkRecord).state);
    const segment = item as SegmentRecord;
    if (segment.state !== 'sealed') return false;
    const session = await this.store.get<SessionRecord>('session', segment.sessionId);
    if (
      !session ||
      session.activeTaskId ||
      session.state === 'creating' ||
      this.runtimes.lifecycle.has(session.runtimeId)
    )
      return false;
    if (
      (await this.store.list<InteractionRecord>('interaction')).some(
        (interaction) => interaction.sessionId === session.id && interaction.state === 'pending',
      )
    )
      return false;
    if (
      (await this.store.list<WorkRecord>('operation')).some(
        (operation) => operation.sessionId === session.id && !terminalStates.has(operation.state),
      )
    )
      return false;
    return true;
  }

  private async estimatedBytes(kind: Candidate['kind'], item: HistoryItem) {
    let size = bytes(item);
    if (kind === 'segment') size += (item as SegmentRecord).bytes;
    else {
      let after = '0';
      for (;;) {
        const page = await this.store.readEvents({
          streamId: kind === 'operation' ? item.id : item.sessionId!,
          after,
          limit: 500,
          ...(kind === 'task' ? { taskId: item.id } : {}),
        });
        const selected = page.items.slice(0, 500);
        size += selected.reduce((sum, event) => sum + event.bytes, 0);
        if (page.items.length <= 500) break;
        after = selected.at(-1)!.seq;
      }
    }
    const contents = new Set(
      (await this.store.list<{ unitId: string; contentId: string }>('content_unit'))
        .filter((unit) => unit.unitId === item.id)
        .map((unit) => unit.contentId),
    );
    for (const ref of await this.store.list<{ contentId: string; bytes: number }>('content_ref'))
      if (contents.delete(ref.contentId)) size += ref.bytes;
    return size;
  }

  /**
   * 普通查询只统计调用方可见对象；directory 提供全目录聚合统计，不返回对象明细。
   * 逻辑容量含去重后的内容文件，物理容量另计 SQLite/WAL 等实际文件占用。
   */
  async usage(ctx: Context, directory = false) {
    const categories: Record<
      string,
      { count: number; bytes: number; protectedBytes: number; eligibleBytes: number }
    > = {};
    let logicalBytes = 0;
    const visibleObjects = new Set<string>();
    if (!directory)
      for (const session of await this.store.list<SessionRecord>('session')) {
        try {
          access(ctx, session);
          visibleObjects.add(session.id);
        } catch {
          /* 不计入其他归属。 */
        }
      }
    for (const kind of ['task', 'operation', 'segment'] as const) {
      const category = { count: 0, bytes: 0, protectedBytes: 0, eligibleBytes: 0 };
      categories[kind === 'segment' ? 'session_event_segment' : kind] = category;
      for (const item of await this.store.list<HistoryItem>(kind)) {
        if (item.purged) continue;
        if (!directory) {
          try {
            await this.authorized(ctx, kind, item);
          } catch {
            continue;
          }
        }
        visibleObjects.add(item.id);
        let size = bytes(item);
        if (kind === 'segment') size += (item as SegmentRecord).bytes;
        else {
          const streamId = kind === 'operation' ? item.id : item.sessionId!;
          let after = '0';
          while (true) {
            const page = await this.store.readEvents({
              streamId,
              after,
              limit: 500,
              ...(kind === 'task' ? { taskId: item.id } : {}),
            });
            const selected = page.items.slice(0, 500);
            size += selected.reduce((total, event) => total + event.bytes, 0);
            if (page.items.length <= 500) break;
            after = selected.at(-1)!.seq;
          }
        }
        category.count++;
        category.bytes += size;
        if (await this.eligible(kind, item)) category.eligibleBytes += size;
        else category.protectedBytes += size;
      }
      logicalBytes += category.bytes;
    }
    const refs = (
      await this.store.list<{ id: string; objectId: string; contentId: string; bytes: number }>(
        'content_ref',
      )
    ).filter((ref) => directory || visibleObjects.has(ref.objectId));
    const contentBytes = [
      ...new Map(refs.map((ref) => [ref.contentId, ref.bytes])).values(),
    ].reduce((a, b) => a + b, 0);
    let physicalBytes = 0;
    for (const dir of [this.events.paths.stateDir, this.events.paths.contentDir]) {
      try {
        for (const file of await readdir(dir)) {
          const info = await stat(join(dir, file));
          if (info.isFile()) physicalBytes += info.size;
        }
      } catch {
        /* 空目录。 */
      }
    }
    return {
      categories,
      logicalBytes: logicalBytes + contentBytes,
      contentBytes,
      physicalBytes: directory ? physicalBytes : null,
      retentionDays: this.runtimes.settings.retentionDays,
      maxBytes: this.runtimes.settings.historyMaxBytes,
    };
  }

  /** 只生成预览，按结束时间优先选择旧数据；候选修订一起参与摘要以供 apply 复核。 */
  async plan(
    ctx: Context,
    args: {
      scope?: CleanupScope | undefined;
      endedBefore?: string | undefined;
      targetBytes?: number | undefined;
    },
  ) {
    const scope = args.scope ?? { kind: 'all' };
    if (scope.kind === 'session_events')
      for (const activationId of scope.selector?.endedActivationIds ?? []) {
        const activation = await this.store.get<ActivationRecord>('activation', activationId);
        if (!activation || activation.sessionId !== scope.sessionId || !activation.endedAt)
          fail('INVALID_CLEANUP_SCOPE', '只能清理所选会话已结束激活代次。');
      }
    const candidates: Candidate[] = [];
    const protectedObjects: { id: string; reason: string }[] = [];
    for (const kind of ['task', 'operation', 'segment'] as const) {
      if (
        scope.kind !== 'all' &&
        (scope.kind === 'tasks'
          ? kind !== 'task'
          : scope.kind === 'operations'
            ? kind !== 'operation'
            : kind !== 'segment')
      )
        continue;
      for (const item of await this.store.list<HistoryItem>(kind)) {
        if ('sessionId' in scope && scope.sessionId && item.sessionId !== scope.sessionId) continue;
        if (
          scope.kind === 'session_events' &&
          scope.selector?.segmentIds &&
          !scope.selector.segmentIds.includes(item.id)
        )
          continue;
        if (
          scope.kind === 'session_events' &&
          scope.selector?.endedActivationIds &&
          !scope.selector.endedActivationIds.includes((item as SegmentRecord).activationId)
        )
          continue;
        try {
          await this.authorized(ctx, kind, item, true);
        } catch {
          continue;
        }
        const endedAt =
          kind === 'segment' ? (item as SegmentRecord).sealedAt : (item as WorkRecord).endedAt;
        if (args.endedBefore && (!endedAt || endedAt >= args.endedBefore)) continue;
        if (!(await this.eligible(kind, item))) {
          if (!item.purged)
            protectedObjects.push({ id: item.id, reason: '活动对象、开放分段或有活动引用' });
          continue;
        }
        candidates.push({
          kind,
          id: item.id,
          revision: item.revision,
          ...(item.sessionId ? { sessionId: item.sessionId } : {}),
          bytes: await this.estimatedBytes(kind, item),
          endedAt: endedAt!,
        });
      }
    }
    candidates.sort((a, b) => a.endedAt.localeCompare(b.endedAt));
    if (args.targetBytes) {
      let selected = 0;
      let total = 0;
      while (selected < candidates.length && total < args.targetBytes)
        total += candidates[selected++]!.bytes;
      candidates.splice(selected);
    }
    const plan: CleanupPlan = {
      id: id('cleanup'),
      revision: 1,
      createdAt: now(),
      ownerId: ctx.principalId,
      scope,
      candidates,
      planDigest: digest(candidates),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    await this.store.put('cleanup_plan', plan);
    return {
      cleanupPlanId: plan.id,
      planDigest: plan.planDigest,
      expiresAt: plan.expiresAt,
      candidates,
      protectedObjects,
      estimatedBytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
      dryRun: true,
    };
  }

  /** 应用前重新检查归属、修订和活动引用，预览后发生变化的对象必须重新生成方案。 */
  async apply(ctx: Context, cleanupPlanId: string, planDigest: string) {
    const plan = await this.store.get<CleanupPlan>('cleanup_plan', cleanupPlanId);
    if (!plan || plan.ownerId !== ctx.principalId) fail('OBJECT_NOT_FOUND', '清理方案不存在。');
    if (plan.expiresAt < now()) fail('PLAN_EXPIRED', '清理方案已过期。');
    if (planDigest !== plan.planDigest) fail('PLAN_CHANGED', '清理摘要不匹配。');
    const checks: Check[] = [];
    for (const candidate of plan.candidates) {
      const item = await this.store.get<HistoryItem>(candidate.kind, candidate.id);
      if (!item || item.revision !== candidate.revision)
        fail('PLAN_CHANGED', '候选已变化，请重新预览。');
      await this.authorized(ctx, candidate.kind, item, true);
      if (!(await this.eligible(candidate.kind, item)))
        fail('OBJECT_IN_USE', '候选在预览后出现活动引用。');
      checks.push({ kind: candidate.kind, id: item.id, revision: item.revision });
      if (item.sessionId) {
        const session = await this.store.get<SessionRecord>('session', item.sessionId);
        if (session) {
          checks.push({ kind: 'session', id: session.id, revision: session.revision });
          const runtime = await this.store.get<RuntimeRecord>('runtime', session.runtimeId);
          if (runtime) checks.push({ kind: 'runtime', id: runtime.id, revision: runtime.revision });
        }
      }
    }
    const before = await this.usage(ctx, true);
    const taskIds = plan.candidates.filter((item) => item.kind === 'task').map((item) => item.id);
    const operationIds = plan.candidates
      .filter((item) => item.kind === 'operation')
      .map((item) => item.id);
    const segmentIds = plan.candidates
      .filter((item) => item.kind === 'segment')
      .map((item) => item.id);
    const result = await this.store.call<{ deletedEvents: number }>('purge', {
      taskIds,
      operationIds,
      segmentIds,
      checks,
    });
    // 先把事件变为可追踪的墓碑，再解除清理单元的内容引用；其他对象仍引用的文件要保留。
    const deleted = new Set(plan.candidates.map((candidate) => candidate.id));
    const contentIds = new Set(
      (await this.store.list<{ unitId: string; contentId: string }>('content_unit'))
        .filter((unit) => deleted.has(unit.unitId))
        .map((unit) => unit.contentId),
    );
    let releasedContentBytes = 0;
    for (const contentId of contentIds)
      await this.store.locked(`content:${contentId}`, async () => {
        const units = (
          await this.store.list<{
            id: string;
            unitId: string;
            objectId: string;
            contentId: string;
          }>('content_unit')
        ).filter((unit) => unit.contentId === contentId);
        const removed = units.filter((unit) => deleted.has(unit.unitId));
        const kept = units.filter((unit) => !deleted.has(unit.unitId));
        const refsToRemove = removed.filter(
          (unit) => !kept.some((other) => other.objectId === unit.objectId),
        );
        await this.store.commit({
          deletes: [
            ...removed.map((unit) => ({ kind: 'content_unit', id: unit.id })),
            ...refsToRemove.map((unit) => ({
              kind: 'content_ref',
              id: `${unit.objectId}:${unit.contentId}`,
            })),
          ],
        });
        if (
          !(await this.store.list<{ contentId: string }>('content_ref')).some(
            (ref) => ref.contentId === contentId,
          )
        ) {
          const path = join(this.events.paths.contentDir, contentId);
          try {
            releasedContentBytes += (await stat(path)).size;
            await rm(path);
          } catch {
            /* 已回收或文件不存在。 */
          }
        }
      });
    const after = await this.usage(ctx, true);
    return {
      ...result,
      deletedCount: {
        task: taskIds.length,
        operation: operationIds.length,
        session_event_segment: segmentIds.length,
      },
      logicalBytesReclaimed: Math.max(0, before.logicalBytes - after.logicalBytes),
      physicalBytesReclaimed: releasedContentBytes,
      dryRun: false,
    };
  }

  /** 先执行时间保留策略，再为超出逻辑容量的部分选择最旧候选；两者复用同一清理校验。 */
  async retain(ctx: Context) {
    const plan = await this.plan(ctx, {
      endedBefore: new Date(
        Date.now() - this.runtimes.settings.retentionDays * 86_400_000,
      ).toISOString(),
    });
    if (plan.candidates.length) await this.apply(ctx, plan.cleanupPlanId, plan.planDigest);
    const usage = await this.usage(ctx, true);
    if (usage.logicalBytes > usage.maxBytes) {
      const capacity = await this.plan(ctx, { targetBytes: usage.logicalBytes - usage.maxBytes });
      if (capacity.candidates.length)
        await this.apply(ctx, capacity.cleanupPlanId, capacity.planDigest);
    }
  }
}
