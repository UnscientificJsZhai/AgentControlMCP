import { digest, now } from '../domain/ids.js';
import { errorDetail, AppError } from '../domain/errors.js';
import type {
  ActivationRecord,
  InstanceRecord,
  InstallationJob,
  InteractionRecord,
  RuntimeRecord,
  SegmentRecord,
  SessionRecord,
  WorkRecord,
} from '../domain/models.js';
import { terminalStates } from '../domain/models.js';
import type { SqliteStore } from '../infrastructure/storage/sqlite-store.js';
import { row } from '../infrastructure/storage/sqlite-store.js';
import type { Row } from '../infrastructure/storage/protocol.js';

/** 只有 ESRCH 视为已退出；权限错误或其他不确定情况按仍存活处理，避免错误抢占资源。 */
export function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * 只修复已确认退出的实例：将未完成工作标为 interrupted，释放占用并封口事件段。
 * 恢复数据库状态不等于恢复下游执行，不重发 prompt、认证或其他结果未知的操作。
 */
export async function recover(store: SqliteStore) {
  const instances = await store.list<InstanceRecord>('instance');
  const dead = instances.filter(
    (instance) => instance.state === 'active' && !isAlive(instance.pid),
  );
  for (const instance of dead) {
    const puts: Row[] = [
      row('instance', { ...instance, revision: instance.revision + 1, state: 'stopped' }),
    ];
    const deletes: { kind: string; id: string }[] = [];
    const releases = [{ key: 'http_service', holder: instance.id }];
    for (const kind of ['task', 'operation'] as const)
      for (const record of await store.list<WorkRecord>(kind))
        if (record.instanceId === instance.id && !terminalStates.has(record.state)) {
          puts.push(
            row(kind, {
              ...record,
              revision: record.revision + 1,
              state: 'interrupted',
              endedAt: now(),
              error: errorDetail(
                new AppError(
                  'DISPATCH_OUTCOME_UNKNOWN',
                  '所属连接器已退出；未确认完成，不自动重放。',
                ),
              ),
            }),
          );
          if (kind === 'task') {
            deletes.push({ kind: 'task_slot', id: record.id });
            releases.push({ key: `prompt:${record.sessionId!}`, holder: record.id });
          }
        }
    const runtimeIds = new Set<string>();
    for (const runtime of await store.list<RuntimeRecord>('runtime'))
      if (runtime.instanceId === instance.id && runtime.state !== 'closed') {
        runtimeIds.add(runtime.id);
        puts.push(
          row('runtime', {
            ...runtime,
            revision: runtime.revision + 1,
            state: 'closed',
            authState: 'unknown',
          }),
        );
        deletes.push({ kind: 'runtime_slot', id: runtime.id });
        releases.push({
          key: `config:${runtime.configId}:runtime:${runtime.id}`,
          holder: runtime.id,
        });
        if (runtime.snapshot.launch.kind === 'installation')
          releases.push({
            key: `installation:${runtime.snapshot.launch.installationId}:runtime:${runtime.id}`,
            holder: runtime.id,
          });
      }
    for (const session of await store.list<SessionRecord>('session'))
      if (session.instanceId === instance.id) {
        if (session.state === 'creating' || session.state === 'ready') {
          const next: SessionRecord = {
            ...session,
            state: 'interrupted',
            revision: session.revision + 1,
          };
          delete next.activeTaskId;
          puts.push(row('session', next));
        }
        // 保留会话终态，同时清理仍由原运行时持有的遗留租约。
        releases.push({
          key: `session:${digest([session.namespace, session.downstreamSessionId])}`,
          holder: session.runtimeId,
        });
      }
    for (const activation of await store.list<ActivationRecord>('activation'))
      if (runtimeIds.has(activation.runtimeId) && !activation.endedAt)
        puts.push(
          row('activation', { ...activation, revision: activation.revision + 1, endedAt: now() }),
        );
    for (const segment of await store.list<SegmentRecord>('segment'))
      if (runtimeIds.has(segment.runtimeId) && segment.state === 'open')
        puts.push(
          row('segment', {
            ...segment,
            revision: segment.revision + 1,
            state: 'sealed',
            sealedAt: now(),
          }),
        );
    for (const interaction of await store.list<InteractionRecord>('interaction'))
      if (interaction.instanceId === instance.id && interaction.state === 'pending')
        puts.push(
          row('interaction', {
            ...interaction,
            revision: interaction.revision + 1,
            state: 'cancelled',
          }),
        );
    for (const job of await store.list<InstallationJob>('installation_job'))
      if (job.instanceId === instance.id) {
        releases.push({ key: `install:${job.key}`, holder: job.lockHolder ?? job.id });
        if (job.state === 'running' || job.state === 'waiting')
          puts.push(
            row('installation_job', {
              ...job,
              revision: job.revision + 1,
              state: job.paths ? 'cleanup_pending' : 'ended',
            }),
          );
      }

    // 以实例修订防止多个启动者重复接管；该实例的状态与资源释放一起提交。
    await store.commit({
      checks: [{ kind: 'instance', id: instance.id, revision: instance.revision }],
      puts,
      deletes,
      releases,
    });
  }
  return {
    recoveredInstances: dead.map((instance) => instance.id),
    uncertainInstances: instances
      .filter((instance) => instance.state === 'active' && isAlive(instance.pid))
      .map((instance) => instance.id),
  };
}
