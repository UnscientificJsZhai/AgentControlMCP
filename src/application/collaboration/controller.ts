import { realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bytes, digest, id, now } from '../../domain/ids.js';
import { AppError, fail } from '../../domain/errors.js';
import type {
  Context,
  InteractionRecord,
  RuntimeRecord,
  SessionRecord,
  WorkRecord,
} from '../../domain/models.js';
import { terminalStates } from '../../domain/models.js';
import { collaborationSchemaVersion, inSubtree } from '../../domain/collaboration.js';
import type {
  AgentState,
  AgentView,
  ManagedAgentRecord,
  TeamRecord,
  TaskIntentRecord,
  RecoveryDecision,
  CompletionCriteria,
  AcceptanceResult,
  MessageRecord,
} from '../../domain/collaboration.js';
import type { SqliteStore } from '../../infrastructure/storage/sqlite-store.js';
import type { Row } from '../../infrastructure/storage/protocol.js';
import { row } from '../../infrastructure/storage/sqlite-store.js';
import { inside } from '../../infrastructure/platform/file-callbacks.js';
import type { ConfigService } from '../config-service.js';
import type { AgentAvailabilityService } from '../agent-availability-service.js';
import type { TaskService } from '../task-service.js';
import type { InteractionService, PermissionDecision } from '../interaction-service.js';
import type { IdentityService } from '../identity-service.js';
import type { AuthService } from '../auth-service.js';
import type { Settings, PermissionPolicy } from '../../domain/schemas.js';
import { CollaborationStore, completionRows } from './store.js';
import { CollaborationScheduler } from './scheduler.js';

export interface CollaborationDependencies {
  store: SqliteStore;
  tasks: TaskService;
  configs: ConfigService;
  availability: AgentAvailabilityService;
  interactions: InteractionService;
  identities: IdentityService;
  auth: AuthService;
  settings: Settings;
  instanceId: string;
}
export interface SpawnInput {
  requestId: string;
  taskName: string;
  message: string;
  teamId?: string | undefined;
  profile?: string | undefined;
  cwd?: string | undefined;
  completionCriteria?: CompletionCriteria | undefined;
}
export interface TargetInput {
  requestId: string;
  target: string;
}
export interface RespondInput extends TargetInput {
  action: 'reply' | 'present' | 'cancel' | 'prepare_restore';
  interactionId?: string | undefined;
  decision?: PermissionDecision | undefined;
  answer?: 'accept' | 'decline' | 'cancel' | undefined;
  content?: Record<string, unknown> | undefined;
  presentationReceipt?: string | undefined;
  planId?: string | undefined;
  acceptEnvironmentDigest?: string | undefined;
  authMethodId?: string | undefined;
}

/** 协作入口集中管理归属、幂等、成员树与任务准入，ACP 执行仍由原服务负责。 */
export class CollaborationController {
  readonly storage;
  readonly scheduler;
  readonly sessions;
  readonly runtimes;
  readonly operations;
  stopping = false;
  revokeBridge: (agentId: string) => Promise<void> = async () => {};

  constructor(
    readonly app: CollaborationDependencies,
    private readonly taskMessageMaxBytes = 16 * 1024 ** 2 - 8192,
  ) {
    this.sessions = app.tasks.sessions;
    this.runtimes = this.sessions.runtimes;
    this.operations = this.sessions.operations;
    this.storage = new CollaborationStore(app.store, this.sessions.events);
    this.scheduler = new CollaborationScheduler(this);
  }

  context(team: TeamRecord, agent: ManagedAgentRecord): Context {
    return { ...team.context, managedAgentId: agent.id };
  }

  async team(ctx: Context, teamId: string, mutate = false) {
    await this.app.identities.check(ctx);
    const team = await this.app.store.get<TeamRecord>('collab_team', teamId);
    if (
      !team ||
      (!ctx.admin && team.ownerId !== ctx.principalId) ||
      (ctx.collaborationMember && ctx.collaborationMember.teamId !== teamId)
    )
      return fail('OBJECT_NOT_FOUND', '团队不存在或不可见。');
    if (mutate && team.instanceId !== this.app.instanceId)
      fail('INSTANCE_MISMATCH', '请连接团队所属实例；实例已退出时请显式恢复。', {
        instanceId: team.instanceId,
      });
    return team;
  }

  /** 凭据续接与调度持同一团队锁，防止旧 tick 在新凭据写入后再覆盖暂停状态。 */
  async renew(ctx: Context, teamId: string) {
    if (ctx.collaborationMember || !ctx.credentialId) return;
    await this.storage.serial.run(teamId, async () => {
      const team = await this.team(ctx, teamId);
      if (ctx.principalId !== team.ownerId) return;
      if (ctx.credentialId !== team.context.credentialId) {
        await this.app.store.commit({
          checks: [{ kind: 'collab_team', id: team.id, revision: team.revision }],
          puts: [
            row('collab_team', {
              ...team,
              revision: team.revision + 1,
              context: { ...team.context, credentialId: ctx.credentialId },
            }),
          ],
        });
      }
      for (const agent of await this.members(team.id)) {
        if (
          agent.lifecycle !== 'paused' ||
          agent.error?.code !== 'UNAUTHENTICATED' ||
          !agent.sessionId
        )
          continue;
        const session = await this.app.store.get<SessionRecord>('session', agent.sessionId);
        if (session?.state === 'ready')
          await this.update(agent, { lifecycle: 'active', error: undefined });
      }
    });
  }

  async agent(agentId: string) {
    const agent = await this.app.store.get<ManagedAgentRecord>('collab_agent', agentId);
    if (!agent) return fail('OBJECT_NOT_FOUND', '成员不存在。');
    return agent;
  }

  async target(ctx: Context, target: string, control = false) {
    let agent = await this.app.store.get<ManagedAgentRecord>('collab_agent', target);
    if (!agent && ctx.collaborationMember) {
      const caller = await this.agent(ctx.collaborationMember.agentId);
      const path = target.startsWith('/')
        ? posix.normalize(target)
        : posix.resolve(caller.path, target);
      agent =
        (await this.app.store.list<ManagedAgentRecord>('collab_agent')).find(
          (a) => a.teamId === caller.teamId && a.path === path,
        ) ?? null;
    }
    if (!agent) return fail('OBJECT_NOT_FOUND', '成员不存在；外部调用请使用完整 agentId。');
    const team = await this.team(ctx, agent.teamId);
    if (ctx.collaborationMember && control) {
      const caller = await this.agent(ctx.collaborationMember.agentId);
      if (!inSubtree(caller.path, agent.path))
        fail('ACCESS_DENIED', '成员仅能控制自己的子树，不能批准自身操作。');
    }
    return { agent, team };
  }

  async members(teamId: string) {
    return (await this.app.store.list<ManagedAgentRecord>('collab_agent')).filter(
      (agent) => agent.teamId === teamId,
    );
  }

  async update(
    agent: ManagedAgentRecord,
    patch: { [K in keyof ManagedAgentRecord]?: ManagedAgentRecord[K] | undefined },
  ) {
    const next = Object.fromEntries(
      Object.entries({ ...agent, ...patch, revision: agent.revision + 1 }).filter(
        ([, v]) => v !== undefined,
      ),
    ) as unknown as ManagedAgentRecord;
    await this.app.store.commit({
      checks: [{ kind: 'collab_agent', id: agent.id, revision: agent.revision }],
      puts: [row('collab_agent', next)],
    });
    return next;
  }

  async view(agent: ManagedAgentRecord): Promise<AgentView & Record<string, unknown>> {
    const intents = await this.storage.intents(agent.id);
    const latest = intents.at(-1);
    const active = intents.find((intent) => intent.state === 'dispatched');
    const lastDispatched = [...intents].reverse().find((intent) => intent.taskId);
    const last = active ?? lastDispatched ?? latest;
    const task = last?.taskId ? await this.app.store.get<WorkRecord>('task', last.taskId) : null;
    const outbox = last
      ? await this.app.store.get<{ work: WorkRecord }>('collab_outbox', last.id)
      : null;
    const work = task ?? outbox?.work;
    const session = agent.sessionId
      ? await this.app.store.get<SessionRecord>('session', agent.sessionId)
      : null;
    const runtimeId = session?.runtimeId ?? agent.runtimeId;
    const pending = runtimeId
      ? (await this.app.store.list<InteractionRecord>('interaction')).filter(
          (i) => i.runtimeId === runtimeId && i.state === 'pending',
        )
      : [];
    let state: AgentState;
    if (
      agent.lifecycle === 'closed' ||
      agent.lifecycle === 'closing' ||
      agent.lifecycle === 'stopping'
    )
      state = agent.lifecycle;
    else if (pending.length || agent.authRequired) state = 'waiting_input';
    else if (agent.lifecycle === 'starting' || agent.operationId) state = 'starting';
    else if (!session || session.state !== 'ready' || agent.lifecycle === 'paused')
      state = 'needs_recovery';
    else if (active && work && !terminalStates.has(work.state)) state = 'running';
    else state = 'idle';
    const stopReason = (work?.result as { stopReason?: string } | undefined)?.stopReason;
    const completion = last
      ? await this.app.store.get<MessageRecord>('collab_message', `msg_${last.id}`)
      : null;
    const acceptance = (completion?.body as { acceptance?: AcceptanceResult } | undefined)
      ?.acceptance;
    return {
      agentId: agent.id,
      teamId: agent.teamId,
      path: agent.path,
      parentId: agent.parentId,
      configId: agent.configId,
      configRevision: agent.configRevision,
      state,
      queuedTasks: intents.filter((intent) => intent.state === 'queued').length,
      queuePaused: agent.queuePaused ?? false,
      bridge: agent.bridge,
      lastRun: last
        ? {
            intentId: last.id,
            ...(last.taskId ? { taskId: last.taskId } : {}),
            state: work?.state ?? last.state,
            ...(stopReason ? { stopReason } : {}),
            ...(acceptance ? { acceptance } : {}),
          }
        : null,
      pending: pending.map(({ id, type, request, connectionGeneration }) => ({
        interactionId: id,
        type,
        request,
        connectionGeneration,
      })),
      ...(agent.error ? { error: agent.error } : {}),
      ...(agent.authRequired
        ? {
            authentication: {
              runtimeId,
              instanceId: this.app.instanceId,
              nextAction:
                'respond_agent reply + authMethodId；终端登录需 interaction attach --instance <id>',
            },
          }
        : {}),
      ...(state === 'needs_recovery'
        ? { nextAction: { tool: 'respond_agent', action: 'prepare_restore', target: agent.id } }
        : {}),
    };
  }

  async spawn(ctx: Context, args: SpawnInput) {
    return this.storage.serial.run('spawn', async () => {
      const previous = await this.app.store.replay<{
        teamId: string;
        agentId: string;
        configId?: string;
        configRevision?: number;
      }>(this.storage.request(ctx, 'spawn_agent', args));
      if (previous) {
        await this.team(ctx, previous.teamId);
        return previous;
      }
      this.checkTaskSize(args.message, args.completionCriteria);
      if (this.stopping) fail('INSTANCE_UNAVAILABLE', '实例正在停止。');
      if (ctx.collaborationMember && args.teamId && args.teamId !== ctx.collaborationMember.teamId)
        fail('ACCESS_DENIED', 'Bridge 不能切换团队。');
      const parent = ctx.collaborationMember
        ? await this.agent(ctx.collaborationMember.agentId)
        : undefined;
      const profile =
        args.profile ?? parent?.configId ?? this.app.settings.collaborationDefaultProfile;
      const availability = await this.app.availability.snapshot();
      const configs = availability.profiles
        .filter((p) => p.availability.ready)
        .map((p) => p.record);
      if (!configs.length)
        throw new AppError(
          'AGENT_SETUP_REQUIRED',
          '当前没有可用的 Agent profile。',
          { phase: this.app.availability.phase(ctx, availability) },
          '调用 discover_agents 查看原因并接入现有 Agent；只有用户明确指定目标后才能安装。',
        );
      const matches = profile
        ? configs.filter((c) => c.id === profile || c.config.name === profile)
        : configs;
      if (matches.length !== 1)
        fail(
          'CONFIG_INVALID',
          '请选择唯一的可用 profile；调用 discover_agents 查看接入状态。不会自动安装或替换所选 Agent。',
          {
            profiles: configs.map((c) => ({ profile: c.id, name: c.config.name })),
          },
        );
      let config = matches[0]!;
      this.checkConfig(config.id, args.completionCriteria);
      if (parent) {
        if (config.id !== parent.configId)
          fail(
            'ACCESS_DENIED',
            '子成员只能使用父成员已授权的 profile；跨 profile 请由外部根创建成员。',
          );
        // 旧父成员不能借当前配置的新修订取得新增凭据、MCP 服务或更宽松模式。
        config = await this.app.configs.get(parent.configId, parent.configRevision);
      }
      const teamId = ctx.collaborationMember?.teamId ?? args.teamId;
      if (teamId) await this.renew(ctx, teamId);
      const existing = teamId ? await this.team(ctx, teamId, true) : null;
      const cwd = await realpath(
        args.cwd ?? parent?.cwd ?? existing?.cwd ?? config.config.cwd ?? process.cwd(),
      );
      if (parent && !inside(parent.cwd, cwd))
        fail('ACCESS_DENIED', '子成员目录不能超出父成员工作区。');
      const team: TeamRecord = existing ?? {
        id: id('team'),
        revision: 1,
        createdAt: now(),
        schemaVersion: collaborationSchemaVersion,
        ownerId: ctx.principalId,
        instanceId: this.app.instanceId,
        cwd,
        sequence: '0',
        context: {
          principalId: ctx.principalId,
          serviceId: ctx.serviceId,
          mode: ctx.mode,
          ...(ctx.credentialId ? { credentialId: ctx.credentialId } : {}),
          ...(ctx.nativeInteraction ? { nativeInteraction: true } : {}),
        },
      };
      return this.storage.serial.run(team.id, async () => {
        if (parent && ['closing', 'closed'].includes((await this.agent(parent.id)).lifecycle))
          fail('AGENT_CLOSED', '父成员正在关闭。');
        const members = await this.members(team.id);
        if (
          members.filter((a) => a.lifecycle !== 'closed').length >=
          this.app.settings.collaborationMaxAgents
        )
          fail('CAPACITY_EXCEEDED', '团队成员已达上限。');
        const path = `${parent?.path ?? '/root'}/${args.taskName}`;
        if (path.split('/').length - 2 > this.app.settings.collaborationMaxDepth)
          fail('CAPACITY_EXCEEDED', '子成员深度已达上限。');
        if (members.some((a) => a.path === path))
          fail('AGENT_PATH_CONFLICT', '此团队中的成员路径已经使用。');
        await this.storage.capacity(
          bytes(args),
          this.app.settings.historyMaxBytes,
          this.app.settings.minimumFreeBytes,
        );
        const agent: ManagedAgentRecord = {
          id: id('agent'),
          revision: 1,
          createdAt: now(),
          teamId: team.id,
          parentId: parent?.id ?? 'root',
          path,
          configId: config.id,
          configRevision: config.revision,
          cwd,
          lifecycle: 'starting',
          mailAfter: '0',
          bridge: 'unconnected',
        };
        const intent: TaskIntentRecord = {
          id: id('intent'),
          revision: 1,
          createdAt: now(),
          teamId: team.id,
          agentId: agent.id,
          order: '1',
          message: args.message,
          ...(args.completionCriteria ? { completionCriteria: args.completionCriteria } : {}),
          state: 'queued',
        };
        const response = {
          teamId: team.id,
          agentId: agent.id,
          path,
          state: 'starting',
          configId: agent.configId,
          configRevision: agent.configRevision,
        };
        await this.app.store.commit({
          maxLogicalBytes: this.app.settings.historyMaxBytes,
          checks: existing ? [] : [{ kind: 'collab_team', id: team.id, absent: true }],
          puts: [
            ...(existing ? [] : [row('collab_team', team)]),
            row('collab_agent', agent),
            row('collab_intent', intent),
          ],
          claims: [{ key: `collab_path:${team.id}:${path}`, holder: agent.id }],
          idempotency: this.storage.request(ctx, 'spawn_agent', args, response),
        });
        this.scheduler.wake();
        return response;
      });
    });
  }

  private checkConfig(configId: string, criteria?: CompletionCriteria) {
    if (criteria?.configId !== undefined && criteria.configId !== configId)
      fail('PROFILE_MISMATCH', '实际 profile 与验收要求的 configId 不一致，未创建任务。', {
        expectedConfigId: criteria.configId,
        actualConfigId: configId,
      });
  }

  private checkTaskSize(message: string, criteria?: CompletionCriteria) {
    const blocks = [
      { type: 'text', text: message },
      ...(criteria ? [{ type: 'text', text: JSON.stringify(criteria) }] : []),
    ];
    if (bytes(blocks) > this.taskMessageMaxBytes)
      fail('CONFIG_INVALID', '任务正文与完成条件合计过大；序列化后必须小于 16 MiB 减 8 KiB。');
  }

  async followup(
    ctx: Context,
    args: TargetInput & { message: string; completionCriteria?: CompletionCriteria | undefined },
  ) {
    const initial = await this.target(ctx, args.target, true);
    await this.renew(ctx, initial.team.id);
    return this.storage.serial.run(initial.team.id, async () => {
      const { agent, team } = await this.target(ctx, args.target, true);
      const replay = await this.app.store.replay(this.storage.request(ctx, 'followup_task', args));
      if (replay) return replay;
      this.checkConfig(agent.configId, args.completionCriteria);
      this.checkTaskSize(args.message, args.completionCriteria);
      await this.team(ctx, team.id, true);
      const view = await this.view(agent);
      if (['closed', 'closing', 'stopping', 'needs_recovery'].includes(view.state))
        fail('AGENT_UNAVAILABLE', '成员当前不能接受新轮次。', { state: view.state });
      const intents = await this.storage.intents(agent.id);
      if (
        intents.filter((i) => i.state === 'queued').length >=
        this.app.settings.collaborationMaxQueuedTasks
      )
        fail('CAPACITY_EXCEEDED', '成员待执行队列已满。');
      await this.storage.capacity(
        bytes(args),
        this.app.settings.historyMaxBytes,
        this.app.settings.minimumFreeBytes,
      );
      const intent: TaskIntentRecord = {
        id: id('intent'),
        revision: 1,
        createdAt: now(),
        teamId: team.id,
        agentId: agent.id,
        order: String(BigInt(intents.at(-1)?.order ?? '0') + 1n),
        message: args.message,
        ...(args.completionCriteria ? { completionCriteria: args.completionCriteria } : {}),
        state: 'queued',
      };
      const response = { agentId: agent.id, intentId: intent.id, delivery: 'queued' };
      await this.app.store.commit({
        maxLogicalBytes: this.app.settings.historyMaxBytes,
        puts: [
          row('collab_intent', intent),
          row('collab_agent', { ...agent, queuePaused: false, revision: agent.revision + 1 }),
        ],
        idempotency: this.storage.request(ctx, 'followup_task', args, response),
      });
      this.scheduler.wake();
      return response;
    });
  }

  async send(ctx: Context, args: TargetInput & { message: string }) {
    const rootTarget = ctx.collaborationMember && ['/root', 'root'].includes(args.target);
    const initial = rootTarget
      ? { team: await this.team(ctx, ctx.collaborationMember!.teamId), agent: undefined }
      : await this.target(ctx, args.target);
    await this.renew(ctx, initial.team.id);
    return this.storage.serial.run(initial.team.id, async () => {
      const team = await this.team(ctx, initial.team.id, true);
      const replay = await this.app.store.replay<{ messageId: string; delivery: string }>(
        this.storage.request(ctx, 'send_message', args),
      );
      if (replay) return replay;
      if (initial.agent && (await this.agent(initial.agent.id)).lifecycle === 'closed')
        fail('AGENT_CLOSED', '成员已关闭。');
      await this.storage.capacity(
        bytes(args),
        this.app.settings.historyMaxBytes,
        this.app.settings.minimumFreeBytes,
      );
      const sender = ctx.collaborationMember
        ? await this.agent(ctx.collaborationMember.agentId)
        : null;
      const channel = sender ? ('agent_collaboration' as const) : ('external' as const);
      const messageId = id('msg');
      const body = await this.sessions.events.externalize(messageId, { text: args.message });
      const response = {
        messageId,
        delivery: 'queued',
        channel,
        type: 'MESSAGE',
        teamId: team.id,
        recipient: initial.agent?.id ?? 'root',
      };
      await this.storage.append(
        team,
        [
          {
            id: messageId,
            revision: 1,
            createdAt: now(),
            teamId: team.id,
            recipient: initial.agent?.id ?? 'root',
            from: sender?.path ?? '/root',
            agentId: sender?.id ?? 'root',
            type: 'MESSAGE',
            channel,
            textDigest: digest(args.message),
            ...(sender && ctx.collaborationCall?.taskId && ctx.collaborationCall.intentId
              ? { taskId: ctx.collaborationCall.taskId, intentId: ctx.collaborationCall.intentId }
              : {}),
            body,
          },
        ],
        {
          maxLogicalBytes: this.app.settings.historyMaxBytes,
          idempotency: this.storage.request(ctx, 'send_message', args, response),
        },
      );
      return response;
    });
  }

  private async visibleView(ctx: Context, agent: ManagedAgentRecord) {
    const view = await this.view(agent);
    const caller = ctx.collaborationMember?.agentId;
    if (!caller || caller === agent.id || caller === agent.parentId) return view;
    // 同级成员可协作寻址，但不能通过状态接口读取彼此的表单、审批或错误正文。
    return {
      agentId: view.agentId,
      teamId: view.teamId,
      path: view.path,
      parentId: view.parentId,
      configId: view.configId,
      configRevision: view.configRevision,
      state: view.state,
      queuedTasks: view.queuedTasks,
      bridge: view.bridge,
      lastRun: view.lastRun,
    };
  }

  async list(
    ctx: Context,
    args: {
      teamId?: string | undefined;
      pathPrefix?: string | undefined;
      target?: string | undefined;
      detail?: 'status' | 'output' | undefined;
      cursor?: string | undefined;
      intentId?: string | undefined;
      messageId?: string | undefined;
    },
  ) {
    if (args.target) {
      const { agent } = await this.target(ctx, args.target);
      await this.renew(ctx, agent.teamId);
      if (args.detail === 'output') return this.scheduler.output(ctx, agent, args);
      return this.visibleView(ctx, await this.agent(agent.id));
    }
    const teamId = ctx.collaborationMember?.teamId ?? args.teamId;
    if (ctx.collaborationMember && args.teamId && args.teamId !== teamId)
      fail('ACCESS_DENIED', '不能读取其他团队。');
    const teams = teamId
      ? [await this.team(ctx, teamId)]
      : await Promise.all(
          (await this.app.store.list<TeamRecord>('collab_team'))
            .filter((t) => ctx.admin || t.ownerId === ctx.principalId)
            .map((t) => this.team(ctx, t.id)),
        );
    await Promise.all(teams.map((t) => this.renew(ctx, t.id)));
    const members = (await Promise.all(teams.map((t) => this.members(t.id))))
      .flat()
      .filter(
        (a) => !args.pathPrefix || a.path === args.pathPrefix || inSubtree(args.pathPrefix, a.path),
      );
    return {
      teams: teams.map(({ id, cwd, instanceId }) => ({ teamId: id, cwd, instanceId })),
      agents: await Promise.all(members.map((a) => this.visibleView(ctx, a))),
      profiles: (await this.app.availability.snapshot()).profiles
        .filter((p) => p.availability.ready)
        .map(({ record: c }) => ({ profile: c.id, name: c.config.name })),
    };
  }

  async wait(
    ctx: Context,
    args: {
      teamId?: string | undefined;
      cursor?: string | undefined;
      timeoutMs?: number | undefined;
    },
  ) {
    const teamId = ctx.collaborationMember?.teamId ?? args.teamId;
    if (!teamId) fail('CONFIG_INVALID', '外部调用 wait_agent 必须指定 teamId。');
    if (ctx.collaborationMember && args.teamId && args.teamId !== teamId)
      fail('ACCESS_DENIED', '不能读取其他团队。');
    await this.renew(ctx, teamId);
    const recipient = ctx.collaborationMember?.agentId ?? 'root';
    await this.team(ctx, teamId);
    if (args.cursor) await this.storage.acknowledge(teamId, recipient, args.cursor);
    const deadline = Date.now() + (args.timeoutMs ?? 10_000);
    for (;;) {
      await this.team(ctx, teamId);
      const page = await this.storage.mailbox(teamId, recipient, args.cursor);
      if (page.messages.length || Date.now() >= deadline || ctx.signal?.aborted) {
        await this.team(ctx, teamId);
        return {
          messages: page.messages.map(({ id, body, ...m }) => ({
            ...m,
            messageId: id,
            ...(body as Record<string, unknown>),
          })),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
          agents: await Promise.all(
            (await this.members(teamId)).map((a) => this.visibleView(ctx, a)),
          ),
          timedOut: !page.messages.length && Date.now() >= deadline,
        };
      }
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  }

  /** 停止准入与排队取消在团队同一序列发生；下游确认由调度器随后收敛。 */
  async stop(ctx: Context, args: TargetInput, close = false) {
    const { team: initial } = await this.target(ctx, args.target, true);
    await this.renew(ctx, initial.id);
    return this.storage.serial.run(initial.id, async () => {
      const { team, agent } = await this.target(ctx, args.target, true);
      const method = close ? 'close_agent' : 'interrupt_agent';
      const replay = await this.app.store.replay(this.storage.request(ctx, method, args));
      if (replay) return replay;
      await this.team(ctx, team.id, true);
      const targets = (
        close
          ? (await this.members(team.id)).filter(
              (a) => a.id === agent.id || inSubtree(agent.path, a.path),
            )
          : [agent]
      ).filter((a) => a.lifecycle !== 'closed');
      const response = {
        accepted: true,
        agentId: agent.id,
        state: agent.lifecycle === 'closed' ? 'closed' : close ? 'closing' : 'stopping',
      };
      const puts: Row[] = targets.map((a) =>
        row('collab_agent', {
          ...a,
          lifecycle: close ? 'closing' : 'stopping',
          revision: a.revision + 1,
        }),
      );
      for (const target of targets)
        for (const intent of await this.storage.intents(target.id))
          if (intent.state === 'queued')
            puts.push(...this.scheduler.endIntent(team, intent, 'cancelled'));
      await this.app.store.commit({
        puts,
        idempotency: this.storage.request(ctx, method, args, response),
      });
      this.scheduler.wake();
      return response;
    });
  }

  async presentation(ctx: Context, args: RespondInput) {
    const { agent, team } = await this.target(ctx, args.target, true);
    await this.team(ctx, team.id, true);
    if (!args.interactionId) fail('CONFIG_INVALID', '需要 interactionId。');
    const interaction = await this.app.interactions.get(
      this.context(team, agent),
      args.interactionId,
      true,
    );
    const runtime = await this.runtimeFor(agent);
    if (interaction.runtimeId !== runtime?.id)
      fail('OBJECT_NOT_FOUND', '交互不属于此成员当前连接。');
    if (ctx.collaborationMember && !['permission', 'host_permission'].includes(interaction.type))
      fail('ACCESS_DENIED', '真人交互只能由外部控制者呈现。');
    return { agent, team, interaction, context: this.context(team, agent) };
  }

  async runtimeFor(agent: ManagedAgentRecord) {
    const session = agent.sessionId
      ? await this.app.store.get<SessionRecord>('session', agent.sessionId)
      : null;
    const operation = agent.operationId
      ? await this.app.store.get<WorkRecord>('operation', agent.operationId)
      : null;
    const runtimeId = operation?.runtimeId ?? session?.runtimeId ?? agent.runtimeId;
    return runtimeId ? this.app.store.get<RuntimeRecord>('runtime', runtimeId) : null;
  }

  async replayResponse(ctx: Context, args: RespondInput) {
    const { team } = await this.target(ctx, args.target, true);
    await this.renew(ctx, team.id);
    return this.app.store.replay(this.storage.request(ctx, 'respond_agent', args));
  }

  async respond(ctx: Context, args: RespondInput, logicalArgs: RespondInput = args) {
    const initial = await this.target(ctx, args.target, true);
    await this.renew(ctx, initial.team.id);
    return this.storage.serial.run(initial.team.id, async () => {
      const { agent, team } = await this.target(ctx, args.target, true);
      const replay = await this.app.store.replay(
        this.storage.request(ctx, 'respond_agent', logicalArgs),
      );
      if (replay) return replay;
      if (['closed', 'closing', 'stopping'].includes(agent.lifecycle))
        fail('AGENT_UNAVAILABLE', '成员正在关闭或停止。');
      let result: unknown;
      const execution = {
        ...this.context(team, agent),
        ...((ctx.nativeInteraction ?? false) ? { nativeInteraction: true } : {}),
      };
      if (args.action === 'prepare_restore')
        result = await this.scheduler.prepareRestore(ctx, team, agent, args);
      else if (args.planId) result = await this.scheduler.restore(ctx, team, agent, args);
      else if (args.authMethodId) {
        await this.team(ctx, team.id, true);
        if (ctx.collaborationMember) fail('ACCESS_DENIED', '认证由外部控制者处理。');
        if (!agent.authRequired) fail('CONFIG_INVALID', '成员没有待处理的认证请求。');
        const runtime = await this.runtimeFor(agent);
        if (!runtime) fail('OBJECT_NOT_FOUND', '原 Runtime 不存在。');
        const channel = this.runtimes.channelAvailable(execution, 'local_cli')
          ? 'local_cli'
          : execution.nativeInteraction
            ? 'mcp_native'
            : 'none';
        // CLI 在原实例附着后，可把保留连接升级为实际存在的交互通道。
        this.runtimes.handle(runtime).channel = channel;
        const accepted = await this.app.auth.authenticate(execution, {
          runtimeId: runtime.id,
          expectedRevision: runtime.revision,
          expectedConnectionGeneration: runtime.connectionGeneration,
          methodId: args.authMethodId,
          interactionChannel: channel,
          idempotencyKey: `collab-auth:${agent.id}:${args.requestId}`,
        });
        await this.update(agent, {
          operationId: accepted.operationId,
          operationKind: 'authenticate',
        });
        result = { agentId: agent.id, accepted: true };
      } else {
        const info = await this.presentation(ctx, args);
        const record = info.interaction;
        if (args.action === 'present')
          fail('INTERACTION_CHANNEL_UNAVAILABLE', '请通过真实 MCP 用户呈现流程。');
        if (['permission', 'host_permission'].includes(record.type)) {
          const decision = args.action === 'cancel' ? { kind: 'cancel' as const } : args.decision;
          if (!decision) fail('CONFIG_INVALID', '需要权限 decision。');
          if (ctx.collaborationMember) {
            const parentRuntime = await this.runtimeFor(
              await this.agent(ctx.collaborationMember.agentId),
            );
            if (
              !parentRuntime ||
              !(await this.app.interactions.mayDelegateApproval(parentRuntime.id, record, decision))
            )
              fail('ACCESS_DENIED', '此操作超出委托者已获准范围，必须由根控制者答复。');
          }
          result = await this.app.interactions.respondPermission(execution, {
            interactionId: record.id,
            expectedRevision: record.revision,
            idempotencyKey: `collab-reply:${agent.id}:${args.requestId}`,
            decision,
          });
        } else {
          const action = args.action === 'cancel' ? 'cancel' : args.answer;
          if (!action) fail('CONFIG_INVALID', '需要交互 answer。');
          result = await this.app.interactions.respondInteraction(execution, {
            interactionId: record.id,
            expectedRevision: record.revision,
            idempotencyKey: `collab-reply:${agent.id}:${args.requestId}`,
            action,
            content: args.content,
            presentationReceipt: args.presentationReceipt,
          });
        }
      }
      // 恢复的外层幂等响应已在 Operation 受理事务中保存，不能留下受理后的回写窗口。
      if (!args.planId)
        await this.app.store.commit({
          idempotency: this.storage.request(ctx, 'respond_agent', logicalArgs, result),
        });
      this.scheduler.wake();
      return result;
    });
  }

  async acceptTask(ctx: Context, task: WorkRecord) {
    const binding = ctx.collaborationIntent;
    if (!binding) return {};
    const intent = await this.app.store.get<TaskIntentRecord>('collab_intent', binding.intentId);
    const agent = await this.agent(binding.agentId);
    if (!intent || intent.state !== 'queued' || agent.lifecycle !== 'active')
      fail('AGENT_UNAVAILABLE', '任务准入已取消。');
    return {
      checks: [
        { kind: 'collab_intent', id: intent.id, revision: intent.revision },
        { kind: 'collab_agent', id: agent.id, revision: agent.revision },
      ],
      puts: [
        row('collab_intent', {
          ...intent,
          state: 'dispatched',
          taskId: task.id,
          mailAfter: binding.mailAfter,
          revision: intent.revision + 1,
        }),
      ],
    };
  }

  async acceptOperation(ctx: Context, operation: WorkRecord) {
    if (!ctx.managedAgentId) return {};
    const agent = await this.agent(ctx.managedAgentId);
    if (ctx.collaborationRestore && ['session_load', 'session_resume'].includes(operation.type)) {
      if (agent.operationId || agent.lifecycle === 'starting')
        fail('RECOVERY_CONFLICT', '成员已有正在处理的操作，请等待其结果。');
      const team = await this.team(ctx, agent.teamId, true);
      const decision = await this.app.store.get<RecoveryDecision>(
        'collab_recovery',
        ctx.collaborationRestore.recoveryId,
      );
      if (!decision || decision.acceptedOperationId)
        fail('RECOVERY_CONFLICT', '此恢复方案已受理或不存在，请重新准备。');
      const queued = (await this.storage.intents(agent.id)).filter((i) => i.state === 'queued');
      if (
        JSON.stringify(queued.map((i) => i.id)) !==
        JSON.stringify(ctx.collaborationRestore.queuedIntentIds)
      )
        fail('PLAN_CHANGED', '恢复受理前队列发生变化，请重新准备。');
      return {
        checks: [
          { kind: 'collab_agent', id: agent.id, revision: agent.revision },
          { kind: 'collab_recovery', id: decision.id, revision: decision.revision },
          ...queued.map((i) => ({ kind: 'collab_intent', id: i.id, revision: i.revision })),
        ],
        puts: [
          row('collab_agent', {
            ...agent,
            lifecycle: 'starting',
            operationId: operation.id,
            operationKind: 'restore',
            recoveryId: ctx.collaborationRestore.recoveryId,
            authRequired: false,
            revision: agent.revision + 1,
          }),
          ...queued.flatMap((intent) => this.scheduler.endIntent(team, intent, 'cancelled')),
          row('collab_recovery', {
            ...decision,
            acceptedOperationId: operation.id,
            revision: decision.revision + 1,
          }),
        ],
        idempotency: {
          ...ctx.collaborationRestore.request,
          method: 'collaboration:respond_agent',
          response: { agentId: agent.id, accepted: true, state: 'starting' },
        },
      };
    }
    if (operation.type !== 'session_create') return {};
    if (agent.lifecycle !== 'starting') fail('AGENT_UNAVAILABLE', '成员已停止创建。');
    return {
      checks: [{ kind: 'collab_agent', id: agent.id, revision: agent.revision }],
      puts: [
        row('collab_agent', {
          ...agent,
          operationId: operation.id,
          operationKind: 'create',
          revision: agent.revision + 1,
        }),
      ],
    };
  }

  async operationTerminalRecords(operation: WorkRecord) {
    if (
      !operation.collaborationSetup ||
      (await this.app.store.get('collab_outbox', operation.collaborationSetup.intentId))
    )
      return [];
    return completionRows(operation);
  }

  async inheritedPolicies(session: SessionRecord) {
    const policies: { policy: PermissionPolicy; roots: string[] }[] = [];
    if (!session.managedAgentId) return policies;
    let agent = await this.agent(session.managedAgentId);
    while (agent.parentId !== 'root') {
      agent = await this.agent(agent.parentId);
      const config = await this.app.configs.get(agent.configId, agent.configRevision);
      policies.push({ policy: config.config.permissionPolicy, roots: [agent.cwd] });
    }
    return policies;
  }

  start() {
    this.scheduler.start();
  }
  async shutdown() {
    this.stopping = true;
    await this.scheduler.stop();
    for (const team of await this.app.store.list<TeamRecord>('collab_team')) {
      if (team.instanceId !== this.app.instanceId) continue;
      await this.storage.serial.run(team.id, async () => {
        for (const agent of await this.members(team.id)) {
          if (agent.lifecycle === 'closed') continue;
          const puts: Row[] = [
            row('collab_agent', { ...agent, lifecycle: 'paused', revision: agent.revision + 1 }),
          ];
          for (const intent of await this.storage.intents(agent.id))
            if (intent.state === 'queued')
              puts.push(...this.scheduler.endIntent(team, intent, 'cancelled'));
          await this.app.store.commit({ puts });
          await this.revokeBridge(agent.id);
        }
      });
    }
  }
}
