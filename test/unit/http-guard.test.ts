import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { httpRequestGuard } from '../../src/transport/mcp/serve.js';

for (const scenario of [
  { name: 'rejects an untrusted Host', host: 'evil.example', status: 403 },
  { name: 'rejects a missing Host', status: 403 },
  { name: 'rejects a wildcard Host on a wildcard listener', host: '0.0.0.0', status: 403 },
  {
    name: 'rejects an untrusted Origin',
    host: 'localhost',
    origin: 'https://evil.example',
    status: 403,
  },
  { name: 'returns 404 for non-MCP paths', host: 'localhost', url: '/other', status: 404 },
  { name: 'allows a loopback address with a port', host: '127.0.0.1:7331' },
  { name: 'allows an IPv6 loopback address', host: '[::1]:7331' },
  {
    name: 'allows explicitly configured Host and Origin values',
    host: 'mcp.example',
    origin: 'https://app.example',
  },
  { name: 'allows MCP query parameters', host: 'localhost', url: '/mcp?session=1' },
]) {
  /**
   * 验证 HTTP 入口按路径、Host 和 Origin 判断是否放行。
   *
   * @remarks
   * 拒绝请求时必须写入对应状态码并结束响应，合法请求则交由后续处理。
   */
  void test('HTTP request guard ' + scenario.name, () => {
    let status: number | undefined;
    let ended = false;
    const request = {
      url: scenario.url ?? '/mcp',
      headers: {
        ...(scenario.host ? { host: scenario.host } : {}),
        ...(scenario.origin ? { origin: scenario.origin } : {}),
      },
    } as IncomingMessage;
    const response = {
      writeHead: (code: number) => {
        status = code;
      },
      end: () => {
        ended = true;
      },
    } as unknown as ServerResponse;
    const guard = httpRequestGuard(
      { host: '0.0.0.0', port: 7331 },
      {
        allowedHosts: ['mcp.example'],
        allowedOrigins: ['https://app.example'],
      },
    );
    assert.equal(guard(request, response), scenario.status === undefined);
    assert.equal(status, scenario.status);
    assert.equal(ended, scenario.status !== undefined);
  });
}
