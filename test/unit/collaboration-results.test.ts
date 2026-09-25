import test from 'node:test';
import assert from 'node:assert/strict';
import { collectResult, verifyCompletion } from '../../src/application/collaboration/results.js';
import type { EventService } from '../../src/application/event-service.js';
import type { WorkRecord } from '../../src/domain/models.js';
import type { MessageRecord, BridgeCallEvidence } from '../../src/domain/collaboration.js';
import { digest } from '../../src/domain/ids.js';

/**
 * 创建外置内容不可读取的事件服务替身。
 *
 * @param items - 按读取顺序返回的事件记录。
 * @returns 保留内联结果、读取外置内容时报告文件缺失的服务替身。
 */
function eventsWith(items: { kind: string; payload: unknown }[]) {
  return {
    store: { readEvents: () => Promise.resolve({ missing: [], items }) },
    content: () => Promise.reject(Object.assign(new Error('missing file'), { code: 'ENOENT' })),
    externalize: (_id: string, result: unknown) => Promise.resolve(result),
  } as unknown as EventService;
}

const work = {
  id: 'task',
  kind: 'task',
  sessionId: 'session',
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

/**
 * 验证外置输出丢失时仍交付可见文本，并标记内容不完整。
 *
 * @remarks
 * 思考事件不应进入公开结果，读取失败也不能丢弃已经收集到的可见片段。
 */
void test('Missing external output preserves visible chunks, hides thoughts, and marks content incomplete', async () => {
  const result = await collectResult(
    eventsWith([
      { kind: 'agent_message_chunk', payload: { content: { type: 'text', text: '可见片段' } } },
      { kind: 'agent_thought_chunk', payload: { content: { type: 'text', text: '不公开思考' } } },
      {
        kind: 'agent_message_chunk',
        payload: { representation: 'resource', contentId: 'missing' },
      },
    ]),
    work,
    'intent',
  );
  assert.ok('kind' in result);
  assert.ok('text' in result);
  assert.equal(result.kind, 'assistant_output');
  assert.equal(result.text, '可见片段');
  assert.equal(result.contentComplete, false);
});

for (const outcome of ['started', 'succeeded'] as const) {
  /**
   * 验证 Bridge 调用的完成标记取决于是否已有成功证据。
   *
   * @remarks
   * 仅开始的调用仍不完整，但两种状态都应保留对应的调用记录。
   */
  void test('Bridge call completeness reflects its outcome: ' + outcome, async () => {
    const call: BridgeCallEvidence = { callId: 'call-1', tool: 'acm_send_message', outcome };
    const result = await collectResult(
      eventsWith([{ kind: 'collaboration_bridge_call', payload: call }]),
      work,
      'intent',
    );
    assert.equal(result.bridgeCallsComplete, outcome === 'succeeded');
    assert.equal(result.bridgeCalls.length, 1);
  });
}

/**
 * 验证配置匹配、ACP 正常结束且本轮 Bridge 消息匹配时通过验收。
 *
 * @remarks
 * 总体状态和每项检查都必须成功，避免单个条件掩盖其他条件。
 */
void test('Completion passes for a matching current-turn Bridge MESSAGE and a normal ACP stop', () => {
  const result = verifyCompletion(criteria, work, 'cfg-new', true, [message]);
  assert.equal(result.status, 'passed');
  assert.ok(result.checks.every((check) => check.passed));
});

/**
 * 验证未指定完成条件时不隐式执行验收。
 *
 * @remarks
 * 即使任务中断且内容不完整，也应返回未请求验收状态和空检查列表。
 */
void test('Completion criteria are not inferred when none are requested', () => {
  assert.deepEqual(
    verifyCompletion(undefined, { state: 'interrupted' } as WorkRecord, '', false, []),
    {
      status: 'not_requested',
      checks: [],
    },
  );
});

/**
 * 验证实际配置与预期配置不一致时验收失败。
 *
 * @remarks
 * 失败必须归属到配置检查，其他完成证据不能替代配置一致性。
 */
void test('Completion rejects a mismatched configuration', () => {
  const result = verifyCompletion(criteria, work, 'cfg-old', true, [message]);
  assert.equal(result.status, 'failed');
  assert.equal(result.checks.find((check) => check.name === 'configId')?.passed, false);
});

/**
 * 验证 ACP 输出不完整时不能通过验收。
 *
 * @remarks
 * 即使存在匹配的 Bridge 消息，ACP 轮次检查仍必须失败。
 */
void test('Completion rejects incomplete ACP output', () => {
  const result = verifyCompletion(criteria, work, 'cfg-new', false, [message]);
  assert.equal(result.status, 'failed');
  assert.equal(result.checks.find((check) => check.name === 'acp_turn')?.passed, false);
});

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
  /**
   * 验证 Bridge 消息的来源、轮次、接收者、类型、通道及正文摘要均须匹配。
   *
   * @remarks
   * 每次仅修改一个字段，防止其他团队、旧任务或框架消息被误用作本轮完成证据。
   */
  void test(
    'Bridge MESSAGE completion rejects a mismatched field: ' + Object.keys(patch)[0],
    () => {
      const result = verifyCompletion(criteria, work, 'cfg-new', true, [{ ...message, ...patch }]);
      assert.equal(result.status, 'failed');
      assert.equal(result.checks.find((check) => check.name === 'bridge_message')?.passed, false);
    },
  );
}

/**
 * 验证缺少 Bridge 消息时不能满足明确要求的消息验收条件。
 *
 * @remarks
 * ACP 正常结束且内容完整不能代替通过协作通道发送消息。
 */
void test('Completion rejects missing Bridge MESSAGE evidence', () => {
  const result = verifyCompletion(criteria, work, 'cfg-new', true, []);
  assert.equal(result.status, 'failed');
  assert.equal(result.checks.find((check) => check.name === 'bridge_message')?.passed, false);
});

for (const stopReason of ['cancelled', 'max_tokens', 'refusal']) {
  /**
   * 验证取消、令牌耗尽和拒绝响应均不能视为 ACP 正常完成。
   *
   * @remarks
   * 匹配的 Bridge 消息不能覆盖异常停止原因，ACP 轮次检查必须失败。
   */
  void test('Completion rejects an abnormal stop reason: ' + stopReason, () => {
    const result = verifyCompletion(
      criteria,
      { ...work, result: { stopReason } },
      'cfg-new',
      true,
      [message],
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.checks.find((check) => check.name === 'acp_turn')?.passed, false);
  });
}
