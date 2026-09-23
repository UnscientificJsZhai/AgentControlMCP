import { realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { access } from '../domain/access-control.js';
import { fail } from '../domain/errors.js';
import { digest, id, now } from '../domain/ids.js';
import type {
  Context,
  InteractionRecord,
  RuntimeRecord,
  SessionRecord,
  WorkRecord,
} from '../domain/models.js';
import type { OperationDescription } from '../domain/permission-policy.js';
import type { PermissionPolicy } from '../domain/schemas.js';
import { decide } from '../domain/permission-policy.js';
import { checkedPath, inside } from '../infrastructure/platform/file-callbacks.js';
import { redact } from '../infrastructure/platform/environment.js';
import type { SqliteStore } from '../infrastructure/storage/sqlite-store.js';
import { row } from '../infrastructure/storage/sqlite-store.js';
import type { RuntimeService } from './runtime-service.js';
import type { TaskService } from './task-service.js';
import { idem, Serial } from './common.js';

export type PermissionDecision =
  { kind: 'acp_option'; optionId: string } | { kind: 'cancel' } | { kind: 'host'; allow: boolean };

/**
 * 将下游权限请求及表单交互转为可查询的持久化记录，同时在原连接上等待答复。
 * 决策先落盘再交付，实例退出或连接代次变化后不能把旧答复发送给新连接。
 */
export class InteractionService {
  inheritedPolicies: (
    session: SessionRecord,
  ) => Promise<{ policy: PermissionPolicy; roots: string[] }[]> = () => Promise.resolve([]);
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; timer?: NodeJS.Timeout }
  >();
  private readonly receipts = new Map<
    string,
    { interactionId: string; principalId: string; digest: string }
  >();
  private readonly serial = new Serial();

  constructor(
    readonly store: SqliteStore,
    readonly runtimes: RuntimeService,
    readonly tasks: TaskService,
  ) {}

  async get(ctx: Context, interactionId: string, control = false) {
    const record = await this.store.get<InteractionRecord>('interaction', interactionId);
    if (!record) return fail('OBJECT_NOT_FOUND', '交互不存在。');
    if (record.sessionId) {
      const session = await this.store.get<SessionRecord>('session', record.sessionId);
      if (!session) return fail('SESSION_NOT_FOUND', '会话不存在。');
      access(ctx, session, control ? 'control' : 'read');
    } else await this.runtimes.get(ctx, record.runtimeId);
    return record;
  }

  async list(
    ctx: Context,
    filter: {
      sessionId?: string | undefined;
      taskId?: string | undefined;
      operationId?: string | undefined;
      state?: string | undefined;
    },
    permissions: boolean,
  ) {
    const items: InteractionRecord[] = [];
    for (const item of await this.store.list<InteractionRecord>('interaction')) {
      if (
        (item.type === 'permission' || item.type === 'host_permission') !== permissions ||
        (filter.sessionId && item.sessionId !== filter.sessionId) ||
        (filter.taskId && item.taskId !== filter.taskId) ||
        (filter.operationId && item.operationId !== filter.operationId) ||
        (filter.state === 'resolved'
          ? item.state === 'pending'
          : item.state !== (filter.state ?? 'pending'))
      )
        continue;
      try {
        items.push(await this.get(ctx, item.id));
      } catch {
        /* 不泄露其他身份的交互。 */
      }
    }
    return items;
  }

  /** 路径必须可解析且位于授权工作区；规则的空 roots 在这里展开为会话工作目录集合。 */
  private async policy(runtimeId: string, description: OperationDescription | null) {
    const runtime = await this.store.get<RuntimeRecord>('runtime', runtimeId);
    const handle = this.runtimes.live.get(runtimeId);
    if (!runtime || !handle?.sessionId || !description) return 'ask' as const;
    const session = await this.store.get<SessionRecord>('session', handle.sessionId);
    if (!session) return 'ask' as const;
    const roots = [session.cwd, ...session.additionalDirectories];
    const paths: string[] = [];
    for (const path of description.paths) {
      try {
        paths.push(await checkedPath(path, roots, description.operation === 'write'));
      } catch {
        return 'ask' as const;
      }
    }
    const policy = {
      ...runtime.snapshot.permissionPolicy,
      rules: await Promise.all(
        runtime.snapshot.permissionPolicy.rules.map(async (rule) => ({
          ...rule,
          roots: await Promise.all(rule.roots.map((root) => realpath(root).catch(() => root))),
        })),
      ),
    };
    const own = decide(policy, { ...description, paths }, (path, ruleRoots) =>
      (ruleRoots.length ? ruleRoots : roots).some((root) => inside(root, path)),
    );
    const inherited = await this.inheritedPolicies(session);
    const results = await Promise.all(
      inherited.map(async ({ policy: parentPolicy, roots: parentRoots }) => {
        const normalized = {
          ...parentPolicy,
          rules: await Promise.all(
            parentPolicy.rules.map(async (rule) => ({
              ...rule,
              roots: await Promise.all(rule.roots.map((root) => realpath(root).catch(() => root))),
            })),
          ),
        };
        return decide(normalized, { ...description, paths }, (path, ruleRoots) =>
          (ruleRoots.length ? ruleRoots : parentRoots).some((root) => inside(root, path)),
        );
      }),
    );
    return [own, ...results].includes('deny')
      ? 'deny'
      : [own, ...results].every((r) => r === 'allow_once')
        ? 'allow_once'
        : 'ask';
  }

  /** 只从明确的 read 类型和路径推导自动授权；其他描述保留原始 ACP 选项交给用户。 */
  async permission(
    runtimeId: string,
    request: RequestPermissionRequest,
    signal: AbortSignal,
    requestId: string | number | null,
  ) {
    const operation: OperationDescription | null =
      request.toolCall.kind === 'read' && request.toolCall.locations?.length
        ? { operation: 'read', paths: request.toolCall.locations.map((location) => location.path) }
        : null;
    const policy = await this.policy(runtimeId, operation);
    const option = request.options.find(
      (item) =>
        item.kind ===
        (policy === 'allow_once' ? 'allow_once' : policy === 'deny' ? 'reject_once' : ''),
    );
    if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } };
    return this.open(runtimeId, 'permission', request, signal, requestId);
  }

  async host(runtimeId: string, description: OperationDescription, signal: AbortSignal) {
    const policy = await this.policy(runtimeId, description);
    if (policy === 'allow_once') return;
    if (policy === 'deny') fail('ACCESS_DENIED', '宿主操作被预设策略拒绝。');
    const result = (await this.open(
      runtimeId,
      'host_permission',
      description as unknown as Record<string, unknown>,
      signal,
      null,
    )) as { allow: boolean };
    if (!result.allow) fail('ACCESS_DENIED', '宿主操作未获批准。');
  }

  /** 保存脱敏请求并挂起回调；同时限制待处理数量，取消或超时均按拒绝方向收尾。 */
  async open(
    runtimeId: string,
    type: InteractionRecord['type'],
    request: Record<string, unknown>,
    signal: AbortSignal,
    requestId: string | number | null,
  ) {
    const runtime = await this.store.get<RuntimeRecord>('runtime', runtimeId);
    const handle = this.runtimes.live.get(runtimeId);
    if (!runtime || !handle) fail('DOWNSTREAM_EXITED', '交互所属 Runtime 已结束。');
    const session = handle.sessionId
      ? await this.store.get<SessionRecord>('session', handle.sessionId)
      : null;
    if (
      session &&
      typeof request.sessionId === 'string' &&
      session.downstreamSessionId &&
      request.sessionId !== session.downstreamSessionId
    )
      fail('PROTOCOL_ERROR', '交互会话关联无效。');
    if (
      (type === 'form' || type === 'url' || type === 'terminal_auth') &&
      handle.channel === 'none'
    )
      fail(
        'INTERACTION_CHANNEL_UNAVAILABLE',
        '需要在连接器宿主机附加 CLI 或支持用户交互的 MCP 客户端。',
      );
    if (
      (await this.store.list<InteractionRecord>('interaction')).filter(
        (item) => item.runtimeId === runtimeId && item.state === 'pending',
      ).length >= 64
    )
      fail('CAPACITY_EXCEEDED', '待处理交互过多。');
    const timeout = runtime.snapshot.permissionPolicy.timeoutMs;
    const record: InteractionRecord = {
      id: id('int'),
      revision: 1,
      createdAt: now(),
      ownerId: runtime.ownerId,
      instanceId: runtime.instanceId,
      runtimeId,
      connectionGeneration: runtime.connectionGeneration,
      ...(session ? { sessionId: session.id } : {}),
      ...(session?.activeTaskId ? { taskId: session.activeTaskId } : {}),
      ...(handle.operationId ? { operationId: handle.operationId } : {}),
      ...(requestId !== null ? { requestId } : {}),
      type,
      state: 'pending',
      request: redact(request, handle.secrets),
      expiresAt: timeout ? new Date(Date.now() + timeout).toISOString() : null,
      channel: handle.channel,
    };
    await this.store.put('interaction', record);
    const result = new Promise<unknown>((resolve) => {
      const entry: { resolve: (value: unknown) => void; timer?: NodeJS.Timeout } = { resolve };
      if (timeout)
        entry.timer = setTimeout(() => {
          void this.end(record.id, 'expired');
        }, timeout);
      this.pending.set(record.id, entry);
    });
    const abort = () => {
      void this.end(record.id, 'cancelled');
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    if (record.taskId) await this.tasks.update(record.taskId, { state: 'waiting_interaction' });
    else if (record.operationId)
      await this.runtimes.operations.update(record.operationId, { state: 'waiting_interaction' });
    try {
      return await result;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  async end(interactionId: string, state: 'cancelled' | 'expired') {
    return this.serial.run(interactionId, async () => {
      const record = await this.store.get<InteractionRecord>('interaction', interactionId);
      if (!record || record.state !== 'pending') return;
      await this.store.put('interaction', { ...record, state, revision: record.revision + 1 });
      this.deliver(
        record,
        record.type === 'permission'
          ? { outcome: { outcome: 'cancelled' } }
          : record.type === 'host_permission'
            ? { allow: false }
            : { action: 'cancel' },
      );
      await this.resume(record);
    });
  }

  private deliver(record: InteractionRecord, result: unknown) {
    const pending = this.pending.get(record.id);
    clearTimeout(pending?.timer);
    this.pending.delete(record.id);
    pending?.resolve(result);
  }

  /** 同一 Runtime 的待处理交互全部结束后，才将关联任务或操作恢复为 running。 */
  private async resume(record: InteractionRecord) {
    const remaining = (await this.store.list<InteractionRecord>('interaction')).some(
      (item) => item.runtimeId === record.runtimeId && item.state === 'pending',
    );
    if (!remaining && record.taskId) {
      const task = await this.store.get<WorkRecord>('task', record.taskId);
      if (task?.state === 'waiting_interaction')
        await this.tasks.update(record.taskId, { state: 'running' });
    } else if (!remaining && record.operationId)
      await this.runtimes.operations.update(record.operationId, { state: 'running' });
  }

  async respondPermission(
    ctx: Context,
    args: {
      interactionId: string;
      expectedRevision: number;
      idempotencyKey: string;
      decision: PermissionDecision;
    },
  ) {
    const record = await this.get(ctx, args.interactionId, true);
    const replay = await this.store.replay(idem(ctx, 'permission_respond', args, null));
    if (replay) return replay;
    let response: unknown;
    if (args.decision.kind === 'cancel')
      response =
        record.type === 'permission' ? { outcome: { outcome: 'cancelled' } } : { allow: false };
    else if (record.type === 'host_permission' && args.decision.kind === 'host')
      response = { allow: args.decision.allow };
    else if (record.type === 'permission' && args.decision.kind === 'acp_option') {
      const options = record.request.options as { optionId: string }[];
      const optionId = args.decision.optionId;
      if (!options.some((item) => item.optionId === optionId))
        fail('INVALID_PERMISSION_OPTION', '必须选择此请求的原始权限选项。');
      response = { outcome: { outcome: 'selected', optionId } };
    } else fail('INVALID_PERMISSION_OPTION', '答复类型与交互不匹配。');
    return this.respond(ctx, record, args, response, 'permission_respond');
  }

  /** 委托者只能批准自身预先获准的操作；不能把自己的 ask 通过子成员变成 allow。 */
  async mayDelegateApproval(
    runtimeId: string,
    record: InteractionRecord,
    decision: PermissionDecision,
  ) {
    if (decision.kind === 'cancel' || (decision.kind === 'host' && !decision.allow)) return true;
    let description: OperationDescription | null = null;
    if (decision.kind === 'acp_option') {
      const option = (record.request.options as { optionId: string; kind: string }[]).find(
        (o) => o.optionId === decision.optionId,
      );
      if (option?.kind.startsWith('reject')) return true;
      if (option?.kind !== 'allow_once') return false;
      const call = record.request.toolCall as { kind: string; locations?: { path: string }[] };
      if (call.kind === 'read' && call.locations?.length)
        description = { operation: 'read', paths: call.locations.map((l) => l.path) };
    } else if (record.type === 'host_permission')
      description = record.request as unknown as OperationDescription;
    return (await this.policy(runtimeId, description)) === 'allow_once';
  }

  /** 由真实交互通道签发一次性审阅收据，绑定身份、交互和完整响应内容。 */
  receipt(ctx: Context, interactionId: string, response: unknown) {
    const token = randomBytes(32).toString('base64url');
    this.receipts.set(token, {
      interactionId,
      principalId: ctx.principalId,
      digest: digest(response),
    });
    return token;
  }

  async respondInteraction(
    ctx: Context,
    args: {
      interactionId: string;
      expectedRevision: number;
      idempotencyKey: string;
      action: 'accept' | 'decline' | 'cancel';
      content?: Record<string, unknown> | undefined;
      presentationReceipt?: string | undefined;
    },
  ) {
    const record = await this.get(ctx, args.interactionId, true);
    const replay = await this.store.replay(idem(ctx, 'interaction_respond', args, null));
    if (replay) return replay;
    if (record.type === 'permission' || record.type === 'host_permission')
      fail('CONFIG_INVALID', '权限请求请使用 permission_respond。');
    const response = { action: args.action, ...(args.content ? { content: args.content } : {}) };
    if (args.action === 'accept') {
      const receipt = this.receipts.get(args.presentationReceipt ?? '');
      if (
        !receipt ||
        receipt.principalId !== ctx.principalId ||
        receipt.interactionId !== record.id ||
        receipt.digest !== digest(response)
      )
        fail('INTERACTION_CHANNEL_UNAVAILABLE', '接受交互必须有真实用户审阅收据。');
    } else if (args.content) fail('CONFIG_INVALID', '拒绝或取消不能提交表单内容。');
    return this.respond(ctx, record, args, response, 'interaction_respond');
  }

  /** 在串行区内重新授权并检查收据，避免并发答复重复消费或权限撤销后仍提交决策。 */
  private async respond(
    ctx: Context,
    initial: InteractionRecord,
    args: {
      expectedRevision: number;
      idempotencyKey: string;
      presentationReceipt?: string | undefined;
    },
    response: unknown,
    method: string,
  ) {
    return this.serial.run(initial.id, async () => {
      const record = await this.get(ctx, initial.id, true);
      const replay = await this.store.replay(idem(ctx, method, args, null));
      if (replay) return replay;
      if (
        method === 'interaction_respond' &&
        (response as { action: string }).action === 'accept'
      ) {
        const receipt = this.receipts.get(args.presentationReceipt ?? '');
        if (
          !receipt ||
          receipt.principalId !== ctx.principalId ||
          receipt.interactionId !== record.id ||
          receipt.digest !== digest(response)
        )
          fail('INTERACTION_CHANNEL_UNAVAILABLE', '审阅收据无效或已消费。');
      }
      const runtime = await this.runtimes.get(ctx, record.runtimeId, true);
      if (runtime.connectionGeneration !== record.connectionGeneration)
        fail('RUNTIME_GENERATION_CONFLICT', '交互来自旧连接代次。');
      if (record.state !== 'pending')
        fail(
          record.state === 'expired'
            ? 'INTERACTION_EXPIRED'
            : record.state === 'cancelled'
              ? 'INTERACTION_CANCELLED'
              : 'INTERACTION_ALREADY_RESOLVED',
          '交互已不再等待答复。',
        );
      if (!this.pending.has(record.id)) fail('INSTANCE_MISMATCH', '请连接交互所属实例。');
      const session = record.sessionId
        ? await this.tasks.sessions.get(ctx, record.sessionId, 'control')
        : null;
      await this.store.commit({
        checks: [
          { kind: 'interaction', id: record.id, revision: args.expectedRevision },
          ...(session ? [{ kind: 'session', id: session.id, revision: session.revision }] : []),
        ],
        puts: [
          row('interaction', {
            ...record,
            revision: record.revision + 1,
            state: 'decided',
            decision: response,
          }),
        ],
        idempotency: idem(ctx, method, args, { interactionId: record.id, state: 'decided' }),
      });
      // 提交成功后才消费收据并唤醒原请求；写入连接的完成状态由 responded 单独记录。
      if (args.presentationReceipt) this.receipts.delete(args.presentationReceipt);
      this.deliver(record, response);
      await this.resume(record);
      return { interactionId: record.id, state: 'decided' };
    });
  }

  /** 仅由 ACP 输出流确认响应写入后调用；这不表示下游已完成获准的实际操作。 */
  async responded(runtimeId: string, requestId: string | number | null) {
    for (const record of await this.store.list<InteractionRecord>('interaction'))
      if (
        record.runtimeId === runtimeId &&
        record.requestId === requestId &&
        record.state === 'decided'
      )
        await this.store.put('interaction', {
          ...record,
          state: 'responded',
          revision: record.revision + 1,
        });
  }

  async complete(runtimeId: string, elicitationId: string) {
    for (const record of await this.store.list<InteractionRecord>('interaction'))
      if (
        record.runtimeId === runtimeId &&
        record.type === 'url' &&
        record.request.elicitationId === elicitationId
      )
        await this.store.put('interaction', {
          ...record,
          completed: true,
          revision: record.revision + 1,
        });
  }

  async cancel(runtimeId: string, taskId?: string) {
    for (const record of await this.store.list<InteractionRecord>('interaction'))
      if (
        record.runtimeId === runtimeId &&
        (!taskId || record.taskId === taskId) &&
        record.state === 'pending'
      )
        await this.end(record.id, 'cancelled');
  }
}
