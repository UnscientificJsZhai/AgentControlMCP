import { performance } from 'node:perf_hooks';
import { ServiceLifecycle } from '../domain/service-lifecycle.js';
import type { ActivityLease, LifecyclePolicy } from '../domain/service-lifecycle.js';
import type { Transaction, CommitResult, Row } from '../infrastructure/storage/protocol.js';

const workKinds = new Set([
  'task',
  'operation',
  'collab_intent',
  'collab_agent',
  'interaction',
  'installation_job',
]);

/** 工作租约与持久化受理共用屏障；失败和幂等重放不会添加虚假的工作计数。 */
export class ServiceActivity {
  readonly lifecycle: ServiceLifecycle;
  private readonly work = new Map<string, ActivityLease>();
  private readonly interactionRuntime = new Map<string, string>();
  private readonly teams = new Set<string>();
  constructor(
    readonly instanceId: string,
    idleTimeoutMs: number,
    policy: LifecyclePolicy,
  ) {
    this.lifecycle = new ServiceLifecycle(idleTimeoutMs, policy, () => performance.now());
  }
  async commit(input: Transaction, action: () => Promise<CommitResult>) {
    const relevant = (input.puts ?? []).filter(
      (r) => workKinds.has(r.kind) || r.kind === 'collab_team' || r.kind === 'runtime',
    );
    // 排空期间只允许收尾，不能创建新工作或从终态重新受理。
    const incomingTeams = new Set([
      ...this.teams,
      ...relevant
        .filter(
          (r) =>
            r.kind === 'collab_team' &&
            (r.data as { instanceId: string }).instanceId === this.instanceId,
        )
        .map((r) => r.id),
    ]);
    const needsAdmission = relevant.some(
      (r) => this.isActive(r, incomingTeams) && !this.work.has(`${r.kind}:${r.id}`),
    );
    const lease = needsAdmission ? this.lifecycle.acquire('work', 'admission') : undefined;
    try {
      const result = await action();
      if (!result.replayed) {
        for (const r of relevant)
          if (r.kind === 'collab_team') {
            const team = r.data as { instanceId: string };
            if (team.instanceId === this.instanceId) this.teams.add(r.id);
            else this.teams.delete(r.id);
          }
        for (const r of relevant) {
          const record = r.data as { runtimeId?: string; state?: string };
          if (r.kind === 'runtime' && record.state === 'closed') {
            for (const [key, runtimeId] of this.interactionRuntime)
              if (runtimeId === r.id) {
                this.work.get(key)?.release();
                this.work.delete(key);
                this.interactionRuntime.delete(key);
              }
          }
          const key = `${r.kind}:${r.id}`;
          if (r.kind === 'interaction' && record.runtimeId)
            this.interactionRuntime.set(key, record.runtimeId);
          if (this.isActive(r)) {
            if (!this.work.has(key))
              this.work.set(key, this.lifecycle.acquire('work', `${r.kind}:${r.id}`));
          } else {
            this.work.get(key)?.release();
            this.work.delete(key);
          }
        }
        for (const r of input.deletes ?? []) {
          const key = `${r.kind}:${r.id}`;
          this.work.get(key)?.release();
          this.work.delete(key);
        }
      }
      return result;
    } finally {
      lease?.release();
    }
  }
  private isActive(row: Row, teams = this.teams) {
    const r = row.data as {
      instanceId?: string;
      teamId?: string;
      state?: string;
      lifecycle?: string;
      requestId?: string | number | null;
    };
    if (r.instanceId !== undefined && r.instanceId !== this.instanceId) return false;
    if (r.teamId && !teams.has(r.teamId)) return false;
    switch (row.kind) {
      case 'task':
      case 'operation':
        return ['accepted', 'running', 'waiting_interaction', 'cancelling'].includes(r.state ?? '');
      case 'collab_intent':
        return r.state === 'queued' || r.state === 'dispatched';
      case 'collab_agent':
        return ['starting', 'stopping', 'closing'].includes(r.lifecycle ?? '');
      case 'interaction':
        return r.state === 'pending' || (r.state === 'decided' && r.requestId != null);
      case 'installation_job':
        return r.state === 'waiting' || r.state === 'running';
      default:
        return false;
    }
  }
}
