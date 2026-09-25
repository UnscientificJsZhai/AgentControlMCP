import { Worker } from 'node:worker_threads';
import { chmod, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { id } from '../../domain/ids.js';
import { AppError } from '../../domain/errors.js';
import type { Entity, EventRecord } from '../../domain/models.js';
import type { CommitResult, EventInput, RpcResponse, Transaction } from './protocol.js';

export const row = <T extends Entity>(kind: string, entity: T) => ({
  kind,
  id: entity.id,
  revision: entity.revision,
  data: entity,
});

/**
 * 将同步 SQLite 操作隔离到 Worker，主线程通过请求编号等待结果，不直接持有数据库句柄。
 * Worker 退出后拒绝所有在途及后续调用，避免业务 Promise 永久挂起。
 */
export class SqliteStore {
  private readonly worker: Worker;
  private sequence = 0;
  private unavailable = false;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();

  private constructor(path: string) {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { path } });
    this.worker.on('message', (response: RpcResponse) => {
      const pending = this.pending.get(response.requestId);
      this.pending.delete(response.requestId);
      if (response.error)
        pending?.reject(
          new AppError(response.error.code, response.error.message, response.error.details),
        );
      else pending?.resolve(response.value);
    });
    const unavailable = () => {
      this.unavailable = true;
      for (const pending of this.pending.values())
        pending.reject(new AppError('STORAGE_UNAVAILABLE', '存储 Worker 已退出。'));
      this.pending.clear();
    };
    this.worker.on('error', unavailable);
    this.worker.on('exit', unavailable);
  }

  /** 首次读取充当就绪屏障，确认 Worker 已建库后再收紧数据库文件权限。 */
  static async open(path: string) {
    const isMemory =
      path === ':memory:' ||
      (path.startsWith('file:') && (path.includes('mode=memory') || path.includes(':memory:')));
    if (!isMemory) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      // SQLite 创建 WAL/SHM 时沿用数据库权限，首次建库前就限制为仅当前用户可读写。
      try {
        await (await open(path, 'ax', 0o600)).close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const store = new SqliteStore(path);
    try {
      await store.list('meta');
      if (!isMemory) {
        for (const suffix of ['', '-wal', '-shm']) {
          try {
            await chmod(path + suffix, 0o600);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      }
      return store;
    } catch (error) {
      await store.close().catch(() => store.worker.terminate());
      throw error;
    }
  }

  call<T>(method: string, args: unknown): Promise<T> {
    if (this.unavailable)
      return Promise.reject(new AppError('STORAGE_UNAVAILABLE', '存储 Worker 不可用。'));
    const requestId = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve: (value) => resolve(value as T), reject });
      this.worker.postMessage({ requestId, method, args });
    });
  }

  get<T>(kind: string, id: string) {
    return this.call<T | null>('get', { kind, id });
  }

  list<T>(kind: string) {
    return this.call<T[]>('list', { kind });
  }

  claim(key: string) {
    return this.call<string | null>('claim', { key });
  }

  replay<T>(input: { principal: string; method: string; key: string; digest: string }) {
    return this.call<T | null>('replay', input);
  }

  commit(input: Transaction) {
    return this.call<CommitResult>('commit', input);
  }

  /** 安装和手动文件作业共用此恢复规则，仅接管已确认退出的持有者。 */
  async releaseDeadLock(key: string) {
    const previous = await this.claim(key);
    if (!previous) return;
    const pid = Number(previous.split(':')[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    try {
      process.kill(pid, 0);
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code === 'ESRCH')
        await this.commit({ releases: [{ key, holder: previous }] });
    }
  }

  /**
   * 通过持久化 claim 协调数据库事务以外的文件操作，最多等待三十秒取得锁。
   * 仅 ESRCH 能证明原持有进程不存在；权限不足等探测失败不能作为抢占依据。
   */
  async locked<T>(key: string, action: () => Promise<T>): Promise<T> {
    const holder = `${process.pid}:${id('lock')}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await this.commit({ claims: [{ key, holder }] });
        break;
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          error.code !== 'RESOURCE_CONFLICT' ||
          Date.now() >= deadline
        )
          throw error;
        await this.releaseDeadLock(key);
        await delay(10);
      }
    }
    try {
      return await action();
    } finally {
      await this.commit({ releases: [{ key, holder }] });
    }
  }

  /** 无条件写入便携入口；需要防止覆盖并发修改时，调用 commit 并显式提供 checks。 */
  async put<T extends Entity>(kind: string, entity: T) {
    await this.commit({ puts: [row(kind, entity)] });
  }

  appendEvent(args: EventInput) {
    return this.call<string>('eventAppend', args);
  }

  readEvents(args: {
    streamId: string;
    after: string;
    limit: number;
    taskId?: string;
    segmentId?: string;
    activationId?: string;
  }) {
    return this.call<{
      items: EventRecord[];
      missing: { from: string; to: string }[];
      highWatermark: string;
    }>('eventRead', args);
  }

  async close() {
    await this.call('close', {});
    await this.worker.terminate();
  }
}
