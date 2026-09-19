import test from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client as LegacyClient } from 'mcp-legacy/client/index.js';
import { StdioClientTransport as LegacyStdio } from 'mcp-legacy/client/stdio.js';
import { StreamableHTTPClientTransport as LegacyHttp } from 'mcp-legacy/client/streamableHttp.js';
import { Container } from '../../src/bootstrap/container.js';
import { startHttp } from '../../src/transport/mcp/serve.js';
import { until } from '../helpers/harness.js';
import { id } from '../../src/domain/ids.js';

for (const era of ['modern', 'legacy'] as const)
  for (const transport of ['stdio', 'http'] as const)
    void test(
      `AC-001/005/006/015: ${era} × ${transport} 工具发现、配置、会话和任务`,
      { timeout: 40_000 },
      async () => {
        const dir = await mkdtemp(join(tmpdir(), 'acm-mcp-'));
        let app: Container | undefined;
        const modern = new Client(
          { name: 'acceptance', version: '1' },
          { versionNegotiation: { mode: { pin: '2026-07-28' } } },
        );
        const legacy = new LegacyClient({ name: 'acceptance', version: '1' });
        const client = era === 'modern' ? modern : legacy;
        try {
          if (transport === 'stdio') {
            const options = {
              command: process.execPath,
              args: [
                resolve('dist/cli/entry.js'),
                'serve',
                'stdio',
                '--data-dir',
                join(dir, 'data'),
                '--client-id',
                'acceptance',
              ],
              stderr: 'pipe' as const,
            };
            if (era === 'modern') await modern.connect(new StdioClientTransport(options));
            else await legacy.connect(new LegacyStdio(options));
          } else {
            app = await Container.create({ dataDir: join(dir, 'data'), mode: 'http' });
            const { url } = await startHttp(app, { host: '127.0.0.1', port: 0, noAuth: true });
            const options = { requestInit: { headers: { 'x-agent-client-id': 'acceptance' } } };
            if (era === 'modern')
              await modern.connect(new StreamableHTTPClientTransport(new URL(url), options));
            else
              await legacy.connect(
                new LegacyHttp(new URL(url), options) as Parameters<LegacyClient['connect']>[0],
              );
            const bad = await new Promise<number | undefined>((resolve, reject) => {
              const req = request(
                url,
                {
                  method: 'POST',
                  headers: { host: 'evil.example', 'x-agent-client-id': 'acceptance' },
                },
                (res) => {
                  res.resume();
                  resolve(res.statusCode);
                },
              );
              req.on('error', reject);
              req.end('{}');
            });
            assert.equal(bad, 403);
            const origin = await fetch(url, {
              method: 'POST',
              headers: { origin: 'https://evil.example', 'x-agent-client-id': 'acceptance' },
              body: '{}',
            });
            assert.equal(origin.status, 403);
          }
          const list = await client.listTools();
          assert.equal(list.tools.length, 62);
          const call = async (name: string, args: Record<string, unknown> = {}) => {
            const raw = await client.callTool({ name, arguments: args });
            const result = raw.structuredContent as {
              ok: boolean;
              data: Record<string, unknown>;
              error?: unknown;
            };
            assert.equal(result.ok, true, JSON.stringify(result));
            return result.data;
          };
          const info = await call('connector_info');
          assert.ok(String(info.principalId).includes('acceptance'));
          const registered = await call('agent_register', {
            config: {
              name: 'MCP 验收',
              origin: { kind: 'manual' },
              launch: {
                kind: 'command',
                executable: process.execPath,
                args: [resolve('.test-dist/test/fixtures/acp-agent.js')],
              },
              cwd: dir,
            },
            idempotencyKey: id('register'),
          });
          const created = await call('session_create', {
            configId: registered.configId,
            idempotencyKey: id('create'),
          });
          const sessionOp = await until(async () => {
            const op = await call('operation_get', { operationId: created.operationId });
            if (op.state === 'failed') assert.fail(JSON.stringify(op));
            return op.state === 'completed' ? op : null;
          });
          const session = sessionOp.result as { sessionId: string };
          const task = await call('task_submit', {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'mcp hello' }],
            idempotencyKey: id('prompt'),
          });
          const done = await until(async () => {
            const state = await call('task_get', { taskId: task.taskId });
            return ['completed', 'failed'].includes(String(state.state)) ? state : null;
          });
          assert.equal(done.state, 'completed', JSON.stringify(done));
          const events = await call('task_events', { taskId: task.taskId });
          assert.ok(JSON.stringify(events).includes('mcp hello'));
        } finally {
          await client.close();
          await app?.close();
          await rm(dir, { recursive: true, force: true });
        }
      },
    );
