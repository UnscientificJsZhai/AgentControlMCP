import { fail } from './errors.js';
import type { Context, SessionRecord } from './models.js';

/**
 * 校验会话的读取、控制或所有权权限；管理员由本地可信入口注入。
 * 对完全不可见的会话统一返回不存在，避免通过错误码泄露其他身份的会话。
 */
export function access(
  ctx: Context,
  session: SessionRecord,
  level: 'read' | 'control' | 'owner' = 'read',
) {
  if (ctx.admin) return;
  const owner = session.ownerId === ctx.principalId;
  const grant = session.grants[ctx.principalId];
  if (!owner && !grant) fail('SESSION_NOT_FOUND', '会话不存在或不可见。');
  if (!owner && (level === 'owner' || (level === 'control' && grant !== 'control')))
    fail('ACCESS_DENIED', '当前会话权限不足。');
}

/** 列表查询使用与单对象读取相同的可见性规则，但不因不可见对象抛错。 */
export function visible(ctx: Context, session: SessionRecord) {
  return !!ctx.admin || session.ownerId === ctx.principalId || !!session.grants[ctx.principalId];
}
