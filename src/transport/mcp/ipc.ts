import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { chmod } from 'node:fs/promises';
import { once } from 'node:events';
import { timingSafeEqual } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { Container } from '../../bootstrap/container.js';
import { id } from '../../domain/ids.js';
import { AppError, errorDetail, fail } from '../../domain/errors.js';
import {
  handshakeMaxBytes,
  handshakeTimeoutMs,
  mcpMaxBytes,
  validateHandshake,
  ipcVersion,
} from '../../infrastructure/service/protocol.js';
import type { ServiceDescriptor } from '../../infrastructure/service/protocol.js';
import type { Toolset } from './catalog.js';
import { createServer as createMcpServer } from './server.js';

/** 只消费握手首行；把同一 chunk 的剩余字节原样放回，保留 UTF-8 分片。 */
export function readHandshake(socket: Socket, timeoutMs = handshakeTimeoutMs): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer);
      socket.removeListener('readable', read);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      if (error) reject(error);
      else resolve(value);
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new AppError('INSTANCE_UNAVAILABLE', '握手连接已关闭。'));
    const read = () => {
      let chunk: Buffer | null;
      while ((chunk = socket.read() as Buffer | null)) {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf(10);
        if (end >= 0) {
          if (end + 1 > handshakeMaxBytes) {
            finish(new AppError('IPC_HANDSHAKE_INVALID', '握手过大。'));
            return;
          }
          try {
            const value = JSON.parse(buffer.subarray(0, end).toString('utf8')) as unknown;
            const remainder = buffer.subarray(end + 1);
            if (remainder.length) socket.unshift(remainder);
            finish(undefined, value);
          } catch {
            finish(new AppError('IPC_HANDSHAKE_INVALID', '握手不是有效 JSON。'));
          }
          return;
        }
        if (buffer.length > handshakeMaxBytes) {
          finish(new AppError('IPC_HANDSHAKE_INVALID', '握手过大。'));
          return;
        }
      }
    };
    const timer = setTimeout(
      () => finish(new AppError('TIMEOUT', '执行服务认证超时。')),
      timeoutMs,
    );
    socket.on('readable', read);
    socket.once('error', onError);
    socket.once('close', onClose);
    read();
  });
}

/** 普通 MCP 端点独立认证，不能取得管理员上下文；每个连接使用原有 SDK 工厂。 */
export async function startMcpIpc(app: Container, endpoint: string, token: string) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    void (async () => {
      const h = validateHandshake(await readHandshake(socket));
      const actual = Buffer.from(h.token),
        expected = Buffer.from(token);
      if (
        h.instanceId !== app.instanceId ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        fail('UNAUTHENTICATED', '执行服务凭证或实例身份无效。');
      if (!isAbsolute(h.startupCwd)) fail('IPC_HANDSHAKE_INVALID', '启动目录必须为绝对路径。');
      const lease = app.activity!.lifecycle.acquire('connection', 'stdio');
      const connectionId = id('connection');
      const ctx = {
        principalId: `stdio:${h.clientId}`,
        mode: 'stdio' as const,
        serviceId: app.serviceId,
        connectionId,
        startupCwd: h.startupCwd,
      };
      app.channels.register(connectionId, ctx.principalId);
      socket.write(
        JSON.stringify({ ok: true, version: ipcVersion, instanceId: app.instanceId }) + '\n',
      );
      const transport = new StdioServerTransport(socket, socket, { maxBufferSize: mcpMaxBytes });
      const handle = serveStdio((request) => createMcpServer(app, ctx, request, h.toolset), {
        transport,
        legacy: 'serve',
        onerror: () => socket.destroy(),
      });
      const transportClose = transport.onclose;
      transport.onclose = () => {
        transportClose?.();
        socket.destroy();
      };
      socket.once('close', () => {
        lease.release();
        app.channels.remove(connectionId);
        void handle.close().catch(() => {});
      });
      // readHandshake 使用 readable 模式，SDK 在 data 模式接收完整 MCP 字节流。
      socket.resume();
    })().catch((error: unknown) => {
      if (!socket.destroyed)
        socket.end(JSON.stringify({ ok: false, error: errorDetail(error) }) + '\n');
    });
  });
  server.listen(endpoint);
  await once(server, 'listening');
  if (process.platform !== 'win32') await chmod(endpoint, 0o600);
  const previous = app.onShutdown;
  app.onShutdown = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await previous();
  };
}

export async function connectMcpIpc(
  descriptor: ServiceDescriptor,
  token: string,
  clientId: string,
  toolset: Toolset,
  startupCwd: string,
  timeoutMs = handshakeTimeoutMs,
) {
  const socket = createConnection(descriptor.endpoint);
  socket.on('error', () => {});
  try {
    const response = readHandshake(socket, timeoutMs);
    socket.once('connect', () =>
      socket.write(
        JSON.stringify({
          version: ipcVersion,
          instanceId: descriptor.instanceId,
          token,
          clientId,
          toolset,
          startupCwd,
        }) + '\n',
      ),
    );
    const ack = (await response) as {
      ok: boolean;
      instanceId?: string;
      version?: number;
      error?: { code: string; message: string };
    };
    if (!ack.ok)
      throw new AppError(ack.error?.code ?? 'UNAUTHENTICATED', ack.error?.message ?? '握手失败。');
    if (ack.instanceId !== descriptor.instanceId || ack.version !== ipcVersion)
      fail('IPC_VERSION_MISMATCH', '执行服务响应身份或版本不符。');
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
