import { RequestError } from '@agentclientprotocol/sdk';
import type { CreateTerminalRequest, TerminalOutputResponse } from '@agentclientprotocol/sdk';
import { StringDecoder } from 'node:string_decoder';
import { AppError, fail } from '../../domain/errors.js';
import { id } from '../../domain/ids.js';
import { checkedPath } from './file-callbacks.js';
import { ProcessHost } from './process-host.js';
import type { LaunchSpec } from './process-host.js';
import { normalizeEnvironment } from './environment.js';
import type { OperationDescription } from '../../domain/permission-policy.js';

type TerminalHost = Pick<
  ProcessHost,
  'stdout' | 'stderr' | 'closed' | 'stop' | 'exitCode' | 'exitSignal'
>;

interface Terminal {
  id: string;
  runtimeId: string;
  host: TerminalHost;
  output: string;
  bytes: number;
  limit: number;
  discarded: number;
  decoder: StringDecoder;
}

interface PendingTerminal {
  runtimeId: string;
  controller: AbortController;
  finished: Promise<void>;
}

/** 管理 ACP 创建的命令进程及有限输出缓存；所有查询均绑定原 Runtime，不能跨连接使用。 */
export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>();
  private readonly pending = new Set<PendingTerminal>();
  private readonly closing = new Map<string, Promise<void>>();

  constructor(
    private readonly platform: {
      checkedPath: typeof checkedPath;
      start: (spec: LaunchSpec) => Promise<TerminalHost>;
    } = { checkedPath, start: (spec) => ProcessHost.start(spec) },
  ) {}

  async create(
    runtimeId: string,
    request: CreateTerminalRequest,
    env: NodeJS.ProcessEnv,
    roots: string[],
    authorize: (description: OperationDescription, signal: AbortSignal) => Promise<void>,
  ) {
    if (this.closing.has(runtimeId)) fail('DOWNSTREAM_EXITED', 'Runtime 正在关闭。');
    const occupied = [...this.terminals.values(), ...this.pending];
    if (
      occupied.length >= 16 ||
      occupied.filter((terminal) => terminal.runtimeId === runtimeId).length >= 4
    )
      fail('CAPACITY_EXCEEDED', '已达到终端数量上限。');
    let finish!: () => void;
    const pending: PendingTerminal = {
      runtimeId,
      controller: new AbortController(),
      finished: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    // 首个 await 前预约容量，路径检查、审批和进程启动都计入同一预算。
    this.pending.add(pending);
    const { signal } = pending.controller;
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason as AppError);
      signal.addEventListener('abort', abort, { once: true });
    });
    let host: TerminalHost | undefined;
    try {
      const command = {
        executable: request.command,
        args: [...(request.args ?? [])],
        env: normalizeEnvironment(
          Object.fromEntries((request.env ?? []).map((entry) => [entry.name, entry.value])),
        ),
      };
      // 审批只包含请求覆盖项；实际环境在等待审批前快照，不公开宿主继承值。
      const targetEnv = { ...normalizeEnvironment(env), ...command.env };
      const cwd = await Promise.race([
        this.platform.checkedPath(request.cwd ?? roots[0]!, roots),
        cancelled,
      ]);
      signal.throwIfAborted();
      await Promise.race([
        authorize({ operation: 'execute', paths: [cwd], command }, signal),
        cancelled,
      ]);
      signal.throwIfAborted();
      // 启动后不能直接放弃 Promise：关闭必须等句柄返回，再回收尚未发布的进程。
      host = await this.platform.start({
        executable: command.executable,
        args: command.args,
        cwd,
        env: targetEnv,
      });
      signal.throwIfAborted();
      const terminal: Terminal = {
        id: id('term'),
        runtimeId,
        host,
        output: '',
        bytes: 0,
        limit: Math.min(request.outputByteLimit ?? 1024 ** 2, 8 * 1024 ** 2),
        discarded: 0,
        decoder: new StringDecoder('utf8'),
      };
      // stdout/stderr 共用字节预算；StringDecoder 处理 chunk 边界上的 UTF-8 半个字符。
      const append = (chunk: Buffer) => {
        const available = Math.max(0, terminal.limit - terminal.bytes);
        const accepted = chunk.subarray(0, available);
        terminal.output += terminal.decoder.write(accepted);
        terminal.bytes += accepted.length;
        terminal.discarded += chunk.length - accepted.length;
      };
      host.stdout.on('data', append);
      host.stderr.on('data', append);
      this.terminals.set(terminal.id, terminal);
      host = undefined;
      return { terminalId: terminal.id };
    } finally {
      try {
        if (host) await host.stop();
      } finally {
        signal.removeEventListener('abort', abort);
        this.pending.delete(pending);
        finish();
      }
    }
  }

  private get(runtimeId: string, terminalId: string) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.runtimeId !== runtimeId)
      return fail('OBJECT_NOT_FOUND', '终端不存在或不属于此 Runtime。');
    return terminal;
  }

  output(runtimeId: string, terminalId: string): TerminalOutputResponse {
    const terminal = this.get(runtimeId, terminalId);
    return {
      output: terminal.output,
      truncated: terminal.discarded > 0,
      ...(terminal.host.exitCode !== null || terminal.host.exitSignal
        ? { exitStatus: { exitCode: terminal.host.exitCode, signal: terminal.host.exitSignal } }
        : {}),
    };
  }

  /** 取消只终止本次等待，命令仍运行；终止命令或释放资源需调用 kill/release。 */
  async wait(runtimeId: string, terminalId: string, signal: AbortSignal) {
    const terminal = this.get(runtimeId, terminalId);
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        terminal.host.closed,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(RequestError.requestCancelled());
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
      return { exitCode: terminal.host.exitCode, signal: terminal.host.exitSignal };
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
    }
  }

  async kill(runtimeId: string, terminalId: string) {
    await this.get(runtimeId, terminalId).host.stop();
    return {};
  }

  async release(runtimeId: string, terminalId: string) {
    await this.kill(runtimeId, terminalId);
    this.terminals.delete(terminalId);
    return {};
  }

  close(runtimeId: string) {
    const previous = this.closing.get(runtimeId);
    if (previous) return previous;
    // 先同步阻止新预约，再取消在途创建；关闭完成后不保留无界的 Runtime 墓碑。
    const closing = Promise.resolve()
      .then(async () => {
        const pending = [...this.pending].filter((item) => item.runtimeId === runtimeId);
        for (const item of pending)
          item.controller.abort(
            new AppError('DOWNSTREAM_EXITED', 'Runtime 关闭，终端创建已取消。'),
          );
        await Promise.allSettled([
          ...pending.map((item) => item.finished),
          ...[...this.terminals.values()]
            .filter((terminal) => terminal.runtimeId === runtimeId)
            .map((terminal) => this.release(runtimeId, terminal.id)),
        ]);
      })
      .finally(() => this.closing.delete(runtimeId));
    this.closing.set(runtimeId, closing);
    return closing;
  }
}
