import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Container } from '../../src/bootstrap/container.js';
import { until } from '../helpers/harness.js';
import { isAlive } from '../../src/application/recovery-service.js';
import { id } from '../../src/domain/ids.js';
import type { WorkRecord } from '../../src/domain/models.js';

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
      const config = await call('agent_register', {
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
      const runtime = await call('runtime_get', { runtimeId: session.runtimeId });
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
