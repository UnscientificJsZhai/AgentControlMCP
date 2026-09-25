import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentCapabilities, ContentBlock } from '@agentclientprotocol/sdk';
import { requireCapability, validatePrompt } from '../../src/infrastructure/acp/capability-gate.js';

/**
 * 验证每个可选 ACP 方法只接受与自身对应的能力声明。
 *
 * @remarks
 * 缺失能力时必须拒绝调用，其他方法的声明不能被视为等价授权。
 */
void test('Optional ACP methods require their own capability declarations', () => {
  const declared: AgentCapabilities = {
    loadSession: true,
    auth: { logout: {} },
    sessionCapabilities: { resume: {}, list: {}, delete: {}, close: {} },
  };
  for (const method of ['load', 'resume', 'list', 'delete', 'close', 'logout'] as const) {
    assert.throws(() => requireCapability({}, method), { code: 'CAPABILITY_UNSUPPORTED' });
    assert.doesNotThrow(() => requireCapability(declared, method));
  }
  assert.throws(() => requireCapability({ loadSession: true }, 'resume'), {
    code: 'CAPABILITY_UNSUPPORTED',
  });
  assert.throws(() => requireCapability({ sessionCapabilities: { close: {} } }, 'logout'), {
    code: 'CAPABILITY_UNSUPPORTED',
  });
});

/**
 * 验证提示内容按块检查多模态能力，文本和资源链接无需额外声明。
 *
 * @remarks
 * 混合提示中的每种受限内容都必须获得声明，不能用单一能力放行整组内容。
 */
void test('Prompts allow text and resource links but require capabilities for each multimodal block', () => {
  const text: ContentBlock = { type: 'text', text: 'hello' };
  assert.doesNotThrow(() =>
    validatePrompt({}, [text, { type: 'resource_link', uri: 'file:///fixture', name: 'fixture' }]),
  );
  const cases: { block: ContentBlock; capabilities: AgentCapabilities }[] = [
    {
      block: { type: 'image', data: 'eA==', mimeType: 'image/png' },
      capabilities: { promptCapabilities: { image: true } },
    },
    {
      block: { type: 'audio', data: 'eA==', mimeType: 'audio/wav' },
      capabilities: { promptCapabilities: { audio: true } },
    },
    {
      block: { type: 'resource', resource: { uri: 'file:///fixture', text: 'embedded' } },
      capabilities: { promptCapabilities: { embeddedContext: true } },
    },
  ];
  for (const { block, capabilities } of cases) {
    assert.throws(() => validatePrompt({}, [text, block]), { code: 'CAPABILITY_UNSUPPORTED' });
    assert.doesNotThrow(() => validatePrompt(capabilities, [text, block]));
  }
  assert.throws(
    () =>
      validatePrompt(
        cases[0]!.capabilities,
        cases.map(({ block }) => block),
      ),
    {
      code: 'CAPABILITY_UNSUPPORTED',
    },
  );
});
