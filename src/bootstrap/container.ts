import { mkdir, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk';
import { AppError, fail } from '../domain/errors.js';
import { digest, id, now } from '../domain/ids.js';
import { settingsSchema } from '../domain/schemas.js';
import type { Settings } from '../domain/schemas.js';
import type {
  Context,
  InstanceRecord,
  RuntimeRecord,
  SessionRecord,
  WorkRecord,
} from '../domain/models.js';
import { SqliteStore, row } from '../infrastructure/storage/sqlite-store.js';
import { ConfigService } from '../application/config-service.js';
import { OperationService } from '../application/operation-service.js';
import { RuntimeService } from '../application/runtime-service.js';
import { EventService } from '../application/event-service.js';
import { SessionService } from '../application/session-service.js';
import { TaskService } from '../application/task-service.js';
import { InteractionService } from '../application/interaction-service.js';
import { IdentityService } from '../application/identity-service.js';
import { AuthService } from '../application/auth-service.js';
import { RegistryClient } from '../infrastructure/registry/client.js';
import { Installer } from '../infrastructure/installers/installer.js';
import { InstallationService } from '../application/installation-service.js';
import { LocalPlanService } from '../application/local-plan-service.js';
import { HistoryService } from '../application/history-service.js';
import { TerminalManager } from '../infrastructure/platform/terminal-manager.js';
import { readText, writeText, checkedPath } from '../infrastructure/platform/file-callbacks.js';
import { recover } from '../application/recovery-service.js';
import { fingerprint } from '../adapters/local/codex.js';
import { SettingsService } from '../application/settings-service.js';

export const defaultDataDir = () =>
  process.env.AGENT_CONTROL_MCP_DATA_DIR ??
  (process.platform === 'darwin'
    ? join(homedir(), 'Library/Application Support/AgentControlMCP')
    : process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? homedir(), 'AgentControlMCP')
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'agent-control-mcp'));
export class Container {
  readonly instanceId = id('instance');
  readonly configs;
  readonly operations;
  readonly runtimes;
  readonly events;
  readonly sessions;
  readonly tasks;
  readonly interactions;
  readonly identities;
  readonly auth;
  readonly registry;
  readonly installations;
  readonly local;
  readonly history;
  readonly terminals = new TerminalManager();
  readonly admin: Context;
  readonly attachedChannels = new Set<string>();
  readonly instance: InstanceRecord;
  private timer: NodeJS.Timeout | undefined;
  private closing: Promise<void> | undefined;
  onShutdown: () => Promise<void> = async () => {};
  private constructor(
    readonly store: SqliteStore,
    readonly dataDir: string,
    readonly settings: Settings,
    readonly serviceId: string,
    cursorKey: string,
    readonly mode: Context['mode'],
  ) {
    this.admin = { principalId: 'local_admin', mode: 'cli', serviceId, admin: true };
    this.configs = new ConfigService(store, dataDir);
    this.operations = new OperationService(store, this.instanceId);
    this.runtimes = new RuntimeService(
      store,
      this.configs,
      this.operations,
      this.instanceId,
      settings,
    );
    this.events = new EventService(store, dataDir, cursorKey);
    this.sessions = new SessionService(store, this.runtimes, this.operations, this.events);
    this.tasks = new TaskService(store, this.sessions);
    this.interactions = new InteractionService(store, this.runtimes, this.tasks);
    this.identities = new IdentityService(store, serviceId);
    this.auth = new AuthService(this.runtimes, this.interactions);
    this.registry = new RegistryClient(store, settings.allowInsecureRegistry);
    this.installations = new InstallationService(
      store,
      this.registry,
      new Installer(dataDir, settings.allowInsecureRegistry),
      this.operations,
      this.configs,
      settings.maxInstallations,
    );
    this.local = new LocalPlanService(this.installations);
    this.history = new HistoryService(this.events, this.operations, this.runtimes);
    const nonce = randomBytes(32).toString('hex');
    const endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\agentcontrol-${digest(dataDir).slice(0, 12)}-${this.instanceId}`
        : join(
            tmpdir(),
            `acm-${process.getuid?.() ?? 'user'}-${digest(dataDir).slice(0, 10)}-${this.instanceId.slice(-12)}.sock`,
          );
    this.instance = {
      id: this.instanceId,
      revision: 1,
      createdAt: now(),
      mode,
      serviceId,
      pid: process.pid,
      nonce,
      endpoint,
      heartbeat: now(),
      state: 'active',
    };
    this.operations.authorize = async (ctx, operation, control) => {
      await this.identities.check(ctx);
      if (ctx.admin) return;
      if (operation.sessionId) {
        await this.sessions.get(ctx, operation.sessionId, control ? 'control' : 'read');
      } else if (operation.runtimeId) {
        await this.runtimes.get(ctx, operation.runtimeId, control);
      } else if (operation.ownerId !== ctx.principalId)
        fail('OBJECT_NOT_FOUND', '操作不存在或不可见。');
    };
    this.runtimes.validateBinding = (configId, path) => this.validateBinding(configId, path);
    this.sessions.cancelTask = (ctx, taskId) => this.tasks.cancel(ctx, taskId);
    this.tasks.cancelInteractions = (runtimeId, taskId) =>
      this.interactions.cancel(runtimeId, taskId);
    this.tasks.capacityCleanup = async () => {
      const usage = await this.history.usage(this.admin, true);
      if (usage.logicalBytes >= settings.historyMaxBytes) await this.history.retain(this.admin);
    };
    this.tasks.capacityUsage = async () =>
      (await this.history.usage(this.admin, true)).logicalBytes;
    this.runtimes.channelAvailable = (ctx, channel) =>
      channel === 'none' ||
      (channel === 'local_cli' &&
        (this.attachedChannels.has(ctx.principalId) ||
          this.attachedChannels.has(this.admin.principalId))) ||
      (channel === 'mcp_native' && ctx.nativeInteraction === true);
    this.runtimes.onClose = async (runtimeId) => {
      await this.interactions.cancel(runtimeId);
      await this.terminals.close(runtimeId);
      await this.tasks.exited(runtimeId);
      await this.sessions.ended(runtimeId);
    };
    this.runtimes.ports = (runtimeId) => ({
      request: (method, params, signal, requestId) =>
        this.callback(runtimeId, method, params, signal, requestId),
      notify: async (method, params) => {
        if (method === 'session/update')
          await this.sessions.notification(runtimeId, params as acp.SessionNotification);
        else
          await this.interactions.complete(
            runtimeId,
            (params as acp.CompleteElicitationNotification).elicitationId,
          );
      },
      responded: (requestId) => this.interactions.responded(runtimeId, requestId),
      exited: async () => {
        const current = await store.get<RuntimeRecord>('runtime', runtimeId);
        if (current && !this.runtimes.lifecycle.has(runtimeId))
          await this.runtimes.closeNow(runtimeId);
      },
    });
  }
  static async create(
    options: {
      dataDir?: string | undefined;
      mode?: Context['mode'];
      settings?: Partial<Settings>;
    } = {},
  ) {
    const path = options.dataDir ?? defaultDataDir();
    await mkdir(path, { recursive: true, mode: 0o700 });
    const dataDir = await realpath(path);
    const store = await SqliteStore.open(join(dataDir, 'state/state.db'));
    try {
      await recover(store);
      let meta = await store.get<{ serviceId: string; cursorKey: string; settings: Settings }>(
        'meta',
        'connector',
      );
      if (!meta) {
        const created = {
          id: 'connector',
          revision: 1,
          createdAt: now(),
          serviceId: id('service'),
          cursorKey: randomBytes(32).toString('hex'),
          settings: settingsSchema.parse(options.settings ?? {}),
        };
        try {
          await store.commit({
            checks: [{ kind: 'meta', id: 'connector', absent: true }],
            puts: [row('meta', created)],
          });
        } catch (error) {
          if (!(error instanceof AppError && error.code === 'REVISION_CONFLICT')) throw error;
        }
        meta = (await store.get<typeof created>('meta', 'connector'))!;
      }
      const container = new Container(
        store,
        dataDir,
        settingsSchema.parse({ ...meta.settings, ...options.settings }),
        meta.serviceId,
        meta.cursorKey,
        options.mode ?? 'cli',
      );
      await store.commit({
        puts: [row('instance', container.instance)],
        claims:
          container.mode === 'http' ? [{ key: 'http_service', holder: container.instanceId }] : [],
      });
      await container.registry.initialize();
      await new SettingsService(store, dataDir).export();
      container.timer = setInterval(() => {
        void (async () => {
          const current = await store.get<InstanceRecord>('instance', container.instanceId);
          if (current)
            await store.put('instance', {
              ...current,
              revision: current.revision + 1,
              heartbeat: now(),
            });
          await container.runtimes.expire();
        })().catch(() => {});
      }, 5000);
      container.timer.unref();
      if (container.mode !== 'cli') {
        void container.installations.updates().catch(() => {});
        void container.history.retain(container.admin).catch(() => {});
      }
      return container;
    } catch (error) {
      await store.close();
      throw error;
    }
  }
  async callback(
    runtimeId: string,
    method: acp.ClientRequestMethod,
    params: unknown,
    signal: AbortSignal,
    requestId: string | number | null,
  ): Promise<unknown> {
    const handle = this.runtimes.live.get(runtimeId);
    if (!handle) fail('DOWNSTREAM_EXITED', 'Runtime 尚未就绪。');
    if (method === 'elicitation/create') {
      const request = params as acp.CreateElicitationRequest;
      if (request.mode !== 'form' && request.mode !== 'url')
        fail('CAPABILITY_UNSUPPORTED', '不支持此交互模式。');
      return this.interactions.open(runtimeId, request.mode, request, signal, requestId);
    }
    const session = handle.sessionId
      ? await this.store.get<SessionRecord>('session', handle.sessionId)
      : null;
    if (!session) fail('SESSION_NOT_FOUND', '回调尚未关联会话。');
    const request = params as { sessionId: string };
    if (session.downstreamSessionId && request.sessionId !== session.downstreamSessionId)
      fail('SESSION_NOT_FOUND', '回调会话不匹配。');
    const roots = [session.cwd, ...session.additionalDirectories];
    switch (method) {
      case 'session/request_permission':
        return this.interactions.permission(
          runtimeId,
          params as acp.RequestPermissionRequest,
          signal,
          requestId,
        );
      case 'fs/read_text_file': {
        if (!this.settings.fileCallbacks) fail('CAPABILITY_UNSUPPORTED', '文件回调已禁用。');
        const request = params as acp.ReadTextFileRequest;
        await checkedPath(request.path, roots);
        await this.interactions.host(
          runtimeId,
          { operation: 'read', paths: [request.path] },
          signal,
        );
        return readText(request.path, roots, request.line, request.limit);
      }
      case 'fs/write_text_file': {
        if (!this.settings.fileCallbacks) fail('CAPABILITY_UNSUPPORTED', '文件回调已禁用。');
        const request = params as acp.WriteTextFileRequest;
        await checkedPath(request.path, roots, true);
        await this.interactions.host(
          runtimeId,
          { operation: 'write', paths: [request.path] },
          signal,
        );
        return writeText(request.path, request.content, roots);
      }
      case 'terminal/create': {
        if (!this.settings.terminals) fail('CAPABILITY_UNSUPPORTED', '终端已禁用。');
        return this.terminals.create(
          runtimeId,
          params as acp.CreateTerminalRequest,
          handle.spec.env,
          roots,
          (description) => this.interactions.host(runtimeId, description, signal),
        );
      }
      case 'terminal/output':
        return this.terminals.output(runtimeId, (params as acp.TerminalOutputRequest).terminalId);
      case 'terminal/wait_for_exit':
        return this.terminals.wait(
          runtimeId,
          (params as acp.WaitForTerminalExitRequest).terminalId,
          signal,
        );
      case 'terminal/kill':
        return this.terminals.kill(runtimeId, (params as acp.KillTerminalRequest).terminalId);
      case 'terminal/release':
        return this.terminals.release(runtimeId, (params as acp.ReleaseTerminalRequest).terminalId);
    }
  }
  async validateBinding(configId: string, path: string) {
    const binding = await this.store.get<{ candidate: { path: string; fingerprint: string } }>(
      'local_binding',
      configId,
    );
    if (
      binding?.candidate.path === path &&
      (await fingerprint(path)) !== binding.candidate.fingerprint
    )
      fail('LOCAL_EXECUTABLE_UNAVAILABLE', '绑定的 Codex 文件已改变，请重新生成方案。');
  }
  close() {
    this.closing ??= this.shutdown();
    return this.closing;
  }
  private async shutdown() {
    clearInterval(this.timer);
    for (const task of await this.store.list<WorkRecord>('task'))
      if (
        task.instanceId === this.instanceId &&
        ['accepted', 'running', 'waiting_interaction'].includes(task.state)
      )
        await this.tasks.cancel(this.admin, task.id).catch(() => {});
    await this.runtimes.close();
    await this.installations.close();
    await this.operations.close();
    await this.tasks.close();
    await this.onShutdown();
    const instance = await this.store.get<InstanceRecord>('instance', this.instanceId);
    if (instance)
      await this.store.commit({
        puts: [row('instance', { ...instance, revision: instance.revision + 1, state: 'stopped' })],
        releases: [{ key: 'http_service', holder: this.instanceId }],
      });
    await this.store.close();
  }
}
