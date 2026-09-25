import test from 'node:test';
import assert from 'node:assert/strict';
import type { Container } from '../../src/bootstrap/container.js';
import type { Context } from '../../src/domain/models.js';
import { AppError } from '../../src/domain/errors.js';
import { agentConfig } from '../../src/domain/schemas.js';
import { createMcpTools } from '../../src/transport/mcp/catalog.js';
import { invoke } from '../../src/transport/mcp/tools.js';

const ctx: Context = { principalId: 'alice', mode: 'stdio', serviceId: 'integration' };

/**
 * 验证管理网关沿完整调用链执行原操作的参数校验。
 *
 * @remarks
 * 使用含多余字段的注册请求，确认网关返回配置错误且业务注册函数未被调用。
 */
void test('The management gateway validates operation arguments before business execution', async (t) => {
  const register = t.mock.fn(() => Promise.resolve({ configId: 'unexpected', revision: 1 }));
  const app = {
    identities: { check: async () => {} },
    configs: { register },
  } as unknown as Container;
  const config = agentConfig.parse({
    name: 'integration',
    origin: { kind: 'manual' },
    launch: { kind: 'command', executable: 'unit-agent', args: [] },
  });
  const result = await invoke(app, createMcpTools(app, 'management'), ctx, 'management_write', {
    action: 'agent_register',
    arguments: { config, idempotencyKey: 'register', extra: true },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'CONFIG_INVALID');
  assert.equal(register.mock.callCount(), 0);
});

for (const action of ['history_get', 'history_list'] as const) {
  /**
   * 验证管理读取完成后再次检查记录移交后的访问权限。
   *
   * @remarks
   * 单条读取须拒绝已失去权限的结果，列表读取须过滤不可见记录并保留仍可见的记录。
   */
  void test('Management reads recheck access after ownership transfer: ' + action, async () => {
    let transferred = false;
    const visible = { id: 'visible-task', historyKind: 'task' };
    const hidden = { id: 'transferred-task', historyKind: 'task' };
    const app = {
      identities: { check: async () => {} },
      history: {
        get: (_ctx: Context, _kind: string, id: string) => {
          if (id === visible.id) return Promise.resolve(visible);
          if (transferred) throw new AppError('SESSION_NOT_FOUND', '已移交');
          transferred = true;
          return Promise.resolve(hidden);
        },
        list: () => {
          transferred = true;
          return Promise.resolve([hidden, visible]);
        },
      },
    } as unknown as Container;
    const result = await invoke(app, createMcpTools(app, 'management'), ctx, 'management_read', {
      action,
      arguments: action === 'history_get' ? { kind: 'task', id: hidden.id } : { kind: 'task' },
    });
    if (action === 'history_get') {
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'SESSION_NOT_FOUND');
    } else {
      assert.equal(result.ok, true);
      if (result.ok) assert.deepEqual((result.data as { items: unknown[] }).items, [visible]);
    }
  });
}
