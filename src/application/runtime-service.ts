import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { ClientCapabilities, InitializeResponse } from '@agentclientprotocol/sdk';
import type { Context, RuntimeRecord, SessionRecord } from '../domain/models.js';
import type { Settings } from '../domain/schemas.js';
import type { InstallationRecord } from '../domain/models.js';
import { AppError, fail } from '../domain/errors.js';
import { id, now } from '../domain/ids.js';
import { access } from '../domain/access-control.js';
import type { SqliteStore } from '../infrastructure/storage/sqlite-store.js';
import { row } from '../infrastructure/storage/sqlite-store.js';
import { ClientRuntime } from '../infrastructure/acp/client-runtime.js';
import type { CallbackPorts } from '../infrastructure/acp/client-runtime.js';
import { resolveEnvironment, redact } from '../infrastructure/platform/environment.js';
import type { LaunchSpec } from '../infrastructure/platform/process-host.js';
import type { ConfigService } from './config-service.js';
import type { OperationService } from './operation-service.js';
import { Serial } from './common.js';

export interface RuntimeInput {
  configId: string;
  configRevision?: number | undefined;
  cwd?: string | undefined;
  interactionChannel?: string | undefined;
}
export interface RuntimeHandle {
  client: ClientRuntime;
  spec: LaunchSpec;
  secrets: string[];
  channel: string;
  operationId?: string;
  sessionId?: string;
}
export class RuntimeService {
  readonly live = new Map<string, RuntimeHandle>();
  readonly lifecycle = new Set<string>();
  readonly serial = new Serial();
  ports!: (runtimeId: string) => CallbackPorts;
  channelAvailable: (ctx: Context, channel: string) => boolean = (_ctx, channel) =>
    channel === 'none';
  validateBinding: (configId: string, path: string) => Promise<void> = async () => {};
  onClose: (runtimeId: string) => Promise<void> = async () => {};
  constructor(
    readonly store: SqliteStore,
    readonly configs: ConfigService,
    readonly operations: OperationService,
    readonly instanceId: string,
    readonly settings: Settings,
  ) {}
  async get(ctx: Context, runtimeId: string, control = false) {
    const record = await this.store.get<RuntimeRecord>('runtime', runtimeId);
    if (!record) return fail('OBJECT_NOT_FOUND', 'Runtime 不存在。');
    if (record.sessionId) {
      const session = await this.store.get<SessionRecord>('session', record.sessionId);
      if (!session) return fail('OBJECT_NOT_FOUND', '会话关联缺失。');
      access(ctx, session, control ? 'control' : 'read');
    } else if (!ctx.admin && record.ownerId !== ctx.principalId)
      fail('OBJECT_NOT_FOUND', 'Runtime 不存在或不可见。');
    return record;
  }
  handle(record: RuntimeRecord) {
    if (record.instanceId !== this.instanceId)
      fail('INSTANCE_MISMATCH', '请连接 Runtime 所属实例。');
    const handle = this.live.get(record.id);
    if (!handle || record.state === 'closed') return fail('DOWNSTREAM_EXITED', 'Runtime 已停止。');
    return handle;
  }
  guard(record: RuntimeRecord, expectedRevision: number, generation: number) {
    if (record.connectionGeneration !== generation)
      fail('RUNTIME_GENERATION_CONFLICT', 'ACP 连接代次已变化。');
    if (record.revision !== expectedRevision)
      fail('REVISION_CONFLICT', 'Runtime 修订已变化。', { currentRevision: record.revision });
  }
  async update(runtimeId: string, patch: Partial<RuntimeRecord>) {
    return this.serial.run(runtimeId, async () => {
      const old = await this.store.get<RuntimeRecord>('runtime', runtimeId);
      if (!old) return fail('OBJECT_NOT_FOUND', 'Runtime 不存在。');
      const record = { ...old, ...patch, revision: old.revision + 1 };
      await this.store.commit({
        checks: [{ kind: 'runtime', id: runtimeId, revision: old.revision }],
        puts: [row('runtime', record)],
      });
      return record;
    });
  }
  prepare(ctx: Context, args: RuntimeInput & { idempotencyKey: string }) {
    return this.operations.start(ctx, 'runtime_prepare', args, async (op, signal) =>
      this.view(await this.prepareNow(ctx, args, op, signal)),
    );
  }
  async prepareNow(
    ctx: Context,
    args: RuntimeInput,
    operationId: string,
    signal: AbortSignal,
  ): Promise<RuntimeRecord> {
    const config = await this.configs.get(args.configId, args.configRevision);
    if (!config.config.enabled) fail('CONFIG_INVALID', '注册配置已停用。');
    const requestedCwd = args.cwd ?? config.config.cwd;
    if (!requestedCwd) fail('WORKDIR_REQUIRED', '必须指定宿主工作目录。');
    if (!isAbsolute(requestedCwd)) fail('CONFIG_INVALID', '工作目录必须是绝对路径。');
    const cwd = await realpath(requestedCwd);
    if (!(await stat(cwd)).isDirectory()) fail('CONFIG_INVALID', '工作目录不是目录。');
    const channel = args.interactionChannel ?? 'none';
    if (!this.channelAvailable(ctx, channel))
      fail('INTERACTION_CHANNEL_UNAVAILABLE', '此入口没有所请求的真实交互通道。');
    const runtime: RuntimeRecord = {
      id: id('run'),
      revision: 1,
      createdAt: now(),
      instanceId: this.instanceId,
      ownerId: ctx.principalId,
      configId: config.id,
      configRevision: config.revision,
      snapshot: config.config,
      cwd,
      state: 'starting',
      connectionGeneration: 1,
      authState: 'unknown',
      expiresAt: new Date(Date.now() + this.settings.preparedTtlMs).toISOString(),
    };
    const launch = config.config.launch;
    const installation =
      launch.kind === 'installation'
        ? await this.store.get<InstallationRecord>('installation', launch.installationId)
        : null;
    if (launch.kind === 'installation' && !installation) fail('CONFIG_INVALID', '安装记录不存在。');
    const slot = {
      id: runtime.id,
      revision: 1,
      createdAt: now(),
      instanceId: this.instanceId,
      scope: 'global',
    };
    await this.store.commit({
      checks: [
        {
          kind: args.configRevision ? 'config_revision' : 'config',
          id: args.configRevision ? `${config.id}:${config.revision}` : config.id,
          revision: config.revision,
        },
        ...(installation ? [{ kind: 'installation', id: installation.id }] : []),
      ],
      puts: [row('runtime', runtime), row('runtime_slot', slot)],
      claims: [
        { key: `config:${config.id}:runtime:${runtime.id}`, holder: runtime.id },
        ...(installation
          ? [{ key: `installation:${installation.id}:runtime:${runtime.id}`, holder: runtime.id }]
          : []),
      ],
      limits: [
        {
          kind: 'runtime_slot',
          path: 'instanceId',
          value: this.instanceId,
          max: this.settings.maxRuntimes,
        },
        {
          kind: 'runtime_slot',
          path: 'scope',
          value: 'global',
          max: this.settings.maxGlobalRuntimes,
        },
      ],
    });
    await this.operations.update(operationId, { runtimeId: runtime.id });
    try {
      signal.throwIfAborted();
      const resolved = await resolveEnvironment(config.config.environment, installation?.env);
      const local = config.config.environment.values.CODEX_PATH;
      if (local) {
        const path = resolved.env.CODEX_PATH;
        if (!path) fail('LOCAL_EXECUTABLE_UNAVAILABLE', '绑定的 CODEX_PATH 无法解析。');
        await this.validateBinding(config.id, path);
        try {
          const bound = await stat(path);
          if (!bound.isFile()) throw new Error();
        } catch {
          fail(
            'LOCAL_EXECUTABLE_UNAVAILABLE',
            '绑定的 Codex 不可用；保留原配置，请重新生成复用方案。',
          );
        }
      }
      const spec: LaunchSpec = {
        executable: launch.kind === 'command' ? launch.executable : installation!.executable,
        args: [...(installation?.prefixArgs ?? []), ...(launch.args ?? installation?.args ?? [])],
        cwd,
        env: resolved.env,
      };
      const capabilities: ClientCapabilities = {
        fs: {
          readTextFile: this.settings.fileCallbacks,
          writeTextFile: this.settings.fileCallbacks,
        },
        terminal: this.settings.terminals,
        session: { configOptions: { boolean: {} } },
        ...(channel !== 'none'
          ? { elicitation: { form: {}, url: {} }, auth: { terminal: channel === 'local_cli' } }
          : {}),
      };
      const client = await ClientRuntime.start(
        spec,
        resolved.secrets,
        capabilities,
        this.ports(runtime.id),
        this.settings.initializationTimeoutMs,
        signal,
      );
      this.live.set(runtime.id, { client, spec, secrets: resolved.secrets, channel, operationId });
      if (signal.aborted) {
        await this.closeNow(runtime.id);
        throw new AppError('CANCELLED', 'Runtime 准备已取消。');
      }
      const updated = await this.update(runtime.id, {
        state: 'prepared',
        initialize: redact(client.initialize, resolved.secrets),
        pid: client.host.pid,
      });
      return updated;
    } catch (error) {
      await this.closeNow(runtime.id);
      throw error;
    }
  }
  view(record: RuntimeRecord) {
    return {
      ...record,
      runtimeId: record.id,
      runtimeRevision: record.revision,
      authMethods: (record.initialize as InitializeResponse | undefined)?.authMethods ?? [],
      launchSnapshot: record.snapshot,
    };
  }
  async closeNow(runtimeId: string) {
    const handle = this.live.get(runtimeId);
    this.live.delete(runtimeId);
    if (handle) await handle.client.close();
    const record = await this.store.get<RuntimeRecord>('runtime', runtimeId);
    if (!record || record.state === 'closed') return;
    await this.onClose(runtimeId);
    const launch = record.snapshot.launch;
    await this.store.commit({
      puts: [
        row('runtime', {
          ...record,
          state: 'closed',
          authState: 'unknown',
          revision: record.revision + 1,
        }),
      ],
      deletes: [{ kind: 'runtime_slot', id: runtimeId }],
      releases: [
        { key: `config:${record.configId}:runtime:${runtimeId}`, holder: runtimeId },
        ...(launch.kind === 'installation'
          ? [
              {
                key: `installation:${launch.installationId}:runtime:${runtimeId}`,
                holder: runtimeId,
              },
            ]
          : []),
      ],
    });
  }
  async expire() {
    for (const record of await this.store.list<RuntimeRecord>('runtime'))
      if (
        record.instanceId === this.instanceId &&
        record.state === 'prepared' &&
        Date.parse(record.expiresAt) < Date.now() &&
        !this.lifecycle.has(record.id)
      )
        await this.closeNow(record.id);
  }
  async close() {
    await Promise.allSettled([...this.live.keys()].map((runtimeId) => this.closeNow(runtimeId)));
  }
}
