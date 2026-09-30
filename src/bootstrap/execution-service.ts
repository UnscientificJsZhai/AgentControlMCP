import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Container } from './container.js';
import type { StoragePaths } from '../infrastructure/storage/paths.js';
import type { Settings } from '../domain/schemas.js';
import { digest } from '../domain/ids.js';
import { AppError, errorDetail, fail } from '../domain/errors.js';
import { startMcpIpc } from '../transport/mcp/ipc.js';
import { startAdmin } from '../transport/admin/ipc.js';
import { startHttp, validateHttpOptions } from '../transport/mcp/serve.js';
import type { HttpOptions } from '../transport/mcp/serve.js';
import { Serial } from '../application/common.js';
import {
  publishDescriptor,
  removeDescriptor,
  serviceBuildId,
} from '../infrastructure/service/discovery.js';

const httpSchema = z.strictObject({
  host: z.string().min(1),
  port: z.number().int().min(0).max(65535),
  noAuth: z.boolean().optional(),
  toolset: z.enum(['collaboration', 'legacy', 'management']).optional(),
});

/** 一个执行者持有 Container、所有传输与统一生命周期，HTTP 接管只改变监听和运行策略。 */
export class ExecutionService {
  private readonly serial = new Serial();
  private http: { options: HttpOptions; url: string } | undefined;
  private httpError: ReturnType<typeof errorDetail> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closing: Promise<void> | undefined;
  private readonly closeContainer: () => Promise<void>;
  private readonly signal = () => {
    void this.close().catch(() => {
      process.exitCode = 1;
    });
  };
  private constructor(readonly app: Container) {
    this.closeContainer = app.close.bind(app);
    app.close = () => this.close();
    app.ensureHttp = (options) => this.ensureHttp(httpSchema.parse(options));
    app.serviceStatus = () => this.status();
  }
  static async start(options: {
    paths: StoragePaths;
    settings?: Settings;
    source: 'auto_stdio' | 'manual_http';
    http?: HttpOptions;
  }) {
    const app = await Container.create({
      paths: options.paths,
      mode: 'http',
      ...(options.settings ? { settings: options.settings } : {}),
      executionService: { source: options.source },
    });
    const service = new ExecutionService(app);
    const token = randomBytes(32).toString('hex');
    const endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\acm-mcp-${digest(app.paths.databasePath).slice(0, 12)}-${app.instanceId}`
        : join(app.paths.runtimeDir, 'mcp.sock');
    try {
      const http = options.http ?? {
        host: app.settings.httpHost,
        port: app.settings.httpPort,
        noAuth: app.settings.httpAuth === 'none',
        toolset: 'collaboration',
      };
      validateHttpOptions(http);
      if (http.noAuth && app.settings.externalProxy)
        fail('CONFIG_INVALID', '外部代理后端必须启用令牌认证。');
      await startAdmin(app);
      await startMcpIpc(app, endpoint, token);
      try {
        await service.bindHttp(http);
      } catch (error) {
        if (options.source === 'manual_http') throw error;
        service.httpError = errorDetail(
          new AppError('HTTP_UNAVAILABLE', '配置的 HTTP 地址绑定失败；IPC 继续服务。', {
            code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN',
          }),
        );
      }
      app.activity!.lifecycle.ready();
      app.instance.phase = 'ready';
      await app.store.put('instance', { ...app.instance, revision: 2 });
      await publishDescriptor(
        app.paths,
        {
          version: 1,
          buildId: await serviceBuildId(),
          instanceId: app.instanceId,
          serviceId: app.serviceId,
          pid: process.pid,
          databasePath: app.paths.databasePath,
          endpoint,
          adminEndpoint: app.instance.endpoint,
          credentialPath: join(app.paths.runtimeDir, 'service-credentials.json'),
          settingsDigest: digest(app.settings),
          settings: app.settings,
        },
        token,
        app.instance.nonce,
      );
      const previous = app.onShutdown;
      app.onShutdown = async () => {
        await removeDescriptor(app.paths, app.instanceId);
        await previous();
      };
      service.timer = setInterval(
        () => {
          if (app.activity!.lifecycle.beginDrain()) service.signal();
        },
        Math.min(1000, Math.max(10, app.settings.serviceIdleTimeoutMs || 1000)),
      );
      service.timer.unref();
      process.once('SIGINT', service.signal);
      process.once('SIGTERM', service.signal);
      return service;
    } catch (error) {
      await service.close();
      throw error;
    }
  }
  private async bindHttp(options: HttpOptions) {
    const effective = {
      ...options,
      noAuth: options.noAuth ?? false,
      toolset: options.toolset ?? 'collaboration',
    };
    const endpoint = await startHttp(this.app, effective);
    this.http = { options: effective, url: endpoint.url };
    this.httpError = undefined;
  }
  async ensureHttp(options: HttpOptions) {
    return this.serial.run('http', async () => {
      const lease = this.app.activity!.lifecycle.acquire('work', 'http_takeover');
      try {
        if (this.app.activity!.lifecycle.phase !== 'ready')
          fail('SERVICE_DRAINING', '服务不能接管 HTTP。');
        const effective = {
          ...options,
          noAuth: options.noAuth ?? false,
          toolset: options.toolset ?? 'collaboration',
        };
        validateHttpOptions(effective);
        if (this.http && digest(this.http.options) !== digest(effective))
          fail('SERVICE_HTTP_CONFLICT', '已有 HTTP 监听参数不同，不能重绑活动监听。');
        if (!this.http) await this.bindHttp(effective);
        // 只有绑定/复用成功后才保存持久运行策略，失败时原策略保持。
        const current = await this.app.store.get<typeof this.app.instance>(
          'instance',
          this.app.instanceId,
        );
        await this.app.store.put('instance', {
          ...current!,
          revision: current!.revision + 1,
          lifecyclePolicy: 'persistent',
        });
        this.app.activity!.lifecycle.persist();
        return this.status();
      } finally {
        lease.release();
      }
    });
  }
  status() {
    const instance: Partial<typeof this.app.instance> = { ...this.app.instance };
    delete instance.nonce;
    const snapshot = this.app.activity!.lifecycle.snapshot();
    return {
      ...instance,
      ...snapshot,
      idleDeadline:
        snapshot.idleRemainingMs === null
          ? null
          : new Date(Date.now() + snapshot.idleRemainingMs).toISOString(),
      http: this.http
        ? { available: true, ...this.http }
        : { available: false, error: this.httpError },
    };
  }
  close() {
    this.closing ??= this.shutdown();
    return this.closing;
  }
  private async shutdown() {
    this.app.activity!.lifecycle.beginDrain(true);
    clearInterval(this.timer);
    process.removeListener('SIGINT', this.signal);
    process.removeListener('SIGTERM', this.signal);
    const timeout = setTimeout(() => {
      // 退出服务会关闭监督控制管道/Job，所属进程树由现有 ProcessHost 清理；记录留待恢复。
      process.stderr.write(
        JSON.stringify({
          error: { code: 'SERVICE_SHUTDOWN_TIMEOUT', message: '停机宽限耗尽，强制退出执行服务。' },
        }) + '\n',
      );
      process.exit(1);
    }, this.app.settings.serviceShutdownTimeoutMs);
    try {
      const current = await this.app.store.get<typeof this.app.instance>(
        'instance',
        this.app.instanceId,
      );
      if (current)
        await this.app.store.put('instance', {
          ...current,
          revision: current.revision + 1,
          phase: 'draining',
        });
    } catch {
      /* 存储不可用也必须继续清理；不可落盘记录留给恢复。 */
    }
    // 仅在清理成功后撤销强退出计时器，失败不能留下永久 draining 的活动执行者。
    await this.closeContainer();
    clearTimeout(timeout);
  }
}
