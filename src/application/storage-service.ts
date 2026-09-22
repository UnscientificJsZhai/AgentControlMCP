import { lstat, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Context,
  Entity,
  InstallationJob,
  InstallationRecord,
  InstanceRecord,
} from '../domain/models.js';
import { digest, id, now } from '../domain/ids.js';
import { fail } from '../domain/errors.js';
import type { StoragePaths } from '../infrastructure/storage/paths.js';
import { assertStorageRoot, removeOwnedDirectory } from '../infrastructure/storage/paths.js';
import { diskSpace, inspectTree } from '../infrastructure/storage/disk.js';
import { row, type SqliteStore } from '../infrastructure/storage/sqlite-store.js';
import { idem } from './common.js';
import { isAlive } from './recovery-service.js';

type Area = 'installation' | 'staging' | 'cache';
type Scope = 'orphans' | 'cache';
interface Candidate {
  area: Area;
  name: string;
  key: string;
  bytes: number;
  fingerprint: string;
}
interface CleanupPlan extends Entity {
  ownerId: string;
  scope: Scope;
  candidates: Candidate[];
  planDigest: string;
  expiresAt: string;
  completed: string[];
}

/** 清理只接受计划中的对象标识；目录由宿主解析，客户端不能传入待删除路径。 */
export class StorageService {
  constructor(
    readonly store: SqliteStore,
    readonly paths: StoragePaths,
  ) {}

  private root(area: Area) {
    return area === 'installation'
      ? this.paths.installationsDir
      : area === 'staging'
        ? this.paths.stagingDir
        : this.paths.cacheDir;
  }

  private async inventory() {
    const installations = await this.store.list<InstallationRecord>('installation');
    const jobs = await this.store.list<InstallationJob>('installation_job');
    const instances = await this.store.list<InstanceRecord>('instance');
    const active = jobs.filter(
      (job) =>
        ['waiting', 'running'].includes(job.state) &&
        instances.some(
          (instance) =>
            instance.id === job.instanceId && instance.state === 'active' && isAlive(instance.pid),
        ),
    );
    return { installations, jobs, active };
  }

  private async eligible(area: Area, name: string, key: string) {
    const { installations, active } = await this.inventory();
    if (active.some((job) => job.key === key || (area === 'staging' && job.id === name)))
      return false;
    if (area === 'installation' && installations.some((item) => item.key === key)) return false;
    return true;
  }

  private async candidates(scope: Scope) {
    const { jobs, installations } = await this.inventory();
    const candidates: Candidate[] = [];
    for (const area of (scope === 'cache'
      ? ['cache']
      : ['installation', 'staging', 'cache']) as Area[]) {
      const root = this.root(area);
      await assertStorageRoot(root);
      for (const name of (await readdir(root)).sort()) {
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue;
        const key =
          area === 'staging'
            ? (jobs.find((job) => job.id === name)?.key ?? `orphan_${name}`)
            : name;
        if (
          scope === 'orphans' &&
          area === 'cache' &&
          installations.some((item) => item.key === key)
        )
          continue;
        if (!(await this.eligible(area, name, key))) continue;
        const info = await inspectTree(join(root, name));
        if (info.exists)
          candidates.push({ area, name, key, bytes: info.bytes, fingerprint: info.fingerprint });
      }
    }
    return candidates;
  }

  async usage() {
    const seen = new Set<string>();
    const categories: Record<
      string,
      { bytes: number; reclaimableBytes: number; protectedBytes: number }
    > = {};
    for (const [category, root] of Object.entries({
      installations: this.paths.installationsDir,
      cache: this.paths.cacheDir,
      staging: this.paths.stagingDir,
      config: this.paths.configDir,
      content: this.paths.contentDir,
    })) {
      await assertStorageRoot(root);
      const { bytes } = await inspectTree(root, seen);
      categories[category] = { bytes, reclaimableBytes: 0, protectedBytes: bytes };
    }
    let databaseBytes = 0;
    for (const suffix of ['', '-wal', '-shm'])
      databaseBytes += (await inspectTree(this.paths.databasePath + suffix, seen)).bytes;
    categories.database = {
      bytes: databaseBytes,
      reclaimableBytes: 0,
      protectedBytes: databaseBytes,
    };
    const candidates = [...(await this.candidates('orphans')), ...(await this.candidates('cache'))];
    const unique = new Map(candidates.map((item) => [`${item.area}:${item.name}`, item]));
    for (const item of unique.values()) {
      const category = categories[item.area === 'installation' ? 'installations' : item.area]!;
      category.reclaimableBytes = Math.min(category.bytes, category.reclaimableBytes + item.bytes);
      category.protectedBytes = category.bytes - category.reclaimableBytes;
    }
    const sum = (field: 'bytes' | 'reclaimableBytes' | 'protectedBytes') =>
      Object.values(categories).reduce((total, item) => total + item[field], 0);
    return {
      categories,
      fileBytes: sum('bytes'),
      reclaimableBytes: sum('reclaimableBytes'),
      protectedBytes: sum('protectedBytes'),
      volumes: await diskSpace([
        this.paths.dataDir,
        this.paths.cacheDir,
        this.paths.configDir,
        this.paths.stateDir,
      ]),
    };
  }

  async diagnose() {
    const { installations, jobs } = await this.inventory();
    const permissions = await Promise.all(
      [
        ...new Set([
          this.paths.dataDir,
          this.paths.configDir,
          this.paths.stateDir,
          this.paths.cacheDir,
          this.paths.installationsDir,
          this.paths.stagingDir,
          this.paths.contentDir,
          ...(this.paths.runtimeDir ? [this.paths.runtimeDir] : []),
        ]),
      ].map(async (path) => {
        const info = await lstat(path);
        return {
          path,
          mode: (info.mode & 0o777).toString(8),
          private:
            process.platform === 'win32'
              ? null
              : (info.mode & 0o077) === 0 && info.uid === process.getuid?.(),
        };
      }),
    );
    const missing = [];
    for (const installation of installations) {
      const required = [
        join(this.paths.installationsDir, installation.key, 'installation.json'),
        installation.executable,
        ...(installation.distribution === 'npx' && installation.prefixArgs.length
          ? [installation.prefixArgs.at(-1)!]
          : []),
      ];
      if (
        (
          await Promise.all(
            required.map((path) =>
              stat(path).then(
                (info) => info.isFile(),
                () => false,
              ),
            ),
          )
        ).some((exists) => !exists)
      )
        missing.push(installation.id);
    }
    return {
      paths: this.paths,
      permissions,
      missingInstallations: missing,
      pendingRemovals: installations
        .filter((item) => item.state === 'removing')
        .map((item) => item.id),
      pendingJobs: jobs.filter((job) => job.state === 'cleanup_pending').map((job) => job.id),
      orphanCount: (await this.candidates('orphans')).length,
      usage: await this.usage(),
    };
  }

  async plan(ctx: Context, args: { scope?: Scope | undefined; idempotencyKey: string }) {
    const replay = await this.store.replay(idem(ctx, 'storage_cleanup_plan', args, null));
    if (replay) return replay;
    const scope = args.scope ?? 'orphans';
    const candidates = await this.candidates(scope);
    const plan: CleanupPlan = {
      id: id('storage_plan'),
      revision: 1,
      createdAt: now(),
      ownerId: ctx.principalId,
      scope,
      candidates,
      planDigest: digest({ scope, candidates }),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      completed: [],
    };
    const response = {
      cleanupPlanId: plan.id,
      planDigest: plan.planDigest,
      expiresAt: plan.expiresAt,
      candidates,
      reclaimableBytes: candidates.reduce((n, item) => n + item.bytes, 0),
      dryRun: true,
    };
    const result = await this.store.commit({
      puts: [row('storage_cleanup_plan', plan)],
      idempotency: idem(ctx, 'storage_cleanup_plan', args, response),
    });
    return result.response;
  }

  async apply(
    ctx: Context,
    args: { cleanupPlanId: string; planDigest: string; idempotencyKey: string },
  ) {
    return this.store.locked(
      `idempotency:${digest([ctx.principalId, 'storage_cleanup_apply', args.idempotencyKey])}`,
      () =>
        this.store.locked(`storage-plan:${args.cleanupPlanId}`, async () => {
          const replay = await this.store.replay(idem(ctx, 'storage_cleanup_apply', args, null));
          if (replay) return replay;
          let plan = await this.store.get<CleanupPlan>('storage_cleanup_plan', args.cleanupPlanId);
          if (!plan || (plan.ownerId !== ctx.principalId && !ctx.admin))
            fail('OBJECT_NOT_FOUND', '清理计划不存在或不可见。');
          if (plan.planDigest !== args.planDigest || Date.parse(plan.expiresAt) <= Date.now())
            fail('STORAGE_PLAN_STALE', '清理计划已过期或摘要不匹配，请重新预览。');
          for (const candidate of plan.candidates) {
            const token = `${candidate.area}:${candidate.name}`;
            if (plan.completed.includes(token)) continue;
            await this.store.locked(`install:${candidate.key}`, async () => {
              if (!(await this.eligible(candidate.area, candidate.name, candidate.key)))
                fail('STORAGE_PLAN_STALE', '对象已被安装或活动作业占用，请重新预览。');
              const root = this.root(candidate.area);
              await assertStorageRoot(root);
              const current = await inspectTree(join(root, candidate.name));
              if (current.exists && current.fingerprint !== candidate.fingerprint)
                fail('STORAGE_PLAN_STALE', '目录内容已变化，请重新预览。');
              await removeOwnedDirectory(root, candidate.name);
              const next: CleanupPlan = {
                ...plan!,
                revision: plan!.revision + 1,
                completed: [...plan!.completed, token],
              };
              await this.store.commit({
                checks: [{ kind: 'storage_cleanup_plan', id: plan!.id, revision: plan!.revision }],
                puts: [row('storage_cleanup_plan', next)],
              });
              plan = next;
            });
          }
          // 空目录也需要解除待清理状态，避免已清理作业永久阻止同目标重装。
          for (const job of await this.store.list<InstallationJob>('installation_job')) {
            if (job.state !== 'cleanup_pending') continue;
            await this.store.locked(`install:${job.key}`, async () => {
              const currentJob = await this.store.get<InstallationJob>('installation_job', job.id);
              if (currentJob?.state !== 'cleanup_pending') return;
              const paths = [
                join(this.paths.installationsDir, job.key),
                join(this.paths.stagingDir, job.id),
                join(this.paths.cacheDir, job.key),
              ];
              if (
                (await Promise.all(paths.map((path) => inspectTree(path)))).some(
                  (item) => item.exists,
                )
              )
                return;
              await this.store.commit({
                checks: [{ kind: 'installation_job', id: job.id, revision: currentJob.revision }],
                puts: [
                  row('installation_job', {
                    ...currentJob,
                    revision: currentJob.revision + 1,
                    state: 'ended',
                  }),
                ],
              });
            });
          }
          const response = {
            dryRun: false,
            removedCount: plan.completed.length,
            removedFileBytes: plan.candidates.reduce((sum, item) => sum + item.bytes, 0),
          };
          await this.store.commit({
            idempotency: idem(ctx, 'storage_cleanup_apply', args, response),
          });
          return response;
        }),
    );
  }
}
