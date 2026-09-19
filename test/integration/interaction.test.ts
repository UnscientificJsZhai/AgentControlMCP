import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHttp } from '../../src/transport/mcp/serve.js';
import { harness, until, completed } from '../helpers/harness.js';
import { id } from '../../src/domain/ids.js';

void test(
  'AC-025: 原生 MRTR 表单与 URL 呈现、内容绑定收据、URL 完成通知',
  { timeout: 30_000 },
  async () => {
    const h = await harness();
    const client = new Client(
      { name: 'form-ui-fixture', version: '1' },
      {
        versionNegotiation: { mode: { pin: '2026-07-28' } },
        capabilities: { elicitation: { form: {}, url: {} } },
      },
    );
    let presentations = 0;
    client.setRequestHandler('elicitation/create', (request) => {
      presentations++;
      return Promise.resolve(
        request.params.mode === 'url'
          ? { action: 'accept' as const }
          : { action: 'accept' as const, content: { name: '审阅结果' } },
      );
    });
    try {
      const { url } = await startHttp(h.app, { host: '127.0.0.1', port: 0, noAuth: true });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { 'x-agent-client-id': 'alice' } },
        }),
      );
      const call = async (name: string, args: Record<string, unknown>) => {
        const output = await client.callTool({ name, arguments: args });
        const result = output.structuredContent as { ok: boolean; data: Record<string, unknown> };
        assert.equal(result.ok, true, JSON.stringify(output));
        return result.data;
      };
      await call('connector_info', {});
      const session = await h.operation<{ sessionId: string }>(
        call('session_create', {
          configId: h.registered.configId,
          interactionChannel: 'mcp_native',
          idempotencyKey: id('create'),
        }),
      );
      const task = await h.app.tasks.submit(h.alice, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'form url' }],
        idempotencyKey: id('task'),
      });
      for (const type of ['form', 'url']) {
        const pending = await until(async () =>
          (await h.app.interactions.list(h.alice, { sessionId: session.sessionId }, false)).find(
            (item) => item.type === type,
          ),
        );
        await assert.rejects(
          h.app.interactions.respondInteraction(h.alice, {
            interactionId: pending.id,
            expectedRevision: pending.revision,
            action: 'accept',
            content: { name: '伪造' },
            idempotencyKey: id('forged'),
          }),
          { code: 'INTERACTION_CHANNEL_UNAVAILABLE' },
        );
        const receipt = await call('interaction_present', { interactionId: pending.id });
        await call('interaction_respond', receipt);
      }
      completed(await h.taskDone(task.taskId));
      assert.equal(presentations, 2);
      assert.ok(
        (await h.app.interactions.list(h.alice, { state: 'resolved' }, false)).some(
          (item) => item.type === 'url' && item.completed,
        ),
      );
    } finally {
      await client.close();
      await h.cleanup();
    }
  },
);
