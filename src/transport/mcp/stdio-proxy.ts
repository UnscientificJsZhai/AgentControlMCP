import type { Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { AppError } from '../../domain/errors.js';

/** 透明字节转发，pipe 负责背压；仅关闭通信，不重连、不改写请求 ID、不重放。 */
export function proxyStdio(
  socket: Socket,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
) {
  return new Promise<void>((resolve, reject) => {
    let ended = false;
    const cleanup = () => {
      input.unpipe(socket);
      socket.unpipe(output);
      input.removeListener('end', eof);
      input.removeListener('error', broken);
      output.removeListener('error', broken);
      socket.removeListener('error', broken);
      process.removeListener('SIGINT', eof);
      process.removeListener('SIGTERM', eof);
      input.pause();
      socket.destroy();
    };
    const eof = () => {
      if (ended) return;
      ended = true;
      cleanup();
      resolve();
    };
    const broken = () => {
      if (ended) return;
      ended = true;
      cleanup();
      reject(new AppError('INSTANCE_UNAVAILABLE', '执行服务 IPC 异常断开。'));
    };
    input.once('end', eof);
    input.once('error', broken);
    output.once('error', broken);
    socket.once('error', broken);
    socket.once('end', broken);
    socket.once('close', () => {
      if (!ended) broken();
    });
    process.once('SIGINT', eof);
    process.once('SIGTERM', eof);
    socket.pipe(output, { end: false });
    input.pipe(socket, { end: false });
    socket.resume();
    if (input.readableEnded) eof();
    else if (socket.destroyed) broken();
  });
}
