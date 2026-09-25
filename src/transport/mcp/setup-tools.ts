import { z } from 'zod';
import type { Container } from '../../bootstrap/container.js';
import { absolutePath, agentConfig, agentPatch, page, text, write } from '../../domain/schemas.js';
import { createTools, installFields } from './tools.js';
import type { ToolDefinition } from './tools.js';
import { fail } from '../../domain/errors.js';
import { idem } from '../../application/common.js';

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
  const envelope = z.strictObject({
    action: z.enum(['install', ...delegates.map(({ action }) => action)]),
    arguments: z.record(z.string(), z.unknown()),
  });
  // 顶层始终是 action + arguments；公开分支说明，执行时只检查所选 action。
  const setupSchema = envelope.extend({
    arguments: z.union([
      installSchema.describe('action=install 的参数'),
      ...delegates.map(({ action, definition }) =>
        definition.schema.describe(`action=${action} 的参数`),
      ),
    ]),
  });
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
        '显式接入 Agent，参数必须嵌套为 {action, arguments}。最小注册示例：{"action":"register","arguments":{"config":{"name":"my-agent","origin":{"kind":"manual"},"launch":{"kind":"command","executable":"/absolute/path/to/acp-agent","args":[]}},"idempotencyKey":"register-my-agent"}}。permissionPolicy 可整体省略；提供时必须包含 rules（每条含 id/effect/operations/roots）、fallback="ask"、timeoutMs（允许 null，不能漏填）。install 安装并注册；update 修改；refresh_registry 刷新候选；plan_local/apply_local 复用 Codex；cancel 取消 operation。install/apply_local（含 ACP 适配器）只能在用户明确授权目标后调用。长操作返回 operationId，使用 wait_agent_setup 查询。注册失败不得改用旧 profile 宣称新增成功；注册成功后将返回的 configId 用作 spawn_agent.profile。',
      run: async (ctx, input) => {
        const args = envelope.parse(input);
        if (ctx.collaborationMember) fail('ACCESS_DENIED', '下游成员不能管理 Agent 安装或配置。');
        if (args.action === 'install') {
          const parsed = z
            .strictObject({ action: z.literal('install'), arguments: installSchema })
            .parse(input);
          return app.setup.install(ctx, parsed.arguments);
        }
        const target = delegates.find((item) => item.action === args.action)!;
        const value = z
          .strictObject({ action: z.literal(args.action), arguments: target.definition.schema })
          .parse(input).arguments as Record<string, unknown>;
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
        '等待接入 operation 的进度或终态，复用归属校验。注册成功后核对 result.configId，再直接创建成员，无需刷新工具；下载成功但未注册不表示已就绪。',
      run: (ctx, input) => app.setup.wait(ctx, waitSchema.parse(input)),
    },
  ];
}
