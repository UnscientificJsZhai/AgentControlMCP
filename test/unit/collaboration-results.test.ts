import test from 'node:test';
import assert from 'node:assert/strict';
import { collectResult } from '../../src/application/collaboration/results.js';
import type { EventService } from '../../src/application/event-service.js';
import type { WorkRecord } from '../../src/domain/models.js';

void test('丢失外置输出时仍交付可见片段，并明确声明结果不完整', async () => {
  const events = {
    store: {
      readEvents: () =>
        Promise.resolve({
          missing: [],
          items: [
            {
              kind: 'agent_message_chunk',
              payload: { content: { type: 'text', text: '可见片段' } },
            },
            {
              kind: 'agent_thought_chunk',
              payload: { content: { type: 'text', text: '不公开思考' } },
            },
            {
              kind: 'agent_message_chunk',
              payload: { representation: 'resource', contentId: 'missing' },
            },
          ],
        }),
    },
    content: () => Promise.reject(Object.assign(new Error('missing file'), { code: 'ENOENT' })),
    externalize: (_id: string, result: unknown) => Promise.resolve(result),
  } as unknown as EventService;
  const result = await collectResult(
    events,
    { id: 'task', kind: 'task', sessionId: 'session' } as WorkRecord,
    'intent',
  );
  assert.deepEqual(result, {
    kind: 'assistant_output',
    text: '可见片段',
    contentComplete: false,
    source: { sessionId: 'session', taskId: 'task' },
  });
});
