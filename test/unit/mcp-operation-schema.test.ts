import test from 'node:test';
import assert from 'node:assert/strict';
import type { Container } from '../../src/bootstrap/container.js';
import { agentConfig } from '../../src/domain/schemas.js';
import { createTools } from '../../src/transport/mcp/tools.js';

const config = agentConfig.parse({
  name: 'unit',
  origin: { kind: 'manual' },
  launch: { kind: 'command', executable: 'unit-agent', args: [] },
});
const register = createTools({} as Container).find((tool) => tool.name === 'agent_register')!;

/**
 * 验证 Agent 注册契约接受完整配置和幂等键。
 *
 * @remarks
 * 解析结果应与输入一致，确保有效参数不会被意外丢弃或重写。
 */
void test('Agent registration accepts a complete configuration and an idempotency key', () => {
  const args = { config, idempotencyKey: 'register' };
  assert.deepEqual(register.schema.parse(args), args);
});

for (const { label, input, code, path } of [
  {
    label: 'extra arguments',
    input: { config, idempotencyKey: 'register', extra: true },
    code: 'unrecognized_keys',
    path: [],
  },
  {
    label: 'a missing idempotency key',
    input: { config },
    code: 'invalid_type',
    path: ['idempotencyKey'],
  },
]) {
  /**
   * 验证 Agent 注册契约拒绝多余参数和缺失幂等键。
   *
   * @remarks
   * 同时核对校验错误类型和字段路径，保证错误准确指向无效输入。
   */
  void test('Agent registration rejects ' + label, () => {
    const result = register.schema.safeParse(input);
    assert.equal(result.success, false);
    if (result.success) assert.fail();
    assert.deepEqual(
      result.error.issues.map((issue) => ({ code: issue.code, path: issue.path })),
      [{ code, path }],
    );
  });
}
