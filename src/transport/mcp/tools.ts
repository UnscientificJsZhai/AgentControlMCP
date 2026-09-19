import { z } from 'zod';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import {
  agentConfig,
  agentPatch,
  absolutePath,
  channel,
  mcpServer,
  page,
  revision,
  text,
  write,
} from '../../domain/schemas.js';
import type { Context, RuntimeRecord } from '../../domain/models.js';
import { errorDetail, fail } from '../../domain/errors.js';
import { id, now } from '../../domain/ids.js';
import { paginate } from '../../application/common.js';
import type { Container } from '../../bootstrap/container.js';
import { requireCapability } from '../../infrastructure/acp/capability-gate.js';
import { resolveEnvironment } from '../../infrastructure/platform/environment.js';
import { which } from '../../infrastructure/platform/process-host.js';

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType;
  readOnly: boolean;
  destructive: boolean;
  run: (ctx: Context, input: unknown) => Promise<unknown>;
}
const target = z.union([z.strictObject({ runtimeId: text }), z.strictObject({ sessionId: text })]);
const runtimeGuard = { ...revision, expectedConnectionGeneration: z.number().int().positive() };
const waitFields = {
  afterRevision: z.number().int().positive().optional(),
  timeoutMs: z.number().int().min(0).max(30_000).default(10_000),
};
const distribution = z.enum(['binary', 'npx', 'uvx']);
const installFields = {
  sourceId: text,
  registryAgentId: text,
  targetVersion: text,
  distribution,
  snapshotId: text.optional(),
};
const sessionOverrides = {
  additionalDirectories: z.array(absolutePath).optional(),
  mcpServers: z.array(mcpServer).optional(),
  options: z.record(text, z.union([z.string(), z.boolean()])).optional(),
  modeId: text.optional(),
};
const annotations = z
  .object({
    audience: z.array(z.enum(['user', 'assistant'])).optional(),
    priority: z.number().min(0).max(1).optional(),
    lastModified: z.string().optional(),
  })
  .optional();
export const promptBlock = z.union([
  z.strictObject({
    type: z.literal('text'),
    text: z.string(),
    annotations,
    _meta: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({
    type: z.enum(['image', 'audio']),
    data: z.string(),
    mimeType: text,
    uri: z.string().optional(),
    annotations,
    _meta: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({
    type: z.literal('resource_link'),
    uri: text,
    name: text,
    title: z.string().optional(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().optional(),
    annotations,
    _meta: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({
    type: z.literal('resource'),
    resource: z.union([
      z.strictObject({
        uri: text,
        text: z.string(),
        mimeType: z.string().optional(),
        _meta: z.record(z.string(), z.unknown()).optional(),
      }),
      z.strictObject({
        uri: text,
        blob: z.string(),
        mimeType: z.string().optional(),
        _meta: z.record(z.string(), z.unknown()).optional(),
      }),
    ]),
    annotations,
    _meta: z.record(z.string(), z.unknown()).optional(),
  }),
]);
const cleanupScope = z.union([
  z.strictObject({ kind: z.literal('all') }),
  z.strictObject({ kind: z.literal('tasks'), sessionId: text.optional() }),
  z.strictObject({ kind: z.literal('operations') }),
  z.strictObject({
    kind: z.literal('session_events'),
    sessionId: text,
    selector: z
      .union([
        z.strictObject({ segmentIds: z.array(text).min(1) }),
        z.strictObject({ endedActivationIds: z.array(text).min(1) }),
      ])
      .optional(),
  }),
]);
export function createTools(app: Container): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const add = <S extends z.ZodType>(
    name: string,
    description: string,
    schema: S,
    fn: (ctx: Context, input: z.output<S>) => unknown,
    readOnly = false,
    destructive = false,
  ) =>
    tools.push({
      name,
      description,
      schema,
      readOnly,
      destructive,
      run: async (ctx, input) => await fn(ctx, schema.parse(input)),
    });
  const obj = z.strictObject;
  add(
    'connector_info',
    '查询连接器、当前身份、实例、协议版本与限额。',
    obj({}),
    (ctx) => ({
      apiVersion: 1,
      principalId: ctx.principalId,
      mode: app.mode,
      connectorInstanceId: app.instanceId,
      serviceId: app.serviceId,
      protocols: { acp: 1, acpSdk: '1.4.0', mcp: ['2026-07-28', '2025-11-25'], mcpSdk: '2.0.0' },
      limits: app.settings,
    }),
    true,
  );
  add(
    'connector_diagnose',
    '检查宿主依赖、存储和环境引用，不运行 prompt。',
    obj({
      configId: text.optional(),
      checks: z.array(z.enum(['runtime', 'dependencies', 'storage', 'environment'])).optional(),
    }),
    async (_ctx, args) => {
      const dependencies = await Promise.all(
        ['node', 'npm', 'npx', 'uv', 'uvx'].map(async (name) => {
          try {
            return { name, available: true, path: await which(name) };
          } catch {
            return { name, available: false, nextAction: `请在连接器宿主机安装 ${name}。` };
          }
        }),
      );
      let environmentStatus: unknown = null;
      if (args.configId) {
        const config = await app.configs.get(args.configId);
        try {
          await resolveEnvironment(config.config.environment);
          environmentStatus = { resolved: true };
        } catch (error) {
          environmentStatus = errorDetail(error);
        }
      }
      return {
        dependencies,
        environmentStatus,
        storage: await app.store.call('usage', {}),
        platform: process.platform,
        arch: process.arch,
        node: process.version,
      };
    },
    true,
  );
  add(
    'registry_list_sources',
    '列出 Registry 来源与缓存状态。',
    obj(page),
    async (_ctx, args) => paginate(await app.registry.sources(), args),
    true,
  );
  add(
    'registry_configure',
    '添加来源，或按预期修订修改来源。',
    z.union([
      obj({ url: z.url(), name: text, enabled: z.boolean().optional(), ...write }),
      obj({
        sourceId: text,
        ...revision,
        patch: obj({
          url: z.url().optional(),
          name: text.optional(),
          enabled: z.boolean().optional(),
        }).refine((value) => Object.keys(value).length > 0),
        ...write,
      }),
    ]),
    (ctx, args) => app.registry.configure(ctx, args),
  );
  add(
    'registry_refresh',
    '刷新来源索引；不修改注册配置或固定版本。',
    obj({ sourceIds: z.array(text).min(1).optional(), ...write }),
    (ctx, args) =>
      app.operations.start(ctx, 'registry_refresh', args, async (_op, signal) => {
        const sources =
          args.sourceIds ??
          (await app.registry.sources())
            .filter((source) => source.enabled)
            .map((source) => source.id);
        return Promise.all(sources.map((source) => app.registry.refresh(source, signal, true)));
      }),
  );
  add(
    'registry_search',
    '在缓存中查找 Agent，并呈现明确来源、版本、分发与许可证。',
    obj({
      sourceId: text.optional(),
      query: z.string().optional(),
      platform: text.optional(),
      ...page,
    }),
    async (_ctx, args) =>
      paginate(await app.registry.search(args.sourceId, args.query, args.platform), args),
    true,
  );
  add(
    'registry_get_agent',
    '查询指定来源和快照中的 Agent 原始分发元数据。',
    obj({ sourceId: text, registryAgentId: text, snapshotId: text.optional() }),
    (_ctx, args) => app.registry.get(args.sourceId, args.registryAgentId, args.snapshotId),
    true,
  );
  add(
    'agent_list',
    '列出共享注册配置；会话访问仍由归属控制。',
    obj({ enabled: z.boolean().optional(), ...page }),
    async (_ctx, args) =>
      paginate(
        (await app.configs.list()).filter(
          (record) => args.enabled === undefined || record.config.enabled === args.enabled,
        ),
        args,
      ),
    true,
  );
  add(
    'agent_get',
    '查询注册配置、修订与更新状态；环境秘密仅保留引用。',
    obj({ configId: text }),
    async (_ctx, args) => ({
      ...(await app.configs.get(args.configId)),
      configId: args.configId,
      update: await app.store.get('update_status', args.configId),
    }),
    true,
  );
  add(
    'agent_register',
    '创建独立命名配置；安装引用必须 ready。',
    obj({ config: agentConfig, ...write }),
    (ctx, args) => app.configs.register(ctx, args),
  );
  add(
    'agent_update',
    'CAS 修改注册配置，仅影响新会话。传入字段整体替换。',
    obj({ configId: text, patch: agentPatch, ...revision, ...write }),
    (ctx, args) => app.configs.update(ctx, args),
  );
  add(
    'agent_remove',
    '删除未被 Runtime 使用的注册配置，保留安装和历史。',
    obj({ configId: text, ...revision, ...write }),
    (ctx, args) => app.configs.remove(ctx, args),
    false,
    true,
  );
  add(
    'agent_install',
    '获取固定版本 Agent；立即返回自己的 operationId。',
    obj({ ...installFields, ...write }),
    (ctx, args) => app.installations.install(ctx, args),
  );
  add(
    'agent_check_updates',
    '检查可用更新；网络失败不会替换已安装版本。',
    obj({ configIds: z.array(text).min(1).optional(), force: z.boolean().optional(), ...write }),
    (ctx, args) =>
      app.operations.start(ctx, 'agent_check_updates', args, (_op, signal) =>
        app.installations.updates(args.configIds, args.force, signal),
      ),
  );
  add(
    'agent_upgrade',
    '安装成功后 CAS 切换此配置；已有会话保持原启动快照。',
    obj({
      configId: text,
      sourceSnapshotId: text,
      targetVersion: text,
      distribution,
      ...revision,
      ...write,
    }),
    (ctx, args) => app.installations.switch(ctx, args),
  );
  add(
    'agent_rollback',
    '显式切换到保留的安装或可核验的分发快照。',
    obj({
      configId: text,
      target: z.union([
        obj({ installationId: text }),
        obj({ sourceSnapshotId: text, targetVersion: text, distribution }),
      ]),
      ...revision,
      ...write,
    }),
    (ctx, args) => app.installations.switch(ctx, args, true),
  );
  add(
    'installation_list',
    '查询不可变安装及分发信息。',
    obj({ configId: text.optional(), state: text.optional(), ...page }),
    async (_ctx, args) => {
      const config = args.configId ? await app.configs.get(args.configId) : null;
      const configs = await app.configs.list();
      const runtimes = await app.store.list<RuntimeRecord>('runtime');
      return paginate(
        (await app.installations.list())
          .filter(
            (item) =>
              (!args.state || item.state === args.state) &&
              (!config ||
                (config.config.launch.kind === 'installation' &&
                  config.config.launch.installationId === item.id)),
          )
          .map((item) => ({
            ...item,
            references: {
              configIds: configs
                .filter(
                  (config) =>
                    config.config.launch.kind === 'installation' &&
                    config.config.launch.installationId === item.id,
                )
                .map((config) => config.id),
              runtimeCount: runtimes.filter(
                (runtime) =>
                  runtime.state !== 'closed' &&
                  runtime.snapshot.launch.kind === 'installation' &&
                  runtime.snapshot.launch.installationId === item.id,
              ).length,
            },
          })),
        args,
      );
    },
    true,
  );
  add(
    'installation_remove',
    '只清理没有配置或 Runtime 引用的安装。',
    obj({ installationId: text, ...write }),
    (ctx, args) => app.installations.remove(ctx, args),
    false,
    true,
  );
  add(
    'local_agent_scan',
    '非交互扫描 Codex 候选；不安装、不改注册配置。',
    obj({ adapter: z.literal('codex'), paths: z.array(absolutePath).optional() }),
    (_ctx, args) => app.local.scan(args.paths),
    true,
  );
  add(
    'local_agent_plan',
    '生成绑定候选、Adapter 版本和配置修订的复用方案。',
    obj({
      candidateId: text,
      sourceId: text,
      registryAgentId: text,
      targetVersion: text,
      target: z.union([
        obj({ kind: z.literal('new'), config: agentConfig.omit({ origin: true, launch: true }) }),
        obj({ kind: z.literal('existing'), configId: text, ...revision }),
      ]),
    }),
    (ctx, args) => app.local.plan(ctx, args),
  );
  add(
    'local_agent_apply',
    '应用已明确选择的方案摘要；文件或目标变化则拒绝，不自动回退。',
    obj({
      planId: text,
      planDigest: text,
      acceptUnknownCompatibility: z.boolean().optional(),
      ...write,
    }),
    (ctx, args) => app.local.apply(ctx, args),
  );
  add(
    'agent_probe',
    '启动短命探测进程协商能力；认证状态不能跨进程复用。',
    obj({ configId: text, interactionChannel: channel.optional(), ...write }),
    (ctx, args) =>
      app.operations.start(ctx, 'agent_probe', args, async (op, signal) => {
        const runtime = await app.runtimes.prepareNow(ctx, args, op, signal);
        const result = app.runtimes.view(runtime);
        await app.store.put('probe', { id: args.configId, revision: 1, createdAt: now(), result });
        await app.runtimes.closeNow(runtime.id);
        return result;
      }),
  );
  add(
    'agent_auth_methods',
    '查询指定 Runtime 的真实认证方式；configId 仅查询探测缓存。',
    z.union([target, obj({ configId: text, probeOperationId: text.optional() })]),
    (ctx, args) => app.auth.methods(ctx, args),
    true,
  );
  add(
    'agent_authenticate',
    '在指定连接代次认证。已有会话保留同一 Runtime；需要真实交互通道。',
    z.union([
      obj({
        runtimeId: text,
        ...runtimeGuard,
        methodId: text,
        interactionChannel: z.enum(['mcp_native', 'local_cli']),
        ...write,
      }),
      obj({
        sessionId: text,
        ...runtimeGuard,
        methodId: text,
        interactionChannel: z.enum(['mcp_native', 'local_cli']),
        ...write,
      }),
    ]),
    (ctx, args) => app.auth.authenticate(ctx, args),
  );
  add(
    'agent_logout',
    '按下游能力注销指定连接，不推定其他连接的认证状态。',
    z.union([
      obj({ runtimeId: text, ...runtimeGuard, ...write }),
      obj({ sessionId: text, ...runtimeGuard, ...write }),
    ]),
    (ctx, args) => app.auth.authenticate(ctx, args, true),
  );
  add(
    'runtime_prepare',
    '冻结启动快照并准备未绑定 ACP 连接，返回 operationId。',
    obj({
      configId: text,
      configRevision: z.number().int().positive().optional(),
      cwd: absolutePath.optional(),
      interactionChannel: channel.optional(),
      ...write,
    }),
    (ctx, args) => app.runtimes.prepare(ctx, args),
  );
  add(
    'runtime_get',
    '查询 Runtime、认证代次、启动快照和准备期限。',
    obj({ runtimeId: text }),
    async (ctx, args) => app.runtimes.view(await app.runtimes.get(ctx, args.runtimeId)),
    true,
  );
  add(
    'runtime_close',
    '关闭未绑定 Runtime；已绑定时应使用 session_close。',
    obj({ runtimeId: text, ...runtimeGuard, ...write }),
    async (ctx, args) => {
      const initial = await app.runtimes.get(ctx, args.runtimeId, true);
      return app.operations.start(
        ctx,
        'runtime_close',
        args,
        async () => {
          const runtime = await app.runtimes.get(ctx, args.runtimeId, true);
          app.runtimes.guard(runtime, args.expectedRevision, args.expectedConnectionGeneration);
          if (runtime.sessionId || runtime.state === 'bound')
            fail('RUNTIME_IN_USE', 'Runtime 已绑定会话。');
          await app.runtimes.closeNow(runtime.id);
          return { runtimeId: runtime.id, state: 'closed' };
        },
        { runtimeId: initial.id },
      );
    },
  );
  add(
    'session_create',
    '创建会话。可消费同一个已认证 Runtime，或按配置准备新 Runtime。',
    z.union([
      obj({
        runtimeId: text,
        expectedConnectionGeneration: z.number().int().positive(),
        expectedRuntimeRevision: z.number().int().positive(),
        ...sessionOverrides,
        ...write,
      }),
      obj({
        configId: text,
        configRevision: z.number().int().positive().optional(),
        cwd: absolutePath.optional(),
        interactionChannel: channel.optional(),
        ...sessionOverrides,
        ...write,
      }),
    ]),
    (ctx, args) => app.sessions.create(ctx, args),
  );
  add(
    'session_list',
    '列出当前身份可见会话。downstream 列表也仅返回已登记归属的记录。',
    obj({
      scope: z.enum(['connector', 'downstream']).optional(),
      configId: text.optional(),
      cwd: absolutePath.optional(),
      ...page,
    }),
    async (ctx, args) => {
      const items = (await app.sessions.list(ctx, args.configId)).filter(
        (session) => !args.cwd || session.cwd === args.cwd,
      );
      if (args.scope !== 'downstream') return paginate(items, args);
      if (!args.configId) fail('CONFIG_INVALID', '查询下游列表需要 configId。');
      return app.operations.start(
        ctx,
        'session_list',
        { ...args, idempotencyKey: id('query') },
        async (op, signal) => {
          const runtime = await app.runtimes.prepareNow(
            ctx,
            { configId: args.configId!, cwd: args.cwd },
            op,
            signal,
          );
          try {
            const handle = app.runtimes.handle(runtime);
            requireCapability(handle.client.initialize.agentCapabilities ?? {}, 'list');
            const listed = await handle.client.request(
              'session/list',
              {
                ...(args.cwd ? { cwd: args.cwd } : {}),
                ...(args.cursor ? { cursor: args.cursor } : {}),
              },
              app.settings.controlTimeoutMs,
              signal,
            );
            return {
              ...listed,
              sessions: listed.sessions.filter((item) =>
                items.some((session) => session.downstreamSessionId === item.sessionId),
              ),
            };
          } finally {
            await app.runtimes.closeNow(runtime.id);
          }
        },
      );
    },
    true,
  );
  add(
    'session_get',
    '读取归属、配置修订、能力、当前任务与连接状态。',
    obj({ sessionId: text }),
    (ctx, args) => app.sessions.view(ctx, args.sessionId),
    true,
  );
  for (const method of ['load', 'resume'] as const)
    add(
      `session_${method}`,
      'prepare 仅生成恢复方案；apply 在独占租约和明确环境摘要下恢复，不重发 prompt。',
      z.union([
        obj({
          phase: z.literal('prepare'),
          sessionId: text,
          configId: text.optional(),
          configRevision: z.number().int().positive().optional(),
          ...write,
        }),
        obj({
          phase: z.literal('apply'),
          sessionId: text,
          restorePlanId: text,
          acceptEnvironmentDigest: text,
          preparedRuntime: obj({
            runtimeId: text,
            expectedConnectionGeneration: z.number().int().positive(),
            expectedRuntimeRevision: z.number().int().positive(),
          }).optional(),
          ...write,
        }),
      ]),
      (ctx, args) => app.sessions.restore(ctx, method, args),
    );
  add(
    'session_close',
    '取消会话活动任务并清理受管进程；报告实际关闭方式。',
    obj({ sessionId: text, ...revision, ...write }),
    (ctx, args) => app.sessions.close(ctx, args),
  );
  add(
    'session_delete',
    '所有者显式删除已关闭的下游会话；与连接器历史清理不同。',
    obj({ sessionId: text, ...revision, ...write }),
    async (ctx, args) => {
      const original = await app.sessions.get(ctx, args.sessionId, 'owner');
      if (original.state === 'ready' || original.activeTaskId)
        fail('OBJECT_IN_USE', '请先关闭会话。');
      return app.operations.start(
        ctx,
        'session_delete',
        args,
        async (op, signal) => {
          const session = await app.sessions.get(ctx, args.sessionId, 'owner');
          if (session.revision !== args.expectedRevision)
            fail('REVISION_CONFLICT', '会话修订已变化。');
          const runtime = await app.runtimes.prepareNow(
            ctx,
            { configId: session.configId, cwd: session.cwd },
            op,
            signal,
          );
          try {
            const client = app.runtimes.handle(runtime).client;
            requireCapability(client.initialize.agentCapabilities ?? {}, 'delete');
            await client.request(
              'session/delete',
              { sessionId: session.downstreamSessionId },
              app.settings.controlTimeoutMs,
              signal,
            );
            await app.sessions.mutate(session.id, (current) => ({ ...current, state: 'deleted' }));
            return { sessionId: session.id, deleted: true };
          } finally {
            await app.runtimes.closeNow(runtime.id);
          }
        },
        { sessionId: original.id },
      );
    },
    false,
    true,
  );
  add(
    'session_get_options',
    '读取下游实际公布的动态选项与模式。',
    obj({ sessionId: text }),
    async (ctx, args) => {
      const session = await app.sessions.get(ctx, args.sessionId);
      return { revision: session.revision, configOptions: session.options, modes: session.modes };
    },
    true,
  );
  add(
    'session_set_option',
    '在生成或等待权限期间设置下游公布的选项；不修改注册默认值。',
    obj({
      sessionId: text,
      optionId: text,
      value: z.union([z.string(), z.boolean()]),
      ...revision,
      ...write,
    }),
    (ctx, args) => app.sessions.setOption(ctx, args),
  );
  add(
    'session_set_mode',
    '在活动 prompt 期间切换下游模式；不会重启或产生额外 prompt。',
    obj({ sessionId: text, modeId: text, ...revision, ...write }),
    (ctx, args) => app.sessions.setMode(ctx, args),
  );
  add(
    'session_commands',
    '读取最新命令列表；实际调用仍通过 task_submit prompt。',
    obj({ sessionId: text }),
    async (ctx, args) => ({ commands: (await app.sessions.get(ctx, args.sessionId)).commands }),
    true,
  );
  add(
    'session_share',
    '仅所有者可在同一 HTTP 服务中授予 read/control 权限。',
    obj({
      sessionId: text,
      principalId: text,
      access: z.enum(['read', 'control']),
      ...revision,
      ...write,
    }),
    (ctx, args) => app.sessions.ownership(ctx, 'share', args),
  );
  add(
    'session_unshare',
    '撤销共享权限，不取消已经执行的操作。',
    obj({ sessionId: text, principalId: text, ...revision, ...write }),
    (ctx, args) => app.sessions.ownership(ctx, 'unshare', args),
  );
  add(
    'session_transfer',
    '移交会话所有权，任务、进程和游标保持不变。',
    obj({
      sessionId: text,
      targetPrincipalId: text,
      retainPreviousOwnerAs: z.enum(['read', 'control']).optional(),
      ...revision,
      ...write,
    }),
    (ctx, args) => app.sessions.ownership(ctx, 'transfer', args),
  );
  add(
    'task_submit',
    '持久化接受 prompt 后立即返回 taskId。同一会话只有一个活动 prompt。',
    obj({ sessionId: text, prompt: z.array(promptBlock).min(1), ...write }),
    (ctx, args) => app.tasks.submit(ctx, { ...args, prompt: args.prompt as ContentBlock[] }),
  );
  add(
    'task_get',
    '查询任务真实状态、结果和停止原因。',
    obj({ taskId: text }),
    async (ctx, args) => ({ ...(await app.tasks.get(ctx, args.taskId)), taskId: args.taskId }),
    true,
  );
  add(
    'task_wait',
    '等待状态变化或交互，最多 30 秒；到期不取消任务。',
    obj({ taskId: text, ...waitFields }),
    (ctx, args) => app.tasks.wait(ctx, args),
    true,
  );
  add(
    'task_cancel',
    '显式接受任务取消；仅下游确认或进程停止后进入 cancelled。',
    obj({ taskId: text }),
    (ctx, args) => app.tasks.cancel(ctx, args.taskId),
  );
  add(
    'task_events',
    '按稳定游标读取任务事件；清理缺口会明确返回。',
    obj({ taskId: text, ...page }),
    async (ctx, args) => {
      const task = await app.tasks.get(ctx, args.taskId);
      return app.events.read(task.sessionId!, args);
    },
    true,
  );
  add(
    'session_events',
    '读取含历史重放和无 taskId 更新的会话事件。',
    obj({ sessionId: text, activationId: text.optional(), segmentId: text.optional(), ...page }),
    (ctx, args) => app.events.sessionRead(ctx, args.sessionId, args),
    true,
  );
  add(
    'operation_get',
    '读取自己的耗时管理操作，或当前 ACL 授权的会话操作。',
    obj({ operationId: text }),
    async (ctx, args) => ({
      ...(await app.operations.get(ctx, args.operationId)),
      operationId: args.operationId,
    }),
    true,
  );
  add(
    'operation_wait',
    '短暂等待管理操作；到期不会取消安装或认证。',
    obj({ operationId: text, ...waitFields }),
    (ctx, args) => app.operations.wait(ctx, args),
    true,
  );
  add(
    'operation_events',
    '读取本方操作的进度投影，不暴露共享安装其他参与者。',
    obj({ operationId: text, ...page }),
    async (ctx, args) => {
      await app.operations.get(ctx, args.operationId);
      return app.events.read(args.operationId, args);
    },
    true,
  );
  add(
    'operation_cancel',
    '取消本方尚未提交的操作；其他共享安装参与者可继续。',
    obj({ operationId: text }),
    (ctx, args) => app.operations.cancel(ctx, args.operationId),
  );
  add(
    'permission_list',
    '读取 ACP 权限及连接器宿主操作待办。',
    obj({
      sessionId: text.optional(),
      taskId: text.optional(),
      state: z.enum(['pending', 'resolved']).optional(),
      ...page,
    }),
    async (ctx, args) => paginate(await app.interactions.list(ctx, args, true), args),
    true,
  );
  add(
    'permission_respond',
    '按当前 ACL 回复原权限选项；批准只作用于此交互。',
    obj({
      interactionId: text,
      decision: z.union([
        obj({ kind: z.literal('acp_option'), optionId: text }),
        obj({ kind: z.literal('cancel') }),
        obj({ kind: z.literal('host'), allow: z.boolean() }),
      ]),
      ...revision,
      ...write,
    }),
    (ctx, args) => app.interactions.respondPermission(ctx, args),
  );
  add(
    'interaction_list',
    '列出用户表单、URL 和终端认证交互。',
    obj({
      sessionId: text.optional(),
      operationId: text.optional(),
      state: text.optional(),
      ...page,
    }),
    async (ctx, args) => paginate(await app.interactions.list(ctx, args, false), args),
    true,
  );
  add(
    'interaction_present',
    '通过真实 MCP 或宿主 CLI 呈现交互；需要用户审阅。',
    obj({ interactionId: text }),
    () => fail('INTERACTION_CHANNEL_UNAVAILABLE', '请通过支持交互的 MCP 客户端或本地 CLI 呈现。'),
  );
  add(
    'interaction_respond',
    '回复交互；accept 必须携带呈现流程生成的一次性审阅收据。',
    obj({
      interactionId: text,
      action: z.enum(['accept', 'decline', 'cancel']),
      content: z.record(z.string(), z.unknown()).optional(),
      presentationReceipt: text.optional(),
      ...revision,
      ...write,
    }),
    (ctx, args) => app.interactions.respondInteraction(ctx, args),
  );
  add(
    'content_read',
    '按对象 ACL 分页读取外置内容；摘要不充当访问凭据。',
    obj({
      objectType: z.enum(['task', 'session', 'operation']),
      objectId: text,
      contentId: text,
      offset: z.number().int().nonnegative().default(0),
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(256 * 1024)
        .default(64 * 1024),
    }),
    async (ctx, args) => {
      if (args.objectType === 'task') await app.tasks.get(ctx, args.objectId);
      else if (args.objectType === 'session') await app.sessions.get(ctx, args.objectId);
      else await app.operations.get(ctx, args.objectId);
      return app.events.content(args.objectId, args.contentId, args.offset, args.maxBytes);
    },
    true,
  );
  add(
    'history_list',
    '读取持久化任务、操作和会话事件段。',
    obj({
      kind: z.enum(['task', 'operation', 'session_event_segment']).optional(),
      sessionId: text.optional(),
      activationId: text.optional(),
      state: text.optional(),
      before: z.iso.datetime().optional(),
      ...page,
    }),
    async (ctx, args) => paginate(await app.history.list(ctx, args), args),
    true,
  );
  add(
    'history_get',
    '读取保存的结果、事件段描述或清理墓碑。',
    obj({ kind: z.enum(['task', 'operation', 'session_event_segment']), id: text }),
    (ctx, args) => app.history.get(ctx, args.kind, args.id),
    true,
  );
  add(
    'history_usage',
    '统计历史逻辑量、物理量及受保护内容；directory 只返回聚合。',
    obj({ scope: z.enum(['visible', 'directory']).optional() }),
    (ctx, args) => app.history.usage(ctx, args.scope === 'directory'),
    true,
  );
  add(
    'history_cleanup',
    '默认预览；apply 需提交计划摘要并重新核验活动保护。',
    z.union([
      obj({
        mode: z.literal('plan').optional(),
        scope: cleanupScope.optional(),
        endedBefore: z.iso.datetime().optional(),
        targetBytes: z.number().int().positive().optional(),
        ...write,
      }),
      obj({ mode: z.literal('apply'), cleanupPlanId: text, planDigest: text, ...write }),
    ]),
    (ctx, args) =>
      args.mode === 'apply'
        ? app.history.apply(ctx, args.cleanupPlanId, args.planDigest)
        : app.history.plan(ctx, args),
    false,
    true,
  );
  return tools;
}

export async function invoke(
  app: Container,
  definitions: ToolDefinition[],
  ctx: Context,
  name: string,
  args: unknown,
) {
  const requestId = id('request');
  try {
    await app.identities.check(ctx);
    const definition = definitions.find((tool) => tool.name === name);
    if (!definition) fail('CONFIG_INVALID', '工具不存在。', { name });
    const data = await definition.run(ctx, args);
    await app.identities.check(ctx);
    if (definition.readOnly) await reauthorizeResult(app, ctx, name, args, data);
    return { ok: true as const, data, meta: { requestId, warnings: [] } };
  } catch (error) {
    return { ok: false as const, error: errorDetail(error), meta: { requestId } };
  }
}

// 异步磁盘读取和等待结束后复核当前归属，阻止移交期间的在途结果泄露。
async function reauthorizeResult(
  app: Container,
  ctx: Context,
  name: string,
  input: unknown,
  data: unknown,
) {
  const args = input as Record<string, unknown>;
  if (typeof args.sessionId === 'string') await app.sessions.get(ctx, args.sessionId);
  if (typeof args.runtimeId === 'string') await app.runtimes.get(ctx, args.runtimeId);
  if (typeof args.taskId === 'string') await app.tasks.get(ctx, args.taskId);
  if (typeof args.operationId === 'string') await app.operations.get(ctx, args.operationId);
  if (name === 'content_read') {
    if (args.objectType === 'task') await app.tasks.get(ctx, String(args.objectId));
    else if (args.objectType === 'session') await app.sessions.get(ctx, String(args.objectId));
    else await app.operations.get(ctx, String(args.objectId));
  }
  if (name === 'history_get')
    await app.history.get(
      ctx,
      args.kind as 'task' | 'operation' | 'session_event_segment',
      String(args.id),
    );
  const result = data as { items?: Record<string, unknown>[] };
  if (
    !result?.items ||
    !['session_list', 'permission_list', 'interaction_list', 'history_list'].includes(name)
  )
    return;
  const filtered: Record<string, unknown>[] = [];
  for (const item of result.items) {
    try {
      if (name === 'session_list') await app.sessions.get(ctx, String(item.id));
      else if (name === 'history_list')
        await app.history.get(
          ctx,
          item.historyKind as 'task' | 'operation' | 'session_event_segment',
          String(item.id),
        );
      else await app.interactions.get(ctx, String(item.id));
      filtered.push(item);
    } catch {
      /* 归属已变更的对象不返回。 */
    }
  }
  result.items = filtered;
}
