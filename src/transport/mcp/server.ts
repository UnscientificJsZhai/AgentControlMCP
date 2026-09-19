import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { McpServer, ResourceTemplate, inputRequired } from '@modelcontextprotocol/server';
import type {
  CallToolResult,
  McpRequestContext,
  ServerContext,
  ElicitRequestFormParams,
} from '@modelcontextprotocol/server';
import type { Container } from '../../bootstrap/container.js';
import type { Context } from '../../domain/models.js';
import { errorDetail, fail } from '../../domain/errors.js';
import { digest } from '../../domain/ids.js';
import { invoke } from './tools.js';
import { createMcpTools, toolAnnotations } from './catalog.js';

const presentations = new WeakMap<
  Container,
  Map<string, { principalId: string; interactionId: string; revision: number; expires: number }>
>();
const result = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  structuredContent: data,
  ...(data.ok === false ? { isError: true } : {}),
});

export function createServer(app: Container, identity: Context, transport: McpRequestContext) {
  const server = new McpServer(
    { name: 'agent-control-mcp', version: '1.0.0' },
    {
      supportedProtocolVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: {}, resources: {} },
    },
  );
  const definitions = createMcpTools(app);
  if (!presentations.has(app)) presentations.set(app, new Map());
  async function present(ctx: Context, input: unknown, request: ServerContext) {
    const { interactionId } = z.strictObject({ interactionId: z.string() }).parse(input);
    const record = await app.interactions.get(ctx, interactionId, true);
    if (record.state !== 'pending') fail('INTERACTION_ALREADY_RESOLVED', '交互已结束。');
    if (record.type !== 'form' && record.type !== 'url')
      fail('INTERACTION_CHANNEL_UNAVAILABLE', '此交互请通过宿主 CLI 处理。');
    const pending = presentations.get(app)!;
    for (const [key, value] of pending) if (value.expires < Date.now()) pending.delete(key);
    const params = record.request;
    let response: unknown;
    if (transport.era === 'modern') {
      const token = request.mcpReq.requestState<unknown>();
      if (token !== undefined) {
        const state = typeof token === 'string' ? pending.get(token) : undefined;
        if (
          !state ||
          state.principalId !== ctx.principalId ||
          state.interactionId !== interactionId ||
          state.revision !== record.revision
        )
          fail('INTERACTION_CHANNEL_UNAVAILABLE', '交互重入凭证无效、过期或归属已变化。');
        response = request.mcpReq.inputResponses?.answer;
        pending.delete(token as string);
      } else {
        if (pending.size >= 1024) fail('CAPACITY_EXCEEDED', '待呈现交互已达到上限。');
        const nonce = randomBytes(32).toString('base64url');
        pending.set(nonce, {
          principalId: ctx.principalId,
          interactionId,
          revision: record.revision,
          expires: Date.now() + 600_000,
        });
        const input =
          record.type === 'url'
            ? inputRequired.elicitUrl({ message: String(params.message), url: String(params.url) })
            : inputRequired.elicit({
                message: String(params.message),
                requestedSchema:
                  params.requestedSchema as ElicitRequestFormParams['requestedSchema'],
              });
        return inputRequired({ inputRequests: { answer: input }, requestState: nonce });
      }
    } else {
      if (ctx.mode !== 'stdio')
        fail(
          'INTERACTION_CHANNEL_UNAVAILABLE',
          '旧版无状态 HTTP 不支持反向用户交互，请使用本地 CLI。',
        );
      response = await server.server.elicitInput(
        record.type === 'url'
          ? {
              mode: 'url',
              message: String(params.message),
              url: String(params.url),
              elicitationId: String(params.elicitationId),
            }
          : {
              mode: 'form',
              message: String(params.message),
              requestedSchema: params.requestedSchema as ElicitRequestFormParams['requestedSchema'],
            },
      );
    }
    const decision = z
      .strictObject({
        action: z.enum(['accept', 'decline', 'cancel']),
        content: z.record(z.string(), z.unknown()).optional(),
        _meta: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(response);
    if (decision.action === 'accept' && record.type === 'form')
      z.fromJSONSchema(params.requestedSchema as Parameters<typeof z.fromJSONSchema>[0]).parse(
        decision.content,
      );
    const answer = {
      action: decision.action,
      ...(decision.content ? { content: decision.content } : {}),
    };
    await app.interactions.get(ctx, interactionId, true);
    await app.identities.check(ctx);
    return result({
      ok: true,
      data: {
        interactionId,
        expectedRevision: record.revision,
        ...answer,
        ...(answer.action === 'accept'
          ? { presentationReceipt: app.interactions.receipt(ctx, interactionId, answer) }
          : {}),
        idempotencyKey: `present:${digest([interactionId, record.revision, answer])}`,
      },
    });
  }
  for (const definition of definitions)
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.schema,
        annotations: toolAnnotations(definition),
      },
      async (args, request) => {
        const capabilities = server.server.getClientCapabilities();
        const ctx = {
          ...identity,
          signal: request.mcpReq.signal,
          nativeInteraction:
            !!capabilities?.elicitation &&
            (transport.era === 'modern' || identity.mode === 'stdio'),
        };
        try {
          await app.identities.check(ctx);
          if (definition.name === 'interaction_present') return await present(ctx, args, request);
          return result(await invoke(app, definitions, ctx, definition.name, args));
        } catch (error) {
          return result({ ok: false, error: errorDetail(error) });
        }
      },
    );
  server.registerResource(
    'content',
    new ResourceTemplate('agent-control://content/{objectId}/{contentId}', { list: undefined }),
    {
      mimeType: 'application/json',
      description: '按对象权限读取外置结果，超过 256 KiB 请使用 content_read 分页。',
    },
    async (uri, variables) => {
      const objectId = String(variables.objectId);
      const contentId = String(variables.contentId);
      const objectType = objectId.startsWith('tsk_')
        ? 'task'
        : objectId.startsWith('op_')
          ? 'operation'
          : 'session';
      const response = await invoke(app, definitions, identity, 'content_read', {
        objectType,
        objectId,
        contentId,
        maxBytes: 256 * 1024,
      });
      if (!response.ok) fail(response.error.code, response.error.message);
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(response.data) },
        ],
      };
    },
  );
  return server;
}
