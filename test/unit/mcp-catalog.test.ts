import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { Container } from '../../src/bootstrap/container.js';
import type { Context } from '../../src/domain/models.js';
import { createTools } from '../../src/transport/mcp/tools.js';
import { createMcpTools, describeTool } from '../../src/transport/mcp/catalog.js';

const directNames = [
  'agent_list',
  'agent_get',
  'session_create',
  'session_list',
  'session_get',
  'session_load',
  'session_resume',
  'session_close',
  'session_get_options',
  'session_set_option',
  'session_set_mode',
  'session_commands',
  'session_events',
  'task_submit',
  'task_get',
  'task_wait',
  'task_cancel',
  'task_events',
  'permission_list',
  'permission_respond',
  'interaction_list',
  'interaction_present',
  'interaction_respond',
  'operation_get',
  'operation_wait',
  'content_read',
];
const groups = {
  management_read: [
    'connector_info',
    'connector_diagnose',
    'registry_list_sources',
    'registry_search',
    'registry_get_agent',
    'installation_list',
    'local_agent_scan',
    'agent_auth_methods',
    'runtime_get',
    'operation_events',
    'history_list',
    'history_get',
    'history_usage',
    'storage_usage',
  ],
  management_write: [
    'registry_configure',
    'registry_refresh',
    'agent_register',
    'agent_update',
    'agent_install',
    'agent_check_updates',
    'agent_upgrade',
    'agent_rollback',
    'local_agent_plan',
    'local_agent_apply',
    'agent_probe',
    'agent_authenticate',
    'agent_logout',
    'runtime_prepare',
    'runtime_close',
    'session_share',
    'session_unshare',
    'session_transfer',
    'operation_cancel',
  ],
  management_destructive: [
    'agent_remove',
    'installation_remove',
    'session_delete',
    'history_cleanup',
    'storage_cleanup',
  ],
};

void test('MCP 固定保留 26 个交互工具，完整分配 38 个管理操作，定义不超过 30 KiB', async () => {
  const app = {} as Container;
  const original = createTools(app);
  const published = createMcpTools(app);
  const names = published.map((tool) => tool.name);
  assert.equal(original.length, 64);
  assert.equal(names.length, 30);
  assert.equal(new Set(names).size, 30);
  assert.deepEqual(
    names.toSorted(),
    [...directNames, 'management_describe', ...Object.keys(groups)].toSorted(),
  );
  for (const name of directNames) {
    assert.deepEqual(
      describeTool(published.find((tool) => tool.name === name)!),
      describeTool(original.find((tool) => tool.name === name)!),
    );
  }
  const described = z.strictObject({
    action: z.string(),
    toolName: z.string(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
    annotations: z.record(z.string(), z.boolean()),
  });
  const describe = published.find((tool) => tool.name === 'management_describe')!;
  assert.deepEqual(describeTool(describe).annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });
  for (const [toolName, actions] of Object.entries(groups)) {
    const gateway = published.find((tool) => tool.name === toolName)!;
    assert.deepEqual(describeTool(gateway).annotations, {
      readOnlyHint: toolName === 'management_read',
      destructiveHint: toolName === 'management_destructive',
      openWorldHint: true,
    });
    for (const action of actions) {
      const expected = original.find((tool) => tool.name === action)!;
      assert.ok(expected, action);
      assert.equal(names.includes(action), false, action);
      assert.equal(gateway.schema.safeParse({ action, arguments: {} }).success, true);
      const result = described.parse(await describe.run({} as Context, { action }));
      const { description, inputSchema, annotations } = describeTool(expected);
      assert.deepEqual(result, { action, toolName, description, inputSchema, annotations });
    }
    const rejected = [
      ...directNames,
      ...Object.entries(groups).flatMap(([other, items]) => (other === toolName ? [] : items)),
      '_identity_create',
      'management_read',
      'management_describe',
      'missing',
      '__proto__',
    ];
    for (const action of rejected)
      assert.equal(gateway.schema.safeParse({ action, arguments: {} }).success, false, action);
    for (const args of [null, [], 'text'])
      assert.equal(
        gateway.schema.safeParse({ action: actions[0], arguments: args }).success,
        false,
      );
  }
  const managementNames = Object.values(groups).flat();
  assert.equal(new Set([...directNames, ...managementNames]).size, original.length);
  for (const action of [...directNames, '_identity_create', 'management_write', 'missing'])
    assert.equal(describe.schema.safeParse({ action }).success, false, action);
  const serialized = JSON.stringify(published.map(describeTool));
  assert.ok(Buffer.byteLength(serialized) <= 30 * 1024);
  // 低频参数不得被意外展开回常驻工具列表。
  for (const gateway of published.filter((tool) => tool.name.startsWith('management_')))
    assert.equal(JSON.stringify(describeTool(gateway)).includes('permissionPolicy'), false);
});
