import { realpath } from 'node:fs/promises';
import type {
  ActivationRecord,
  Context,
  InstanceRecord,
  RuntimeRecord,
  SessionRecord,
} from '../domain/models.js';
import { digest, id, now } from '../domain/ids.js';
import { fail } from '../domain/errors.js';
import { row } from '../infrastructure/storage/sqlite-store.js';
import { isAlive, recover } from './recovery-service.js';
import type { SqliteStore } from '../infrastructure/storage/sqlite-store.js';
import type { ConfigService } from './config-service.js';
import type { RuntimeService } from './runtime-service.js';

// 只供具有本机管理能力的 CLI 使用；外部会话不会通过 MCP 自动导入。
export class RecoveryAdminService {
  constructor(
    readonly app: {
      store: SqliteStore;
      configs: ConfigService;
      runtimes: RuntimeService;
      admin: Context;
      instanceId: string;
      serviceId: string;
    },
  ) {}

  /** 管理诊断隐藏握手 nonce；进程存活只是观测结果，不证明 PID 仍对应原实例。 */
  async inspect() {
    const instances = (await this.app.store.list<InstanceRecord>('instance')).map(
      ({ nonce: _nonce, ...item }) => ({ ...item, processAlive: isAlive(item.pid) }),
    );
    return {
      instances,
      runtimes: await this.app.store.list<RuntimeRecord>('runtime'),
      sessions: await this.app.store.list<SessionRecord>('session'),
    };
  }

  /** 本实例可直接关闭活动句柄，其他实例必须确认进程退出后才能修复其持久化状态。 */
  async resolve(args: {
    runtimeId?: string | undefined;
    instanceId?: string | undefined;
    expectedRevision: number;
  }) {
    if (args.runtimeId) {
      const runtime = await this.app.runtimes.get(this.app.admin, args.runtimeId);
      if (runtime.revision !== args.expectedRevision)
        fail('REVISION_CONFLICT', 'Runtime 修订已变化。');
      if (runtime.instanceId !== this.app.instanceId)
        fail('INSTANCE_MISMATCH', '请连接原实例；不根据裸 PID 杀进程。');
      await this.app.runtimes.closeNow(runtime.id);
      return { runtimeId: runtime.id, state: 'closed' };
    }
    const instance = await this.app.store.get<InstanceRecord>('instance', args.instanceId!);
    if (!instance) fail('OBJECT_NOT_FOUND', '实例不存在。');
    if (instance.revision !== args.expectedRevision) fail('REVISION_CONFLICT', '实例修订已变化。');
    if (isAlive(instance.pid))
      fail(
        'RECOVERY_CONFLICT',
        '进程仍存在或身份无法确认；请通过原实例管理入口停止后重试，不抢占租约。',
      );
    return recover(this.app.store);
  }

  /**
   * 为已有下游会话建立关闭状态的本地映射，并校验命名空间与目标所有者。
   * 此步骤不连接 Agent；是否真实存在且可恢复，仍由后续显式 load/resume 验证。
   */
  async adopt(args: {
    configId: string;
    expectedRevision: number;
    downstreamSessionId: string;
    namespace: string;
    ownerId: string;
    cwd: string;
  }) {
    const config = await this.app.configs.get(args.configId, args.expectedRevision);
    const namespace =
      config.config.sessionNamespace ??
      (config.config.origin.kind === 'registry'
        ? `registry:${config.config.origin.sourceId}:${config.config.origin.registryAgentId}`
        : `command:${digest(config.config.launch)}`);
    if (namespace !== args.namespace)
      fail('CONFIG_INVALID', '确认的 namespace 与配置不一致。', { namespace });
    if (
      !args.ownerId.startsWith('stdio:') &&
      !(await this.app.store.get('principal', args.ownerId))
    )
      fail('OBJECT_NOT_FOUND', '请指定已有 HTTP 身份或稳定的 stdio:<client-id>。');
    const key = digest([namespace, args.downstreamSessionId]);
    if (
      (await this.app.store.list<SessionRecord>('session')).some(
        (session) =>
          session.namespace === namespace &&
          session.downstreamSessionId === args.downstreamSessionId,
      )
    )
      fail('RESOURCE_CONFLICT', '已有此下游会话的连接器记录，请使用原记录。');
    const cwd = await realpath(args.cwd);
    const runtimeId = id('run');
    const sessionId = id('ses');
    const activationId = id('act');
    const timestamp = now();
    const runtime: RuntimeRecord = {
      id: runtimeId,
      revision: 1,
      createdAt: timestamp,
      instanceId: this.app.instanceId,
      ownerId: args.ownerId,
      configId: config.id,
      configRevision: config.revision,
      snapshot: config.config,
      cwd,
      state: 'closed',
      connectionGeneration: 0,
      authState: 'unknown',
      expiresAt: timestamp,
      sessionId,
    };
    const session: SessionRecord = {
      id: sessionId,
      revision: 1,
      createdAt: timestamp,
      ownerId: args.ownerId,
      grants: {},
      instanceId: this.app.instanceId,
      serviceId: this.app.serviceId,
      mode: args.ownerId.startsWith('stdio:') ? 'stdio' : 'http',
      configId: config.id,
      runtimeId,
      activationId,
      downstreamSessionId: args.downstreamSessionId,
      namespace,
      state: 'closed',
      cwd,
      additionalDirectories: [],
      snapshot: config.config,
      options: [],
      modes: null,
      commands: [],
      controlVersion: 0,
    };
    const activation: ActivationRecord = {
      id: activationId,
      revision: 1,
      createdAt: timestamp,
      sessionId,
      runtimeId,
      instanceId: this.app.instanceId,
      downstreamSessionId: args.downstreamSessionId,
      startedAt: timestamp,
      endedAt: timestamp,
    };
    await this.app.store.commit({
      checks: [{ kind: 'config', id: config.id, revision: args.expectedRevision }],
      absentClaimPrefixes: [`session:${key}`],
      claims: [{ key: `adopt:${key}`, holder: sessionId }],
      puts: [row('runtime', runtime), row('session', session), row('activation', activation)],
    });
    return {
      sessionId,
      state: 'closed',
      downstreamVerified: false,
      nextAction: '显式执行 session load/resume 的 prepare/apply，由下游验证会话存在和可恢复性。',
    };
  }
}
