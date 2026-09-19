import { digest } from '../domain/ids.js';
import type { Context } from '../domain/models.js';

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
export class Serial {
  private readonly tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.tails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }
}
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
