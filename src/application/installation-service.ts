import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, fail } from '../domain/errors.js';
import { digest, id, now } from '../domain/ids.js';
import type { Context, InstallationRecord } from '../domain/models.js';
import type { SqliteStore } from '../infrastructure/storage/sqlite-store.js';
import type { RegistryClient } from '../infrastructure/registry/client.js';
import { platformKey } from '../infrastructure/installers/installer.js';
import type { InstallTarget, Installer } from '../infrastructure/installers/installer.js';
import type { ConfigService } from './config-service.js';
import type { OperationService } from './operation-service.js';
import { idem } from './common.js';

interface Job {
  id: string;
  abort: AbortController;
  participants: Set<string>;
  promise: Promise<InstallationRecord>;
  step: string;
  finished: boolean;
}
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
    if (cached) return cached;
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
        let acquired = false;
        const progress = async (step: string) => {
          shared.step = step;
          await Promise.all(
            [...shared.participants].map((op) => this.operations.update(op, { step })),
          );
        };
        try {
          await this.store.put('installation_job', {
            id: shared.id,
            revision: 1,
            createdAt: now(),
            instanceId: this.operations.instanceId,
            key,
            state: 'running',
          });
          while (!acquired) {
            jobSignal.throwIfAborted();
            const installed = (await this.list()).find((item) => item.key === key);
            if (installed) return installed;
            try {
              await this.store.commit({ claims: [{ key: lock, holder: shared.id }] });
              acquired = true;
            } catch (error) {
              if (!(error instanceof AppError && error.code === 'RESOURCE_CONFLICT')) throw error;
              await progress('waiting_install_lock');
              await delay(100, undefined, { signal: jobSignal });
            }
          }
          const installed = (await this.list()).find((item) => item.key === key);
          if (installed) return installed;
          const record = await this.installer.install(
            target,
            manifest,
            resolved,
            key,
            jobSignal,
            progress,
          );
          await this.store.put('installation', record);
          return record;
        } finally {
          shared.finished = true;
          if (acquired) await this.store.commit({ releases: [{ key: lock, holder: shared.id }] });
          await this.store.put('installation_job', {
            id: shared.id,
            revision: 2,
            createdAt: now(),
            instanceId: this.operations.instanceId,
            key,
            state: 'ended',
          });
          this.jobs.delete(key);
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
      job.participants.delete(operationId);
      if (!job.participants.size && !job.finished) job.abort.abort();
    }
  }
  async remove(ctx: Context, args: { installationId: string; idempotencyKey: string }) {
    const replay = await this.store.replay(idem(ctx, 'installation_remove', args, null));
    if (replay) return replay;
    const record = await this.store.get<InstallationRecord>('installation', args.installationId);
    if (!record) fail('OBJECT_NOT_FOUND', '安装不存在。');
    const holder = id('remove');
    const lock = `install:${record.key}`;
    await this.store.commit({ claims: [{ key: lock, holder }] });
    try {
      const result = await this.store.commit({
        checks: [{ kind: 'installation', id: record.id, revision: record.revision }],
        absentClaimPrefixes: [`installation:${record.id}:`],
        deletes: [{ kind: 'installation', id: record.id }],
        idempotency: idem(ctx, 'installation_remove', args, { removed: true }),
      });
      if (!result.replayed) {
        await rm(record.path, { recursive: true, force: true });
        await rm(join(this.installer.dataDir, 'tool-cache', record.key), {
          recursive: true,
          force: true,
        });
      }
      return result.response;
    } finally {
      await this.store.commit({ releases: [{ key: lock, holder }] });
    }
  }
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
