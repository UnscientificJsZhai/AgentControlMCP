import { fail } from './errors.js';

export type ServicePhase = 'starting' | 'ready' | 'draining' | 'stopped';
export type LifecyclePolicy = 'idle' | 'persistent';
export interface ActivityLease {
  release(): void;
}

/** 所有准入和排空决定均同步完成；单调时钟不受系统时间调整影响。 */
export class ServiceLifecycle {
  phase: ServicePhase = 'starting';
  private idleSince: number | undefined;
  private readonly leases = new Map<number, { kind: 'connection' | 'work'; reason: string }>();
  private sequence = 0;
  constructor(
    readonly idleTimeoutMs: number,
    public policy: LifecyclePolicy,
    private readonly clock: () => number,
  ) {}
  ready() {
    if (this.phase !== 'starting') fail('SERVICE_STATE_INVALID', '服务不能重复就绪。');
    this.phase = 'ready';
    this.updateIdle();
  }
  acquire(kind: 'connection' | 'work', reason: string): ActivityLease {
    if (this.phase === 'draining' || this.phase === 'stopped')
      fail('SERVICE_DRAINING', '服务正在停止，拒绝新工作。');
    const key = ++this.sequence;
    this.leases.set(key, { kind, reason });
    this.idleSince = undefined;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.leases.delete(key);
        this.updateIdle();
      },
    };
  }
  touch() {
    if (this.phase === 'ready' && !this.leases.size) this.idleSince = this.clock();
  }
  persist() {
    if (this.phase !== 'ready') fail('SERVICE_DRAINING', '服务尚未就绪或正在排空。');
    this.policy = 'persistent';
    this.idleSince = undefined;
  }
  beginDrain(force = false) {
    if (this.phase !== 'ready' && !(force && this.phase === 'starting')) return false;
    if (
      !force &&
      (this.policy !== 'idle' ||
        !this.idleTimeoutMs ||
        this.leases.size ||
        this.idleSince === undefined ||
        this.clock() < this.idleSince + this.idleTimeoutMs)
    )
      return false;
    this.phase = 'draining';
    this.idleSince = undefined;
    return true;
  }
  stopped() {
    this.phase = 'stopped';
  }
  snapshot() {
    const values = [...this.leases.values()];
    return {
      phase: this.phase,
      lifecyclePolicy: this.policy,
      connections: values.filter((lease) => lease.kind === 'connection').length,
      workCount: values.filter((lease) => lease.kind === 'work').length,
      keepAliveReasons: [...new Set(values.map((lease) => lease.reason))].sort(),
      idleRemainingMs:
        this.policy === 'idle' && this.idleTimeoutMs && this.idleSince !== undefined
          ? Math.max(0, this.idleSince + this.idleTimeoutMs - this.clock())
          : null,
    };
  }
  private updateIdle() {
    if (this.phase === 'ready' && !this.leases.size && this.policy === 'idle')
      this.idleSince = this.clock();
  }
}
