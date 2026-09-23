/** Worker 与应用层之间的通用记录封装；kind/id 是主键，data 保存完整领域对象。 */
export interface Row {
  kind: string;
  id: string;
  revision: number;
  data: unknown;
  /** 不覆盖首次终态事实，允许正常收尾与崩溃恢复安全竞争。 */
  ifAbsent?: boolean;
}

/** 写入前置条件：absent 要求对象不存在，否则要求存在并按需比较 revision。 */
export interface Check {
  kind: string;
  id: string;
  revision?: number;
  absent?: boolean;
  state?: string;
}

export interface Idempotency {
  principal: string;
  method: string;
  key: string;
  digest: string;
  response: unknown;
}

/**
 * 一个不可分割的业务提交：前置检查、容量限制、资源占用、对象写入和幂等记录共同生效。
 * claims 是持久化互斥占用；释放必须匹配 holder，不能释放其他执行者后来取得的资源。
 */
export interface Transaction {
  maxLogicalBytes?: number;
  checks?: Check[];
  puts?: Row[];
  deletes?: { kind: string; id: string }[];
  claims?: { key: string; holder: string }[];
  releases?: { key: string; holder: string }[];
  absentClaimPrefixes?: string[];
  idempotency?: Idempotency;
  /** 与主受理记录一同写入的上层响应；已存在时禁止创建第二个底层操作。 */
  idempotencyAliases?: Idempotency[];
  limits?: { kind: string; path: string; value: string; max: number }[];
}

export interface CommitResult {
  replayed: boolean;
  response?: unknown;
}

/** 单个 Worker 连接内递增的请求编号，用于关联异步调用与同步 SQLite 执行结果。 */
export interface RpcRequest {
  requestId: number;
  method: string;
  args: unknown;
}

export interface RpcResponse {
  requestId: number;
  value?: unknown;
  error?: { code: string; message: string; details: Record<string, unknown> };
}
