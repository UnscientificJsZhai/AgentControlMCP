import { RequestError } from '@agentclientprotocol/sdk';
import type { CreateTerminalRequest, TerminalOutputResponse } from '@agentclientprotocol/sdk';
import { StringDecoder } from 'node:string_decoder';
import { fail } from '../../domain/errors.js';
import { id } from '../../domain/ids.js';
import { checkedPath } from './file-callbacks.js';
import { ProcessHost } from './process-host.js';
import type { OperationDescription } from '../../domain/permission-policy.js';

interface Terminal {
  id: string;
  runtimeId: string;
  host: ProcessHost;
  output: string;
  bytes: number;
  limit: number;
  discarded: number;
  decoder: StringDecoder;
}
export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>();
  async create(
    runtimeId: string,
    request: CreateTerminalRequest,
    env: NodeJS.ProcessEnv,
    roots: string[],
    authorize: (description: OperationDescription) => Promise<void>,
  ) {
    if (
      this.terminals.size >= 16 ||
      [...this.terminals.values()].filter((terminal) => terminal.runtimeId === runtimeId).length >=
        4
    )
      fail('CAPACITY_EXCEEDED', '已达到终端数量上限。');
    const cwd = await checkedPath(request.cwd ?? roots[0]!, roots);
    await authorize({
      operation: 'execute',
      paths: [cwd],
      command: { executable: request.command, args: request.args ?? [] },
    });
    const host = await ProcessHost.start({
      executable: request.command,
      args: request.args ?? [],
      cwd,
      env: {
        ...env,
        ...Object.fromEntries((request.env ?? []).map((entry) => [entry.name, entry.value])),
      },
    });
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
    return { terminalId: terminal.id };
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
  async close(runtimeId: string) {
    await Promise.allSettled(
      [...this.terminals.values()]
        .filter((terminal) => terminal.runtimeId === runtimeId)
        .map((terminal) => this.release(runtimeId, terminal.id)),
    );
  }
}
