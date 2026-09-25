import type { Context, Entity, WorkRecord } from './models.js';
import type { ErrorDetail } from './errors.js';

export const collaborationSchemaVersion = 1;
/** Bridge 工具使用独立前缀，避免与宿主的原生协作工具混淆。 */
export const collaborationBridge = {
  serverName: 'agent_collaboration',
  toolPrefix: 'acm_',
} as const;

export interface CompletionCriteria {
  configId?: string | undefined;
  requiredMessage?: { target: '/root'; text: string } | undefined;
}

export interface AcceptanceResult {
  status: 'not_requested' | 'passed' | 'failed';
  checks: { name: string; passed: boolean }[];
}

export interface BridgeCallEvidence {
  callId: string;
  tool: string;
  outcome: 'started' | 'succeeded' | 'failed';
  messageId?: string;
}
export type AgentState =
  | 'starting'
  | 'running'
  | 'waiting_input'
  | 'idle'
  | 'stopping'
  | 'needs_recovery'
  | 'closing'
  | 'closed';

/** 团队是一次独立协作，不能用 principalId 或 MCP 连接代替。 */
export interface TeamRecord extends Entity {
  schemaVersion: number;
  ownerId: string;
  instanceId: string;
  context: Pick<
    Context,
    'principalId' | 'mode' | 'serviceId' | 'credentialId' | 'nativeInteraction'
  >;
  cwd: string;
  sequence: string;
}

/** 成员保留稳定身份，生命周期控制与具体轮次的结果分别记录。 */
export interface ManagedAgentRecord extends Entity {
  teamId: string;
  parentId: string;
  path: string;
  configId: string;
  configRevision: number;
  cwd: string;
  lifecycle: 'starting' | 'active' | 'stopping' | 'paused' | 'closing' | 'closed';
  sessionId?: string;
  runtimeId?: string;
  operationId?: string;
  operationKind?: 'create' | 'restore' | 'authenticate';
  setupKey?: string;
  queuePaused?: boolean;
  authRequired?: boolean;
  recoveryId?: string;
  mailAfter: string;
  bridge: 'unconnected' | 'connected' | 'used';
  error?: ErrorDetail;
}

/** queued 尚无 ACP Task；taskId 在 TaskService 的受理事务中唯一关联。 */
export interface TaskIntentRecord extends Entity {
  teamId: string;
  agentId: string;
  order: string;
  message: string;
  completionCriteria?: CompletionCriteria;
  state: 'queued' | 'dispatched' | 'settled';
  taskId?: string;
  /** 此轮携带的邮箱末尾；只有确实进入派发后才推进成员游标。 */
  mailAfter?: string;
  endedAt?: string;
}

export type MessageType =
  'MESSAGE' | 'FINAL_ANSWER' | 'RUN_FAILED' | 'INTERRUPTED' | 'INPUT_REQUIRED';
export interface MessageRecord extends Entity {
  teamId: string;
  recipient: string;
  seq: string;
  from: string;
  agentId: string;
  type: MessageType;
  channel?: 'agent_collaboration' | 'external' | 'framework';
  textDigest?: string;
  body: unknown;
  intentId?: string;
  taskId?: string;
}

/** 终态事务保存发送意图；邮箱写入失败后可以恢复通知，不能恢复业务派发。 */
export interface CompletionRecord extends Entity {
  teamId: string;
  agentId: string;
  intentId: string;
  work: WorkRecord;
  delivered: boolean;
}

export interface RecoveryDecision extends Entity {
  agentId: string;
  restorePlanId: string;
  method: 'load' | 'resume';
  environmentDigest: string;
  expiresAt: string;
  queuedIntentIds: string[];
  acceptedOperationId?: string;
}

export interface AgentView {
  agentId: string;
  teamId: string;
  path: string;
  parentId: string;
  configId: string;
  configRevision: number;
  state: AgentState;
  queuedTasks: number;
  bridge: ManagedAgentRecord['bridge'];
  lastRun: {
    intentId: string;
    taskId?: string;
    state: string;
    stopReason?: string;
    acceptance?: AcceptanceResult;
  } | null;
}

export function inSubtree(parent: string, child: string) {
  return child.startsWith(`${parent}/`);
}

export function completionType(work: Pick<WorkRecord, 'state'>): MessageType {
  return work.state === 'completed'
    ? 'FINAL_ANSWER'
    : work.state === 'cancelled' || work.state === 'interrupted'
      ? 'INTERRUPTED'
      : 'RUN_FAILED';
}
