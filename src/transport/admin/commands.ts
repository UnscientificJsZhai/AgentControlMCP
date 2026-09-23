import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { z } from 'zod';
import type { Container } from '../../bootstrap/container.js';
import type { Context } from '../../domain/models.js';
import { agentConfig, agentPatch } from '../../domain/schemas.js';
import { id } from '../../domain/ids.js';
import { fail } from '../../domain/errors.js';
import { createTools, invoke } from '../mcp/tools.js';
import { createCollaborationTools } from '../mcp/collaboration-tools.js';
import { connectorDocument, SettingsService } from '../../application/settings-service.js';
import { RecoveryAdminService } from '../../application/recovery-admin-service.js';
import { absolutePath, text } from '../../domain/schemas.js';

/**
 * 本地可信入口的命令分发：下划线命令处理身份、文件和恢复管理，其余复用公开操作实现。
 * presentationAuthorized 必须来自存活的 CLI 附着连接，不能由命令参数自行声明。
 */
export async function adminCommand(
  app: Container,
  name: string,
  input: unknown,
  ctx: Context = app.admin,
  presentationAuthorized = false,
): Promise<unknown> {
  const args = z.record(z.string(), z.unknown()).parse(input);
  if (name === 'interaction_respond' && presentationAuthorized && ctx.admin) {
    const interaction = await app.interactions.get(ctx, text.parse(args.interactionId), true);
    const runtime = await app.runtimes.get(ctx, interaction.runtimeId);
    if (runtime.managedAgentId) ctx = { ...ctx, managedAgentId: runtime.managedAgentId };
  }
  if (name === '_recovery_inspect') return new RecoveryAdminService(app).inspect();
  if (name === '_recovery_resolve')
    return new RecoveryAdminService(app).resolve(
      z
        .strictObject({
          runtimeId: text.optional(),
          instanceId: text.optional(),
          expectedRevision: z.number().int().positive(),
        })
        .refine(
          (value) => Boolean(value.runtimeId) !== Boolean(value.instanceId),
          '必须且仅能指定一个 Runtime 或实例',
        )
        .parse(args),
    );
  if (name === '_recovery_adopt')
    return new RecoveryAdminService(app).adopt(
      z
        .strictObject({
          configId: text,
          expectedRevision: z.number().int().positive(),
          downstreamSessionId: text,
          namespace: text,
          ownerId: text,
          cwd: absolutePath,
        })
        .parse(args),
    );
  if (name === '_identity_create') return app.identities.create(z.string().min(1).parse(args.name));
  if (name === '_identity_issue') return app.identities.issue(z.string().parse(args.principalId));
  if (name === '_identity_rotate')
    return app.identities.issue(z.string().parse(args.principalId), true);
  if (name === '_identity_revoke')
    return app.identities.revoke(z.string().parse(args.credentialId));
  if (name === '_identity_list')
    return {
      principals: await app.store.list('principal'),
      credentials: (await app.store.list<Record<string, unknown>>('credential')).map(
        ({ hash: _hash, salt: _salt, ...item }) => item,
      ),
    };
  if (name === '_instances')
    return (await app.store.list<Record<string, unknown>>('instance')).map(
      ({ nonce: _nonce, ...item }) => item,
    );
  if (name === '_config_validate' || name === '_config_apply') {
    const document = z
      .union([
        connectorDocument,
        z.strictObject({
          schemaVersion: z.literal(1),
          documentId: z.string(),
          kind: z.literal('agent'),
          revision: z.number().int().positive(),
          value: agentConfig,
        }),
      ])
      .parse(JSON.parse(await readFile(z.string().parse(args.file), 'utf8')) as unknown);
    if (name === '_config_validate')
      return { valid: true, documentId: document.documentId, revision: document.revision };
    if (document.kind === 'connector')
      return new SettingsService(app.store, app.paths.configDir).apply(document);
    // 可编辑文档允许替换配置内容，但来源身份不可借导入文件悄悄改绑。
    const { origin, ...value } = document.value;
    const original = await app.configs.get(document.documentId);
    if (JSON.stringify(origin) !== JSON.stringify(original.config.origin))
      fail('CONFIG_INVALID', '可编辑文档不能修改来源身份。');
    const patch = agentPatch.parse({
      ...value,
      cwd: value.cwd ?? null,
      sessionNamespace: value.sessionNamespace ?? null,
    });
    return app.configs.update(ctx, {
      configId: document.documentId,
      expectedRevision: document.revision,
      patch,
      idempotencyKey: z.string().optional().parse(args.idempotencyKey) ?? id('cli'),
    });
  }
  // 编辑器操作临时副本，只有后续 apply 通过 Schema 与修订检查才改变数据库事实。
  if (name === '_config_edit') {
    const configId = z.string().parse(args.configId);
    const settings = new SettingsService(app.store, app.paths.configDir);
    const record = configId === 'connector' ? null : await app.configs.get(configId);
    const dir = await mkdtemp(join(tmpdir(), 'agent-control-edit-'));
    const path = join(dir, 'config.json');
    let content: string;
    try {
      content = await readFile(
        configId === 'connector'
          ? join(app.paths.configDir, 'connector.json')
          : join(app.paths.configDir, 'agents', `${configId}.json`),
        'utf8',
      );
    } catch {
      content = JSON.stringify(
        record ? app.configs.document(record) : await settings.document(),
        null,
        2,
      );
    }
    try {
      await writeFile(path, content, { mode: 0o600 });
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    return { path };
  }
  if (name === '_interaction_get')
    return app.interactions.get(ctx, z.string().parse(args.interactionId), true);
  if (name === '_config_export') {
    const configId = z.string().parse(args.configId);
    return configId === 'connector'
      ? new SettingsService(app.store, app.paths.configDir).export(true)
      : app.configs.project(await app.configs.get(configId), true);
  }
  if (name === '_present_receipt') {
    if (!presentationAuthorized)
      fail('INTERACTION_CHANNEL_UNAVAILABLE', '审阅收据只能由已附着的真实 CLI 呈现会话产生。');
    const interactionId = z.string().parse(args.interactionId);
    await app.interactions.get(ctx, interactionId, true);
    return { presentationReceipt: app.interactions.receipt(ctx, interactionId, args.response) };
  }
  // 给当前 IPC 响应留出返回时间，再触发关闭；否则 CLI 可能只能观察到连接被截断。
  if (name === '_stop') {
    setTimeout(() => {
      void app.close();
    }, 50);
    return { stopping: true };
  }
  return invoke(app, [...createTools(app), ...createCollaborationTools(app)], ctx, name, args);
}
