import type { Socket } from 'node:net';
import { createConnection, createServer } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Container } from '../../bootstrap/container.js';
import type { InstanceRecord } from '../../domain/models.js';
import { errorDetail, AppError } from '../../domain/errors.js';
import { adminCommand } from './commands.js';

interface Message {
  nonce: string;
  name: string;
  args: unknown;
  attach?: boolean;
  presentationSession?: string;
}
export async function startAdmin(app: Container) {
  const sockets = new Set<Socket>();
  const presentationSessions = new Set<string>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    let busy = false;
    let attached: string | undefined;
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      if (attached) {
        presentationSessions.delete(attached);
        if (!presentationSessions.size) app.attachedChannels.delete(app.admin.principalId);
      }
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 17 * 1024 ** 2) {
        socket.destroy();
        return;
      }
      if (busy || !buffer.includes('\n')) return;
      busy = true;
      void (async () => {
        const message = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as Message;
        const actual = Buffer.from(String(message.nonce));
        const expected = Buffer.from(app.instance.nonce);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
          throw new AppError('UNAUTHENTICATED', '管理端点凭证无效。');
        if (message.attach) {
          attached = randomBytes(32).toString('base64url');
          presentationSessions.add(attached);
          app.attachedChannels.add(app.admin.principalId);
          socket.write(
            JSON.stringify({ ok: true, data: { attached: true, presentationSession: attached } }) +
              '\n',
          );
          return;
        }
        const data = await adminCommand(
          app,
          message.name,
          message.args,
          app.admin,
          !!message.presentationSession && presentationSessions.has(message.presentationSession),
        );
        socket.end(JSON.stringify({ ok: true, data }) + '\n');
      })().catch((error: unknown) =>
        socket.end(JSON.stringify({ ok: false, error: errorDetail(error) }) + '\n'),
      );
    });
  });
  server.listen(app.instance.endpoint);
  await once(server, 'listening');
  if (process.platform !== 'win32') await chmod(app.instance.endpoint, 0o600);
  const previous = app.onShutdown;
  app.onShutdown = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== 'win32') await unlink(app.instance.endpoint).catch(() => {});
    await previous();
  };
}

export function adminRequest(
  instance: InstanceRecord,
  name: string,
  args: unknown,
  attach = false,
  presentationSession?: string,
): Promise<{ data: unknown; close: () => void }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(instance.endpoint);
    let buffer = '';
    let received = false;
    socket.setTimeout(35_000, () => socket.destroy(new AppError('TIMEOUT', '管理请求超时。')));
    socket.once('connect', () =>
      socket.write(
        JSON.stringify({ nonce: instance.nonce, name, args, attach, presentationSession }) + '\n',
      ),
    );
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 17 * 1024 ** 2) {
        socket.destroy(new Error('管理响应过大'));
        return;
      }
      if (!buffer.includes('\n') || received) return;
      received = true;
      try {
        const response = JSON.parse(buffer) as {
          ok: boolean;
          data: unknown;
          error?: { code: string; message: string };
        };
        if (!response.ok) reject(new AppError(response.error!.code, response.error!.message));
        else {
          socket.setTimeout(0);
          resolve({ data: response.data, close: () => socket.destroy() });
        }
      } catch (error) {
        reject(error instanceof Error ? error : new Error('无效管理响应'));
      }
    });
    socket.on('error', reject);
    socket.once('close', () => {
      if (!received) reject(new AppError('INSTANCE_UNAVAILABLE', '所属实例未响应。'));
    });
  });
}
