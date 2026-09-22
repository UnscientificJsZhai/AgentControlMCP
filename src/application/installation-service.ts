import { lstat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, fail } from '../domain/errors.js';
import { digest, id, now } from '../domain/ids.js';
import type { Context, InstallationRecord, InstallationJob } from '../domain/models.js';
import type { SqliteStore } from '../infrastructure/storage/sqlite-store.js';
import { row } from '../infrastructure/storage/sqlite-store.js';
import type { RegistryClient } from '../infrastructure/registry/client.js';
import { platformKey } from '../infrastructure/installers/installer.js';
import type { InstallTarget, Installer } from '../infrastructure/installers/installer.js';
import type { ConfigService } from './config-service.js';
import type { OperationService } from './operation-service.js';
import { idem } from './common.js';

/** 同目标的底层安装作业；每个参与者仍有自己的 operation、归属和取消权。 */
interface Job {
  id: string;
  abort: AbortController;
  participants: Set<string>;
  promise: Promise<InstallationRecord>;
  step: string;
  finished: boolean;
}

/** 合并相同安装目标并协调跨实例安装锁，升级与回退只在产物就绪后切换注册配置。 */
export class InstallationService {
  private readonly jobs = new Map<string, Job>();

  constructor(
    readonly store: SqliteStore,
    readonly registry: RegistryClient,
    readonly installer: Installer,
    readonly operations: OperationService,
    readonly configs: ConfigService,
    readonly maxJobs: number,
  ) {}

  list() {
    return this.store.list<InstallationRecord>('installation');
  }

  install(ctx: Context, args: InstallTarget & { idempotencyKey: string }) {
    return this.operations.start(ctx, 'agent_install', args, (op, signal) =>
      this.acquire(args, op, signal),
    );
  }

  /** 安装键覆盖来源、快照地址、分发内容、平台及 Node ABI，避免误复用不兼容产物。 */
  async acquire(
    target: InstallTarget,
    operationId: string,
    signal: AbortSignal,
  ): Promise<InstallationRecord> {
    const entry = await this.registry.get(
      target.sourceId,
      target.registryAgentId,
      target.snapshotId,
    );
    if (entry.agent.version !== target.targetVersion)
      fail('VERSION_UNRESOLVABLE', '所选来源快照没有目标版本，请选择保留快照或刷新来源。');
    const manifest =
      target.distribution === 'binary'
        ? entry.agent.distribution.binary?.[platformKey()]
        : entry.agent.distribution[target.distribution];
    if (!manifest) fail('PLATFORM_UNSUPPORTED', '此版本没有所选分发方式或宿主平台产物。');
    const resolved = await this.installer.resolve(target, manifest, signal);
    const key = digest({
      sourceId: target.sourceId,
      sourceSnapshotUrl: (
        await this.registry.store.get<{ url: string }>('registry_snapshot', entry.snapshotId)
      )?.url,
      agent: target.registryAgentId,
      version: target.targetVersion,
      resolved,
      kind: target.distribution,
      platform: platformKey(),
      manifest,
      abi: process.versions.modules,
    });
    const cached = (await this.list()).find((item) => item.key === key);
    if (cached) {
      if (cached.state !== 'ready') fail('INSTALLATION_BUSY', '此安装正在删除，请先完成清理。');
      return cached;
    }
    let job = this.jobs.get(key);
    if (job?.abort.signal.aborted) fail('INSTALLATION_BUSY', '同目标安装仍在停止中。');
    if (!job) {
      if (this.jobs.size >= this.maxJobs) fail('CAPACITY_EXCEEDED', '并发安装数量已达上限。');
      const shared: Job = {
        id: id('job'),
        abort: new AbortController(),
        participants: new Set(),
        step: 'accepted',
        finished: false,
        promise: Promise.resolve(null as unknown as InstallationRecord),
      };
      this.jobs.set(key, shared);
      shared.promise = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
        const jobSignal = AbortSignal.any([shared.abort.signal, AbortSignal.timeout(600_000)]);
        const lock = `install:${key}`;
        const lockHolder = `${process.pid}:${shared.id}`;
        let jobRecord: InstallationJob = {
          id: shared.id,
          revision: 1,
          createdAt: now(),
          instanceId: this.operations.instanceId,
          key,
          lockHolder,
          state: 'waiting',
        };
        let built: InstallationRecord | undefined;
        let published = false;
        let cleanupPending = false;
        let acquired = false;
        const progress = async (step: string) => {
          shared.step = step;
          await Promise.all(
            [...shared.participants].map((op) => this.operations.update(op, { step })),
          );
        };
        try {
          await this.store.put('installation_job', jobRecord);
          while (!acquired) {
            jobSignal.throwIfAborted();
            const installed = (await this.list()).find((item) => item.key === key);
            if (installed) {
              if (installed.state !== 'ready') fail('INSTALLATION_BUSY', '此安装正在删除。');
              return installed;
            }
            try {
              await this.store.commit({ claims: [{ key: lock, holder: lockHolder }] });
              acquired = true;
            } catch (error) {
              if (!(error instanceof AppError && error.code === 'RESOURCE_CONFLICT')) throw error;
              await this.store.releaseDeadLock(lock);
              await progress('waiting_install_lock');
              await delay(100, undefined, { signal: jobSignal });
            }
          }
          // 获锁后再检查缓存，等待期间其他实例可能已经完成并发布同目标安装。
          const installed = (await this.list()).find((item) => item.key === key);
          if (installed) {
            if (installed.state !== 'ready') fail('INSTALLATION_BUSY', '此安装正在删除。');
            return installed;
          }
          if (
            (await this.store.list<InstallationJob>('installation_job')).some(
              (item) =>
                item.id !== shared.id && item.key === key && item.state === 'cleanup_pending',
            )
          )
            fail('STORAGE_CLEANUP_REQUIRED', '此目标有待清理作业，请先运行 storage cleanup。');
          jobRecord = {
            ...jobRecord,
            revision: 2,
            state: 'running',
            paths: this.installer.locations(key, shared.id),
          };
          await this.store.put('installation_job', jobRecord);
          const record = await this.installer.install(
            target,
            manifest,
            resolved,
            key,
            jobSignal,
            progress,
            shared.id,
          );
          built = record;
          const ended: InstallationJob = {
            ...jobRecord,
            revision: jobRecord.revision + 1,
            state: 'ended',
          };
          // 安装与作业终态一起发布，避免 ready 产物留下无法完成的崩溃作业。
          await this.store.commit({
            checks: [
              {
                kind: 'installation_job',
                id: jobRecord.id,
                revision: jobRecord.revision,
                state: 'running',
              },
            ],
            puts: [row('installation', record), row('installation_job', ended)],
          });
          published = true;
          jobRecord = ended;
          return record;
        } catch (error) {
          if (built) {
            // 发布响应异常时重读事实；无法确认数据库状态就保留产物供人工诊断。
            try {
              published = !!(await this.store.get<InstallationRecord>('installation', built.id));
              if (!published) await this.installer.cleanup(key, shared.id);
            } catch {
              cleanupPending = true;
            }
          }
          if (jobRecord.paths && !published && !cleanupPending) {
            for (const path of Object.values(jobRecord.paths)) {
              if (
                await lstat(path).then(
                  () => true,
                  (error: NodeJS.ErrnoException) => error.code !== 'ENOENT',
                )
              )
                cleanupPending = true;
            }
          }
          throw error;
        } finally {
          shared.finished = true;
          try {
            await this.store.commit({
              ...(!published
                ? {
                    puts: [
                      row('installation_job', {
                        ...jobRecord,
                        revision: jobRecord.revision + 1,
                        state: cleanupPending ? 'cleanup_pending' : 'ended',
                      }),
                    ],
                  }
                : {}),
              releases: acquired ? [{ key: lock, holder: lockHolder }] : [],
            });
          } finally {
            this.jobs.delete(key);
          }
        }
      });
      void shared.promise.catch(() => {});
      job = shared;
    }
    job.participants.add(operationId);
    await this.operations.update(operationId, { step: job.step });
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        job.promise,
        new Promise<never>((_resolve, reject) => {
          abort = () =>
            reject(new AppError('CANCELLED', '本方安装操作已取消；其他参与者可以继续。'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
      // 一方取消只退出自己的等待；最后一个参与者离开后才中止共享安装。
      job.participants.delete(operationId);
      if (!job.participants.size && !job.finished) job.abort.abort();
    }
  }

  /** 移除与安装共用目标锁，并拒绝删除仍被注册配置或活动 Runtime 引用的产物。 */
  async remove(ctx: Context, args: { installationId: string; idempotencyKey: string }) {
    // 不同目标复用同一个幂等键时，也必须在任何文件副作用之前完成冲突检查。
    return this.store.locked(
      `idempotency:${digest([ctx.principalId, 'installation_remove', args.idempotencyKey])}`,
      async () => {
        const replay = await this.store.replay(idem(ctx, 'installation_remove', args, null));
        if (replay) return replay;
        const record = await this.store.get<InstallationRecord>(
          'installation',
          args.installationId,
        );
        if (!record) fail('OBJECT_NOT_FOUND', '安装不存在。');
        return this.store.locked(`install:${record.key}`, async () => {
          const replayed = await this.store.replay(idem(ctx, 'installation_remove', args, null));
          if (replayed) return replayed;
          const current = await this.store.get<InstallationRecord>('installation', record.id);
          if (!current) fail('OBJECT_NOT_FOUND', '安装不存在。');
          const removing: InstallationRecord = {
            ...current,
            revision: current.revision + 1,
            state: 'removing',
          };
          await this.store.commit({
            checks: [{ kind: 'installation', id: current.id, revision: current.revision }],
            absentClaimPrefixes: [`installation:${current.id}:`],
            puts: [row('installation', removing)],
          });
          // 删除失败保留 removing 记录；重试相同请求不会提前命中成功幂等结果。
          await this.installer.cleanup(current.key);
          const result = await this.store.commit({
            checks: [
              {
                kind: 'installation',
                id: current.id,
                revision: removing.revision,
                state: 'removing',
              },
            ],
            absentClaimPrefixes: [`installation:${current.id}:`],
            deletes: [{ kind: 'installation', id: current.id }],
            idempotency: idem(ctx, 'installation_remove', args, { removed: true }),
          });
          return result.response;
        });
      },
    );
  }

  /** 先准备目标产物，再用配置 CAS 原子提交版本切换；已有 Runtime 继续使用原启动快照。 */
  async switch(
    ctx: Context,
    args: {
      configId: string;
      expectedRevision: number;
      idempotencyKey: string;
      targetVersion?: string | undefined;
      distribution?: InstallTarget['distribution'] | undefined;
      sourceSnapshotId?: string | undefined;
      target?:
        | {
            installationId?: string | undefined;
            sourceSnapshotId?: string | undefined;
            targetVersion?: string | undefined;
            distribution?: InstallTarget['distribution'] | undefined;
          }
        | undefined;
    },
    rollback = false,
  ) {
    const config = await this.configs.get(args.configId);
    if (config.config.origin.kind !== 'registry')
      fail('CONFIG_INVALID', '此配置没有 Registry 来源。');
    const origin = config.config.origin;
    return this.operations.start(
      ctx,
      rollback ? 'agent_rollback' : 'agent_upgrade',
      args,
      async (operationId, signal) => {
        const target = rollback ? args.target! : args;
        const install =
          'installationId' in target && target.installationId
            ? await this.store.get<InstallationRecord>('installation', target.installationId)
            : await this.acquire(
                {
                  sourceId: origin.sourceId,
                  registryAgentId: origin.registryAgentId,
                  targetVersion: target.targetVersion!,
                  distribution: target.distribution!,
                  snapshotId: target.sourceSnapshotId,
                },
                operationId,
                signal,
              );
        if (
          !install ||
          install.state !== 'ready' ||
          install.sourceId !== origin.sourceId ||
          install.registryAgentId !== origin.registryAgentId
        )
          fail('CONFIG_INVALID', '回退目标与原来源不匹配。');
        signal.throwIfAborted();
        const operation = await this.operations.get(ctx, operationId);
        if (operation.state === 'cancelling') fail('CANCELLED', '版本切换已取消。');
        const updated = await this.configs.update(
          ctx,
          {
            configId: args.configId,
            expectedRevision: args.expectedRevision,
            idempotencyKey: `${operationId}:switch`,
            patch: {
              launch: {
                kind: 'installation',
                installationId: install.id,
                ...(config.config.launch.args !== undefined
                  ? { args: config.config.launch.args }
                  : {}),
              },
            },
          },
          operation,
        );
        return {
          ...updated,
          oldInstallationId:
            config.config.launch.kind === 'installation'
              ? config.config.launch.installationId
              : null,
          newInstallationId: install.id,
        };
      },
    );
  }

  /** 刷新可用版本信息并保存检查状态，只通知更新，不自动安装或切换现有配置。 */
  async updates(configIds?: string[], force = false, signal?: AbortSignal) {
    const results = [];
    for (const config of await this.configs.list()) {
      if ((configIds && !configIds.includes(config.id)) || config.config.origin.kind !== 'registry')
        continue;
      const origin = config.config.origin;
      try {
        await this.registry.refresh(origin.sourceId, signal, force);
        const available = await this.registry.get(origin.sourceId, origin.registryAgentId);
        const current =
          config.config.launch.kind === 'installation'
            ? await this.store.get<InstallationRecord>(
                'installation',
                config.config.launch.installationId,
              )
            : null;
        const result = {
          id: config.id,
          revision: 1,
          createdAt: now(),
          configId: config.id,
          current: current?.version ?? null,
          available: available.agent.version,
          sourceSnapshotId: available.snapshotId,
          checkStatus: 'checked',
          checkedAt: now(),
        };
        await this.store.put('update_status', result);
        results.push(result);
      } catch {
        const result = {
          id: config.id,
          revision: 1,
          createdAt: now(),
          configId: config.id,
          checkStatus: 'error',
          checkedAt: now(),
        };
        await this.store.put('update_status', result);
        results.push(result);
      }
    }
    return { items: results };
  }

  async close() {
    for (const job of this.jobs.values()) job.abort.abort();
    await Promise.allSettled([...this.jobs.values()].map((job) => job.promise));
  }
}
