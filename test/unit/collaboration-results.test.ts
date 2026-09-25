import test from 'node:test';
import assert from 'node:assert/strict';
import { collectResult, verifyCompletion } from '../../src/application/collaboration/results.js';
import type { EventService } from '../../src/application/event-service.js';
import type { WorkRecord } from '../../src/domain/models.js';
import type { MessageRecord, BridgeCallEvidence } from '../../src/domain/collaboration.js';
import { digest } from '../../src/domain/ids.js';

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
  const result = (await collectResult(
    events,
    { id: 'task', kind: 'task', sessionId: 'session' } as WorkRecord,
    'intent',
  )) as unknown as { kind: string; text: string; contentComplete: boolean };
  assert.equal(result.kind, 'assistant_output');
  assert.equal(result.text, '可见片段');
  assert.equal(result.contentComplete, false);
});

void test('Bridge 调用存在未决状态时声明结果未完成，全部成功时声明完成', async () => {
  const baseCall: BridgeCallEvidence = {
    callId: 'call-1',
    tool: 'acm_send_message',
    outcome: 'started',
  };
  const makeEvents = (call: BridgeCallEvidence) =>
    ({
      store: {
        readEvents: () =>
          Promise.resolve({
            missing: [],
            items: [{ kind: 'collaboration_bridge_call', payload: call }],
          }),
      },
      externalize: (_id: string, result: unknown) => Promise.resolve(result),
    }) as unknown as EventService;

  const incomplete = await collectResult(
    makeEvents(baseCall),
    { id: 'task', kind: 'task', sessionId: 'session' } as WorkRecord,
    'intent',
  );
  assert.equal(incomplete.bridgeCallsComplete, false);
  assert.equal(incomplete.bridgeCalls.length, 1);

  const completed = await collectResult(
    makeEvents({ ...baseCall, outcome: 'succeeded' }),
    { id: 'task', kind: 'task', sessionId: 'session' } as WorkRecord,
    'intent',
  );
  assert.equal(completed.bridgeCallsComplete, true);
  assert.equal(completed.bridgeCalls.length, 1);
});

void test('验收必须匹配本轮、成员、团队和 Bridge MESSAGE，且 ACP 正常结束', () => {
  const work = {
    id: 'task',
    kind: 'task',
    state: 'completed',
    result: { stopReason: 'end_turn' },
    collaboration: { teamId: 'team', agentId: 'agent', intentId: 'intent' },
  } as WorkRecord;
  const criteria = {
    configId: 'cfg-new',
    requiredMessage: { target: '/root' as const, text: 'READY' },
  };
  const message = {
    teamId: 'team',
    agentId: 'agent',
    intentId: 'intent',
    taskId: 'task',
    recipient: 'root',
    type: 'MESSAGE',
    channel: 'agent_collaboration',
    textDigest: digest('READY'),
  } as MessageRecord;

  // 正常通过
  const passed = verifyCompletion(criteria, work, 'cfg-new', true, [message]);
  assert.equal(passed.status, 'passed');
  assert.ok(passed.checks.every((c) => c.passed));

  // 未要求验收
  assert.deepEqual(verifyCompletion(undefined, work, 'cfg-new', true, [message]), {
    status: 'not_requested',
    checks: [],
  });

  // configId 不匹配精准失败
  const wrongConfig = verifyCompletion(criteria, work, 'cfg-old', true, [message]);
  assert.equal(wrongConfig.status, 'failed');
  assert.equal(wrongConfig.checks.find((c) => c.name === 'configId')?.passed, false);

  // ACP 轮次输出不完整导致 acp_turn 失败
  const incomplete = verifyCompletion(criteria, work, 'cfg-new', false, [message]);
  assert.equal(incomplete.status, 'failed');
  assert.equal(incomplete.checks.find((c) => c.name === 'acp_turn')?.passed, false);

  // message 字段不匹配导致 bridge_message 检查精准失败
  for (const patch of [
    { teamId: 'other' },
    { agentId: 'other' },
    { taskId: 'old' },
    { intentId: 'old' },
    { recipient: 'sibling' },
    { type: 'FINAL_ANSWER' as const },
    { channel: 'framework' as const },
    { textDigest: digest('wrong') },
  ]) {
    const failedMessage = verifyCompletion(criteria, work, 'cfg-new', true, [
      { ...message, ...patch },
    ]);
    assert.equal(failedMessage.status, 'failed');
    assert.equal(failedMessage.checks.find((c) => c.name === 'bridge_message')?.passed, false);
  }

  // 异常停止原因导致 acp_turn 检查失败
  for (const stopReason of ['cancelled', 'max_tokens', 'refusal']) {
    const failedTurn = verifyCompletion(
      criteria,
      { ...work, result: { stopReason } },
      'cfg-new',
      true,
      [message],
    );
    assert.equal(failedTurn.status, 'failed');
    assert.equal(failedTurn.checks.find((c) => c.name === 'acp_turn')?.passed, false);
  }
});
