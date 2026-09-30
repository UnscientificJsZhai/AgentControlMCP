import { z } from 'zod';
import { fail } from '../../domain/errors.js';

export const ipcVersion = 1;
export const handshakeMaxBytes = 64 * 1024;
export const handshakeTimeoutMs = 10_000;
export const mcpMaxBytes = 17 * 1024 ** 2;
export const handshakeSchema = z.strictObject({
  version: z.literal(ipcVersion),
  instanceId: z.string().min(1),
  token: z.string().min(1).max(256),
  clientId: z.string().regex(/^[\w.-]{1,128}$/),
  toolset: z.enum(['collaboration', 'legacy', 'management']),
  startupCwd: z.string().min(1),
});
export const descriptorSchema = z.strictObject({
  version: z.literal(ipcVersion),
  buildId: z.string(),
  instanceId: z.string(),
  serviceId: z.string(),
  pid: z.number().int().positive(),
  databasePath: z.string(),
  endpoint: z.string(),
  adminEndpoint: z.string(),
  credentialPath: z.string(),
  settingsDigest: z.string(),
  settings: z.record(z.string(), z.unknown()),
});
export type ServiceDescriptor = z.infer<typeof descriptorSchema>;
export function validateHandshake(input: unknown) {
  if ((input as { version?: unknown } | null)?.version !== ipcVersion)
    fail('IPC_VERSION_MISMATCH', '执行服务 IPC 版本不兼容，请先停止旧服务。');
  const parsed = handshakeSchema.safeParse(input);
  if (!parsed.success) fail('IPC_HANDSHAKE_INVALID', '执行服务握手字段无效。');
  return parsed.data;
}
