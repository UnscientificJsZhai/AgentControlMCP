import { readFile, stat } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { fail } from '../../domain/errors.js';
import { bindingSchema, bridgeRequest } from './ipc.js';
import { collaborationDescriptions, collaborationSchemas } from '../mcp/collaboration-tools.js';

/** 轻量 stdio 转发进程，不创建 Container、数据库连接或第二个 Agent 执行器。 */
export async function startBridge(path: string) {
  const info = await stat(path);
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
    fail('ACCESS_DENIED', '成员绑定文件权限过宽。');
  const binding = bindingSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
  const handshake = (await bridgeRequest(binding, 'handshake')) as { ok: boolean };
  if (!handshake.ok) fail('UNAUTHENTICATED', '成员绑定不可用。');
  const handle = serveStdio(
    () => {
      const server = new McpServer(
        { name: 'agent-collaboration', version: '1.0.0' },
        {
          supportedProtocolVersions: ['2026-07-28', '2025-11-25'],
          capabilities: { tools: {} },
          instructions:
            '新 Agent 看不到父对话历史。spawn_agent.message 必须完整提供任务背景、材料、约束与交付标准。用 wait_agent 读取消息；send_message 不唤醒空闲成员。',
        },
      );
      for (const [name, schema] of Object.entries(collaborationSchemas))
        server.registerTool(
          name,
          {
            description: collaborationDescriptions[name as keyof typeof collaborationSchemas],
            inputSchema: schema,
          },
          async (args: unknown): Promise<CallToolResult> => {
            const response = (await bridgeRequest(binding, name, args)) as Record<string, unknown>;
            return {
              content: [{ type: 'text', text: JSON.stringify(response) }],
              structuredContent: response,
              ...(response.ok === false ? { isError: true } : {}),
            };
          },
        );
      return server;
    },
    { legacy: 'serve', onerror: () => {} },
  );
  process.stdin.once('end', () => {
    void handle.close();
  });
  return handle;
}
