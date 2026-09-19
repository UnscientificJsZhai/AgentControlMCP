import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHttp } from '../../src/transport/mcp/serve.js';
import { harness, until } from '../helpers/harness.js';
import { id } from '../../src/domain/ids.js';

void test(
  'AC-005/007/018: HTTP 断线保持审批任务，令牌重连、隔离、共享和撤销',
  { timeout: 30_000 },
  async () => {
    const h = await harness();
    const clients: Client[] = [];
    try {
      const { url } = await startHttp(h.app, { host: '127.0.0.1', port: 0 });
      const a = await h.app.identities.create('A');
      const b = await h.app.identities.create('B');
      const connect = async (token: string) => {
        const client = new Client({ name: 'HTTP 验收', version: '1' });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(url), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          }),
        );
        clients.push(client);
        return client;
      };
      const call = async (client: Client, name: string, args: Record<string, unknown>) => {
        const raw = await client.callTool({ name, arguments: args });
        const response = raw.structuredContent as {
          ok: boolean;
          data: Record<string, unknown>;
          error?: unknown;
        };
        assert.equal(response.ok, true, JSON.stringify(response));
        return response.data;
      };
      const first = await connect(a.token);
      const other = await connect(b.token);
      const accepted = await call(first, 'session_create', {
        configId: h.registered.configId,
        idempotencyKey: id('create'),
      });
      const created = await until(async () => {
        const op = await call(first, 'operation_get', { operationId: accepted.operationId });
        return op.state === 'completed' ? op : null;
      });
      const sessionId = (created.result as { sessionId: string }).sessionId;
      const task = await call(first, 'task_submit', {
        sessionId,
        prompt: [{ type: 'text', text: 'permission' }],
        idempotencyKey: id('prompt'),
      });
      const ctx = await h.app.identities.authenticate(`Bearer ${a.token}`);
      const pending = await until(
        async () => (await h.app.interactions.list(ctx, { taskId: String(task.taskId) }, true))[0],
      );
      await first.close();
      assert.equal((await h.app.tasks.get(ctx, String(task.taskId))).state, 'waiting_interaction');
      const reconnected = await connect(a.token);
      assert.equal(
        (await call(reconnected, 'task_get', { taskId: task.taskId })).state,
        'waiting_interaction',
      );
      const denied = await other.callTool({ name: 'session_get', arguments: { sessionId } });
      assert.equal((denied.structuredContent as { ok: boolean }).ok, false);
      const current = await call(reconnected, 'session_get', { sessionId });
      await call(reconnected, 'management_write', {
        action: 'session_share',
        arguments: {
          sessionId,
          principalId: b.principalId,
          access: 'read',
          expectedRevision: current.revision,
          idempotencyKey: id('share'),
        },
      });
      await call(other, 'session_get', { sessionId });
      const rotated = await h.app.identities.issue(a.principalId, true);
      const revoked = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(revoked.status, 401);
      const fresh = await connect(rotated.token);
      await call(fresh, 'permission_respond', {
        interactionId: pending.id,
        decision: { kind: 'acp_option', optionId: 'once' },
        expectedRevision: pending.revision,
        idempotencyKey: id('approve'),
      });
      const result = await until(async () => {
        const item = await call(fresh, 'task_get', { taskId: task.taskId });
        return item.state === 'completed' ? item : null;
      });
      assert.equal(result.state, 'completed');
      const audit = await readFile(join(h.path, 'audit.jsonl'), 'utf8');
      assert.equal(
        audit.split('\n').filter((line) => line.includes('"method":"session/prompt"')).length,
        1,
      );
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await h.cleanup();
    }
  },
);
