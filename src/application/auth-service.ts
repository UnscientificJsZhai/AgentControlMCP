import { AppError, fail } from '../domain/errors.js';
import type { Context, RuntimeRecord, SessionRecord } from '../domain/models.js';
import { requireCapability } from '../infrastructure/acp/capability-gate.js';
import { ClientRuntime } from '../infrastructure/acp/client-runtime.js';
import type { RuntimeService } from './runtime-service.js';
import type { InteractionService } from './interaction-service.js';
import { row } from '../infrastructure/storage/sqlite-store.js';

export interface RuntimeTarget {
  runtimeId?: string | undefined;
  sessionId?: string | undefined;
}

/** 认证绑定实际 ACP Runtime；探测缓存只能展示方法，不能证明当前连接已经登录。 */
export class AuthService {
  constructor(
    readonly runtimes: RuntimeService,
    readonly interactions: InteractionService,
  ) {}

  async target(ctx: Context, target: RuntimeTarget): Promise<RuntimeRecord> {
    if (target.runtimeId) {
      const runtime = await this.runtimes.get(ctx, target.runtimeId, true);
      if (runtime.managedAgentId && ctx.managedAgentId !== runtime.managedAgentId)
        fail('AGENT_MANAGED', '托管成员认证请使用 respond_agent。');
      return runtime;
    }
    const session = await this.runtimes.store.get<SessionRecord>('session', target.sessionId!);
    if (!session) return fail('SESSION_NOT_FOUND', '会话不存在。');
    return this.runtimes.get(ctx, session.runtimeId, true);
  }

  async methods(ctx: Context, target: RuntimeTarget & { configId?: string | undefined }) {
    if (target.configId) {
      const cached = await this.runtimes.store.get('probe', target.configId);
      if (!cached) fail('CAPABILITY_UNSUPPORTED', '尚无展示用探测结果，请先调用 agent_probe。');
      return cached;
    }
    const runtime = await this.target(ctx, target);
    return {
      runtimeId: runtime.id,
      runtimeRevision: runtime.revision,
      connectionGeneration: runtime.connectionGeneration,
      authMethods: runtime.initialize?.authMethods ?? [],
    };
  }

  /** 在生命周期互斥区内认证或退出登录，拒绝与活动 prompt、控制请求并发。 */
  async authenticate(
    ctx: Context,
    args: RuntimeTarget & {
      expectedRevision: number;
      expectedConnectionGeneration: number;
      methodId?: string | undefined;
      interactionChannel?: string | undefined;
      idempotencyKey: string;
    },
    logout = false,
  ) {
    const runtime = await this.target(ctx, args);
    return this.runtimes.operations.start(
      ctx,
      logout ? 'agent_logout' : 'agent_authenticate',
      args,
      async (operationId, signal) => {
        const admit = async () => {
          const current = await this.target(ctx, args);
          this.runtimes.guard(current, args.expectedRevision, args.expectedConnectionGeneration);
          const session = current.sessionId
            ? await this.runtimes.store.get<SessionRecord>('session', current.sessionId)
            : null;
          this.interactions.tasks.sessions.assertLifecycleAvailable(session, current.id);
          const handle = this.runtimes.handle(current);
          this.runtimes.lifecycle.add(current.id);
          handle.operationId = operationId;
          return { current, handle };
        };
        const { current, handle } = await (runtime.sessionId
          ? this.interactions.tasks.sessions.serial.run(runtime.sessionId, admit)
          : this.runtimes.serial.run(runtime.id, admit));
        let reconnecting = false;
        try {
          if (logout) {
            requireCapability(handle.client.initialize.agentCapabilities ?? {}, 'logout');
            await handle.client.request(
              'logout',
              {},
              this.runtimes.settings.controlTimeoutMs,
              signal,
            );
            return this.runtimes.view(
              await this.runtimes.update(current.id, { authState: 'logged_out' }),
            );
          }
          const method = handle.client.initialize.authMethods?.find(
            (method) => method.id === args.methodId,
          );
          if (!method) fail('CONFIG_INVALID', '认证方式未由此连接公布。');
          if (!this.runtimes.channelAvailable(ctx, args.interactionChannel ?? 'none'))
            fail('INTERACTION_CHANNEL_UNAVAILABLE', '请求入口没有真实交互通道。');
          // terminal 认证由宿主交互式进程执行，不发送 authenticate；成功后重新初始化 ACP。
          if ('type' in method && method.type === 'terminal') {
            if (current.sessionId)
              fail(
                'AUTH_RECONNECT_REQUIRED',
                '终端登录要求关闭原会话，再准备新 Runtime 并按能力恢复。',
              );
            if (handle.channel !== 'local_cli')
              fail('INTERACTION_CHANNEL_UNAVAILABLE', '终端登录需要连接器宿主机上的交互式 CLI。');
            reconnecting = true;
            await handle.client.close();
            const result = (await this.interactions.open(
              current.id,
              'terminal_auth',
              { method, snapshot: current.snapshot, cwd: current.cwd },
              signal,
              null,
            )) as { action: string; content?: { exitCode?: number } };
            if (result.action !== 'accept' || result.content?.exitCode !== 0)
              fail('AUTH_FAILED', '终端认证未成功结束。');
            const client = await ClientRuntime.start(
              handle.spec,
              handle.secrets,
              {
                fs: {
                  readTextFile: this.runtimes.settings.fileCallbacks,
                  writeTextFile: this.runtimes.settings.fileCallbacks,
                },
                terminal: this.runtimes.settings.terminals,
                session: { configOptions: { boolean: {} } },
                elicitation: { form: {}, url: {} },
                auth: { terminal: true },
              },
              this.runtimes.ports(current.id),
              this.runtimes.settings.initializationTimeoutMs,
              signal,
            );
            try {
              const updated = await this.runtimes.serial.run(current.id, async () => {
                if (signal.aborted || this.runtimes.live.get(current.id) !== handle)
                  fail('CANCELLED', '重连期间 Runtime 已关闭。');
                const latest = (await this.runtimes.store.get<RuntimeRecord>(
                  'runtime',
                  current.id,
                ))!;
                if (
                  signal.aborted ||
                  latest.state === 'closed' ||
                  this.runtimes.live.get(current.id) !== handle
                )
                  fail('CANCELLED', '重连期间 Runtime 已关闭。');
                handle.client = client;
                // 新连接不能继承旧连接的认证结论；提升代次使旧交互答复失效。
                const next: RuntimeRecord = {
                  ...latest,
                  revision: latest.revision + 1,
                  state: 'prepared',
                  connectionGeneration: latest.connectionGeneration + 1,
                  authState: 'unknown',
                  initialize: client.initialize,
                  pid: client.host.pid,
                  expiresAt: new Date(
                    Date.now() + this.runtimes.settings.preparedTtlMs,
                  ).toISOString(),
                };
                await this.runtimes.store.commit({
                  checks: [{ kind: 'runtime', id: latest.id, revision: latest.revision }],
                  puts: [row('runtime', next)],
                });
                return next;
              });
              signal.throwIfAborted();
              reconnecting = false;
              return this.runtimes.view(updated);
            } catch (error) {
              await client.close();
              throw error;
            }
          }
          await this.runtimes.update(current.id, { authState: 'authenticating' });
          await handle.client.request('authenticate', { methodId: method.id }, undefined, signal);
          return this.runtimes.view(
            await this.runtimes.update(current.id, {
              authState: 'authenticated',
              expiresAt: new Date(Date.now() + this.runtimes.settings.preparedTtlMs).toISOString(),
            }),
          );
        } catch (error) {
          if (
            reconnecting ||
            signal.aborted ||
            (error instanceof AppError && ['TIMEOUT', 'DOWNSTREAM_EXITED'].includes(error.code))
          )
            await this.runtimes.closeNow(current.id);
          if (
            error instanceof AppError &&
            (error.code === 'AUTH_REQUIRED' || error.code === 'PROTOCOL_ERROR')
          ) {
            await this.runtimes.update(current.id, { authState: 'required' });
            throw new AppError('AUTH_FAILED', '下游未确认认证成功。', error.details);
          }
          throw error;
        } finally {
          this.runtimes.lifecycle.delete(current.id);
        }
      },
      { runtimeId: runtime.id, ...(runtime.sessionId ? { sessionId: runtime.sessionId } : {}) },
    );
  }
}
