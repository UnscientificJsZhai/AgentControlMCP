import { AppError, errorDetail, fail } from '../domain/errors.js';
import { agentConfig } from '../domain/schemas.js';
import type { AgentConfig } from '../domain/schemas.js';
import type { Context } from '../domain/models.js';
import type { InstallTarget } from '../infrastructure/installers/installer.js';
import { platformKey } from '../infrastructure/installers/installer.js';
import type { InstallationService } from './installation-service.js';
import type { AgentAvailabilityService } from './agent-availability-service.js';
import type { LocalPlanService } from './local-plan-service.js';
import type { IdentityService } from './identity-service.js';
import { paginate } from './common.js';

export interface AgentSetupInstall extends InstallTarget {
  profile: Omit<AgentConfig, 'origin' | 'launch'>;
  launchArgs?: string[] | undefined;
  idempotencyKey: string;
}

/** 接入编排仅由明确的写操作调用；发现、目录刷新和 Runtime 启动均不调用安装器。 */
export class AgentSetupService {
  constructor(
    readonly installations: InstallationService,
    readonly availability: AgentAvailabilityService,
    readonly local: LocalPlanService,
    readonly identities: IdentityService,
  ) {}

  async discover(
    ctx: Context,
    args: {
      sourceId?: string | undefined;
      query?: string | undefined;
      limit?: number | undefined;
      cursor?: string | undefined;
      local?: { adapter: 'codex'; paths?: string[] | undefined } | undefined;
    },
  ) {
    const snapshot = await this.availability.snapshot();
    return {
      phase: this.availability.phase(ctx, snapshot),
      profiles: snapshot.profiles.map(({ record, availability }) => ({
        profile: record.id,
        configId: record.id,
        name: record.config.name,
        revision: record.revision,
        ...availability,
      })),
      installations: snapshot.installations.map((item) => ({
        installationId: item.id,
        sourceId: item.sourceId,
        registryAgentId: item.registryAgentId,
        version: item.version,
        distribution: item.distribution,
        state: item.state,
      })),
      sources: await this.installations.registry.sources(),
      candidates: paginate(
        await this.installations.registry.search(args.sourceId, args.query, platformKey()),
        args,
      ),
      ...(args.local ? { local: await this.local.scan(args.local.paths) } : {}),
      guidance:
        'AgentControlMCP 已连接，工具目录固定。空 profiles 表示尚未配置。优先接入现有 Agent；只有用户明确指定安装目标（含 ACP 适配器）才调用 setup_agent 的 install/apply_local。setup_agent 参数为 {action, arguments: {...}}，可省略整个 permissionPolicy 使用默认策略。注册成功后直接将 configId 传给 spawn_agent.profile；新增失败不能用旧配置冒充。无 Registry 缓存时可显式 refresh_registry。',
    };
  }

  async requireReady(config: AgentConfig, configId?: string) {
    if (!config.enabled) return;
    const result = await this.availability.inspect(config, configId);
    if (!result.ready)
      throw new AppError(result.reason.code, result.reason.message, result.reason.details);
  }

  install(ctx: Context, args: AgentSetupInstall) {
    return this.installations.operations.start(
      ctx,
      'agent_setup_install',
      args,
      async (operationId, signal) => {
        const installation = await this.installations.acquire(args, operationId, signal);
        try {
          signal.throwIfAborted();
          const config = agentConfig.parse({
            ...args.profile,
            origin: {
              kind: 'registry',
              sourceId: args.sourceId,
              registryAgentId: args.registryAgentId,
            },
            launch: {
              kind: 'installation',
              installationId: installation.id,
              ...(args.launchArgs ? { args: args.launchArgs } : {}),
            },
          });
          if (!config.enabled) fail('CONFIG_INVALID', '安装并注册需要启用的 profile。');
          await this.requireReady(config);
          // 取消与配置提交共用操作锁；事务将 profile、安装引用和成功结果一起发布。
          const result = await this.installations.operations.serial.run(operationId, async () => {
            signal.throwIfAborted();
            await this.identities.check(ctx);
            const operation = await this.installations.operations.get(ctx, operationId);
            if (operation.state === 'cancelling') fail('CANCELLED', '接入操作已取消。');
            return this.installations.configs.register(
              ctx,
              {
                config,
                idempotencyKey: `${operationId}:register`,
              },
              operation,
            );
          });
          await this.availability.refresh();
          return result;
        } catch (error) {
          const detail = errorDetail(error);
          throw new AppError(
            detail.code,
            detail.message,
            {
              ...detail.details,
              installationId: installation.id,
            },
            '已完成的安装产物已保留；修正配置后用 setup_agent register 引用此 installationId，无需重新安装。',
          );
        }
      },
    );
  }

  async wait(
    ctx: Context,
    args: {
      operationId: string;
      afterRevision?: number | undefined;
      timeoutMs?: number | undefined;
    },
  ) {
    const operation = await this.installations.operations.wait(ctx, args);
    const snapshot = await this.availability.snapshot();
    // 在可用性检查之后再次复核，保持原 operation 的身份和对象访问规则。
    await this.installations.operations.get(ctx, operation.id);
    return {
      ...operation,
      phase: this.availability.phase(ctx, snapshot),
      nextAction:
        operation.state === 'completed'
          ? '接入操作已结束。涉及注册时必须核对 result.configId 与 discover_agents 中的 profile，再用该 configId 创建成员并核对成员绑定；无需刷新工具目录或重连。'
          : (operation.error?.nextAction ??
            '使用本 operationId 继续等待；需要停止时调用 setup_agent cancel。'),
    };
  }
}
