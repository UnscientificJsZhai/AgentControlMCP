import { digest, id, now } from '../domain/ids.js';
import { AppError, errorDetail, fail } from '../domain/errors.js';
import type { Context, WorkRecord } from '../domain/models.js';
import type { AgentConfig } from '../domain/schemas.js';
import { agentConfig } from '../domain/schemas.js';
import { fingerprint, scanCodex } from '../adapters/local/codex.js';
import type { LocalCandidate } from '../adapters/local/codex.js';
import type { InstallationService } from './installation-service.js';
import { row } from '../infrastructure/storage/sqlite-store.js';
import { idem } from './common.js';
import { operationUpdateEvent } from './operation-service.js';

type Target =
  | { kind: 'new'; config: Omit<AgentConfig, 'origin' | 'launch'> }
  | { kind: 'existing'; configId: string; expectedRevision: number };

interface Plan {
  id: string;
  revision: number;
  createdAt: string;
  ownerId: string;
  candidate: LocalCandidate;
  sourceId: string;
  registryAgentId: string;
  targetVersion: string;
  snapshotId: string;
  manifestDigest: string;
  target: Target;
  config: AgentConfig;
  planDigest: string;
  expiresAt: string;
}

/** 为复用宿主 Codex 生成可审阅方案，明确绑定程序指纹、Adapter 快照及配置变更。 */
export class LocalPlanService {
  validateConfig: (config: AgentConfig, configId?: string) => Promise<void> = async () => {};
  onChange: () => Promise<void> = async () => {};
  constructor(readonly installations: InstallationService) {}

  async scan(paths?: string[]) {
    const candidates = await scanCodex(paths);
    for (const candidate of candidates)
      await this.installations.store.put('local_candidate', candidate);
    return { candidates };
  }

  /** 只准备目标配置；pending_installation 在 apply 安装成功后才替换为真实安装 ID。 */
  async plan(
    ctx: Context,
    args: {
      candidateId: string;
      sourceId: string;
      registryAgentId: string;
      targetVersion: string;
      target: Target;
    },
  ) {
    if (args.registryAgentId !== 'codex-acp')
      fail('CONFIG_INVALID', '首版专用复用仅支持 codex-acp Adapter。');
    const candidate = await this.installations.store.get<LocalCandidate>(
      'local_candidate',
      args.candidateId,
    );
    if (!candidate) fail('OBJECT_NOT_FOUND', '候选不存在，请先扫描。');
    if (candidate.compatibility === 'incompatible')
      fail('LOCAL_EXECUTABLE_INCOMPATIBLE', '候选未通过启动探测。');
    const entry = await this.installations.registry.get(args.sourceId, args.registryAgentId);
    if (entry.agent.version !== args.targetVersion || !entry.agent.distribution.npx)
      fail('VERSION_UNRESOLVABLE', '所选固定 Adapter 版本不在当前来源中。');
    const existing =
      args.target.kind === 'existing'
        ? await this.installations.configs.get(args.target.configId)
        : null;
    if (args.target.kind === 'existing' && existing?.revision !== args.target.expectedRevision)
      fail('REVISION_CONFLICT', '目标配置已改变。');
    const base = existing?.config ?? (args.target as Extract<Target, { kind: 'new' }>).config;
    const config = agentConfig.parse({
      ...base,
      origin: existing?.config.origin ?? {
        kind: 'registry',
        sourceId: args.sourceId,
        registryAgentId: args.registryAgentId,
      },
      launch: { kind: 'installation', installationId: 'pending_installation' },
      environment: {
        ...base.environment,
        values: {
          ...base.environment.values,
          CODEX_PATH: { kind: 'literal', value: candidate.path },
        },
      },
    });
    const content = {
      candidate,
      sourceId: args.sourceId,
      registryAgentId: args.registryAgentId,
      targetVersion: args.targetVersion,
      snapshotId: entry.snapshotId,
      manifestDigest: digest(entry.agent.distribution.npx),
      target: args.target,
      config,
    };
    const plan: Plan = {
      ...content,
      id: id('plan'),
      revision: 1,
      createdAt: now(),
      ownerId: ctx.principalId,
      planDigest: digest(content),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    await this.installations.store.put('local_plan', plan);
    return {
      planId: plan.id,
      planDigest: plan.planDigest,
      expiresAt: plan.expiresAt,
      candidate,
      before: existing?.config ?? null,
      after: config,
      adapter: entry,
      installationRequired: true,
      guidance: '应用此方案可能安装所选 codex-acp 适配器；必须先获得用户对此安装目标的明确授权。',
    };
  }

  /** 验证方案归属、摘要和兼容性确认后执行安装，再以事务提交本地绑定和配置切换。 */
  async apply(
    ctx: Context,
    args: {
      planId: string;
      planDigest: string;
      acceptUnknownCompatibility?: boolean | undefined;
      idempotencyKey: string;
    },
  ) {
    const replay = await this.installations.store.replay(
      idem(ctx, 'local_agent_apply', args, null),
    );
    if (replay) {
      const accepted = replay as { operationId: string; state: string };
      await this.installations.operations.get(ctx, accepted.operationId);
      return accepted;
    }
    const plan = await this.installations.store.get<Plan>('local_plan', args.planId);
    if (!plan || (plan.ownerId !== ctx.principalId && !ctx.admin))
      fail('OBJECT_NOT_FOUND', '方案不存在。');
    if (plan.planDigest !== args.planDigest) fail('PLAN_CHANGED', '确认摘要与方案不一致。');
    if (Date.parse(plan.expiresAt) < Date.now()) fail('PLAN_EXPIRED', '方案已过期。');
    if (plan.candidate.compatibility === 'unknown' && !args.acceptUnknownCompatibility)
      fail('LOCAL_EXECUTABLE_INCOMPATIBLE', '此组合尚未验证，应用时需要明确接受未知兼容状态。');
    return this.installations.operations.start(
      ctx,
      'local_agent_apply',
      args,
      async (operationId, signal) => {
        if ((await fingerprint(plan.candidate.path)) !== plan.candidate.fingerprint)
          fail('PLAN_CHANGED', '本地文件已变化，请重新扫描并确认方案。');
        const entry = await this.installations.registry.get(
          plan.sourceId,
          plan.registryAgentId,
          plan.snapshotId,
        );
        if (digest(entry.agent.distribution.npx) !== plan.manifestDigest)
          fail('PLAN_CHANGED', 'Adapter 分发摘要已改变。');
        const installation = await this.installations.acquire(
          {
            sourceId: plan.sourceId,
            registryAgentId: plan.registryAgentId,
            targetVersion: plan.targetVersion,
            distribution: 'npx',
            snapshotId: plan.snapshotId,
          },
          operationId,
          signal,
        );
        try {
          signal.throwIfAborted();
          // 安装可能耗时较长，提交前再次检查本地文件，避免使用确认后已经变化的候选。
          if ((await fingerprint(plan.candidate.path)) !== plan.candidate.fingerprint)
            fail('PLAN_CHANGED', '安装期间本地文件变化。');
          const store = this.installations.store;
          const previous =
            plan.target.kind === 'existing'
              ? await this.installations.configs.get(plan.target.configId)
              : null;
          const record = {
            id: previous?.id ?? id('cfg'),
            revision: (previous?.revision ?? 0) + 1,
            createdAt: previous?.createdAt ?? now(),
            config: {
              ...plan.config,
              launch: { kind: 'installation' as const, installationId: installation.id },
            },
          };
          // 本次方案已复核新指纹；不能再套用即将被替换的旧 local_binding。
          await this.installations.configs.validate(record.config);
          await this.validateConfig(record.config);
          const result = {
            configId: record.id,
            revision: record.revision,
            installationId: installation.id,
            localBinding: plan.candidate,
          };
          const operation = await this.installations.operations.get(ctx, operationId);
          if (operation.state === 'cancelling') fail('CANCELLED', '方案应用已取消。');
          const completed: WorkRecord = {
            ...operation,
            revision: operation.revision + 1,
            commitState: 'committed',
            state: 'completed',
            result,
            endedAt: now(),
          };
          await store.commit({
            checks: [
              { kind: 'operation', id: operationId, revision: operation.revision },
              { kind: 'installation', id: installation.id, state: 'ready' },
              ...(plan.target.kind === 'existing'
                ? [
                    {
                      kind: 'config',
                      id: plan.target.configId,
                      revision: plan.target.expectedRevision,
                    },
                  ]
                : []),
            ],
            puts: [
              row('config', record),
              { ...row('config_revision', record), id: `${record.id}:${record.revision}` },
              row('local_binding', {
                id: record.id,
                revision: record.revision,
                createdAt: now(),
                candidate: plan.candidate,
              }),
              row('operation', completed),
            ],
            events: [operationUpdateEvent(completed)],
            claims: [
              { key: `installation:${installation.id}:config:${record.id}`, holder: record.id },
            ],
            releases:
              previous?.config.launch.kind === 'installation'
                ? [
                    {
                      key: `installation:${previous.config.launch.installationId}:config:${record.id}`,
                      holder: record.id,
                    },
                  ]
                : [],
            idempotency: idem(
              ctx,
              'local_plan_commit',
              { idempotencyKey: operationId },
              { configId: record.id },
            ),
          });
          await this.onChange();
          await this.installations.configs.project(record);
          return result;
        } catch (error) {
          const detail = errorDetail(error);
          throw new AppError(
            detail.code,
            detail.message,
            { ...detail.details, installationId: installation.id },
            '安装产物已保留。请修正配置并重新生成复用方案，或显式注册此 installationId。',
          );
        }
      },
    );
  }
}
