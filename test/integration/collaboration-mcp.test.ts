import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client as LegacyClient } from 'mcp-legacy/client/index.js';
import { StdioClientTransport as LegacyStdio } from 'mcp-legacy/client/stdio.js';
import { StreamableHTTPClientTransport as LegacyHttp } from 'mcp-legacy/client/streamableHttp.js';
import { ElicitRequestSchema } from 'mcp-legacy/types.js';
import { startHttp } from '../../src/transport/mcp/serve.js';
import { harness, until } from '../helpers/harness.js';

for (const era of ['modern', 'legacy'] as const)
  for (const transport of ['stdio', 'http'] as const)
    void test(`协作默认目录：${era} × ${transport} 实际调用与邮箱结果`, async () => {
      const h = await harness();
      const modern = new Client({ name: 'collaboration', version: '1' });
      const legacy = new LegacyClient({ name: 'collaboration', version: '1' });
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
              join(h.path, 'data'),
            ],
            stderr: 'pipe' as const,
          };
          if (era === 'modern') await modern.connect(new StdioClientTransport(options));
          else await legacy.connect(new LegacyStdio(options));
        } else {
          const { url } = await startHttp(h.app, { host: '127.0.0.1', port: 0, noAuth: true });
          const options = { requestInit: { headers: { 'x-agent-client-id': 'alice' } } };
          if (era === 'modern')
            await modern.connect(new StreamableHTTPClientTransport(new URL(url), options));
          else
            await legacy.connect(
              new LegacyHttp(new URL(url), options) as Parameters<LegacyClient['connect']>[0],
            );
        }
        const tools = (await client.listTools()).tools;
        assert.ok(tools.some((t) => t.name === 'spawn_agent'));
        assert.ok(tools.some((t) => t.name === 'wait_agent'));
        const call = async (name: string, args: Record<string, unknown>) => {
          const result = (await client.callTool({ name, arguments: args })).structuredContent as {
            ok: boolean;
            data: Record<string, unknown>;
          };
          assert.equal(result.ok, true, JSON.stringify(result));
          return result.data;
        };
        const spawned = await call('spawn_agent', {
          requestId: 'create',
          taskName: 'protocol',
          profile: h.registered.configId,
          message: 'protocol round trip',
        });
        const page = await until(async () => {
          const value = await call('wait_agent', { teamId: spawned.teamId, timeoutMs: 100 });
          return JSON.stringify(value.messages).includes('FINAL_ANSWER') ? value : null;
        });
        assert.match(JSON.stringify(page.messages), /fixture:protocol round trip/);
        await call('close_agent', { requestId: 'close', target: spawned.agentId });
        await until(
          async () => (await call('list_agents', { target: spawned.agentId })).state === 'closed',
        );
      } finally {
        await client.close();
        await h.cleanup();
      }
    });

for (const era of ['modern', 'legacy'] as const)
  void test(`协作 ${era} 原生呈现与幂等重试；现代 HTTP 另验断连及凭据轮换`, async () => {
    const h = await harness();
    const clients: (Client | LegacyClient)[] = [];
    let presentations = 0;
    try {
      const identity = await h.app.identities.create('原生协作');
      const { url } = await startHttp(h.app, { host: '127.0.0.1', port: 0 });
      const connect = async (token: string) => {
        const headers = { Authorization: `Bearer ${token}` };
        const modern = new Client(
          { name: 'native', version: '1' },
          {
            versionNegotiation: { mode: { pin: '2026-07-28' } },
            capabilities: { elicitation: { form: {}, url: {} } },
          },
        );
        const legacy = new LegacyClient(
          { name: 'native', version: '1' },
          {
            capabilities: { elicitation: { form: {}, url: {} } },
          },
        );
        const answer = () => {
          presentations++;
          return Promise.resolve({ action: 'accept' as const, content: { name: '真实呈现' } });
        };
        if (era === 'modern') {
          modern.setRequestHandler('elicitation/create', answer);
          await modern.connect(
            new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }),
          );
        } else {
          legacy.setRequestHandler(ElicitRequestSchema, answer);
          await legacy.connect(
            new LegacyStdio({
              command: process.execPath,
              args: [
                resolve('dist/cli/entry.js'),
                'serve',
                'stdio',
                '--data-dir',
                join(h.path, 'data'),
              ],
              stderr: 'pipe',
            }),
          );
        }
        const client = era === 'modern' ? modern : legacy;
        clients.push(client);
        return client;
      };
      const first = await connect(identity.token);
      const raw = await first.callTool({
        name: 'spawn_agent',
        arguments: {
          requestId: 'form',
          taskName: 'form',
          message: 'form request',
        },
      });
      const result = raw.structuredContent as {
        ok: boolean;
        data: { agentId: string; teamId: string };
      };
      assert.equal(result.ok, true, JSON.stringify(result));
      const c = h.app.collaboration;
      const pending = await until(async () => {
        const view = await c.view(await c.agent(result.data.agentId));
        const items = view.pending as { interactionId: string }[];
        return items[0];
      });
      let fresh = first;
      if (era === 'modern') {
        await first.close();
        const freshIdentity = await h.app.identities.issue(identity.principalId, true);
        fresh = await connect(freshIdentity.token);
      }
      const args = {
        requestId: 'present',
        target: result.data.agentId,
        action: 'present',
        interactionId: pending.interactionId,
      };
      const presented = await fresh.callTool({ name: 'respond_agent', arguments: args });
      assert.equal(
        (presented.structuredContent as { ok: boolean }).ok,
        true,
        JSON.stringify(presented),
      );
      const replay = await fresh.callTool({ name: 'respond_agent', arguments: args });
      assert.deepEqual(replay.structuredContent, presented.structuredContent);
      assert.equal(presentations, 1);
      await until(
        async () => (await c.storage.intents(result.data.agentId))[0]?.state === 'settled',
      );
      assert.equal((await c.view(await c.agent(result.data.agentId))).state, 'idle');
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await h.cleanup();
    }
  });
