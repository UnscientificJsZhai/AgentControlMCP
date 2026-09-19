import { fail } from './errors.js';
import type { Context, SessionRecord } from './models.js';

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
export function visible(ctx: Context, session: SessionRecord) {
  return !!ctx.admin || session.ownerId === ctx.principalId || !!session.grants[ctx.principalId];
}
