import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { Container } from '../../src/bootstrap/container.js';
import { agentConfig } from '../../src/domain/schemas.js';
import { createServer } from '../../src/transport/mcp/server.js';

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
    }[];
    supervision: { unfinishedTasks: unknown[] };
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

  await call('respond_agent', {
    requestId: 'approve',
    target: started.agentId,
    action: 'reply',
    interactionId: approval.interactionId,
    decision: { kind: 'acp_option', optionId: 'allow' },
  });
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
