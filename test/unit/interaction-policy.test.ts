import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { InteractionService } from '../../src/application/interaction-service.js';
import type { PermissionPolicy } from '../../src/domain/schemas.js';

type Dependencies = ConstructorParameters<typeof InteractionService>;

for (const source of ['own', 'inherited'] as const) {
  /**
   * 验证自身或继承策略中的拒绝规则优先于放行规则。
   *
   * @remarks
   * 一旦合并结果为拒绝，应直接结束宿主请求，不能再创建人工审批。
   */
  void test(
    source + ' deny rules override allow rules without opening host approval',
    async (t) => {
      const root = resolve('workspace');
      /**
       * 构造作用于当前工作区的读取策略。
       *
       * @param effect - 用于自身或继承策略的读取决策。
       * @returns 以人工询问为回退行为的权限策略。
       */
      const policy = (effect: 'deny' | 'allow_once'): PermissionPolicy => ({
        rules: [{ id: 'read', effect, operations: ['read'], roots: [root] }],
        fallback: 'ask',
        timeoutMs: null,
      });
      const runtime = {
        snapshot: { permissionPolicy: policy(source === 'own' ? 'deny' : 'allow_once') },
      };
      const session = { cwd: root, additionalDirectories: [] };
      const store = {
        get: (kind: string, id: string) => {
          if (kind === 'runtime' && id === 'runtime') return Promise.resolve(runtime);
          if (kind === 'session' && id === 'session') return Promise.resolve(session);
          assert.fail('此用例只能读取权限计算所需的 Runtime 和会话');
        },
      };
      const service = new InteractionService(
        store as unknown as Dependencies[0],
        { live: new Map([['runtime', { sessionId: 'session' }]]) } as Dependencies[1],
        null as never,
        { checkedPath: (path) => Promise.resolve(path), realpath: (path) => Promise.resolve(path) },
      );
      service.inheritedPolicies = () =>
        Promise.resolve([
          { policy: policy(source === 'own' ? 'allow_once' : 'deny'), roots: [root] },
        ]);
      t.mock.method(service, 'open', () => assert.fail('deny 不能创建人工审批'));
      await assert.rejects(
        service.host(
          'runtime',
          { operation: 'read', paths: [join(root, 'input.txt')] },
          new AbortController().signal,
        ),
        { code: 'ACCESS_DENIED' },
      );
    },
  );
}
