import { z } from 'zod';
import type { Container } from '../../bootstrap/container.js';
import { createTools } from './tools.js';
import type { ToolDefinition } from './tools.js';

const directNames = new Set([
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
]);

// 显式限定可经管理入口执行的操作，新增内部命令不会自动暴露给 MCP。
const managementNames = new Set([
  'connector_info',
  'connector_diagnose',
  'registry_list_sources',
  'registry_configure',
  'registry_refresh',
  'registry_search',
  'registry_get_agent',
  'agent_register',
  'agent_update',
  'agent_remove',
  'agent_install',
  'agent_check_updates',
  'agent_upgrade',
  'agent_rollback',
  'installation_list',
  'installation_remove',
  'local_agent_scan',
  'local_agent_plan',
  'local_agent_apply',
  'agent_probe',
  'agent_auth_methods',
  'agent_authenticate',
  'agent_logout',
  'runtime_prepare',
  'runtime_get',
  'runtime_close',
  'session_delete',
  'session_share',
  'session_unshare',
  'session_transfer',
  'operation_events',
  'operation_cancel',
  'history_list',
  'history_get',
  'history_usage',
  'history_cleanup',
]);

export function toolAnnotations(tool: ToolDefinition) {
  return {
    readOnlyHint: tool.readOnly,
    destructiveHint: tool.destructive,
    openWorldHint: tool.openWorld ?? true,
  };
}

export function describeTool(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object' as const,
      ...z.toJSONSchema(tool.schema, { io: 'input', target: 'draft-2020-12' }),
    },
    annotations: toolAnnotations(tool),
  };
}

function managementToolName(tool: ToolDefinition) {
  return tool.destructive
    ? 'management_destructive'
    : tool.readOnly
      ? 'management_read'
      : 'management_write';
}

export function createMcpTools(app: Container): ToolDefinition[] {
  const operations = createTools(app);
  const management = operations.filter((tool) => managementNames.has(tool.name));
  const describeSchema = z.strictObject({ action: z.enum(management.map((tool) => tool.name)) });
  const describe: ToolDefinition = {
    name: 'management_describe',
    description:
      '查询某个管理 action 的用途、完整参数 Schema 和对应执行工具。仅返回该 action，不执行操作；参数未知时先调用本工具。',
    schema: describeSchema,
    readOnly: true,
    destructive: false,
    openWorld: false,
    run: (_ctx, input) => {
      const { action } = describeSchema.parse(input);
      const tool = management.find((item) => item.name === action)!;
      const { description, inputSchema, annotations } = describeTool(tool);
      return Promise.resolve({
        action,
        toolName: managementToolName(tool),
        description,
        inputSchema,
        annotations,
      });
    },
  };
  const descriptions = {
    management_read:
      '执行低频只读管理查询：连接器信息与诊断、Registry、安装、本地 Agent、认证方式、Runtime、操作事件、历史。参数未知时先调用 management_describe。',
    management_write:
      '执行低频管理变更：Registry 配置与刷新、Agent 配置与安装升级回滚、本地复用、能力探测与认证、Runtime、会话共享移交、操作取消。参数未知时先调用 management_describe。',
    management_destructive:
      '执行删除与清理：Agent 配置、无引用安装、已关闭下游会话、历史清理。保留原有修订、幂等和清理计划校验。参数未知时先调用 management_describe。',
  };
  const gateways = Object.entries(descriptions).map(([name, description]): ToolDefinition => {
    const allowed = management.filter((tool) => managementToolName(tool) === name);
    const schema = z.strictObject({
      action: z.enum(allowed.map((tool) => tool.name)),
      arguments: z.record(z.string(), z.unknown()),
    });
    const resolveOperation = (input: unknown) => {
      const args = schema.parse(input);
      return {
        definition: allowed.find((tool) => tool.name === args.action)!,
        input: args.arguments,
      };
    };
    return {
      name,
      description,
      schema,
      readOnly: name === 'management_read',
      destructive: name === 'management_destructive',
      resolveOperation,
      run: (ctx, input) => {
        const target = resolveOperation(input);
        return target.definition.run(ctx, target.input);
      },
    };
  });
  return [...operations.filter((tool) => directNames.has(tool.name)), describe, ...gateways];
}
