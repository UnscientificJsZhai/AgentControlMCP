import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHttpOptions } from '../../src/transport/mcp/serve.js';

/**
 * 验证匿名 HTTP 仅允许监听回环地址。
 *
 * @remarks
 * IPv4、IPv6 和 localhost 均覆盖；启用认证后才允许非回环监听地址。
 */
void test('Anonymous HTTP requires loopback addresses while authenticated HTTP allows other hosts', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost'])
    assert.doesNotThrow(() => validateHttpOptions({ host, port: 0, noAuth: true }));
  assert.throws(() => validateHttpOptions({ host: '0.0.0.0', port: 7331, noAuth: true }), {
    code: 'CONFIG_INVALID',
  });
  assert.doesNotThrow(() => validateHttpOptions({ host: '0.0.0.0', port: 7331 }));
});

/**
 * 验证 HTTP 端口接受合法边界值并拒绝非法数字。
 *
 * @remarks
 * 包含端口零和最大端口，以及负数、越界值、小数和非数值。
 */
void test('HTTP ports accept boundary values and reject out-of-range or non-integer inputs', () => {
  for (const port of [0, 65535])
    assert.doesNotThrow(() => validateHttpOptions({ host: '127.0.0.1', port }));
  for (const port of [-1, 65536, 0.5, NaN])
    assert.throws(() => validateHttpOptions({ host: '127.0.0.1', port }), {
      code: 'CONFIG_INVALID',
    });
});
