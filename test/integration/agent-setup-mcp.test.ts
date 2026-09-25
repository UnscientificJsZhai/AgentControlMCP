import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client as LegacyClient } from 'mcp-legacy/client/index.js';
import { StdioClientTransport as LegacyStdio } from 'mcp-legacy/client/stdio.js';
import { StreamableHTTPClientTransport as LegacyHttp } from 'mcp-legacy/client/streamableHttp.js';
import { startHttp } from '../../src/transport/mcp/serve.js';
import { createMcpTools } from '../../src/transport/mcp/catalog.js';
import { setupHarness } from '../helpers/agent-setup.js';
import { until } from '../helpers/harness.js';
import { id } from '../../src/domain/ids.js';

type Response = {
  ok: boolean;
  data: Record<string, unknown>;
  error?: { code: string; details?: { issues?: { path: (string | number)[]; message: string }[] } };
};

for (const era of ['modern', 'legacy'] as const)
  for (const transport of ['stdio', 'http'] as const)
    void test(
      `接入闭环 ${era} × ${transport}：固定目录、无刷新创建、字段反馈、已有任务保留`,
      { timeout: 60_000 },
      async () => {
        const h = await setupHarness();
        const modern = new Client(
          { name: 'setup', version: '1' },
          {
            versionNegotiation: { mode: { pin: '2026-07-28' } },
          },
        );
        const legacy = new LegacyClient({ name: 'setup', version: '1' });
        const client = era === 'modern' ? modern : legacy;
        try {
          if (transport === 'stdio') {
            const options = {
              command: process.execPath,
              args: [
                resolve('dist/cli/entry.js'),
                'serve',
                'stdio',
                '--client-id',
                'setup',
                '--data-dir',
                join(h.root, 'data'),
              ],
              env: {
                ...Object.fromEntries(
                  Object.entries(process.env).filter(
                    (entry): entry is [string, string] => entry[1] !== undefined,
                  ),
                ),
                HOME: h.home,
                USERPROFILE: h.home,
              },
              stderr: 'pipe' as const,
            };
            if (era === 'modern') await modern.connect(new StdioClientTransport(options));
            else await legacy.connect(new LegacyStdio(options));
          } else {
            const { url } = await startHttp(h.app, { host: '127.0.0.1', port: 0, noAuth: true });
            const options = { requestInit: { headers: { 'x-agent-client-id': 'setup' } } };
            if (era === 'modern')
              await modern.connect(new StreamableHTTPClientTransport(new URL(url), options));
            else
              await legacy.connect(
                new LegacyHttp(new URL(url), options) as Parameters<LegacyClient['connect']>[0],
              );
          }
          const call = async (name: string, args: Record<string, unknown> = {}) => {
            const result = (await client.callTool({ name, arguments: args }))
              .structuredContent as Response;
            assert.equal(result.ok, true, JSON.stringify(result));
            return result.data;
          };
          const wait = async (operationId: unknown) =>
            until(async () => {
              const value = await call('wait_agent_setup', { operationId, timeoutMs: 100 });
              if (value.state === 'failed' || value.state === 'cancelled')
                assert.fail(JSON.stringify(value));
              return value.state === 'completed' ? value : null;
            }, 30_000);
          // 模拟只在首次连接查询目录、不监听变更也不主动刷新的客户端。
          const initialTools = (await client.listTools()).tools;
          assert.deepEqual(
            initialTools.map((tool) => tool.name),
            createMcpTools(h.app).map((tool) => tool.name),
          );
          assert.equal((await call('discover_agents')).phase, 'bootstrap');
          assert.deepEqual((await call('list_agents')).agents, []);
          const hidden = (
            await client.callTool({
              name: 'spawn_agent',
              arguments: { requestId: 'hidden', taskName: 'hidden', message: '不触发安装' },
            })
          ).structuredContent as Response;
          assert.equal(hidden.error?.code, 'AGENT_SETUP_REQUIRED');

          const invalid = async (args: Record<string, unknown>, paths: string[]) => {
            const response = await client.callTool({ name: 'setup_agent', arguments: args });
            assert.equal(response.isError, true);
            const value = response.structuredContent as Response;
            assert.equal(value.error?.code, 'CONFIG_INVALID');
            const actual = value.error?.details?.issues?.map((issue) => issue.path.join('.')) ?? [];
            for (const path of paths) assert.ok(actual.includes(path), JSON.stringify(value));
            assert.equal((await h.app.configs.list()).length, 0);
          };
          await invalid({ action: 'register', config: {}, idempotencyKey: 'wrong-level' }, [
            'arguments',
          ]);
          await invalid(
            {
              action: 'register',
              arguments: {
                config: {
                  name: 'bad',
                  origin: { kind: 'manual' },
                  launch: { kind: 'command', executable: process.execPath, args: [] },
                  permissionPolicy: {
                    rules: [{ effect: 'allow_once', operations: ['read'], roots: [] }],
                    fallback: 'ask',
                  },
                },
                idempotencyKey: 'missing-policy-fields',
              },
            },
            [
              'arguments.config.permissionPolicy.rules.0.id',
              'arguments.config.permissionPolicy.timeoutMs',
            ],
          );
          await invalid(
            {
              action: 'register',
              arguments: { config: {}, idempotencyKey: 'missing-config-fields' },
            },
            ['arguments.config.name'],
          );
          await invalid({ action: 'unknown', arguments: {} }, ['action']);

          await wait(
            (
              await call('setup_agent', {
                action: 'refresh_registry',
                arguments: { sourceIds: [h.target.sourceId], idempotencyKey: 'refresh' },
              })
            ).operationId,
          );
          const discovery = await call('discover_agents');
          const candidate = (discovery.candidates as { items: { snapshotId: string }[] }).items[0]!;
          const install = {
            ...h.target,
            snapshotId: candidate.snapshotId,
            profile: h.profile,
            idempotencyKey: 'explicit-install',
          };
          const accepted = await call('setup_agent', { action: 'install', arguments: install });
          const finished = await wait(accepted.operationId);
          assert.equal(finished.phase, 'ready');
          assert.match(String(finished.nextAction), /无需刷新/);
          assert.equal(h.downloads, 1);
          assert.deepEqual(
            await call('setup_agent', { action: 'install', arguments: install }),
            accepted,
          );
          const configId = (finished.result as { configId: string }).configId;
          assert.equal((await h.app.configs.get(configId)).id, configId);
          // 首次缓存已经含 spawn_agent：这里不重连、不重查 tools/list。
          const spawned = await call('spawn_agent', {
            requestId: 'spawn',
            taskName: 'installed',
            message: 'bootstrap round trip',
            profile: configId,
            completionCriteria: { configId },
          });
          assert.equal(spawned.configId, configId);
          const output = await until(async () => {
            const page = await call('wait_agent', { teamId: spawned.teamId, timeoutMs: 100 });
            return JSON.stringify(page).includes('FINAL_ANSWER') ? page : null;
          });
          assert.match(JSON.stringify(output), /fixture:bootstrap round trip/);

          // 外部配置写入必须被当前长连接识别，禁用后仍可控制旧成员和读取结果。
          const config = await h.app.configs.get(configId);
          await h.app.configs.update(h.app.admin, {
            configId,
            expectedRevision: config.revision,
            patch: { enabled: false },
            idempotencyKey: id('disable'),
          });
          const blocked = (
            await client.callTool({
              name: 'spawn_agent',
              arguments: {
                requestId: 'disabled',
                taskName: 'disabled',
                message: '不能回退',
                profile: configId,
              },
            })
          ).structuredContent as Response;
          assert.equal(blocked.error?.code, 'AGENT_SETUP_REQUIRED');
          await call('interrupt_agent', { requestId: 'interrupt', target: spawned.agentId });
          await call('close_agent', { requestId: 'close', target: spawned.agentId });
          await until(
            async () => (await call('list_agents', { target: spawned.agentId })).state === 'closed',
          );
          assert.match(
            JSON.stringify(
              await call('list_agents', { target: spawned.agentId, detail: 'output' }),
            ),
            /fixture:bootstrap round trip/,
          );
          assert.deepEqual((await client.listTools()).tools, initialTools);
        } finally {
          await client.close();
          await h.cleanup();
        }
      },
    );
