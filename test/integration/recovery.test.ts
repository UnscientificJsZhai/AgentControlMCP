import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Container } from '../../src/bootstrap/container.js';
import { until } from '../helpers/harness.js';
import { isAlive, recover } from '../../src/application/recovery-service.js';
import { digest, id, now } from '../../src/domain/ids.js';
import type { InstanceRecord, SessionRecord, WorkRecord } from '../../src/domain/models.js';
import { agentConfig } from '../../src/domain/schemas.js';
import { row, SqliteStore } from '../../src/infrastructure/storage/sqlite-store.js';

void test('AC-008: 恢复保留会话终态并清理遗留租约，不影响存活实例', async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  assert.equal(child.exitCode, 0);
  assert.ok(child.pid);
  assert.equal(isAlive(child.pid), false);
  const root = await mkdtemp(join(tmpdir(), 'acm-session-recovery-'));
  const store = await SqliteStore.open(join(root, 'state.sqlite'));
  try {
    const timestamp = now();
    const deadInstance: InstanceRecord = {
      id: 'dead-instance',
      revision: 1,
      createdAt: timestamp,
      mode: 'stdio',
      serviceId: 'recovery',
      pid: child.pid,
      state: 'active',
      nonce: 'dead-instance-nonce',
      endpoint: '',
      heartbeat: timestamp,
    };
    const liveInstance: InstanceRecord = {
      ...deadInstance,
      id: 'live-instance',
      pid: process.pid,
      nonce: 'live-instance-nonce',
    };
    const snapshot = agentConfig.parse({
      name: '恢复测试',
      origin: { kind: 'manual' },
      launch: { kind: 'command', executable: process.execPath, args: [] },
      cwd: root,
    });
    const sessions = (['closed', 'deleted', 'interrupted', 'ready', 'creating'] as const).map(
      (state): SessionRecord => ({
        id: `session-${state}`,
        revision: 3,
        createdAt: timestamp,
        ownerId: 'owner',
        grants: {},
        instanceId: deadInstance.id,
        serviceId: deadInstance.serviceId,
        mode: 'stdio',
        configId: 'config',
        runtimeId: `runtime-${state}`,
        activationId: `activation-${state}`,
        downstreamSessionId: `downstream-${state}`,
        namespace: 'recovery',
        state,
        cwd: root,
        additionalDirectories: [],
        snapshot,
        options: [],
        modes: null,
        commands: [],
        controlVersion: 1,
        ...(state === 'ready' || state === 'creating' ? { activeTaskId: 'pending-task' } : {}),
      }),
    );
    const liveSession: SessionRecord = {
      ...sessions[0]!,
      id: 'live-session',
      instanceId: liveInstance.id,
      runtimeId: 'live-runtime',
      downstreamSessionId: 'live-downstream',
      state: 'ready',
      activeTaskId: 'live-task',
    };
    const reassignedSession: SessionRecord = {
      ...sessions[0]!,
      id: 'reassigned-session',
      downstreamSessionId: 'reassigned-downstream',
    };
    const leaseKey = (session: SessionRecord) =>
      `session:${digest([session.namespace, session.downstreamSessionId])}`;
    await store.commit({
      puts: [
        ...[deadInstance, liveInstance].map((instance) => row('instance', instance)),
        ...[...sessions, liveSession, reassignedSession].map((session) => row('session', session)),
      ],
      claims: [
        ...[...sessions, liveSession].map((session) => ({
          key: leaseKey(session),
          holder: session.runtimeId,
        })),
        { key: leaseKey(reassignedSession), holder: liveSession.runtimeId },
      ],
    });

    assert.deepEqual(await recover(store), {
      recoveredInstances: [deadInstance.id],
      uncertainInstances: [liveInstance.id],
    });
    for (const session of sessions) {
      const expected = { ...session };
      if (session.state === 'ready' || session.state === 'creating') {
        expected.state = 'interrupted';
        expected.revision += 1;
        delete expected.activeTaskId;
      }
      assert.deepEqual(await store.get('session', session.id), expected);
      assert.equal(await store.claim(leaseKey(session)), null);
    }
    assert.deepEqual(await store.get('instance', deadInstance.id), {
      ...deadInstance,
      state: 'stopped',
      revision: deadInstance.revision + 1,
    });
    assert.deepEqual(await store.get('instance', liveInstance.id), liveInstance);
    assert.deepEqual(await store.get('session', liveSession.id), liveSession);
    assert.deepEqual(await store.get('session', reassignedSession.id), reassignedSession);
    assert.equal(await store.claim(leaseKey(liveSession)), liveSession.runtimeId);
    assert.equal(await store.claim(leaseKey(reassignedSession)), liveSession.runtimeId);

    const recoveredSessions = await store.list<SessionRecord>('session');
    assert.deepEqual(await recover(store), {
      recoveredInstances: [],
      uncertainInstances: [liveInstance.id],
    });
    assert.deepEqual(await store.list('session'), recoveredSessions);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

void test(
  'AC-006/008/027: 强制退出后进程树清理，重启标记 interrupted，不重发 prompt',
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'acm-recovery-'));
    const dataDir = join(root, 'data');
    const audit = join(root, 'audit.jsonl');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve('dist/cli/entry.js'),
        'serve',
        'stdio',
        '--data-dir',
        dataDir,
        '--client-id',
        'recovery',
      ],
      stderr: 'pipe',
    });
    const client = new Client({ name: 'recovery', version: '1' });
    let restarted: Container | undefined;
    try {
      await client.connect(transport);
      const call = async (name: string, args: Record<string, unknown>) => {
        const raw = await client.callTool({ name, arguments: args });
        const result = raw.structuredContent as { ok: boolean; data: Record<string, unknown> };
        assert.equal(result.ok, true, JSON.stringify(raw));
        return result.data;
      };
      const config = await call('management_write', {
        action: 'agent_register',
        arguments: {
          config: {
            name: 'tree',
            origin: { kind: 'manual' },
            cwd: root,
            launch: {
              kind: 'command',
              executable: process.execPath,
              args: [resolve('.test-dist/test/fixtures/acp-agent.js')],
            },
            environment: { values: { FIXTURE_AUDIT: { kind: 'literal', value: audit } } },
          },
          idempotencyKey: id('c'),
        },
      });
      const accepted = await call('session_create', {
        configId: config.configId,
        idempotencyKey: id('s'),
      });
      const op = await until(async () => {
        const op = await call('operation_get', { operationId: accepted.operationId });
        return op.state === 'completed' ? op : null;
      });
      const session = op.result as { sessionId: string; runtimeId: string };
      const runtime = await call('management_read', {
        action: 'runtime_get',
        arguments: { runtimeId: session.runtimeId },
      });
      const task = await call('task_submit', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'tree slow' }],
        idempotencyKey: 'no-retry',
      });
      const grandchild = await until(async () => {
        const lines = (await readFile(audit, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { grandchildPid?: number });
        return lines.find((item) => item.grandchildPid)?.grandchildPid;
      });
      process.kill(transport.pid!, 'SIGKILL');
      await until(
        () => Promise.resolve(!isAlive(runtime.pid as number) && !isAlive(grandchild)),
        10_000,
      );
      restarted = await Container.create({ dataDir, mode: 'stdio' });
      const record = await restarted.store.get<WorkRecord>('task', task.taskId as string);
      assert.equal(record?.state, 'interrupted');
      assert.equal(
        (await readFile(audit, 'utf8'))
          .split('\n')
          .filter((line) => line.includes('"method":"session/prompt"')).length,
        1,
      );
    } finally {
      await client.close();
      await restarted?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
