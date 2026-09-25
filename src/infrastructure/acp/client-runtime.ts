import { client, ndJsonStream, RequestError } from '@agentclientprotocol/sdk';
import type {
  AgentRequestMethod,
  AgentRequestParamsByMethod,
  AgentRequestResponsesByMethod,
  ClientCapabilities,
  ClientConnection,
  ClientRequestMethod,
  ClientRequestResponsesByMethod,
  InitializeResponse,
} from '@agentclientprotocol/sdk';
import { Readable, Writable, Transform } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { AppError, fail } from '../../domain/errors.js';
import { ProcessHost } from '../platform/process-host.js';
import type { LaunchSpec } from '../platform/process-host.js';
import { redact } from '../platform/environment.js';

/** 显式限制可派发的方法集合，避免把 SDK 新增或实验性能力无意暴露为稳定接口。 */
export const stableRequests = [
  'initialize',
  'authenticate',
  'logout',
  'session/new',
  'session/load',
  'session/list',
  'session/delete',
  'session/resume',
  'session/close',
  'session/set_mode',
  'session/set_config_option',
  'session/prompt',
] as const;

/** ACP 适配器只转发协议事件，由装配层注入持久化、授权和宿主资源操作。 */
export interface CallbackPorts {
  request: (
    method: ClientRequestMethod,
    params: unknown,
    signal: AbortSignal,
    requestId: string | number | null,
  ) => Promise<unknown>;
  notify: (method: string, params: unknown) => Promise<void>;
  responded: (requestId: string | number | null) => Promise<void>;
  exited: () => Promise<void>;
}

/** 一个子进程对应一条 ACP 连接，负责消息边界、通知顺序、超时和对外结果脱敏。 */
export class ClientRuntime {
  readonly connection: ClientConnection;
  initialize!: InitializeResponse;
  private notifications: Promise<void> = Promise.resolve();
  private notificationError: unknown;

  private constructor(
    readonly host: ProcessHost,
    readonly secrets: string[],
    ports: CallbackPorts,
  ) {
    const app = client();
    const request = <M extends ClientRequestMethod>(
      method: M,
      params: unknown,
      signal: AbortSignal,
      requestId: string | number | null,
    ): Promise<ClientRequestResponsesByMethod[M]> =>
      ports.request(method, params, signal, requestId) as Promise<
        ClientRequestResponsesByMethod[M]
      >;
    app.onRequest('session/request_permission', (ctx) =>
      request('session/request_permission', ctx.params, ctx.signal, ctx.requestId),
    );
    app.onRequest('fs/read_text_file', (ctx) =>
      request('fs/read_text_file', ctx.params, ctx.signal, ctx.requestId),
    );
    app.onRequest('fs/write_text_file', (ctx) =>
      request('fs/write_text_file', ctx.params, ctx.signal, ctx.requestId),
    );
    app.onRequest('terminal/create', (ctx) =>
      request('terminal/create', ctx.params, ctx.signal, ctx.requestId),
    );
    app.onRequest('terminal/output', (ctx) =>
      request('terminal/output', ctx.params, ctx.signal, ctx.requestId),
    );
    app.onRequest('terminal/wait_for_exit', (ctx) =>
      request('terminal/wait_for_exit', ctx.params, ctx.signal, ctx.requestId),
    );
    app.onRequest('terminal/kill', (ctx) =>
      request('terminal/kill', ctx.params, ctx.signal, ctx.requestId),
    );
    app.onRequest('terminal/release', (ctx) =>
      request('terminal/release', ctx.params, ctx.signal, ctx.requestId),
    );
    app.onRequest('elicitation/create', (ctx) =>
      request('elicitation/create', ctx.params, ctx.signal, ctx.requestId),
    );
    // 顺序持久化通知；通知丢失会破坏任务结果与历史的一致性，因此失败时停止下游。
    const notification = (method: string, params: unknown) => {
      this.notifications = this.notifications
        .then(() => ports.notify(method, redact(params, secrets)))
        .catch((error: unknown) => {
          this.notificationError = error;
          void this.host.stop();
        });
      return this.notifications;
    };
    app.onNotification('session/update', (ctx) => notification('session/update', ctx.params));
    app.onNotification('elicitation/complete', (ctx) =>
      notification('elicitation/complete', ctx.params),
    );
    // NDJSON 的帧边界是换行而不是 stream chunk；跨 chunk 累计以阻止超大单条消息。
    let frameBytes = 0;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        for (const byte of chunk) {
          frameBytes = byte === 10 ? 0 : frameBytes + 1;
          if (frameBytes > 16 * 1024 ** 2) {
            callback(new AppError('PROTOCOL_ERROR', 'ACP 消息超过 16 MiB。'));
            return;
          }
        }
        callback(null, chunk);
      },
    });
    bounded.on('error', () => {
      void host.stop();
    });
    host.stdout.pipe(bounded);
    const stream = ndJsonStream(
      Writable.toWeb(host.stdin),
      Readable.toWeb(bounded) as ReadableStream<Uint8Array>,
    );
    const writer = stream.writable.getWriter();
    this.connection = app.connect({
      readable: stream.readable,
      writable: new WritableStream({
        async write(message) {
          // 只有底层 writer 接受响应后才记录 responded，不能把已决定等同于已发回。
          await writer.write(message);
          if ('id' in message && ('result' in message || 'error' in message))
            await ports.responded(message.id);
        },
        close: () => writer.close(),
        abort: (reason) => writer.abort(reason),
      }),
    });
    // 持续排空 stderr 防止子进程背压；不把可能含凭据的原始日志混入协议或结果。
    host.stderr.resume();
    void host.closed.then(() => ports.exited()).catch(() => {});
  }

  static async start(
    spec: LaunchSpec,
    secrets: string[],
    capabilities: ClientCapabilities,
    ports: CallbackPorts,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) fail('CANCELLED', '初始化在启动前已取消。');
    const runtime = new ClientRuntime(await ProcessHost.start(spec), secrets, ports);
    try {
      runtime.initialize = await runtime.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: capabilities,
          clientInfo: { name: 'agent-control-mcp', version: '1.0.0' },
        },
        timeoutMs,
        signal,
      );
      if (runtime.initialize.protocolVersion !== 1) fail('PROTOCOL_ERROR', '下游未接受 ACP v1。');
      return runtime;
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }

  /**
   * 派发后只竞争响应、取消和超时，不自动重试；终止等待无法证明下游没有产生副作用。
   * 成功返回前等待通知屏障，使当前已排队的 session/update 先完成持久化。
   */
  async request<M extends AgentRequestMethod>(
    method: M,
    params: AgentRequestParamsByMethod[M],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<AgentRequestResponsesByMethod[M]> {
    if (!(stableRequests as readonly string[]).includes(method))
      fail('CAPABILITY_UNSUPPORTED', '此方法不属于稳定 ACP 基线。');
    if (signal?.aborted) fail('CANCELLED', 'ACP 请求在派发前已取消。');
    const cancellation = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let rejectAbort: ((error: unknown) => void) | undefined;
    const onAbort = () => {
      cancellation.abort();
      rejectAbort?.(new AppError('CANCELLED', 'ACP 请求等待已取消，副作用结果可能未知。'));
    };
    try {
      const request = this.connection.agent.request(method, params, {
        cancellationSignal: cancellation.signal,
      });
      const interrupted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
        if (timeoutMs)
          timer = setTimeout(() => {
            cancellation.abort();
            reject(new AppError('TIMEOUT', 'ACP 请求超时，不能自动重试。'));
          }, timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      const result = await Promise.race([request, interrupted]);
      await this.barrier();
      return redact(result, this.secrets);
    } catch (error) {
      if (error instanceof RequestError)
        throw new AppError(
          error.code === -32000
            ? 'AUTH_REQUIRED'
            : error.code === -32601
              ? 'CAPABILITY_UNSUPPORTED'
              : 'PROTOCOL_ERROR',
          '下游返回 ACP 错误。',
          { acpCode: error.code },
        );
      if (error instanceof AppError) throw error;
      throw new AppError('DOWNSTREAM_EXITED', 'ACP 连接已结束或响应无效。');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 等待当前通知队列并传播其失败，供任务终态提交前显式同步。 */
  async barrier() {
    // SDK 逐个 await 通知路由，却同步完成响应；先排空已接收帧的分发微任务，
    // 让通知进入持久化队列。这里按事件循环阶段同步，不依赖固定毫秒延迟。
    await setImmediate();
    // 等待过程中 SDK 还可能追加已收到的通知，直到队列引用稳定才能提交终态。
    for (;;) {
      const pending = this.notifications;
      await pending;
      if (pending === this.notifications) break;
    }
    if (this.notificationError)
      throw this.notificationError instanceof Error
        ? this.notificationError
        : new AppError('PROTOCOL_ERROR', '通知处理失败。');
  }

  cancel(sessionId: string) {
    return this.connection.agent.notify('session/cancel', { sessionId });
  }

  async close() {
    this.connection.close();
    await this.host.stop();
  }
}
