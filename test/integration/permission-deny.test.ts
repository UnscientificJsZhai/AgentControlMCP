import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { harness } from '../helpers/harness.js';
import { id } from '../../src/domain/ids.js';
import type { PermissionPolicy } from '../../src/domain/schemas.js';

for (const source of ['own', 'inherited'] as const)
  for (const hasRejectOption of [false, true])
    void test(
      `${source} deny：${hasRejectOption ? '选择原始拒绝选项' : '无拒绝选项时取消'}且不产生可批准交互`,
      { timeout: 20_000 },
      async () => {
        const h = await harness();
        try {
          const policy: PermissionPolicy = {
            rules: [
              {
                id: 'deny-workspace-read',
                effect: 'deny',
                operations: ['read'],
                roots: [h.path],
              },
            ],
            fallback: 'ask',
            timeoutMs: null,
          };
          if (source === 'own')
            await h.app.configs.update(h.alice, {
              configId: h.registered.configId,
              expectedRevision: 1,
              patch: { permissionPolicy: policy },
              idempotencyKey: id('policy'),
            });
          else
            // 自身仍使用默认 allow_once，验证继承的 deny 不能被自身放行覆盖。
            h.app.interactions.inheritedPolicies = () =>
              Promise.resolve([{ policy, roots: [h.path] }]);

          const created = await h.session();
          const session = await h.app.sessions.get(h.alice, created.sessionId);
          assert.ok(session.downstreamSessionId);
          const request: RequestPermissionRequest = {
            sessionId: session.downstreamSessionId,
            toolCall: {
              toolCallId: 'read-denied',
              kind: 'read',
              locations: [{ path: join(h.path, 'input.txt') }],
            },
            options: [
              { kind: 'allow_once', optionId: 'original-allow-id', name: '仅允许一次' },
              ...(hasRejectOption
                ? [
                    {
                      kind: 'reject_once' as const,
                      optionId: 'original-reject-id',
                      name: '拒绝',
                    },
                  ]
                : []),
            ],
          };
          // 回归时 open 会挂起；超时取消保证失败路径也能结束并清理 Runtime。
          const signal = AbortSignal.timeout(5_000);
          const response = await h.app.callback(
            created.runtimeId,
            'session/request_permission',
            request,
            signal,
            'deny-request',
          );
          assert.equal(signal.aborted, false, 'deny 必须直接裁定，不能等待取消或人工审批');
          assert.deepEqual(
            response,
            hasRejectOption
              ? { outcome: { outcome: 'selected', optionId: 'original-reject-id' } }
              : { outcome: { outcome: 'cancelled' } },
          );
          assert.deepEqual(
            await h.app.interactions.list(h.alice, { sessionId: session.id }, true),
            [],
            '不能向 permission_respond 暴露可批准的待处理交互',
          );
          assert.deepEqual(await h.app.store.list('interaction'), [], '不得持久化待审批记录');
        } finally {
          await h.cleanup();
        }
      },
    );
