import type { AgentConfig, ErrorDetail, Settings } from './types.js';

/** 由入口认证后建立的调用上下文；请求方不能自行声明 admin 或原生交互能力。 */
export interface Context {
  principalId: string;
  mode: 'http' | 'stdio' | 'cli';
  serviceId: string;
  admin?: boolean;
  credentialId?: string;
  /** 当前请求的等待生命周期；后台任务是否取消由相应应用服务决定。 */
  signal?: AbortSignal;
  nativeInteraction?: boolean;
}

/** 持久化对象的公共字段；revision 用于比较并交换，避免覆盖并发更新。 */
export interface Entity {
  id: string;
  revision: number;
  createdAt: string;
}

export interface ConfigRecord extends Entity {
  config: AgentConfig;
}

/** task 与 operation 共用状态词汇；终态记录仍保留以供历史查询和幂等重放。 */
export type RunState =
  | 'accepted'
  | 'running'
  | 'waiting_interaction'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export const terminalStates = new Set<RunState>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

/** task 表示一次 prompt，operation 表示安装、认证等可在请求返回后继续执行的用例。 */
export interface WorkRecord extends Entity {
  kind: 'task' | 'operation';
  ownerId: string;
  instanceId: string;
  type: string;
  state: RunState;
  sessionId?: string;
  runtimeId?: string;
  result?: unknown;
  error?: ErrorDetail;
  endedAt?: string;
  /** 派发结果与运行状态独立；unknown 不表示未执行，恢复时不得据此自动重试。 */
  dispatchOutcome?: string;
  step?: string;
  /** 业务提交点决定取消能否阻止提交；completed 与 committed 不是同一概念。 */
  commitState: 'pending' | 'committed' | 'cancelled';
}

/** 一次 ACP 连接的持久化描述；进程、流和已解析的秘密只保存在内存句柄中。 */
export interface RuntimeRecord extends Entity {
  instanceId: string;
  ownerId: string;
  configId: string;
  configRevision: number;
  /** 启动时冻结的注册配置，后续配置更新不会改变已有 Runtime 的运行环境。 */
  snapshot: AgentConfig;
  cwd: string;
  state: 'starting' | 'prepared' | 'binding' | 'bound' | 'creation_unknown' | 'closed';
  /** 重建 ACP 连接时递增，用于拒绝旧连接的认证、控制和交互响应。 */
  connectionGeneration: number;
  authState: string;
  sessionId?: string;
  initialize?: Record<string, unknown>;
  expiresAt: string;
  pid?: number;
}

/** 连接器的逻辑会话，可在显式恢复后关联新的 Runtime 和 activation。 */
export interface SessionRecord extends Entity {
  ownerId: string;
  grants: Record<string, 'read' | 'control'>;
  instanceId: string;
  serviceId: string;
  mode: Context['mode'];
  configId: string;
  runtimeId: string;
  /** 本次运行或恢复的激活标识，用于区分同一逻辑会话中的不同事件来源。 */
  activationId: string;
  downstreamSessionId: string;
  /** 与下游会话 ID 共同组成租约键，隔离不同 Agent 的同名会话。 */
  namespace: string;
  state: 'creating' | 'ready' | 'closed' | 'interrupted' | 'deleted';
  cwd: string;
  additionalDirectories: string[];
  snapshot: AgentConfig;
  options: unknown[];
  modes: Record<string, unknown> | null;
  commands: unknown[];
  activeTaskId?: string;
  /** 配置投影的版本，防止较晚返回的控制响应覆盖更新通知中的新值。 */
  controlVersion: number;
}

/** 待人工处理的回调；decided 仅表示决策落盘，responded 才表示响应已写入连接。 */
export interface InteractionRecord extends Entity {
  ownerId: string;
  instanceId: string;
  runtimeId: string;
  connectionGeneration: number;
  sessionId?: string;
  taskId?: string;
  operationId?: string;
  requestId?: string | number;
  type: 'permission' | 'host_permission' | 'form' | 'url' | 'terminal_auth';
  state: 'pending' | 'decided' | 'responded' | 'cancelled' | 'expired';
  request: Record<string, unknown>;
  decision?: unknown;
  expiresAt: string | null;
  channel: string;
  completed?: boolean;
}

/** 宿主服务实例及其本地管理地址；nonce 用于管理连接握手，不能当作公开元数据。 */
export interface InstanceRecord extends Entity {
  mode: Context['mode'];
  serviceId: string;
  pid: number;
  state: 'active' | 'stopped';
  nonce: string;
  endpoint: string;
  heartbeat: string;
}

/** 无 task 归属的事件段；封口后可以独立回收，避免后台通知和历史重放永久占用容量。 */
export interface SegmentRecord extends Entity {
  sessionId: string;
  activationId: string;
  runtimeId: string;
  kind: 'ambient' | 'history_replay';
  state: 'open' | 'sealed' | 'purged';
  sealedAt?: string;
  bytes: number;
}

/** 记录逻辑会话与某次 Runtime 绑定的时间范围，不代表下游新建了另一份历史。 */
export interface ActivationRecord extends Entity {
  sessionId: string;
  runtimeId: string;
  instanceId: string;
  downstreamSessionId: string;
  startedAt: string;
  endedAt?: string;
}

/** 追加写入的事件；seq 使用十进制字符串，避免 JavaScript 数值精度截断 SQLite 序号。 */
export interface EventRecord {
  seq: string;
  streamId: string;
  taskId: string | null;
  segmentId: string | null;
  activationId: string | null;
  kind: string;
  payload: unknown;
  createdAt: string;
  bytes: number;
}

export interface RegistrySource extends Entity {
  name: string;
  url: string;
  enabled: boolean;
  snapshotId?: string;
  fetchedAt?: string;
  etag?: string;
  error?: string;
}

export interface Distribution {
  package?: string;
  command?: string;
  archive?: string;
  sha256?: string;
  cmd?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface RegistryAgent {
  id: string;
  name: string;
  description?: string;
  version: string;
  license?: string;
  license_url?: string;
  distribution: { binary?: Record<string, Distribution>; npx?: Distribution; uvx?: Distribution };

  [key: string]: unknown;
}

/** 安装方案引用的 Registry 内容快照；刷新源不会悄悄改写已生成的方案。 */
export interface RegistrySnapshot extends Entity {
  sourceId: string;
  url: string;
  digest: string;
  agents: RegistryAgent[];
}

/** 已发布的安装产物；prefixArgs 是包运行器前缀，args 是 Agent 的默认启动参数。 */
export interface InstallationRecord extends Entity {
  key: string;
  sourceId: string;
  registryAgentId: string;
  version: string;
  resolvedPackageVersion: string;
  distribution: 'binary' | 'npx' | 'uvx';
  manifest: Distribution;
  platform: string;
  path: string;
  executable: string;
  prefixArgs: string[];
  args: string[];
  env: Record<string, string>;
  integrity: string;
  state: 'ready' | 'removing';
  binDir?: string;
}

/** 作业先登记归属再创建文件，崩溃后的目录仍可诊断和手动回收。 */
export interface InstallationJob extends Entity {
  instanceId: string;
  lockHolder: string;
  key: string;
  state: 'waiting' | 'running' | 'cleanup_pending' | 'ended';
  paths?: { installation: string; staging: string; cache: string };
}

export interface Principal extends Entity {
  name: string;
  enabled: boolean;
}

/** 仅保存带盐凭据哈希；明文令牌只在创建时返回一次。 */
export interface Credential extends Entity {
  principalId: string;
  salt: string;
  hash: string;
  revoked: boolean;
}

export interface ConnectorDocument extends Entity {
  settings: Settings;
}
