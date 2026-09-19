import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness } from '../helpers/harness.js';
import { id } from '../../src/domain/ids.js';
import type { ContentBlock } from '@agentclientprotocol/sdk';

void test(
  'AC-002/025: 五类内容、logout、resume、list、delete 均经过独立 ACP 对端',
  { timeout: 30_000 },
  async () => {
    const h = await harness();
    try {
      const session = await h.session();
      const prompt: ContentBlock[] = [
        { type: 'text', text: '多模态验收' },
        { type: 'image', data: 'AA==', mimeType: 'image/png' },
        { type: 'audio', data: 'AA==', mimeType: 'audio/wav' },
        { type: 'resource_link', uri: 'file:///fixture.txt', name: 'fixture' },
        {
          type: 'resource',
          resource: { uri: 'file:///fixture.txt', mimeType: 'text/plain', text: 'embedded' },
        },
      ];
      const task = await h.app.tasks.submit(h.alice, {
        sessionId: session.sessionId,
        prompt,
        idempotencyKey: id('prompt'),
      });
      assert.equal((await h.taskDone(task.taskId)).state, 'completed');
      const runtime = await h.app.runtimes.get(h.alice, session.runtimeId);
      await h.operation(
        h.app.auth.authenticate(
          h.alice,
          {
            sessionId: session.sessionId,
            expectedRevision: runtime.revision,
            expectedConnectionGeneration: runtime.connectionGeneration,
            idempotencyKey: id('logout'),
          },
          true,
        ),
      );
      let current = await h.app.sessions.get(h.alice, session.sessionId);
      await h.operation(
        h.app.sessions.close(h.alice, {
          sessionId: current.id,
          expectedRevision: current.revision,
          idempotencyKey: id('close'),
        }),
      );
      const plan = await h.call<{ id: string; environmentDigest: string }>('session_resume', {
        phase: 'prepare',
        sessionId: current.id,
        idempotencyKey: id('plan'),
      });
      await h.operation(
        h.call('session_resume', {
          phase: 'apply',
          sessionId: current.id,
          restorePlanId: plan.id,
          acceptEnvironmentDigest: plan.environmentDigest,
          idempotencyKey: id('resume'),
        }),
      );
      await h.operation(
        h.call('session_list', { scope: 'downstream', configId: h.registered.configId }),
      );
      current = await h.app.sessions.get(h.alice, current.id);
      await h.operation(
        h.app.sessions.close(h.alice, {
          sessionId: current.id,
          expectedRevision: current.revision,
          idempotencyKey: id('close'),
        }),
      );
      current = await h.app.sessions.get(h.alice, current.id);
      await h.operation(
        h.call('session_delete', {
          sessionId: current.id,
          expectedRevision: current.revision,
          idempotencyKey: id('delete'),
        }),
      );
      assert.equal((await h.app.sessions.get(h.alice, current.id)).state, 'deleted');
      const audit = await readFile(join(h.path, 'audit.jsonl'), 'utf8');
      for (const method of ['logout', 'session/resume', 'session/list', 'session/delete'])
        assert.ok(audit.includes(`"method":"${method}"`), method);
      const sent = audit
        .split('\n')
        .filter(Boolean)
        .map(
          (line: string) =>
            JSON.parse(line) as { method?: string; params?: { prompt?: ContentBlock[] } },
        )
        .find((line) => line.method === 'session/prompt');
      assert.deepEqual(sent?.params?.prompt, prompt);
    } finally {
      await h.cleanup();
    }
  },
);

void test('AC-002: 未声明内容与会话能力时在派发前拒绝', async () => {
  const h = await harness('http', { FIXTURE_NO_CAPS: '1' });
  try {
    const session = await h.session();
    await assert.rejects(
      h.app.tasks.submit(h.alice, {
        sessionId: session.sessionId,
        prompt: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }],
        idempotencyKey: id('task'),
      }),
      { code: 'CAPABILITY_UNSUPPORTED' },
    );
    const current = await h.app.sessions.get(h.alice, session.sessionId);
    const closed = await h.operation<{ method: string }>(
      h.app.sessions.close(h.alice, {
        sessionId: current.id,
        expectedRevision: current.revision,
        idempotencyKey: id('close'),
      }),
    );
    assert.equal(closed.method, 'process_termination');
    const audit = await readFile(join(h.path, 'audit.jsonl'), 'utf8');
    assert.equal(audit.includes('"method":"session/prompt"'), false);
    assert.equal(audit.includes('"method":"session/close"'), false);
  } finally {
    await h.cleanup();
  }
});
