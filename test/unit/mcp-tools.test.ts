import test from 'node:test';
import assert from 'node:assert/strict';
import type { Container } from '../../src/bootstrap/container.js';
import { createMcpTools, describeTool } from '../../src/transport/mcp/catalog.js';
import { createTools } from '../../src/transport/mcp/tools.js';

const app = {} as Container;

/**
 * 验证默认工具目录公开协作与设置入口，同时隐藏管理操作。
 *
 * @remarks
 * 工具名称必须唯一，管理网关、内部工具和直接注册操作不能出现在默认目录中。
 */
void test('The default collaboration catalog hides management gateways and internal operations', () => {
  const names = createMcpTools(app).map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('spawn_agent'));
  assert.ok(names.includes('setup_agent'));
  assert.ok(names.every((name) => !name.startsWith('management_') && !name.startsWith('_')));
  assert.equal(names.includes('agent_register'), false);
});

/**
 * 验证兼容目录保留直接会话操作，并通过管理网关限制敏感操作。
 *
 * @remarks
 * 同时检查名称唯一性、直接工具来源及序列化大小，防止目录无意扩张。
 */
void test('The legacy catalog preserves direct session tools and gates sensitive management operations', () => {
  const tools = createMcpTools(app, 'legacy');
  const names = tools.map((tool) => tool.name);
  const rawNames = new Set(createTools(app).map((tool) => tool.name));
  assert.equal(new Set(names).size, names.length);
  for (const name of ['session_create', 'task_submit', 'content_read'])
    assert.ok(names.includes(name));
  for (const name of ['agent_register', 'agent_remove', '_identity_create'])
    assert.equal(names.includes(name), false);
  for (const name of names.filter((name) => !name.startsWith('management_')))
    assert.ok(rawNames.has(name));
  // 限制实际序列化目录的上下文成本，避免恢复全量 Schema 的重型默认目录。
  assert.ok(Buffer.byteLength(JSON.stringify(tools.map(describeTool))) <= 30 * 1024);
});
