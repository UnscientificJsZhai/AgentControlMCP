import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { Container } from '../../src/bootstrap/container.js';
import { agentConfig } from '../../src/domain/schemas.js';
import { createServer } from '../../src/transport/mcp/server.js';
import type { PermissionResolutionChoice } from '../../src/application/collaboration/actions.js';

/** 经真实 MCP 工具调度与可控 ACP 进程验证审批后的等待闭环。 */
void test('Collaboration wait retains approval after timeout and settles after ACP response', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'acm-collaboration-wait-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const app = await Container.create({ dataDir: directory, mode: 'cli' });
  t.after(async () => app.close());
  const fixture = join(process.cwd(), 'test/fixtures/collaboration-permission-agent.mjs');
  const gatePath = join(directory, 'release-permission');
  const config = agentConfig.parse({
    name: 'collaboration-fixture',
    origin: { kind: 'manual' },
    launch: { kind: 'command', executable: process.execPath, args: [fixture, gatePath] },
    cwd: directory,
  });
  const registered = await app.configs.register(app.admin, {
    config,
    idempotencyKey: 'fixture-config',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(app, app.admin, { era: 'legacy' });
  const client = new Client({ name: 'collaboration-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const respond = t.mock.method(app.collaboration, 'respond');
  const catalog = await client.listTools();
  assert.equal(
    (catalog.tools.find((tool) => tool.name === 'respond_agent')!.inputSchema.anyOf as unknown[])
      .length,
    7,
  );
  for (const input of [
    {
      requestId: 'invalid',
      agentId: 'agent',
      interactionId: 'interaction',
      optionId: 'allow',
      decision: { kind: 'host', allow: true },
    },
    {
      requestId: 'invalid-linux',
      agentId: 'agent',
      teamId: 'team',
      response: { decision: { kind: 'host', allow: true }, optionId: 'allow' },
    },
  ]) {
    const failure = await client.callTool({ name: 'respond_agent', arguments: input });
    assert.equal(failure.isError, true);
    const detail = failure.structuredContent as {
      ok: boolean;
      error: { code: string; details: { issues: { path: string[] }[] } };
    };
    assert.equal(detail.ok, false);
    assert.equal(detail.error.code, 'CONFIG_INVALID');
    assert.deepEqual(
      detail.error.details.issues.map((issue) => issue.path),
      [['target'], ['action']],
    );
    assert.equal(failure.content[0]!.type, 'text');
    assert.deepEqual(JSON.parse((failure.content[0] as { text: string }).text), detail);
  }
  assert.equal(respond.mock.callCount(), 0);
  const call = async <T>(name: string, input: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: input })).structuredContent as {
      ok: boolean;
      data: T;
      error?: { code: string; message: string };
    };
    assert.equal(result.ok, true, JSON.stringify(result.ok ? result.data : result.error));
    return result.data;
  };
  const started = await call<{
    teamId: string;
    agentId: string;
    intentId: string;
    nextAction: { tool: string; teamId: string };
  }>('spawn_agent', {
    requestId: 'spawn',
    taskName: 'fixture',
    message: 'Request fixture permission and finish.',
    profile: registered.configId,
    cwd: directory,
  });
  assert.equal(started.nextAction.tool, 'wait_agent');
  assert.equal(started.nextAction.teamId, started.teamId);
  const replay = await call<{ agentId: string; intentId: string }>('spawn_agent', {
    requestId: 'spawn',
    taskName: 'fixture',
    message: 'Request fixture permission and finish.',
    profile: registered.configId,
    cwd: directory,
  });
  assert.equal(replay.agentId, started.agentId);
  assert.equal(replay.intentId, started.intentId);

  type Wait = {
    reason: string;
    timedOut: boolean;
    nextCursor: string;
    pendingInteractions: {
      interactionId: string;
      request: Record<string, unknown>;
      options: { optionId: string }[];
      resolutionChoices: PermissionResolutionChoice[];
    }[];
    supervision: {
      unfinishedTasks: unknown[];
      executionSettled: boolean;
      readyToSummarize: boolean;
    };
    nextAction: { tool: string };
  };
  let current = await call<Wait>('wait_agent', { teamId: started.teamId, timeoutMs: 0 });
  assert.equal(current.reason, 'timeout');
  assert.equal(current.timedOut, true);
  await writeFile(gatePath, '');
  const approvalDeadline = Date.now() + 3000;
  while (current.reason !== 'input_required' && Date.now() < approvalDeadline)
    current = await call<Wait>('wait_agent', {
      teamId: started.teamId,
      cursor: current.nextCursor,
      timeoutMs: Math.min(700, Math.max(0, approvalDeadline - Date.now())),
    });
  assert.equal(current.reason, 'input_required', JSON.stringify(current));
  assert.equal(current.nextAction.tool, 'respond_agent');
  assert.equal(current.supervision.readyToSummarize, false);
  const approval = current.pendingInteractions[0]!;
  assert.deepEqual(
    approval.options.map((option) => option.optionId),
    ['allow', 'reject'],
  );
  const afterCursor = await call<Wait>('wait_agent', {
    teamId: started.teamId,
    cursor: current.nextCursor,
    timeoutMs: 0,
  });
  assert.equal(afterCursor.reason, 'input_required');
  assert.equal(afterCursor.pendingInteractions[0]?.interactionId, approval.interactionId);

  for (const decision of [
    { kind: 'acp_option', optionId: 'guessed' },
    { kind: 'host', allow: true },
  ]) {
    const invalid = await client.callTool({
      name: 'respond_agent',
      arguments: {
        requestId: `invalid-${decision.kind}`,
        target: started.agentId,
        action: 'reply',
        interactionId: approval.interactionId,
        decision,
      },
    });
    assert.equal(
      (invalid.structuredContent as { error: { code: string } }).error.code,
      'INVALID_PERMISSION_OPTION',
    );
    assert.equal((await app.interactions.get(app.admin, approval.interactionId)).state, 'pending');
  }

  const allow = approval.resolutionChoices.find((choice) => choice.kind === 'allow_once')!;
  const permission = await call<{
    teamId: string;
    nextAction: { tool: string; arguments: { teamId: string; cursor?: string } };
  }>(allow.call.tool, allow.call.arguments);
  assert.equal(permission.teamId, started.teamId);
  assert.equal(permission.nextAction.tool, 'wait_agent');
  assert.equal(permission.nextAction.arguments.teamId, started.teamId);
  assert.equal(permission.nextAction.arguments.cursor, undefined);
  assert.deepEqual(await call(allow.call.tool, allow.call.arguments), permission);
  const conflict = (
    await client.callTool({
      name: 'respond_agent',
      arguments: {
        requestId: 'approve-again',
        target: started.agentId,
        action: 'reply',
        interactionId: approval.interactionId,
        decision: { kind: 'acp_option', optionId: 'allow' },
      },
    })
  ).structuredContent as { ok: boolean; error?: { code: string } };
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error?.code, 'INTERACTION_ALREADY_RESOLVED');
  current = await call<Wait>('wait_agent', {
    teamId: started.teamId,
    cursor: afterCursor.nextCursor,
    timeoutMs: 700,
  });
  const completionDeadline = Date.now() + 3000;
  while (current.reason !== 'settled' && Date.now() < completionDeadline)
    current = await call<Wait>('wait_agent', {
      teamId: started.teamId,
      cursor: current.nextCursor,
      timeoutMs: Math.min(700, Math.max(0, completionDeadline - Date.now())),
    });
  assert.equal(current.reason, 'settled');
  assert.deepEqual(current.pendingInteractions, []);
  assert.deepEqual(current.supervision.unfinishedTasks, []);
  assert.equal(current.supervision.readyToSummarize, true);
  const followupInput = {
    requestId: 'followup',
    target: started.agentId,
    message: 'A separate later turn.',
  };
  const followup = await call<{
    teamId: string;
    intentId: string;
    nextAction: { tool: string; teamId: string };
  }>('followup_task', followupInput);
  const repeated = await call<{ teamId: string; intentId: string }>('followup_task', followupInput);
  assert.equal(followup.teamId, started.teamId);
  assert.equal(followup.nextAction.tool, 'wait_agent');
  assert.equal(followup.nextAction.teamId, started.teamId);
  assert.equal(repeated.intentId, followup.intentId);
  await call('interrupt_agent', { requestId: 'stop-followup', target: started.agentId });
});
