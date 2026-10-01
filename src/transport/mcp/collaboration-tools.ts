import { z } from 'zod';
import type { Container } from '../../bootstrap/container.js';
import { absolutePath, text } from '../../domain/schemas.js';
import { collaborationGuidance } from '../../domain/collaboration.js';
import { AppError } from '../../domain/errors.js';
import type { ToolDefinition } from './tools.js';

const request = { requestId: text.max(128) };
const target = { ...request, target: text };
const message = text.refine(
  (s) => s.trim().length > 0 && Buffer.byteLength(s) <= 16 * 1024 ** 2 - 8192,
  '消息必须包含实际内容，并为成员元数据保留空间（最大 16 MiB 减 8 KiB）。',
);
const completionCriteria = z
  .strictObject({
    configId: text
      .optional()
      .describe('预期注册成功后返回的 configId；不匹配时拒绝创建或追加任务。'),
    requiredMessage: z
      .strictObject({ target: z.literal('/root'), text: message })
      .optional()
      .describe(
        '要求本轮通过 MCP Bridge 向外部根发送完全相同的 MESSAGE；最终回答和原生协作消息不能替代。',
      ),
  })
  .refine(
    (value) => value.configId !== undefined || value.requiredMessage !== undefined,
    '至少提供一个验收条件',
  );
const permissionDecisionBranches = [
  z.strictObject({ kind: z.literal('acp_option'), optionId: text }),
  z.strictObject({ kind: z.literal('host'), allow: z.boolean() }),
  z.strictObject({ kind: z.literal('cancel') }),
] as const;
const permissionDecision = z.union(permissionDecisionBranches);
export const respondAgentBranches = {
  prepareRestore: z.strictObject({ ...target, action: z.literal('prepare_restore') }),
  present: z.strictObject({ ...target, action: z.literal('present'), interactionId: text }),
  cancel: z.strictObject({ ...target, action: z.literal('cancel'), interactionId: text }),
  restore: z.strictObject({
    ...target,
    action: z.literal('reply'),
    planId: text,
    acceptEnvironmentDigest: text,
  }),
  authenticate: z.strictObject({ ...target, action: z.literal('reply'), authMethodId: text }),
  permission: z.strictObject({
    ...target,
    action: z.literal('reply'),
    interactionId: text,
    decision: permissionDecision,
  }),
  answer: z.strictObject({
    ...target,
    action: z.literal('reply'),
    interactionId: text,
    answer: z.enum(['accept', 'decline', 'cancel']),
    content: z.record(z.string(), z.unknown()).optional(),
    presentationReceipt: text.optional(),
  }),
};
// 公开目录保持原 anyOf 契约；处理器按 kind 定向报告 decision 字段错误。
const targetedPermission = respondAgentBranches.permission.extend({
  decision: z.discriminatedUnion('kind', permissionDecisionBranches),
});
const respondBase = z.looseObject({
  ...target,
  action: z.enum(['reply', 'present', 'cancel', 'prepare_restore']),
});

/** 保留原始字段并选择适用的严格分支，避免七类不相关校验错误混入同一答复。 */
export function parseRespondAgentInput(input: unknown) {
  const args = respondBase.parse(input);
  switch (args.action) {
    case 'prepare_restore':
      return respondAgentBranches.prepareRestore.parse(args);
    case 'present':
      return respondAgentBranches.present.parse(args);
    case 'cancel':
      return respondAgentBranches.cancel.parse(args);
    case 'reply': {
      const categories = [
        { schema: targetedPermission, fields: ['decision'] },
        {
          schema: respondAgentBranches.answer,
          fields: ['answer', 'content', 'presentationReceipt'],
        },
        { schema: respondAgentBranches.restore, fields: ['planId', 'acceptEnvironmentDigest'] },
        { schema: respondAgentBranches.authenticate, fields: ['authMethodId'] },
      ].filter(({ fields }) => fields.some((field) => args[field] !== undefined));
      if (categories.length !== 1)
        throw new AppError(
          'CONFIG_INVALID',
          'reply 必须且只能提供一种答复载荷。',
          { requiredOneOf: ['decision', 'answer', 'planId', 'authMethodId'] },
          '权限使用 decision；表单使用 answer；恢复使用 planId；认证使用 authMethodId。不要混用。',
        );
      return categories[0]!.schema.parse(args);
    }
  }
}
export const collaborationSchemas = {
  spawn_agent: z.strictObject({
    ...request,
    taskName: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    message,
    teamId: text.optional(),
    profile: text.optional(),
    cwd: absolutePath.optional(),
    completionCriteria: completionCriteria.optional(),
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
  followup_task: z.strictObject({
    ...target,
    message,
    completionCriteria: completionCriteria.optional(),
  }),
  wait_agent: z.strictObject({
    teamId: text.optional(),
    cursor: text.optional(),
    timeoutMs: z.number().int().min(0).max(30000).optional(),
  }),
  interrupt_agent: z.strictObject(target),
  respond_agent: z.union(Object.values(respondAgentBranches)),
  close_agent: z.strictObject(target),
};
export const collaborationDescriptions: Record<keyof typeof collaborationSchemas, string> = {
  spawn_agent: `创建独立成员并开始任务，返回 teamId/agentId/intentId/configId/configRevision 和下一步等待指引。profile 使用成功注册的 configId；新增注册失败时不能改用旧配置冒充。message 必须自包含背景与交付要求；子成员看不到父历史。completionCriteria 可固定预期 configId 和本轮必须发送的 Bridge MESSAGE。省略 teamId 创建新团队；Bridge 自动绑定父成员。${collaborationGuidance(false)}`,
  list_agents:
    '读取团队、成员实际 configId/configRevision、Bridge 状态、待办及 profile。target + detail=output 读取结果、acceptance 与本轮 Bridge 调用证据，可用 intentId 选择旧轮次、messageId 选择消息、cursor 分页大输出。connected 只表示握手，used 不代表所需消息已发送；必须核对 MESSAGE 与验收条件。',
  send_message:
    '将普通消息保存到目标邮箱，不启动空闲成员；queued 仅表示已保存。运行中通过协作工具读取，或随下一轮任务提供。',
  followup_task: `给已有成员安排独立后续轮次，保留它自己的会话历史。忙碌时 FIFO 排队，不向当前轮重复注入。返回 teamId 和下一步等待指引。${collaborationGuidance(false)}`,
  wait_agent: `等待调用者邮箱和监督范围；返回消息、当前待办、任务摘要、reason 与 nextCursor。外部调用必须给 teamId；Bridge 自动确定邮箱。旧游标可重复读取，超时或断连不取消任务。${collaborationGuidance(false)}`,
  interrupt_agent:
    '请求停止当前轮次并取消尚未执行的队列；accepted 不代表已经停止。保留成员身份和普通邮箱。',
  respond_agent:
    '处理成员待办：权限先审阅并选择 resolutionChoices，原样使用 call.arguments；target 是成员，interactionId 是交互，decision 是原始选项（acp_option）或宿主允许/拒绝（host）。不能用 agentId 代替 target 或把 optionId 放在顶层。reply 后继续 wait_agent；相同错误参数不要原样重试，未知或已解决交互先刷新待办。present 真实呈现表单/URL；cancel 交互；reply 认证方法；prepare_restore 准备恢复，再 reply 确认 planId 和环境摘要。恢复不重放旧任务。',
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
          return app.collaboration.respond(ctx, parseRespondAgentInput(input));
        case 'close_agent':
          return app.collaboration.stop(ctx, collaborationSchemas.close_agent.parse(input), true);
        default:
          throw new Error('未知协作工具');
      }
    },
  }));
}
