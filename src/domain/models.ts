import type { AgentConfig, ErrorDetail, Settings } from './types.js';

export interface Context {
  principalId: string;
  mode: 'http' | 'stdio' | 'cli';
  serviceId: string;
  admin?: boolean;
  credentialId?: string;
  signal?: AbortSignal;
  nativeInteraction?: boolean;
}
export interface Entity {
  id: string;
  revision: number;
  createdAt: string;
}
export interface ConfigRecord extends Entity {
  config: AgentConfig;
}
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
  dispatchOutcome?: string;
  step?: string;
  commitState: 'pending' | 'committed' | 'cancelled';
}
export interface RuntimeRecord extends Entity {
  instanceId: string;
  ownerId: string;
  configId: string;
  configRevision: number;
  snapshot: AgentConfig;
  cwd: string;
  state: 'starting' | 'prepared' | 'binding' | 'bound' | 'creation_unknown' | 'closed';
  connectionGeneration: number;
  authState: string;
  sessionId?: string;
  initialize?: Record<string, unknown>;
  expiresAt: string;
  pid?: number;
}
export interface SessionRecord extends Entity {
  ownerId: string;
  grants: Record<string, 'read' | 'control'>;
  instanceId: string;
  serviceId: string;
  mode: Context['mode'];
  configId: string;
  runtimeId: string;
  activationId: string;
  downstreamSessionId: string;
  namespace: string;
  state: 'creating' | 'ready' | 'closed' | 'interrupted' | 'deleted';
  cwd: string;
  additionalDirectories: string[];
  snapshot: AgentConfig;
  options: unknown[];
  modes: Record<string, unknown> | null;
  commands: unknown[];
  activeTaskId?: string;
  controlVersion: number;
}
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
export interface InstanceRecord extends Entity {
  mode: Context['mode'];
  serviceId: string;
  pid: number;
  state: 'active' | 'stopped';
  nonce: string;
  endpoint: string;
  heartbeat: string;
}
export interface SegmentRecord extends Entity {
  sessionId: string;
  activationId: string;
  runtimeId: string;
  kind: 'ambient' | 'history_replay';
  state: 'open' | 'sealed' | 'purged';
  sealedAt?: string;
  bytes: number;
}
export interface ActivationRecord extends Entity {
  sessionId: string;
  runtimeId: string;
  instanceId: string;
  downstreamSessionId: string;
  startedAt: string;
  endedAt?: string;
}
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
export interface RegistrySnapshot extends Entity {
  sourceId: string;
  url: string;
  digest: string;
  agents: RegistryAgent[];
}
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
  state: 'ready';
}
export interface Principal extends Entity {
  name: string;
  enabled: boolean;
}
export interface Credential extends Entity {
  principalId: string;
  salt: string;
  hash: string;
  revoked: boolean;
}
export interface ConnectorDocument extends Entity {
  settings: Settings;
}
