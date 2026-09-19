import type {
  AgentCapabilities,
  ContentBlock,
  SessionConfigOption,
} from '@agentclientprotocol/sdk';
import { fail } from '../../domain/errors.js';

export function requireCapability(
  capabilities: AgentCapabilities,
  method: 'load' | 'resume' | 'list' | 'delete' | 'close' | 'logout',
) {
  const supported =
    method === 'load'
      ? capabilities.loadSession === true
      : method === 'logout'
        ? capabilities.auth?.logout != null
        : capabilities.sessionCapabilities?.[method] != null;
  if (!supported) fail('CAPABILITY_UNSUPPORTED', `下游未声明 ${method} 能力。`);
}
export function validatePrompt(capabilities: AgentCapabilities, blocks: ContentBlock[]) {
  for (const block of blocks) {
    const supported =
      block.type === 'image'
        ? capabilities.promptCapabilities?.image
        : block.type === 'audio'
          ? capabilities.promptCapabilities?.audio
          : block.type === 'resource'
            ? capabilities.promptCapabilities?.embeddedContext
            : true;
    if (!supported) fail('CAPABILITY_UNSUPPORTED', `下游不支持 ${block.type} 内容。`);
  }
}
export function validateOption(
  options: SessionConfigOption[],
  optionId: string,
  value: string | boolean,
) {
  const option = options.find((item) => item.id === optionId);
  if (!option) fail('CAPABILITY_UNSUPPORTED', '下游未公布此配置项。');
  if (option.type === 'boolean') {
    if (typeof value !== 'boolean') fail('CONFIG_INVALID', '此配置项需要布尔值。');
    return;
  }
  const values = option.options.flatMap((item) =>
    'options' in item ? item.options.map((value) => value.value) : [item.value],
  );
  if (typeof value !== 'string' || !values.includes(value))
    fail('CONFIG_INVALID', '值不在下游公布的选项中。');
}
