import test from 'node:test';
import assert from 'node:assert/strict';
import type { PermissionOption } from '@agentclientprotocol/sdk';
import { InteractionService } from '../../src/application/interaction-service.js';
import type { OperationDescription } from '../../src/domain/permission-policy.js';

const allow: PermissionOption = { kind: 'allow_once', optionId: 'original-allow', name: '允许' };
const reject: PermissionOption = { kind: 'reject_once', optionId: 'original-reject', name: '拒绝' };

for (const { decision, options, selected, opens } of [
  { decision: 'deny', options: [allow, reject], selected: reject.optionId, opens: false },
  { decision: 'deny', options: [allow], selected: undefined, opens: false },
  { decision: 'allow_once', options: [reject, allow], selected: allow.optionId, opens: false },
  { decision: 'allow_once', options: [reject], selected: undefined, opens: true },
  { decision: 'ask', options: [allow], selected: undefined, opens: true },
] as const) {
  /**
   * 验证权限决策映射到原始 ACP 选项，必要时转入人工交互。
   *
   * @remarks
   * 本组聚焦选项映射与操作描述；策略来源及继承由 interaction-policy 用例覆盖。
   */
  void test(`Permission ${decision} with options ${options.map((option) => option.kind).join('/')}: ${opens ? 'manual interaction' : 'automatic decision'}`, async (t) => {
    const service = new InteractionService(null as never, null as never, null as never);
    const policy = t.mock.method(
      service as unknown as {
        policy: (runtimeId: string, description: OperationDescription | null) => Promise<string>;
      },
      'policy',
      () => Promise.resolve(decision),
    );
    const open = t.mock.method(service, 'open', () =>
      Promise.resolve({ outcome: { outcome: 'cancelled' } }),
    );
    const response = await service.permission(
      'runtime',
      {
        sessionId: 'downstream-session',
        toolCall: {
          toolCallId: 'read',
          kind: 'read',
          locations: [{ path: '/workspace/input.txt' }],
        },
        options: [...options],
      },
      new AbortController().signal,
      'request',
    );
    assert.deepEqual(
      policy.mock.calls.map((call) => call.arguments),
      [['runtime', { operation: 'read', paths: ['/workspace/input.txt'] }]],
    );
    assert.equal(open.mock.callCount(), opens ? 1 : 0);
    assert.deepEqual(response, {
      outcome: selected ? { outcome: 'selected', optionId: selected } : { outcome: 'cancelled' },
    });
  });
}
