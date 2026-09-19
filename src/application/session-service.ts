import { realpath } from 'node:fs/promises';
import type {
  McpServer,
  NewSessionRequest,
  SessionConfigOption,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { access, visible } from '../domain/access-control.js';
import { AppError, fail } from '../domain/errors.js';
import { digest, id, now } from '../domain/ids.js';
import type {
  ActivationRecord,
  Context,
  Principal,
  RuntimeRecord,
  SessionRecord,
  WorkRecord,
} from '../domain/models.js';
import type { AgentConfig } from '../domain/schemas.js';
import { requireCapability, validateOption } from '../infrastructure/acp/capability-gate.js';
import { resolveValue } from '../infrastructure/platform/environment.js';
import type { SqliteStore } from '../infrastructure/storage/sqlite-store.js';
import { row } from '../infrastructure/storage/sqlite-store.js';
import type { EventService } from './event-service.js';
import type { OperationService } from './operation-service.js';
import type { RuntimeService } from './runtime-service.js';
import type { RuntimeInput } from './runtime-service.js';
import { idem, Serial } from './common.js';

export interface CreateInput {
  idempotencyKey: string;
  configId?: string | undefined;
  configRevision?: number | undefined;
  cwd?: string | undefined;
  interactionChannel?: string | undefined;
  runtimeId?: string | undefined;
  expectedConnectionGeneration?: number | undefined;
  expectedRuntimeRevision?: number | undefined;
  additionalDirectories?: string[] | undefined;
  mcpServers?: AgentConfig['mcpServers'] | undefined;
  options?: Record<string, string | boolean> | undefined;
  modeId?: string | undefined;
}
interface RestorePlan {
  id: string;
  revision: number;
  createdAt: string;
  ownerId: string;
  sessionId: string;
  method: 'load' | 'resume';
  configId: string;
  configRevision: number;
  environmentDigest: string;
  expiresAt: string;
}
export class SessionService {
  readonly serial = new Serial();
  private readonly controls = new Set<string>();
  assertLifecycleAvailable(session: SessionRecord | null, runtimeId: string, allowPrompt = false) {
    if (
      this.runtimes.lifecycle.has(runtimeId) ||
      (session && (this.controls.has(session.id) || (!allowPrompt && session.activeTaskId)))
    )
      fail('SESSION_BUSY', '需要当前会话控制、认证及 prompt 结束。');
  }
  cancelTask: (ctx: Context, taskId: string) => Promise<unknown> = async () => {};
  constructor(
    readonly store: SqliteStore,
    readonly runtimes: RuntimeService,
    readonly operations: OperationService,
    readonly events: EventService,
  ) {}
  async get(ctx: Context, sessionId: string, level: 'read' | 'control' | 'owner' = 'read') {
    const session = await this.store.get<SessionRecord>('session', sessionId);
    if (!session) return fail('SESSION_NOT_FOUND', '会话不存在。');
    access(ctx, session, level);
    return session;
  }
  async list(ctx: Context, configId?: string) {
    return (await this.store.list<SessionRecord>('session')).filter(
      (item) => visible(ctx, item) && (!configId || item.configId === configId),
    );
  }
  async view(ctx: Context, sessionId: string) {
    const session = await this.get(ctx, sessionId);
    const runtime = await this.runtimes.get(ctx, session.runtimeId);
    return {
      ...session,
      sessionId: session.id,
      runtimeRevision: runtime.revision,
      connectionGeneration: runtime.connectionGeneration,
      authState: runtime.authState,
      capabilities: runtime.initialize?.agentCapabilities,
      configRevision: runtime.configRevision,
    };
  }
  async mutate(sessionId: string, fn: (session: SessionRecord) => SessionRecord) {
    return this.serial.run(sessionId, async () => {
      const session = await this.store.get<SessionRecord>('session', sessionId);
      if (!session) return fail('SESSION_NOT_FOUND', '会话不存在。');
      const next = { ...fn(session), revision: session.revision + 1 };
      await this.store.commit({
        checks: [{ kind: 'session', id: sessionId, revision: session.revision }],
        puts: [row('session', next)],
      });
      return next;
    });
  }
  async runtime(ctx: Context, sessionId: string) {
    const session = await this.get(ctx, sessionId, 'control');
    if (session.state !== 'ready') fail('DOWNSTREAM_EXITED', '会话当前不可运行，请显式恢复。');
    const record = await this.runtimes.get(ctx, session.runtimeId, true);
    return { session, record, handle: this.runtimes.handle(record) };
  }
  async params(
    runtime: RuntimeRecord,
    additionalDirectories: string[],
    mcpServers: AgentConfig['mcpServers'],
  ): Promise<NewSessionRequest> {
    const handle = this.runtimes.handle(runtime);
    const caps = handle.client.initialize.agentCapabilities ?? {};
    if (additionalDirectories.length && caps.sessionCapabilities?.additionalDirectories == null)
      fail('CAPABILITY_UNSUPPORTED', '下游不支持额外工作目录。');
    const servers: McpServer[] = [];
    for (const server of mcpServers) {
      if (server.type === 'stdio') {
        if (/agent-control-mcp/.test([server.command, ...server.args].join(' ')))
          fail('CONFIG_INVALID', '拒绝直接递归挂载连接器。');
        servers.push({
          name: server.name,
          command: server.command,
          args: server.args,
          env: await Promise.all(
            Object.entries(server.env).map(async ([name, value]) => {
              const resolved = await resolveValue(value);
              if (value.kind !== 'literal') handle.secrets.push(resolved);
              return { name, value: resolved };
            }),
          ),
        });
      } else {
        if (!caps.mcpCapabilities?.[server.type])
          fail('CAPABILITY_UNSUPPORTED', `下游不支持 ${server.type} MCP 服务。`);
        servers.push({
          type: server.type,
          name: server.name,
          url: server.url,
          headers: await Promise.all(
            Object.entries(server.headers).map(async ([name, value]) => {
              const resolved = await resolveValue(value);
              if (value.kind !== 'literal') handle.secrets.push(resolved);
              return { name, value: resolved };
            }),
          ),
        });
      }
    }
    return {
      cwd: runtime.cwd,
      additionalDirectories: await Promise.all(additionalDirectories.map((path) => realpath(path))),
      mcpServers: servers,
    };
  }
  async create(ctx: Context, args: CreateInput) {
    if (args.runtimeId) await this.runtimes.get(ctx, args.runtimeId, true);
    return this.operations.start(
      ctx,
      'session_create',
      args,
      async (operationId, signal) => {
        const runtime = args.runtimeId
          ? await this.runtimes.get(ctx, args.runtimeId, true)
          : await this.runtimes.prepareNow(ctx, args as RuntimeInput, operationId, signal);
        if (args.runtimeId)
          this.runtimes.guard(
            runtime,
            args.expectedRuntimeRevision!,
            args.expectedConnectionGeneration!,
          );
        if (runtime.state !== 'prepared' || this.runtimes.lifecycle.has(runtime.id))
          fail('RUNTIME_IN_USE', 'Runtime 已绑定、正在认证或结果未知。');
        if (Date.parse(runtime.expiresAt) < Date.now())
          fail('RUNTIME_EXPIRED', 'Runtime 准备已过期。');
        this.runtimes.lifecycle.add(runtime.id);
        const handle = this.runtimes.handle(runtime);
        let session: SessionRecord | undefined;
        try {
          const params = await this.params(
            runtime,
            args.additionalDirectories ?? [],
            args.mcpServers ?? runtime.snapshot.mcpServers,
          );
          const sessionId = id('ses');
          const activationId = id('act');
          session = {
            id: sessionId,
            revision: 1,
            createdAt: now(),
            ownerId: ctx.principalId,
            grants: {},
            instanceId: this.runtimes.instanceId,
            serviceId: ctx.serviceId,
            mode: ctx.mode,
            configId: runtime.configId,
            runtimeId: runtime.id,
            activationId,
            downstreamSessionId: '',
            namespace:
              runtime.snapshot.sessionNamespace ??
              (runtime.snapshot.origin.kind === 'registry'
                ? `registry:${runtime.snapshot.origin.sourceId}:${runtime.snapshot.origin.registryAgentId}`
                : `command:${digest(runtime.snapshot.launch)}`),
            state: 'creating',
            cwd: runtime.cwd,
            additionalDirectories: params.additionalDirectories ?? [],
            snapshot: runtime.snapshot,
            options: [],
            modes: null,
            commands: [],
            controlVersion: 0,
          };
          const activation: ActivationRecord = {
            id: activationId,
            revision: 1,
            createdAt: now(),
            sessionId,
            runtimeId: runtime.id,
            instanceId: this.runtimes.instanceId,
            downstreamSessionId: '',
            startedAt: now(),
          };
          await this.store.commit({
            checks: [{ kind: 'runtime', id: runtime.id, revision: runtime.revision }],
            puts: [
              row('runtime', { ...runtime, revision: runtime.revision + 1, state: 'binding' }),
              row('session', session),
              row('activation', activation),
            ],
          });
          handle.sessionId = sessionId;
          handle.operationId = operationId;
          await this.operations.update(operationId, { runtimeId: runtime.id, sessionId });
          const response = await handle.client.request(
            'session/new',
            params,
            this.runtimes.settings.controlTimeoutMs,
            signal,
          );
          const lease = `session:${digest([session.namespace, response.sessionId])}`;
          await this.store.commit({
            claims: [{ key: lease, holder: runtime.id }],
            puts: [
              row('activation', {
                ...activation,
                downstreamSessionId: response.sessionId,
                revision: 2,
              }),
            ],
          });
          await this.bind(sessionId, runtime.id, operationId, {
            downstreamSessionId: response.sessionId,
            options: response.configOptions ?? [],
            modes: response.modes ?? null,
          });
          this.runtimes.lifecycle.delete(runtime.id);
          for (const [optionId, value] of Object.entries(
            args.options ?? runtime.snapshot.sessionDefaults.options,
          )) {
            const current = await this.get(ctx, sessionId);
            await this.setOption(ctx, {
              sessionId,
              optionId,
              value,
              expectedRevision: current.revision,
              idempotencyKey: `${operationId}:${optionId}`,
            });
          }
          const modeId = args.modeId ?? runtime.snapshot.sessionDefaults.modeId;
          if (modeId) {
            const current = await this.get(ctx, sessionId);
            await this.setMode(ctx, {
              sessionId,
              modeId,
              expectedRevision: current.revision,
              idempotencyKey: `${operationId}:mode`,
            });
          }
          return this.view(ctx, sessionId);
        } catch (error) {
          if (
            (await this.store.get<WorkRecord>('operation', operationId))?.commitState ===
            'committed'
          )
            throw error;
          if (signal.aborted) {
            await this.runtimes.closeNow(runtime.id);
            throw error;
          }
          if (error instanceof AppError && error.code === 'AUTH_REQUIRED') {
            const updated = await this.runtimes.update(runtime.id, {
              state: 'prepared',
              authState: 'required',
            });
            delete handle.sessionId;
            if (session) {
              await this.mutate(session.id, (current) => ({ ...current, state: 'interrupted' }));
              await this.events.closeActivation(session.activationId);
            }
            throw new AppError('AUTH_REQUIRED', '请在保留的 Runtime 上完成认证，再显式创建会话。', {
              runtimeId: updated.id,
              runtimeRevision: updated.revision,
              connectionGeneration: updated.connectionGeneration,
              authMethods: handle.client.initialize.authMethods,
            });
          }
          await this.runtimes.update(runtime.id, { state: 'creation_unknown' });
          if (session)
            await this.mutate(session.id, (current) => ({ ...current, state: 'interrupted' }));
          throw error;
        } finally {
          this.runtimes.lifecycle.delete(runtime.id);
        }
      },
      args.runtimeId ? { runtimeId: args.runtimeId } : {},
    );
  }
  private async bind(
    sessionId: string,
    runtimeId: string,
    operationId: string,
    patch: Partial<SessionRecord>,
  ) {
    return this.serial.run(sessionId, () =>
      this.operations.serial.run(operationId, async () => {
        const session = (await this.store.get<SessionRecord>('session', sessionId))!;
        const runtime = (await this.store.get<RuntimeRecord>('runtime', runtimeId))!;
        const operation = (await this.store.get<WorkRecord>('operation', operationId))!;
        if (operation.state === 'cancelling' || operation.state === 'cancelled')
          fail('CANCELLED', '会话绑定提交前已取消。');
        await this.store.commit({
          checks: [
            { kind: 'session', id: sessionId, revision: session.revision },
            { kind: 'runtime', id: runtimeId, revision: runtime.revision },
            { kind: 'operation', id: operationId, revision: operation.revision },
          ],
          puts: [
            row('session', {
              ...session,
              ...patch,
              state: 'ready',
              revision: session.revision + 1,
            }),
            row('runtime', {
              ...runtime,
              state: 'bound',
              sessionId,
              revision: runtime.revision + 1,
            }),
            row('operation', {
              ...operation,
              commitState: 'committed',
              revision: operation.revision + 1,
            }),
          ],
        });
      }),
    );
  }
  async notification(runtimeId: string, notification: SessionNotification) {
    const sessionId = this.runtimes.live.get(runtimeId)?.sessionId;
    if (!sessionId) return;
    await this.serial.run(sessionId, async () => {
      const session = await this.store.get<SessionRecord>('session', sessionId);
      if (!session) return;
      if (session.downstreamSessionId && session.downstreamSessionId !== notification.sessionId)
        fail('PROTOCOL_ERROR', '下游更新的会话关联无效。');
      const update = notification.update;
      let projection: Record<string, unknown> | undefined;
      switch (update.sessionUpdate) {
        case 'config_option_update':
          projection = { options: update.configOptions };
          break;
        case 'current_mode_update':
          projection = { modes: { ...session.modes, currentModeId: update.currentModeId } };
          break;
        case 'available_commands_update':
          projection = { commands: update.availableCommands };
          break;
      }
      await this.events.append(session, update.sessionUpdate, update, projection);
    });
  }
  private async control(
    ctx: Context,
    args: { sessionId: string; expectedRevision: number; idempotencyKey: string },
    method: string,
    action: (session: SessionRecord, runtime: RuntimeRecord) => Promise<Partial<SessionRecord>>,
  ) {
    const claim = { id: id('ctl'), revision: 1, createdAt: now(), state: 'dispatching' };
    const admitted = await this.serial.run(args.sessionId, async () => {
      const { session, record } = await this.runtime(ctx, args.sessionId);
      const replay = await this.store.replay<{ controlId: string }>(idem(ctx, method, args, null));
      if (replay) return { session, record, replay };
      if (session.revision !== args.expectedRevision) fail('REVISION_CONFLICT', '会话修订已变化。');
      if (this.controls.has(session.id)) fail('CONTROL_BUSY', '另一会话控制请求尚未结束。');
      if (this.runtimes.lifecycle.has(record.id))
        fail('SESSION_BUSY', 'Runtime 正在执行生命周期操作。');
      this.controls.add(session.id);
      try {
        await this.store.commit({
          checks: [
            { kind: 'session', id: session.id, revision: session.revision },
            { kind: 'runtime', id: record.id, revision: record.revision },
          ],
          idempotency: idem(ctx, method, args, { controlId: claim.id }),
          puts: [row('control', claim)],
        });
      } catch (error) {
        this.controls.delete(session.id);
        throw error;
      }
      return { session, record, replay: null };
    });
    const { session, record } = admitted;
    if (admitted.replay) {
      const previous = await this.store.get<{ result?: unknown }>(
        'control',
        admitted.replay.controlId,
      );
      if (previous?.result) return previous.result;
      return fail('DISPATCH_OUTCOME_UNKNOWN', '此控制请求已经派发，请查询当前会话状态。');
    }
    try {
      const patch = await action(session, record);
      const next = await this.mutate(session.id, (current) =>
        current.controlVersion === session.controlVersion
          ? { ...current, ...patch, controlVersion: current.controlVersion + 1 }
          : current,
      );
      const result = {
        sessionId: next.id,
        revision: next.revision,
        configOptions: next.options,
        modes: next.modes,
      };
      await this.store.put('control', { ...claim, revision: 2, state: 'completed', result });
      return result;
    } finally {
      this.controls.delete(session.id);
    }
  }
  setOption(
    ctx: Context,
    args: {
      sessionId: string;
      optionId: string;
      value: string | boolean;
      expectedRevision: number;
      idempotencyKey: string;
    },
  ) {
    return this.control(ctx, args, 'session_set_option', async (session, runtime) => {
      validateOption(session.options as SessionConfigOption[], args.optionId, args.value);
      const result = await this.runtimes.handle(runtime).client.request(
        'session/set_config_option',
        {
          sessionId: session.downstreamSessionId,
          configId: args.optionId,
          ...(typeof args.value === 'boolean'
            ? { type: 'boolean' as const, value: args.value }
            : { value: args.value }),
        },
        this.runtimes.settings.controlTimeoutMs,
      );
      return { options: result.configOptions };
    });
  }
  setMode(
    ctx: Context,
    args: { sessionId: string; modeId: string; expectedRevision: number; idempotencyKey: string },
  ) {
    return this.control(ctx, args, 'session_set_mode', async (session, runtime) => {
      const modes = session.modes?.availableModes as { id: string }[] | undefined;
      if (!modes?.some((mode) => mode.id === args.modeId))
        fail('CAPABILITY_UNSUPPORTED', '下游未公布此模式。');
      await this.runtimes
        .handle(runtime)
        .client.request(
          'session/set_mode',
          { sessionId: session.downstreamSessionId, modeId: args.modeId },
          this.runtimes.settings.controlTimeoutMs,
        );
      return { modes: { ...session.modes, currentModeId: args.modeId } };
    });
  }
  async ownership(
    ctx: Context,
    method: 'share' | 'unshare' | 'transfer',
    args: {
      sessionId: string;
      expectedRevision: number;
      idempotencyKey: string;
      principalId?: string | undefined;
      targetPrincipalId?: string | undefined;
      access?: 'read' | 'control' | undefined;
      retainPreviousOwnerAs?: 'read' | 'control' | undefined;
    },
  ) {
    return this.serial.run(args.sessionId, async () => {
      const session = await this.get(ctx, args.sessionId, 'owner');
      if (
        (ctx.mode !== 'http' && !ctx.admin) ||
        session.mode !== 'http' ||
        session.serviceId !== ctx.serviceId ||
        session.instanceId !== this.runtimes.instanceId
      )
        fail('INSTANCE_MISMATCH', '共享与移交仅支持同一 HTTP 服务。');
      const targetId = args.targetPrincipalId ?? args.principalId!;
      const target = await this.store.get<Principal>('principal', targetId);
      if (
        !target?.enabled ||
        (targetId.startsWith('anon:') && !targetId.startsWith(`anon:${ctx.serviceId}:`))
      )
        fail('OBJECT_NOT_FOUND', '目标身份不存在或不属于此服务。');
      const next = { ...session, grants: { ...session.grants }, revision: session.revision + 1 };
      if (method === 'share') next.grants[targetId] = args.access!;
      if (method === 'unshare') delete next.grants[targetId];
      if (method === 'transfer') {
        next.ownerId = targetId;
        delete next.grants[targetId];
        delete next.grants[session.ownerId];
        if (args.retainPreviousOwnerAs) next.grants[session.ownerId] = args.retainPreviousOwnerAs;
      }
      const result = await this.store.commit({
        checks: [{ kind: 'session', id: session.id, revision: args.expectedRevision }],
        puts: [row('session', next)],
        idempotency: idem(ctx, `session_${method}`, args, {
          sessionId: next.id,
          revision: next.revision,
          ownerId: next.ownerId,
          grants: next.grants,
        }),
      });
      return result.response;
    });
  }
  async close(
    ctx: Context,
    args: { sessionId: string; expectedRevision: number; idempotencyKey: string },
  ) {
    await this.get(ctx, args.sessionId, 'control');
    return this.operations.start(
      ctx,
      'session_close',
      args,
      async () => {
        const { session, record } = await this.serial.run(args.sessionId, async () => {
          const session = await this.get(ctx, args.sessionId, 'control');
          if (session.revision !== args.expectedRevision)
            fail('REVISION_CONFLICT', '会话修订已变化。');
          const record = await this.runtimes.get(ctx, session.runtimeId, true);
          if (record.instanceId !== this.runtimes.instanceId && record.state !== 'closed')
            fail('INSTANCE_MISMATCH', '会话属于另一个实例。');
          this.assertLifecycleAvailable(session, record.id, true);
          this.runtimes.lifecycle.add(record.id);
          return { session, record };
        });
        let method = 'process_termination';
        try {
          if (session.activeTaskId) await this.cancelTask(ctx, session.activeTaskId);
          const handle = this.runtimes.live.get(record.id);
          if (handle?.client.initialize.agentCapabilities?.sessionCapabilities?.close != null) {
            await handle.client.request(
              'session/close',
              { sessionId: session.downstreamSessionId },
              this.runtimes.settings.controlTimeoutMs,
            );
            method = 'acp_close';
          }
        } finally {
          await this.runtimes.closeNow(record.id);
          this.runtimes.lifecycle.delete(record.id);
        }
        return { sessionId: session.id, state: 'closed', method };
      },
      { sessionId: args.sessionId },
    );
  }
  async ended(runtimeId: string) {
    for (const session of await this.store.list<SessionRecord>('session'))
      if (session.runtimeId === runtimeId && session.state !== 'deleted') {
        await this.events.closeActivation(session.activationId);
        const activation = await this.store.get<ActivationRecord>(
          'activation',
          session.activationId,
        );
        if (activation)
          await this.store.put('activation', {
            ...activation,
            endedAt: now(),
            revision: activation.revision + 1,
          });
        await this.mutate(session.id, (current) => {
          const result = { ...current, state: 'closed' as const };
          delete result.activeTaskId;
          return result;
        });
        await this.store.commit({
          releases: [
            {
              key: `session:${digest([session.namespace, session.downstreamSessionId])}`,
              holder: runtimeId,
            },
          ],
        });
      }
  }
  async restore(
    ctx: Context,
    method: 'load' | 'resume',
    args: {
      phase: 'prepare' | 'apply';
      sessionId: string;
      configId?: string | undefined;
      configRevision?: number | undefined;
      restorePlanId?: string | undefined;
      acceptEnvironmentDigest?: string | undefined;
      preparedRuntime?:
        | {
            runtimeId: string;
            expectedConnectionGeneration: number;
            expectedRuntimeRevision: number;
          }
        | undefined;
      idempotencyKey: string;
    },
  ) {
    const original = await this.get(ctx, args.sessionId, 'control');
    if (original.state === 'ready' || original.state === 'creating')
      fail('RECOVERY_CONFLICT', '会话仍在运行，必须先显式关闭。');
    if (args.phase === 'prepare') {
      const config = await this.runtimes.configs.get(
        args.configId ?? original.configId,
        args.configRevision,
      );
      const plan: RestorePlan = {
        id: id('restore'),
        revision: 1,
        createdAt: now(),
        ownerId: ctx.principalId,
        sessionId: original.id,
        method,
        configId: config.id,
        configRevision: config.revision,
        environmentDigest: digest({
          config: config.config,
          cwd: original.cwd,
          additionalDirectories: original.additionalDirectories,
        }),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
      await this.store.put('restore_plan', plan);
      return {
        ...plan,
        restorePlanId: plan.id,
        previousSnapshot: original.snapshot,
        targetSnapshot: config.config,
      };
    }
    const plan = await this.store.get<RestorePlan>('restore_plan', args.restorePlanId!);
    if (
      !plan ||
      plan.sessionId !== original.id ||
      plan.method !== method ||
      plan.ownerId !== ctx.principalId
    )
      fail('OBJECT_NOT_FOUND', '恢复方案不存在。');
    if (Date.parse(plan.expiresAt) < Date.now()) fail('PLAN_EXPIRED', '恢复方案已过期。');
    if (plan.environmentDigest !== args.acceptEnvironmentDigest)
      fail('PLAN_CHANGED', '必须明确接受方案中的运行环境摘要。');
    return this.operations.start(
      ctx,
      `session_${method}`,
      args,
      async (operationId, signal) => {
        await this.get(ctx, original.id, 'control');
        const runtime = args.preparedRuntime
          ? await this.runtimes.get(ctx, args.preparedRuntime.runtimeId, true)
          : await this.runtimes.prepareNow(
              ctx,
              { configId: plan.configId, configRevision: plan.configRevision, cwd: original.cwd },
              operationId,
              signal,
            );
        if (args.preparedRuntime)
          this.runtimes.guard(
            runtime,
            args.preparedRuntime.expectedRuntimeRevision,
            args.preparedRuntime.expectedConnectionGeneration,
          );
        if (
          runtime.state !== 'prepared' ||
          runtime.configId !== plan.configId ||
          runtime.configRevision !== plan.configRevision ||
          runtime.cwd !== original.cwd ||
          this.runtimes.lifecycle.has(runtime.id)
        )
          fail('PLAN_CHANGED', '准备的 Runtime 与恢复方案不一致。');
        const handle = this.runtimes.handle(runtime);
        requireCapability(handle.client.initialize.agentCapabilities ?? {}, method);
        const lease = `session:${digest([original.namespace, original.downstreamSessionId])}`;
        const activation: ActivationRecord = {
          id: id('act'),
          revision: 1,
          createdAt: now(),
          sessionId: original.id,
          runtimeId: runtime.id,
          instanceId: this.runtimes.instanceId,
          downstreamSessionId: original.downstreamSessionId,
          startedAt: now(),
        };
        await this.store.commit({
          checks: [
            { kind: 'session', id: original.id, revision: original.revision },
            { kind: 'runtime', id: runtime.id, revision: runtime.revision },
          ],
          claims: [{ key: lease, holder: runtime.id }],
          puts: [
            row('runtime', { ...runtime, state: 'binding', revision: runtime.revision + 1 }),
            row('activation', activation),
            row('session', {
              ...original,
              revision: original.revision + 1,
              state: 'creating',
              runtimeId: runtime.id,
              activationId: activation.id,
              instanceId: this.runtimes.instanceId,
              snapshot: runtime.snapshot,
            }),
          ],
        });
        this.runtimes.lifecycle.add(runtime.id);
        handle.sessionId = original.id;
        handle.operationId = operationId;
        await this.operations.update(operationId, { runtimeId: runtime.id });
        const replayId =
          method === 'load'
            ? await this.events.segment(await this.get(ctx, original.id), 'history_replay')
            : null;
        if (replayId) this.events.replay.set(runtime.id, replayId);
        try {
          const params = {
            ...(await this.params(
              runtime,
              original.additionalDirectories,
              runtime.snapshot.mcpServers,
            )),
            sessionId: original.downstreamSessionId,
          };
          const response =
            method === 'load'
              ? await handle.client.request(
                  'session/load',
                  params,
                  this.runtimes.settings.controlTimeoutMs,
                  signal,
                )
              : await handle.client.request(
                  'session/resume',
                  params,
                  this.runtimes.settings.controlTimeoutMs,
                  signal,
                );
          await this.bind(original.id, runtime.id, operationId, {
            options: response.configOptions ?? [],
            modes: response.modes ?? null,
          });
          return this.view(ctx, original.id);
        } catch (error) {
          if (
            (await this.store.get<WorkRecord>('operation', operationId))?.commitState ===
            'committed'
          )
            throw error;
          if (signal.aborted) {
            await this.runtimes.closeNow(runtime.id);
            throw error;
          }
          await this.mutate(original.id, (current) => ({ ...current, state: 'interrupted' }));
          if (error instanceof AppError && error.code === 'AUTH_REQUIRED') {
            delete handle.sessionId;
            await this.store.commit({ releases: [{ key: lease, holder: runtime.id }] });
            const updated = await this.runtimes.update(runtime.id, {
              state: 'prepared',
              authState: 'required',
            });
            throw new AppError(
              'AUTH_REQUIRED',
              '请在此 Runtime 认证后，重新准备恢复方案并显式 apply。',
              {
                runtimeId: runtime.id,
                runtimeRevision: updated.revision,
                connectionGeneration: updated.connectionGeneration,
              },
            );
          }
          await this.runtimes.update(runtime.id, { state: 'creation_unknown' });
          throw error;
        } finally {
          if (replayId) await this.events.seal(replayId);
          this.events.replay.delete(runtime.id);
          this.runtimes.lifecycle.delete(runtime.id);
        }
      },
      { sessionId: original.id },
    );
  }
}
