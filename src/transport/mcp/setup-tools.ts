import { z } from 'zod';
import type { Container } from '../../bootstrap/container.js';
import { absolutePath, agentConfig, agentPatch, page, text, write } from '../../domain/schemas.js';
import { createTools, installFields } from './tools.js';
import type { ToolDefinition } from './tools.js';
import { fail } from '../../domain/errors.js';
import { idem } from '../../application/common.js';

export const setupToolNames = new Set(['discover_agents', 'setup_agent', 'wait_agent_setup']);

/** 精简接入门面复用原管理契约，不将任意内部操作透传给默认协作入口。 */
export function createSetupTools(app: Container): ToolDefinition[] {
  const operations = createTools(app);
  const actions = {
    refresh_registry: 'registry_refresh',
    register: 'agent_register',
    update: 'agent_update',
    plan_local: 'local_agent_plan',
    apply_local: 'local_agent_apply',
    cancel: 'operation_cancel',
  };
  const installSchema = z.strictObject({
    ...installFields,
    profile: agentConfig
      .omit({ origin: true, launch: true })
      .extend({ enabled: z.literal(true).default(true) }),
    launchArgs: z.array(z.string()).optional(),
    ...write,
  });
  const delegates = Object.entries(actions).map(([action, name]) => ({
    action,
    definition: operations.find((tool) => tool.name === name)!,
  }));
  const setupSchema = z.union([
    z.strictObject({ action: z.literal('install'), arguments: installSchema }),
    ...delegates.map(({ action, definition }) =>
      z.strictObject({
        action: z.literal(action),
        arguments: definition.schema,
      }),
    ),
  ]);
  const discoverSchema = z.strictObject({
    sourceId: text.optional(),
    query: z.string().optional(),
    ...page,
    local: z
      .strictObject({ adapter: z.literal('codex'), paths: z.array(absolutePath).optional() })
      .optional(),
  });
  const waitSchema = z.strictObject({
    operationId: text,
    afterRevision: z.number().int().positive().optional(),
    timeoutMs: z.number().int().min(0).max(30_000).default(10_000),
  });
  return [
    {
      name: 'discover_agents',
      schema: discoverSchema,
      readOnly: true,
      destructive: false,
      openWorld: false,
      description:
        '发现可用 profile、现有安装及缓存中的 Registry 候选并返回接入指引；local 参数才扫描本地 Codex。不安装、不注册、不启动 ACP。无可用 Agent 时请让用户明确选择安装目标，优先复用现有安装。',
      run: (ctx, input) => app.setup.discover(ctx, discoverSchema.parse(input)),
    },
    {
      name: 'setup_agent',
      schema: setupSchema,
      readOnly: false,
      destructive: false,
      description:
        '显式接入 Agent：install 安装固定目标并注册 profile；register/update 接入或配置现有程序；refresh_registry 刷新候选；plan_local/apply_local 复用 Codex；cancel 取消 operation。install/apply_local（含 ACP 适配器）只能在用户明确授权目标后调用，不能因任务需要、空环境或失败自行安装。长操作返回 operationId，使用 wait_agent_setup 查询。',
      run: async (ctx, input) => {
        const args = setupSchema.parse(input);
        if (ctx.collaborationMember) fail('ACCESS_DENIED', '下游成员不能管理 Agent 安装或配置。');
        if (args.action === 'install')
          return app.setup.install(ctx, installSchema.parse(args.arguments));
        const target = delegates.find((item) => item.action === args.action)!;
        const value = target.definition.schema.parse(args.arguments) as Record<string, unknown>;
        if (args.action === 'register' || args.action === 'update') {
          const replay = await app.store.replay(
            idem(ctx, target.definition.name, value as { idempotencyKey: string }, null),
          );
          if (replay) return replay;
        }
        if (args.action === 'register')
          await app.setup.requireReady(agentConfig.parse(value.config));
        if (args.action === 'update') {
          const current = await app.configs.get(String(value.configId));
          const merged = { ...current.config, ...agentPatch.parse(value.patch) };
          if (merged.cwd === null) delete merged.cwd;
          if (merged.sessionNamespace === null) delete merged.sessionNamespace;
          await app.setup.requireReady(agentConfig.parse(merged), current.id);
        }
        const result = await target.definition.run(ctx, value);
        await app.availability.refresh();
        return result;
      },
    },
    {
      name: 'wait_agent_setup',
      schema: waitSchema,
      readOnly: true,
      destructive: false,
      openWorld: false,
      description:
        '等待接入 operation 的进度或终态，复用归属校验。成功后重新拉取 tools/list 获取完整协作工具；下载成功但未注册不表示已就绪。',
      run: (ctx, input) => app.setup.wait(ctx, waitSchema.parse(input)),
    },
  ];
}
