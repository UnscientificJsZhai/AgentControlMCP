export interface Row {
  kind: string;
  id: string;
  revision: number;
  data: unknown;
}
export interface Check {
  kind: string;
  id: string;
  revision?: number;
  absent?: boolean;
}
export interface Idempotency {
  principal: string;
  method: string;
  key: string;
  digest: string;
  response: unknown;
}
export interface Transaction {
  checks?: Check[];
  puts?: Row[];
  deletes?: { kind: string; id: string }[];
  claims?: { key: string; holder: string }[];
  releases?: { key: string; holder: string }[];
  absentClaimPrefixes?: string[];
  idempotency?: Idempotency;
  limits?: { kind: string; path: string; value: string; max: number }[];
}
export interface CommitResult {
  replayed: boolean;
  response?: unknown;
}
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
