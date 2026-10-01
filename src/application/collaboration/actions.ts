import { digest } from '../../domain/ids.js';
import type { InteractionRecord } from '../../domain/models.js';
import type { PermissionDecision } from '../interaction-service.js';

export interface PermissionResolutionChoice {
  kind: string;
  name: string;
  optionId?: string;
  allow?: boolean;
  call: {
    tool: string;
    arguments: {
      requestId: string;
      target: string;
      action: 'reply' | 'cancel';
      interactionId: string;
      decision?: PermissionDecision;
    };
  };
}

/** 提供完整调用选项，不代替审阅和提交时的归属、代次与授权检查。 */
export function permissionResolutionChoices(
  agentId: string,
  record: InteractionRecord,
  tool: string,
  delegableOptionIds?: string[],
  mayApproveHost = true,
): PermissionResolutionChoice[] {
  const call = (decision: PermissionDecision | null): PermissionResolutionChoice['call'] => {
    const action = decision ? 'reply' : 'cancel';
    return {
      tool,
      arguments: {
        requestId: `reply:${digest([
          agentId,
          record.id,
          record.connectionGeneration,
          record.revision,
          action,
          decision,
        ])}`,
        target: agentId,
        action,
        interactionId: record.id,
        ...(decision ? { decision } : {}),
      },
    };
  };
  const choices: PermissionResolutionChoice[] = [];
  if (record.type === 'permission') {
    const options: unknown[] = Array.isArray(record.request.options) ? record.request.options : [];
    for (const option of options) {
      if (!option || typeof option !== 'object') continue;
      const value = option as { optionId?: unknown; kind?: unknown; name?: unknown };
      if (typeof value.optionId !== 'string' || typeof value.kind !== 'string') continue;
      if (delegableOptionIds && !delegableOptionIds.includes(value.optionId)) continue;
      choices.push({
        optionId: value.optionId,
        kind: value.kind,
        name: typeof value.name === 'string' ? value.name : value.optionId,
        call: call({ kind: 'acp_option', optionId: value.optionId }),
      });
    }
  } else if (record.type === 'host_permission') {
    for (const allow of mayApproveHost ? [true, false] : [false])
      choices.push({
        kind: 'host',
        allow,
        name: allow ? '允许本次操作' : '拒绝本次操作',
        call: call({ kind: 'host', allow }),
      });
  } else return [];
  choices.push({ kind: 'cancel', name: '取消交互', call: call(null) });
  return choices;
}
