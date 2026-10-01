import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  collaborationSchemas,
  parseRespondAgentInput,
} from '../../src/transport/mcp/collaboration-tools.js';
import { errorDetail } from '../../src/domain/errors.js';

const target = { requestId: 'reply', target: 'agent' };
const valid = [
  { ...target, action: 'prepare_restore' },
  { ...target, action: 'present', interactionId: 'interaction' },
  { ...target, action: 'cancel', interactionId: 'interaction' },
  { ...target, action: 'reply', planId: 'plan', acceptEnvironmentDigest: 'digest' },
  { ...target, action: 'reply', authMethodId: 'authenticate' },
  {
    ...target,
    action: 'reply',
    interactionId: 'interaction',
    decision: { kind: 'acp_option', optionId: 'original-option' },
  },
  { ...target, action: 'reply', interactionId: 'interaction', answer: 'decline' },
];

void test('Targeted response validation preserves all seven strict public branches', () => {
  assert.equal(z.toJSONSchema(collaborationSchemas.respond_agent).anyOf?.length, 7);
  const schema = JSON.stringify(z.toJSONSchema(collaborationSchemas.respond_agent));
  assert.equal(schema.includes('"oneOf"'), false);
  for (const input of valid) {
    assert.deepEqual(parseRespondAgentInput(input), input);
    assert.deepEqual(collaborationSchemas.respond_agent.parse(input), input);
    assert.throws(() => parseRespondAgentInput({ ...input, unexpected: true }));
  }
});

void test('Malformed real approval parameters report only the relevant missing fields', () => {
  assert.throws(
    () =>
      parseRespondAgentInput({
        requestId: 'reply',
        agentId: 'agent',
        interactionId: 'interaction',
        optionId: 'allow',
        decision: { kind: 'host', allow: true },
      }),
    (error: unknown) => {
      assert.ok(error instanceof z.ZodError);
      assert.deepEqual(
        error.issues.map((issue) => issue.path),
        [['target'], ['action']],
      );
      assert.equal(errorDetail(error).code, 'CONFIG_INVALID');
      return true;
    },
  );
  assert.throws(
    () =>
      parseRespondAgentInput({
        ...target,
        action: 'reply',
        interactionId: 'interaction',
        decision: { kind: 'acp_option' },
      }),
    (error: unknown) => {
      assert.ok(error instanceof z.ZodError);
      assert.deepEqual(
        error.issues.map((issue) => issue.path),
        [['decision', 'optionId']],
      );
      return true;
    },
  );
});

void test('Reply rejects missing and mixed payloads instead of selecting an arbitrary branch', () => {
  const reply = { ...target, action: 'reply', interactionId: 'interaction' };
  for (const input of [reply, { ...reply, decision: { kind: 'cancel' }, answer: 'decline' }]) {
    assert.throws(
      () => parseRespondAgentInput(input),
      (error: unknown) => {
        const detail = errorDetail(error);
        assert.equal(detail.code, 'CONFIG_INVALID');
        assert.deepEqual(detail.details?.requiredOneOf, [
          'decision',
          'answer',
          'planId',
          'authMethodId',
        ]);
        return true;
      },
    );
  }
  for (const decision of [
    { kind: 'host', optionId: 'allow' },
    { kind: 'acp_option', optionId: 'allow', allow: true },
    { kind: 'unknown', allow: true },
  ])
    assert.throws(() => parseRespondAgentInput({ ...reply, decision }));
});
