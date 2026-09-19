import { Worker } from 'node:worker_threads';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { id } from '../../domain/ids.js';
import { AppError } from '../../domain/errors.js';
import type { Entity, EventRecord } from '../../domain/models.js';
import type { CommitResult, RpcResponse, Transaction } from './protocol.js';

export const row = <T extends Entity>(kind: string, entity: T) => ({
  kind,
  id: entity.id,
  revision: entity.revision,
  data: entity,
});
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
  static async open(path: string) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const store = new SqliteStore(path);
    await store.list('meta');
    await chmod(path, 0o600);
    return store;
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
        const previous = await this.claim(key);
        if (previous) {
          try {
            process.kill(Number(previous.split(':')[0]), 0);
          } catch (reason) {
            if ((reason as NodeJS.ErrnoException).code === 'ESRCH')
              await this.commit({ releases: [{ key, holder: previous }] });
          }
        }
        await delay(10);
      }
    }
    try {
      return await action();
    } finally {
      await this.commit({ releases: [{ key, holder }] });
    }
  }
  async put<T extends Entity>(kind: string, entity: T) {
    await this.commit({ puts: [row(kind, entity)] });
  }
  appendEvent(args: {
    streamId: string;
    taskId?: string;
    segmentId?: string;
    activationId?: string;
    kind: string;
    payload: unknown;
    projection?: Record<string, unknown>;
  }) {
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
