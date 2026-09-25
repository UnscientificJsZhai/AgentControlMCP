import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const text = z.string().min(1);
export const absolutePath = text.refine(isAbsolute, '必须是宿主机绝对路径');
/** 持久化环境变量的来源声明；宿主变量和文件引用在启动时解析，不提前写入配置明文。 */
export const envValue = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('literal'), value: z.string() }),
  z.strictObject({ kind: z.literal('host_env'), name: text }),
  z.strictObject({ kind: z.literal('env_file'), path: absolutePath, key: text }),
]);
export const environment = z.strictObject({
  values: z.record(text, envValue).default({}),
  inherit: z.array(text).default([]),
});
export const launch = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('installation'),
    installationId: text,
    args: z.array(z.string()).optional(),
  }),
  z.strictObject({ kind: z.literal('command'), executable: text, args: z.array(z.string()) }),
]);
export const policyRule = z.strictObject({
  id: text,
  effect: z.enum(['allow_once', 'ask', 'deny']),
  operations: z.array(z.enum(['read', 'write', 'delete', 'execute'])).min(1),
  roots: z.array(absolutePath),
  command: z
    .strictObject({
      executable: text,
      args: z.array(z.string()),
      env: z.record(text, z.string()).optional(),
    })
    .optional(),
});
export const permissionPolicy = z
  .strictObject({
    rules: z.array(policyRule),
    fallback: z.literal('ask'),
    timeoutMs: z.number().int().positive().nullable(),
  })
  .describe(
    '可整体省略以使用默认策略；显式提供时 rules、fallback、timeoutMs 均必填，每条规则的 id 也必填；timeoutMs 可为 null。',
  );
export const mcpServer = z.union([
  z.strictObject({
    type: z.literal('stdio'),
    name: text,
    command: text,
    args: z.array(z.string()),
    env: z.record(text, envValue),
  }),
  z.strictObject({
    type: z.enum(['http', 'sse']),
    name: text,
    url: z.url(),
    headers: z.record(text, envValue),
  }),
]);
/** 注册配置使用严格对象校验，拒绝未知字段，避免拼写错误被静默忽略。 */
export const agentConfig = z.strictObject({
  name: text.max(200),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  origin: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('manual') }),
    z.strictObject({ kind: z.literal('registry'), sourceId: text, registryAgentId: text }),
  ]),
  launch,
  cwd: absolutePath.optional(),
  environment: environment.default({ values: {}, inherit: [] }),
  // 空 roots 在运行时按授权工作目录展开；默认自动放行范围仅限可识别的读取操作。
  permissionPolicy: permissionPolicy.default({
    rules: [{ id: 'workspace-read', effect: 'allow_once', operations: ['read'], roots: [] }],
    fallback: 'ask',
    timeoutMs: null,
  }),
  sessionDefaults: z
    .strictObject({
      options: z.record(text, z.union([z.string(), z.boolean()])).default({}),
      modeId: text.optional(),
    })
    .default({ options: {} }),
  mcpServers: z.array(mcpServer).default([]),
  sessionNamespace: text.optional(),
});
/**
 * Patch 中缺省字段表示保持原值，因此移除创建配置时的默认值。
 * cwd 与 sessionNamespace 额外接受 null，供应用服务显式删除原字段。
 */
export const agentPatch = agentConfig
  .omit({ origin: true })
  .extend({
    enabled: z.boolean(),
    environment,
    permissionPolicy,
    sessionDefaults: agentConfig.shape.sessionDefaults.removeDefault(),
    mcpServers: z.array(mcpServer),
  })
  .partial()
  .extend({ cwd: absolutePath.nullable().optional(), sessionNamespace: text.nullable().optional() })
  .strict();
/** 实例启动时读取的连接器设置；资源上限同时参与事务准入和后台清理。 */
export const settingsSchema = z.strictObject({
  collaborationDefaultProfile: text.optional(),
  collaborationMaxAgents: z.number().int().min(1).max(32).default(8),
  collaborationMaxDepth: z.number().int().min(1).max(16).default(4),
  collaborationMaxQueuedTasks: z.number().int().min(1).max(128).default(16),
  maxRuntimes: z.number().int().min(1).max(32).default(8),
  maxGlobalRuntimes: z.number().int().min(1).max(128).default(32),
  maxTasks: z.number().int().min(1).max(32).default(8),
  maxInstallations: z.number().int().min(1).max(8).default(2),
  initializationTimeoutMs: z.number().int().positive().default(30_000),
  controlTimeoutMs: z.number().int().positive().default(30_000),
  preparedTtlMs: z.number().int().positive().default(600_000),
  installTimeoutMs: z.number().int().positive().default(600_000),
  retentionDays: z.number().int().positive().default(30),
  historyMaxBytes: z
    .number()
    .int()
    .positive()
    .default(2 * 1024 ** 3),
  minimumFreeBytes: z
    .number()
    .int()
    .nonnegative()
    .default(256 * 1024 ** 2),
  allowInsecureRegistry: z.boolean().default(false),
  fileCallbacks: z.boolean().default(true),
  terminals: z.boolean().default(true),
  allowedOrigins: z.array(z.url()).default([]),
  allowedHosts: z.array(text).default([]),
  externalProxy: z.boolean().default(false),
  httpHost: text.default('127.0.0.1'),
  httpPort: z.number().int().min(0).max(65535).default(7331),
  httpAuth: z.enum(['token', 'none']).default('token'),
});
export type AgentConfig = z.infer<typeof agentConfig>;
export type AgentPatch = z.infer<typeof agentPatch>;
export type EnvValue = z.infer<typeof envValue>;
export type Environment = z.infer<typeof environment>;
export type PermissionPolicy = z.infer<typeof permissionPolicy>;
export type Settings = z.infer<typeof settingsSchema>;
export const page = {
  cursor: text.optional(),
  limit: z.number().int().min(1).max(500).default(100),
};
/** 写请求的幂等键按调用身份和方法隔离；同一键的参数摘要必须保持一致。 */
export const write = { idempotencyKey: text.max(128) };
export const revision = { expectedRevision: z.number().int().positive() };
export const channel = z.enum(['none', 'mcp_native', 'local_cli']);
