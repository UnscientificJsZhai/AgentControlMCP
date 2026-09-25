import { bytes, digest, now } from '../../domain/ids.js';
import { AppError, fail, errorDetail } from '../../domain/errors.js';
import type {
  Context,
  InstanceRecord,
  RuntimeRecord,
  SessionRecord,
  WorkRecord,
} from '../../domain/models.js';
import { terminalStates } from '../../domain/models.js';
import type {
  CompletionRecord,
  ManagedAgentRecord,
  MessageRecord,
  RecoveryDecision,
  TaskIntentRecord,
  TeamRecord,
} from '../../domain/collaboration.js';
import { collaborationBridge, completionType } from '../../domain/collaboration.js';
import { row } from '../../infrastructure/storage/sqlite-store.js';
import { completionRows } from './store.js';
import { collectResult, verifyCompletion } from './results.js';
import type { CollaborationController, RespondInput } from './controller.js';

/** 所有调度决策与工具准入共用团队串行区；等待 ACP 完成不占用此串行区。 */
export class CollaborationScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private retainedAt = 0;
  constructor(readonly controller: CollaborationController) {}
  private get app() {
    return this.controller.app;
  }

  start() {
    this.timer = setInterval(() => this.wake(), 100);
    this.timer.unref();
    this.wake();
  }
  wake() {
    if (this.stopped || this.running) return;
    this.running = this.tick()
      .catch(() => {})
      .finally(() => {
        this.running = undefined;
      });
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }

  async tick() {
    const retain = Date.now() - this.retainedAt > 60_000;
    if (retain) this.retainedAt = Date.now();
    for (const original of await this.app.store.list<TeamRecord>('collab_team')) {
      await this.controller.storage.serial.run(original.id, async () => {
        let team = (await this.app.store.get<TeamRecord>('collab_team', original.id))!;
        // 邮箱可由新实例重建，执行权只属于团队持有实例。
        await this.deliver(team);
        if (retain) await this.controller.storage.retain(team.id, this.app.settings.retentionDays);
        team = (await this.app.store.get<TeamRecord>('collab_team', team.id))!;
        if (team.instanceId !== this.app.instanceId || this.controller.stopping) return;
        for (const member of (await this.controller.members(team.id)).sort(
          (a, b) => b.path.length - a.path.length,
        )) {
          try {
            await this.advance(team, await this.controller.agent(member.id));
          } catch (error) {
            const agent = await this.controller.agent(member.id);
            await this.controller.update(agent, { lifecycle: 'paused', error: errorDetail(error) });
          }
        }
      });
    }
  }

  endIntent(
    team: TeamRecord,
    intent: TaskIntentRecord,
    state: 'cancelled' | 'failed' | 'interrupted',
    error?: ReturnType<typeof errorDetail>,
  ) {
    const work: WorkRecord = {
      id: intent.id,
      revision: 1,
      createdAt: intent.createdAt,
      kind: 'operation',
      type: 'intent',
      ownerId: team.ownerId,
      instanceId: team.instanceId,
      state,
      commitState: 'cancelled',
      dispatchOutcome: 'not_sent',
      endedAt: now(),
      ...(error ? { error } : {}),
      collaboration: { teamId: team.id, agentId: intent.agentId, intentId: intent.id },
    };
    return [
      row('collab_intent', {
        ...intent,
        state: 'settled',
        revision: intent.revision + 1,
        endedAt: work.endedAt,
      }),
      ...completionRows(work),
    ];
  }

  private async deliver(initial: TeamRecord) {
    for (const completion of await this.app.store.list<CompletionRecord>('collab_outbox')) {
      if (completion.teamId !== initial.id || completion.delivered) continue;
      const team = (await this.app.store.get<TeamRecord>('collab_team', initial.id))!;
      const agent = await this.controller.agent(completion.agentId);
      const intent = await this.app.store.get<TaskIntentRecord>(
        'collab_intent',
        completion.intentId,
      );
      const result = await collectResult(
        this.controller.sessions.events,
        completion.work,
        completion.id,
      );
      const runtime = completion.work.runtimeId
        ? await this.app.store.get<RuntimeRecord>('runtime', completion.work.runtimeId)
        : null;
      const configId = runtime?.configId ?? agent.configId;
      const configRevision = runtime?.configRevision ?? agent.configRevision;
      const acceptance = verifyCompletion(
        intent?.completionCriteria,
        completion.work,
        configId,
        result.contentComplete,
        intent?.completionCriteria?.requiredMessage
          ? await this.app.store.list<MessageRecord>('collab_message')
          : [],
      );
      const body = {
        result,
        configId,
        configRevision,
        completionScope: 'acp_turn',
        acceptance,
        state: completion.work.state,
        stopReason:
          (completion.work.result as { stopReason?: string } | undefined)?.stopReason ?? null,
        ...(completion.work.error ? { error: completion.work.error } : {}),
      };
      const message: Omit<MessageRecord, 'seq'> = {
        id: `msg_${completion.id}`,
        revision: 1,
        createdAt: completion.createdAt,
        teamId: team.id,
        recipient: agent.parentId,
        from: agent.path,
        agentId: agent.id,
        type:
          acceptance.status === 'failed' && completion.work.state === 'completed'
            ? 'RUN_FAILED'
            : completionType(completion.work),
        channel: 'framework',
        intentId: completion.intentId,
        ...(completion.work.kind === 'task' ? { taskId: completion.work.id } : {}),
        body,
      };
      const stopReason = (completion.work.result as { stopReason?: string } | undefined)
        ?.stopReason;
      const paused =
        acceptance.status === 'failed' ||
        completion.work.state !== 'completed' ||
        stopReason !== 'end_turn';
      const deliveredMail =
        intent?.mailAfter !== undefined &&
        ['unknown', 'confirmed'].includes(completion.work.dispatchOutcome ?? '');
      await this.controller.storage.append(team, [message], {
        checks: [{ kind: 'collab_outbox', id: completion.id, revision: completion.revision }],
        puts: [
          row('collab_outbox', {
            ...completion,
            delivered: true,
            revision: completion.revision + 1,
          }),
          ...(intent
            ? [
                row('collab_intent', {
                  ...intent,
                  state: 'settled',
                  endedAt: completion.work.endedAt,
                  revision: intent.revision + 1,
                }),
              ]
            : []),
          ...(paused || deliveredMail
            ? [
                row('collab_agent', {
                  ...agent,
                  ...(paused ? { queuePaused: true } : {}),
                  ...(deliveredMail ? { mailAfter: intent.mailAfter! } : {}),
                  revision: agent.revision + 1,
                }),
              ]
            : []),
        ],
      });
    }
  }

  private async notifyInput(
    team: TeamRecord,
    agent: ManagedAgentRecord,
    key: string,
    body: unknown,
  ) {
    if (await this.app.store.get('collab_input', key)) return;
    const current = (await this.app.store.get<TeamRecord>('collab_team', team.id))!;
    await this.controller.storage.append(
      current,
      [...new Set(['root', agent.parentId])].map((recipient) => ({
        id: `msg_${key}_${recipient}`,
        revision: 1,
        createdAt: now(),
        teamId: team.id,
        recipient,
        agentId: agent.id,
        from: agent.path,
        type: 'INPUT_REQUIRED' as const,
        body,
      })),
      {
        checks: [{ kind: 'collab_input', id: key, absent: true }],
        puts: [row('collab_input', { id: key, revision: 1, createdAt: now() })],
      },
    );
  }

  private async advance(team: TeamRecord, agent: ManagedAgentRecord) {
    if (agent.lifecycle === 'closed') return;
    const ctx = this.controller.context(team, agent);
    const runtime = await this.controller.runtimeFor(agent);
    if (runtime && !agent.runtimeId)
      agent = await this.controller.update(agent, { runtimeId: runtime.id });
    const operation = agent.operationId
      ? await this.app.store.get<WorkRecord>('operation', agent.operationId)
      : null;
    if (operation?.sessionId && operation.sessionId !== agent.sessionId)
      agent = await this.controller.update(agent, { sessionId: operation.sessionId });
    const session = agent.sessionId
      ? await this.app.store.get<SessionRecord>('session', agent.sessionId)
      : null;
    const intents = await this.controller.storage.intents(agent.id);
    const active = intents.find((i) => i.state === 'dispatched');
    const work = active?.taskId
      ? await this.app.store.get<WorkRecord>('task', active.taskId)
      : null;
    if (agent.lifecycle === 'stopping' || agent.lifecycle === 'closing') {
      if (operation && !terminalStates.has(operation.state))
        await this.controller.operations.cancel(ctx, operation.id);
      if (work && !terminalStates.has(work.state)) await this.app.tasks.cancel(ctx, work.id);
      if (agent.lifecycle === 'closing') {
        await this.controller.revokeBridge(agent.id);
        if (runtime && runtime.state !== 'closed')
          await this.controller.runtimes.closeNow(runtime.id);
        if (operation && !terminalStates.has(operation.state)) return;
        if (
          (await this.controller.members(team.id)).some(
            (child) => child.path.startsWith(`${agent.path}/`) && child.lifecycle !== 'closed',
          )
        )
          return;
        agent = await this.controller.agent(agent.id);
        await this.controller.update(agent, {
          lifecycle: 'closed',
          operationId: undefined,
          operationKind: undefined,
        });
      } else if (
        (!work || terminalStates.has(work.state)) &&
        (!operation || terminalStates.has(operation.state))
      ) {
        await this.controller.update(agent, {
          lifecycle: session?.state === 'ready' ? 'active' : 'paused',
          operationId: undefined,
          operationKind: undefined,
          queuePaused: false,
        });
      }
      return;
    }
    if (runtime) {
      for (const interaction of await this.app.interactions.list(ctx, {}, true)) {
        if (interaction.runtimeId === runtime.id)
          await this.notifyInput(team, agent, interaction.id, {
            interactionId: interaction.id,
            type: interaction.type,
            request: interaction.request,
          });
      }
      for (const interaction of await this.app.interactions.list(ctx, {}, false)) {
        if (interaction.runtimeId === runtime.id)
          await this.notifyInput(team, agent, interaction.id, {
            interactionId: interaction.id,
            type: interaction.type,
            request: interaction.request,
          });
      }
    }
    if (operation) {
      if (!terminalStates.has(operation.state)) return;
      if (operation.state !== 'completed') {
        if (operation.error?.code === 'AUTH_REQUIRED') {
          await this.controller.update(agent, {
            authRequired: true,
            operationId: undefined,
            operationKind: undefined,
            error: operation.error,
          });
          await this.notifyInput(team, agent, operation.id, {
            type: 'authentication',
            ...(operation.error.details ?? {}),
            nextAction: 'respond_agent reply + authMethodId',
          });
          return;
        }
        await this.controller.update(agent, {
          lifecycle: 'paused',
          operationId: undefined,
          operationKind: undefined,
          error: operation.error,
        });
        return;
      }
      if (agent.operationKind === 'authenticate') {
        // 认证回复明确授权在原 Runtime 重试已被拒绝的建会话；未知结果不走此路径。
        agent = await this.controller.update(agent, {
          authRequired: false,
          operationId: undefined,
          operationKind: undefined,
          error: undefined,
          lifecycle: agent.recoveryId ? 'paused' : 'starting',
          setupKey: `authenticated:${operation.id}`,
        });
        if (agent.recoveryId) return;
      } else {
        agent = await this.controller.update(agent, {
          lifecycle: 'active',
          operationId: undefined,
          operationKind: undefined,
          queuePaused: false,
          error: undefined,
          authRequired: false,
        });
      }
    }
    if (agent.authRequired || agent.lifecycle === 'paused') return;
    await this.app.identities.check(ctx);
    if (agent.lifecycle === 'starting') {
      const first = intents.find((i) => i.state === 'queued');
      if (!first) {
        await this.controller.update(agent, { lifecycle: 'paused' });
        return;
      }
      const retained = runtime?.state === 'prepared' ? runtime : null;
      await this.controller.sessions.create(
        {
          ...ctx,
          collaborationIntent: {
            teamId: team.id,
            agentId: agent.id,
            intentId: first.id,
            mailAfter: agent.mailAfter,
          },
        },
        {
          ...(retained
            ? {
                runtimeId: retained.id,
                expectedRuntimeRevision: retained.revision,
                expectedConnectionGeneration: retained.connectionGeneration,
              }
            : {
                configId: agent.configId,
                configRevision: agent.configRevision,
                cwd: agent.cwd,
                interactionChannel: this.controller.runtimes.channelAvailable(ctx, 'local_cli')
                  ? 'local_cli'
                  : ctx.nativeInteraction
                    ? 'mcp_native'
                    : 'none',
              }),
          idempotencyKey: `collab-create:${agent.id}:${agent.setupKey ?? 'initial'}`,
        },
      );
      return;
    }
    if (!session || session.state !== 'ready' || !runtime || runtime.state === 'closed') {
      await this.controller.update(agent, { lifecycle: 'paused' });
      return;
    }
    if (active || session.activeTaskId || agent.queuePaused) return;
    const intent = intents.find((i) => i.state === 'queued');
    if (!intent) return;
    const page = await this.controller.storage.mailbox(
      team.id,
      agent.id,
      undefined,
      agent.mailAfter,
    );
    const inbox: unknown[] = [];
    for (const message of page.messages)
      inbox.push({
        messageId: message.id,
        from: message.from,
        type: message.type,
        body: message.body,
      });
    const metadata = `协作成员 ${agent.path}，agentId=${agent.id}，团队 ${team.id}，configId=${agent.configId}。这里是 AgentControlMCP 团队；/root 是外部上游调用者，不是本客户端原生协作系统的 root。团队协作必须使用 MCP 服务 ${collaborationBridge.serverName} 的 acm_* 工具，不能用同名原生工具或最终回答替代。向上游发消息示例：agent_collaboration.acm_send_message({"requestId":"${intent.id}:message","target":"/root","message":"所需消息"})。若工具暂不可见，应报告 Bridge 不可用，不能改走原生通道。新成员看不到父历史；acm_spawn_agent.message 必须自包含目标、背景、输入、约束和交付标准。acm_send_message 只入邮箱；acm_followup_task 启动后续轮次；acm_wait_agent 读取邮箱。协作消息不代表真人批准。`;
    const prompt = [
      { type: 'text' as const, text: intent.message },
      ...(intent.order === '1' ? [{ type: 'text' as const, text: metadata }] : []),
      ...(intent.completionCriteria
        ? [
            {
              type: 'text' as const,
              text: `本轮完成条件：${JSON.stringify(intent.completionCriteria)}。requiredMessage 必须通过 agent_collaboration.acm_send_message 实际发送；仅在最终回答中复述不算完成。`,
            },
          ]
        : []),
      ...(inbox.length
        ? [{ type: 'text' as const, text: `以下为协作邮箱消息：\n${JSON.stringify(inbox)}` }]
        : []),
    ];
    if (bytes(prompt) > 16 * 1024 ** 2) {
      await this.app.store.commit({
        puts: this.endIntent(
          team,
          intent,
          'failed',
          errorDetail(
            new AppError(
              'CONFIG_INVALID',
              '任务正文、完成条件和待收邮箱合计超过 16 MiB，未派发 ACP。',
            ),
          ),
        ),
      });
      return;
    }
    try {
      await this.app.tasks.submit(
        {
          ...ctx,
          collaborationIntent: {
            teamId: team.id,
            agentId: agent.id,
            intentId: intent.id,
            mailAfter: page.after,
          },
        },
        { sessionId: session.id, prompt, idempotencyKey: `collab-task:${intent.id}` },
      );
    } catch (error) {
      const detail = errorDetail(error);
      if (['CAPACITY_EXCEEDED', 'STORAGE_FULL', 'SESSION_BUSY'].includes(detail.code)) return;
      await this.app.store.commit({ puts: this.endIntent(team, intent, 'failed', detail) });
    }
  }

  async prepareRestore(
    ctx: Context,
    team: TeamRecord,
    agent: ManagedAgentRecord,
    args: RespondInput,
  ) {
    if (!agent.sessionId) fail('RECOVERY_UNAVAILABLE', '没有可恢复的下游会话，请检查原实例诊断。');
    const runtime = await this.controller.runtimeFor(agent);
    const caps = runtime?.initialize?.agentCapabilities as
      { loadSession?: boolean; sessionCapabilities?: { resume?: unknown } } | undefined;
    const method =
      caps?.sessionCapabilities?.resume != null ? 'resume' : caps?.loadSession ? 'load' : null;
    if (!method) fail('CAPABILITY_UNSUPPORTED', '下游未声明可用的恢复能力。');
    const queued = (await this.controller.storage.intents(agent.id)).filter(
      (i) => i.state === 'queued',
    );
    const plan = await this.controller.sessions.restore(
      this.controller.context(team, agent),
      method,
      {
        phase: 'prepare',
        sessionId: agent.sessionId,
        configId: agent.configId,
        configRevision: agent.configRevision,
        idempotencyKey: `collab-prepare:${agent.id}:${args.requestId}`,
      },
    );
    if (!('restorePlanId' in plan)) fail('INTERNAL_ERROR', '恢复准备没有返回方案。');
    const decision: RecoveryDecision = {
      id: `recovery_${plan.restorePlanId}`,
      revision: 1,
      createdAt: now(),
      agentId: agent.id,
      restorePlanId: plan.restorePlanId,
      method,
      environmentDigest: plan.environmentDigest,
      expiresAt: plan.expiresAt,
      queuedIntentIds: queued.map((i) => i.id),
    };
    await this.app.store.put('collab_recovery', decision);
    await this.controller.team(ctx, team.id);
    return {
      planId: decision.id,
      method,
      environmentDigest: decision.environmentDigest,
      expiresAt: decision.expiresAt,
      queuedTasksToCancel: queued.map((i) => ({ intentId: i.id, message: i.message })),
      historyReplay: method === 'load',
      targetSnapshot: plan.targetSnapshot,
      nextAction: 'respond_agent reply + planId + acceptEnvironmentDigest；确认后不重放旧任务。',
    };
  }

  async restore(ctx: Context, team: TeamRecord, agent: ManagedAgentRecord, args: RespondInput) {
    if (agent.operationId || agent.lifecycle === 'starting')
      fail('RECOVERY_CONFLICT', '成员已有正在处理的操作，请等待其结果。');
    const decision = await this.app.store.get<RecoveryDecision>('collab_recovery', args.planId!);
    if (!decision || decision.agentId !== agent.id) fail('OBJECT_NOT_FOUND', '恢复方案不存在。');
    if (decision.acceptedOperationId) fail('RECOVERY_CONFLICT', '此方案已经受理，请重新准备恢复。');
    if (decision.environmentDigest !== args.acceptEnvironmentDigest || decision.expiresAt < now())
      fail('PLAN_CHANGED', '恢复摘要不匹配或已过期。');
    const queued = (await this.controller.storage.intents(agent.id)).filter(
      (i) => i.state === 'queued',
    );
    if (digest(queued.map((i) => i.id)) !== digest(decision.queuedIntentIds))
      fail('PLAN_CHANGED', '未执行队列已改变，请重新生成恢复方案。');
    if (team.instanceId !== this.app.instanceId) {
      const owner = await this.app.store.get<InstanceRecord>('instance', team.instanceId);
      if (owner?.state === 'active') fail('INSTANCE_MISMATCH', '原实例仍在运行，请连接原实例。');
      team = {
        ...team,
        instanceId: this.app.instanceId,
        context: {
          ...team.context,
          ...(ctx.credentialId ? { credentialId: ctx.credentialId } : {}),
        },
        revision: team.revision + 1,
      };
      await this.app.store.commit({
        checks: [{ kind: 'collab_team', id: team.id, revision: team.revision - 1 }],
        puts: [row('collab_team', team)],
      });
    }
    await this.controller.revokeBridge(agent.id);
    const runtime = await this.controller.runtimeFor(agent);
    const accepted = await this.controller.sessions.restore(
      {
        ...this.controller.context(team, agent),
        collaborationRestore: {
          recoveryId: decision.id,
          queuedIntentIds: decision.queuedIntentIds,
          request: this.controller.storage.request(ctx, 'respond_agent', args),
        },
      },
      decision.method,
      {
        phase: 'apply',
        sessionId: agent.sessionId!,
        restorePlanId: decision.restorePlanId,
        acceptEnvironmentDigest: decision.environmentDigest,
        ...(runtime?.state === 'prepared'
          ? {
              preparedRuntime: {
                runtimeId: runtime.id,
                expectedRuntimeRevision: runtime.revision,
                expectedConnectionGeneration: runtime.connectionGeneration,
              },
            }
          : {}),
        idempotencyKey: `collab-restore:${decision.id}:${args.requestId}`,
      },
    );
    if (!('operationId' in accepted)) fail('INTERNAL_ERROR', '恢复没有返回操作。');
    return { agentId: agent.id, accepted: true, state: 'starting' };
  }

  async output(
    ctx: Context,
    agent: ManagedAgentRecord,
    args: {
      cursor?: string | undefined;
      intentId?: string | undefined;
      messageId?: string | undefined;
    },
  ) {
    const events = this.controller.sessions.events;
    let objectId: string;
    let result: unknown;
    let completion: Record<string, unknown>;
    if (args.messageId) {
      const message = await this.app.store.get<MessageRecord>('collab_message', args.messageId);
      if (
        !message ||
        message.teamId !== agent.teamId ||
        (message.agentId !== agent.id && message.recipient !== agent.id) ||
        (ctx.collaborationMember && message.recipient !== ctx.collaborationMember.agentId)
      )
        fail('OBJECT_NOT_FOUND', '消息不可见。');
      objectId = message.type === 'MESSAGE' ? message.id : (message.intentId ?? message.id);
      result = (message.body as { result?: unknown }).result ?? message.body;
      completion = message.body as Record<string, unknown>;
    } else {
      const intents = await this.controller.storage.intents(agent.id);
      const intent = args.intentId
        ? intents.find((i) => i.id === args.intentId)
        : [...intents].reverse().find((i) => i.state === 'settled');
      if (!intent) return { result: null, contentComplete: false };
      if (
        ctx.collaborationMember &&
        agent.id !== ctx.collaborationMember.agentId &&
        agent.parentId !== ctx.collaborationMember.agentId
      )
        fail('ACCESS_DENIED', '成员只能读取自身或直接子成员的输出。');
      objectId = intent.id;
      const message = await this.app.store.get<MessageRecord>('collab_message', `msg_${intent.id}`);
      result = (message?.body as { result?: unknown } | undefined)?.result ?? message?.body;
      completion = (message?.body as Record<string, unknown> | undefined) ?? {};
    }
    const evidence = {
      configId: completion.configId ?? agent.configId,
      configRevision: completion.configRevision ?? agent.configRevision,
      completionScope: 'acp_turn',
      acceptance: completion.acceptance ?? { status: 'not_requested', checks: [] },
    };
    const ref = result as
      | {
          representation?: string;
          contentId?: string;
          contentComplete?: boolean;
          bridgeCalls?: unknown;
          bridgeCallsComplete?: boolean;
        }
      | undefined;
    if (ref?.representation !== 'resource' || !ref.contentId)
      return {
        ...evidence,
        result: result ?? null,
        contentComplete: result !== undefined && ref?.contentComplete !== false,
      };
    const streamId = `output:${agent.teamId}:${objectId}`;
    const filter = digest({
      contentId: ref.contentId,
      recipient: ctx.collaborationMember?.agentId ?? 'root',
    });
    const offset = args.cursor ? Number(events.decode(args.cursor, streamId, filter)) : 0;
    const page = await events.content(objectId, ref.contentId, offset, 32 * 1024);
    await this.controller.team(ctx, agent.teamId);
    return {
      ...evidence,
      bridgeCalls: ref.bridgeCalls ?? [],
      bridgeCallsComplete: ref.bridgeCallsComplete ?? false,
      ...page,
      nextCursor: events.encode({ streamId, filter, after: String(page.nextOffset) }),
      contentComplete: ref.contentComplete !== false,
    };
  }
}
