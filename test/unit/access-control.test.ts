import test from 'node:test';
import assert from 'node:assert/strict';
import { access, visible } from '../../src/domain/access-control.js';
import type { Context, SessionRecord } from '../../src/domain/models.js';

for (const scenario of [
  {
    name: 'owner access',
    principalId: 'owner',
    grant: undefined,
    level: 'owner',
    error: undefined,
  },
  {
    name: 'ungranted principal',
    principalId: 'other',
    grant: undefined,
    level: 'read',
    error: 'SESSION_NOT_FOUND',
  },
  {
    name: 'shared read access',
    principalId: 'other',
    grant: 'read',
    level: 'read',
    error: undefined,
  },
  {
    name: 'read access cannot grant control',
    principalId: 'other',
    grant: 'read',
    level: 'control',
    error: 'ACCESS_DENIED',
  },
  {
    name: 'control access cannot grant ownership',
    principalId: 'other',
    grant: 'control',
    level: 'owner',
    error: 'ACCESS_DENIED',
  },
  {
    name: 'shared control access',
    principalId: 'other',
    grant: 'control',
    level: 'control',
    error: undefined,
  },
] as const) {
  /**
   * 验证会话所有权、共享权限与可见性之间的访问约束。
   *
   * @remarks
   * 未获授权的身份应得到不存在错误；已共享但权限不足的身份应得到拒绝访问错误。
   */
  void test('Session ACL: ' + scenario.name, () => {
    const ctx: Context = { principalId: scenario.principalId, mode: 'stdio', serviceId: 'unit' };
    const session = {
      ownerId: 'owner',
      grants: scenario.grant ? { other: scenario.grant } : {},
    } as SessionRecord;
    if (scenario.error)
      assert.throws(() => access(ctx, session, scenario.level), { code: scenario.error });
    else assert.doesNotThrow(() => access(ctx, session, scenario.level));
    assert.equal(visible(ctx, session), scenario.error !== 'SESSION_NOT_FOUND');
  });
}
