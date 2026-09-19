import { createServer as httpServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { once } from 'node:events';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { hostHeaderValidation, toNodeHandler } from '@modelcontextprotocol/node';
import type { Container } from '../../bootstrap/container.js';
import { errorDetail, fail } from '../../domain/errors.js';
import { createServer } from './server.js';

export function startStdio(app: Container, clientId: string) {
  if (!/^[\w.-]{1,128}$/.test(clientId)) fail('CONFIG_INVALID', 'stdio 需要稳定客户端标识。');
  const ctx = {
    principalId: `stdio:${clientId}`,
    mode: 'stdio' as const,
    serviceId: app.serviceId,
  };
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 17 * 1024 ** 2,
  });
  const handle = serveStdio((request) => createServer(app, ctx, request), {
    transport,
    legacy: 'serve',
    onerror: () => {},
  });
  const end = () => {
    void app.close();
  };
  process.stdin.once('end', end);
  process.stdin.once('error', end);
  process.stdout.once('error', end);
  const previous = app.onShutdown;
  app.onShutdown = async () => {
    await handle.close();
    await previous();
  };
  return handle;
}

export interface HttpOptions {
  host: string;
  port: number;
  noAuth?: boolean;
}
export function validateHttpOptions(options: HttpOptions) {
  if (options.noAuth && !['127.0.0.1', '::1', 'localhost'].includes(options.host))
    fail('CONFIG_INVALID', '无认证 HTTP 只能监听回环地址。');
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
    fail('CONFIG_INVALID', '监听端口无效。');
}
export async function startHttp(
  app: Container,
  options: HttpOptions,
): Promise<{ server: HttpServer; url: string }> {
  validateHttpOptions(options);
  if (options.noAuth && app.settings.externalProxy)
    fail('CONFIG_INVALID', '外部代理后端必须启用令牌认证。');
  const identity = (headers: Headers) =>
    options.noAuth
      ? app.identities.registerAnonymous(headers.get('x-agent-client-id') ?? '')
      : app.identities.authenticate(headers.get('authorization') ?? undefined);
  const handler = createMcpHandler(
    async (request) => createServer(app, await identity(request.requestInfo!.headers), request),
    { legacy: 'stateless', maxSubscriptions: 64, onerror: () => {} },
  );
  const nodeHandler = toNodeHandler(handler);
  const allowedHosts = [
    ...new Set([
      'localhost',
      '127.0.0.1',
      '[::1]',
      options.host === '::1' ? '[::1]' : options.host,
      ...app.settings.allowedHosts,
    ]),
  ].filter((host) => host !== '0.0.0.0' && host !== '::');
  const checkHost = hostHeaderValidation(allowedHosts);
  const server = httpServer((req, res) => {
    void (async () => {
      if (!checkHost(req, res)) return;
      if (req.url?.split('?')[0] !== '/mcp') {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.headers.origin && !app.settings.allowedOrigins.includes(req.headers.origin)) {
        res.writeHead(403);
        res.end('Origin is not allowed');
        return;
      }
      if (options.noAuth)
        await app.identities.registerAnonymous(String(req.headers['x-agent-client-id'] ?? ''));
      else await app.identities.authenticate(req.headers.authorization);
      let body: unknown;
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const value of req) {
          const chunk = Buffer.from(value as Uint8Array);
          length += chunk.length;
          if (length > 17 * 1024 ** 2) {
            res.writeHead(413);
            res.end();
            return;
          }
          chunks.push(chunk);
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
        } catch {
          res.writeHead(400);
          res.end('Invalid JSON');
          return;
        }
      }
      await nodeHandler(req as Parameters<typeof nodeHandler>[0], res, body);
    })().catch((error: unknown) => {
      if (!res.headersSent)
        res.writeHead(errorDetail(error).code === 'UNAUTHENTICATED' ? 401 : 400, {
          'content-type': 'application/json',
        });
      res.end(JSON.stringify({ error: errorDetail(error) }));
    });
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.listen(options.port, options.host);
  await once(server, 'listening');
  const previous = app.onShutdown;
  app.onShutdown = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await handler.close();
    await previous();
  };
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP 地址不可用');
  return {
    server,
    url: `http://${options.host.includes(':') ? `[${options.host}]` : options.host}:${address.port}/mcp`,
  };
}
