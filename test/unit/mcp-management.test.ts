import test from 'node:test';
import assert from 'node:assert/strict';
import type { Container } from '../../src/bootstrap/container.js';
import type { Context } from '../../src/domain/models.js';
import { agentConfig } from '../../src/domain/schemas.js';
import { AppError } from '../../src/domain/errors.js';
import { createMcpTools } from '../../src/transport/mcp/catalog.js';
import { invoke } from '../../src/transport/mcp/tools.js';

const ctx: Context = { principalId: 'alice', mode: 'stdio', serviceId: 'unit' };
const config = agentConfig.parse({
  name: 'unit',
  origin: { kind: 'manual' },
  launch: { kind: 'command', executable: 'unit-agent', args: [] },
});
const args = { config, idempotencyKey: 'register' };

/**
 * 创建带有注册操作替身的管理网关调用入口。
 *
 * @param register - 注册处理函数；默认在被调用时使测试失败，用于验证提前拒绝路径。
 * @returns 最小容器和绑定测试身份的请求函数。
 */
function fixture(
  register = (_ctx: Context, _args: unknown): Promise<unknown> => {
    assert.fail('非法请求不能进入业务操作');
  },
) {
  const app = {
    identities: { check: async () => {} },
    configs: { register },
  } as unknown as Container;
  const definitions = createMcpTools(app, 'legacy');
  return {
    app,
    request: (name: string, input: unknown) => invoke(app, definitions, ctx, name, input),
  };
}

for (const [name, input, label] of [
  ['missing', {}, 'unknown tools'],
  [
    'management_read',
    { action: 'agent_register', arguments: args },
    'writes through the read gateway',
  ],
  [
    'management_write',
    { action: 'agent_remove', arguments: {} },
    'deletes through the write gateway',
  ],
  ['management_write', { action: '_identity_create', arguments: {} }, 'internal operations'],
  ['management_write', { action: 'management_write', arguments: {} }, 'recursive gateway calls'],
  [
    'management_write',
    { action: 'task_submit', arguments: {} },
    'direct tools through the management gateway',
  ],
  ['agent_register', args, 'management operations bypassing the gateway'],
] as const) {
  /**
   * 验证管理网关拒绝超出路由边界的工具与操作组合。
   *
   * @remarks
   * 默认业务替身在调用时失败，以确认非法请求在进入业务之前已被拦截。
   */
  void test('MCP gateway routing rejects ' + label, async () => {
    const result = await fixture().request(name, input);
    assert.equal(result.ok, false);
    if (result.ok) assert.fail();
    assert.equal(result.error.code, 'CONFIG_INVALID');
  });
}

/**
 * 验证管理网关向原操作传递同一身份与参数，并返回单层响应。
 *
 * @remarks
 * 业务数据保持原结构，网关元数据中仍须包含请求标识。
 */
void test('The management gateway forwards identity and arguments with a single response envelope', async () => {
  const response = { configId: 'registered', revision: 1 };
  const { request } = fixture((context, input) => {
    assert.equal(context, ctx);
    assert.deepEqual(input, args);
    return Promise.resolve(response);
  });
  const result = await request('management_write', { action: 'agent_register', arguments: args });
  assert.equal(result.ok, true);
  if (!result.ok) assert.fail();
  assert.deepEqual(result.data, response);
  assert.ok(result.meta.requestId);
});

/**
 * 验证管理网关保留业务层返回的修订冲突错误码。
 *
 * @remarks
 * 冲突不能被包装成通用错误，以便调用方识别并处理并发更新。
 */
void test('The management gateway preserves business conflict errors', async () => {
  const { request } = fixture(() => Promise.reject(new AppError('REVISION_CONFLICT', '已更新')));
  const result = await request('management_write', { action: 'agent_register', arguments: args });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'REVISION_CONFLICT');
});

/**
 * 验证管理描述返回原操作的 Schema 及其所属管理入口。
 *
 * @remarks
 * 描述读取不能执行业务操作，返回的必填项应包含原操作的幂等键。
 */
void test('Management descriptions expose the operation schema and risk category without execution', async () => {
  const result = await fixture().request('management_describe', { action: 'agent_register' });
  assert.equal(result.ok, true);
  if (!result.ok) assert.fail();
  const data = result.data as {
    action: string;
    toolName: string;
    inputSchema: { required: string[] };
  };
  assert.equal(data.action, 'agent_register');
  assert.equal(data.toolName, 'management_write');
  assert.ok(data.inputSchema.required.includes('idempotencyKey'));
});

/**
 * 验证身份检查失败时请求在业务调用前被拒绝。
 *
 * @remarks
 * 响应应保留认证失败错误码，默认业务替身用于防止意外执行。
 */
void test('Invalid identities are rejected before business operations run', async () => {
  const { app, request } = fixture();
  app.identities.check = () => Promise.reject(new AppError('UNAUTHENTICATED', '凭据失效'));
  const result = await request('management_write', { action: 'agent_register', arguments: args });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'UNAUTHENTICATED');
});
