import { digest } from '../domain/ids.js';
import type { Context } from '../domain/models.js';

/** 构造与业务写入同事务保存的幂等记录，参数摘要覆盖完整请求。 */
export function idem(
  ctx: Context,
  method: string,
  args: { idempotencyKey: string },
  response: unknown,
) {
  return {
    principal: ctx.principalId,
    method,
    key: args.idempotencyKey,
    digest: digest(args),
    response,
  };
}

/**
 * 按对象键串行化本实例的异步修改；不同键可并发，跨实例竞争仍由存储事务处理。
 * 此队列不可重入：回调中再次等待同一键会等待自己完成。
 */
export class Serial {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // 前一次失败不能阻塞后续操作；本次异常仍通过返回的 Promise 交给调用方。
    const next = previous.catch(() => {}).then(fn);
    this.tails.set(key, next);
    try {
      return await next;
    } finally {
      // 仅删除自己仍占据的队尾，防止较早完成的调用移除后续任务。
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }
}

/** 按 ID 排序后使用排他游标分页；会原地排序输入数组，调用方应传入可修改的列表。 */
export function paginate<T extends { id: string }>(
  items: T[],
  options: { cursor?: string | undefined; limit?: number | undefined },
) {
  const filtered = items
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((item) => !options.cursor || item.id > options.cursor);
  const selected = filtered.slice(0, options.limit ?? 100);
  return {
    items: selected,
    hasMore: filtered.length > selected.length,
    nextCursor: filtered.length > selected.length ? (selected.at(-1)?.id ?? null) : null,
  };
}
