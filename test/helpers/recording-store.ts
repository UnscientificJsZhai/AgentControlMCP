import type { Transaction } from '../../src/infrastructure/storage/protocol.js';
import type { SqliteStore } from '../../src/infrastructure/storage/sqlite-store.js';

/**
 * 创建提供固定记录并收集事务提交意图的存储替身。
 *
 * @remarks
 * 不模拟 SQL、事务原子性或提交后的状态变化，仅用于验证读取结果和写入意图。
 *
 * @param records - 按记录类型分组的固定数据，默认各类型均为空。
 * @returns 最小存储接口及按提交顺序收集的事务列表。
 */
export function recordingStore(records: Record<string, readonly unknown[]> = {}) {
  const transactions: Transaction[] = [];
  const store = {
    get: <T>(kind: string, id: string) =>
      Promise.resolve(
        (records[kind]?.find((record) => (record as { id: string }).id === id) ?? null) as T | null,
      ),
    list: <T>(kind: string) => Promise.resolve((records[kind] ?? []) as T[]),
    commit: (transaction: Transaction) => {
      transactions.push(transaction);
      return Promise.resolve({ replayed: false });
    },
  } satisfies Pick<SqliteStore, 'get' | 'list' | 'commit'>;
  return { store, transactions };
}
