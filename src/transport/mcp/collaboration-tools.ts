import { z } from 'zod';
import type { Container } from '../../bootstrap/container.js';
import { absolutePath, text } from '../../domain/schemas.js';
import type { ToolDefinition } from './tools.js';

const request = { requestId: text.max(128) };
const target = { ...request, target: text };
const message = text.refine(
  (s) => s.trim().length > 0 && Buffer.byteLength(s) <= 16 * 1024 ** 2 - 8192,
  '消息必须包含实际内容，并为成员元数据保留空间（最大 16 MiB 减 8 KiB）。',
);
export const collaborationSchemas = {
  spawn_agent: z.strictObject({
    ...request,
    taskName: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    message,
    teamId: text.optional(),
    profile: text.optional(),
    cwd: absolutePath.optional(),
  }),
  list_agents: z.strictObject({
    teamId: text.optional(),
    pathPrefix: text.optional(),
    target: text.optional(),
    detail: z.enum(['status', 'output']).optional(),
    cursor: text.optional(),
    intentId: text.optional(),
    messageId: text.optional(),
  }),
  send_message: z.strictObject({ ...target, message }),
  followup_task: z.strictObject({ ...target, message }),
  wait_agent: z.strictObject({
    teamId: text.optional(),
    cursor: text.optional(),
    timeoutMs: z.number().int().min(0).max(30000).optional(),
  }),
  interrupt_agent: z.strictObject(target),
  respond_agent: z.union([
    z.strictObject({ ...target, action: z.literal('prepare_restore') }),
    z.strictObject({ ...target, action: z.literal('present'), interactionId: text }),
    z.strictObject({ ...target, action: z.literal('cancel'), interactionId: text }),
    z.strictObject({
      ...target,
      action: z.literal('reply'),
      planId: text,
      acceptEnvironmentDigest: text,
    }),
    z.strictObject({ ...target, action: z.literal('reply'), authMethodId: text }),
    z.strictObject({
      ...target,
      action: z.literal('reply'),
      interactionId: text,
      decision: z.union([
        z.strictObject({ kind: z.literal('acp_option'), optionId: text }),
        z.strictObject({ kind: z.literal('host'), allow: z.boolean() }),
        z.strictObject({ kind: z.literal('cancel') }),
      ]),
    }),
    z.strictObject({
      ...target,
      action: z.literal('reply'),
      interactionId: text,
      answer: z.enum(['accept', 'decline', 'cancel']),
      content: z.record(z.string(), z.unknown()).optional(),
      presentationReceipt: text.optional(),
    }),
  ]),
  close_agent: z.strictObject(target),
};
export const collaborationDescriptions: Record<keyof typeof collaborationSchemas, string> = {
  spawn_agent:
    '创建独立成员并开始任务，立即返回稳定 teamId/agentId。message 必须自包含目标、背景、输入、约束和交付要求；子成员看不到父对话历史。省略 teamId 创建新团队；Bridge 自动绑定父成员。',
  list_agents:
    '读取可见团队、成员状态、待办及 profile。target + detail=output 读取结果，可用 intentId 选择旧轮次、messageId 选择消息、cursor 分页大输出。',
  send_message:
    '将普通消息保存到目标邮箱，不启动空闲成员；queued 仅表示已保存。运行中通过协作工具读取，或随下一轮任务提供。',
  followup_task:
    '给已有成员安排独立后续轮次，保留它自己的会话历史。忙碌时 FIFO 排队，不向当前轮重复注入。',
  wait_agent:
    '等待调用者邮箱并返回实际消息、状态与 nextCursor。外部调用必须给 teamId；Bridge 自动确定邮箱。旧游标可重复读取，超时或断连不取消任务。',
  interrupt_agent:
    '请求停止当前轮次并取消尚未执行的队列；accepted 不代表已经停止。保留成员身份和普通邮箱。',
  respond_agent:
    '处理成员待办：reply 权限原始选项或认证方法；present 真实呈现表单/URL；cancel 交互；prepare_restore 准备恢复，再 reply 确认 planId 和环境摘要。恢复不重放旧任务。',
  close_agent: '关闭成员及其子树，取消排队任务并清理进程，保留历史。closed 成员不可隐式恢复。',
};

export function createCollaborationTools(app: Container): ToolDefinition[] {
  return Object.entries(collaborationSchemas).map(([name, schema]) => ({
    name,
    schema,
    description: collaborationDescriptions[name as keyof typeof collaborationSchemas],
    readOnly: name === 'list_agents' || name === 'wait_agent',
    destructive: name === 'close_agent',
    run: async (ctx, input) => {
      switch (name) {
        case 'spawn_agent':
          return app.collaboration.spawn(ctx, collaborationSchemas.spawn_agent.parse(input));
        case 'list_agents':
          return app.collaboration.list(ctx, collaborationSchemas.list_agents.parse(input));
        case 'send_message':
          return app.collaboration.send(ctx, collaborationSchemas.send_message.parse(input));
        case 'followup_task':
          return app.collaboration.followup(ctx, collaborationSchemas.followup_task.parse(input));
        case 'wait_agent':
          return app.collaboration.wait(ctx, collaborationSchemas.wait_agent.parse(input));
        case 'interrupt_agent':
          return app.collaboration.stop(ctx, collaborationSchemas.interrupt_agent.parse(input));
        case 'respond_agent':
          return app.collaboration.respond(ctx, collaborationSchemas.respond_agent.parse(input));
        case 'close_agent':
          return app.collaboration.stop(ctx, collaborationSchemas.close_agent.parse(input), true);
        default:
          throw new Error('未知协作工具');
      }
    },
  }));
}
