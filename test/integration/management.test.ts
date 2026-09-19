import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { harness, until } from '../helpers/harness.js';
import { id } from '../../src/domain/ids.js';
import { agentPatch } from '../../src/domain/schemas.js';
import { ConfigService } from '../../src/application/config-service.js';
import { SqliteStore } from '../../src/infrastructure/storage/sqlite-store.js';
import { join } from 'node:path';

void test('AC-010/011/024: 部分更新保留环境引用、多实例 CAS、人工文件冲突', async () => {
  assert.deepEqual(agentPatch.parse({ name: '更新名称' }), { name: '更新名称' });
  const h = await harness();
  const store = await SqliteStore.open(join(h.app.dataDir, 'state/state.db'));
  const other = new ConfigService(store, h.app.dataDir);
  try {
    const outcomes = await Promise.allSettled([
      h.app.configs.update(h.alice, {
        configId: h.registered.configId,
        patch: { name: '甲' },
        expectedRevision: 1,
        idempotencyKey: id('a'),
      }),
      other.update(h.bob, {
        configId: h.registered.configId,
        patch: { name: '乙' },
        expectedRevision: 1,
        idempotencyKey: id('b'),
      }),
    ]);
    assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
    const actual = await h.app.configs.get(h.registered.configId);
    assert.ok(actual.config.environment.values.FIXTURE_AUDIT);
    const path = join(h.app.dataDir, 'config/agents', `${actual.id}.json`);
    const file = await readFile(path, 'utf8');
    const edited = file.replace(actual.config.name, '人工未应用');
    await writeFile(path, edited);
    const response = await h.app.configs.update(h.alice, {
      configId: actual.id,
      patch: { name: '第三次' },
      expectedRevision: actual.revision,
      idempotencyKey: id('update'),
    });
    assert.equal(response.exportPending, true);
    assert.equal(await readFile(path, 'utf8'), edited);
  } finally {
    await store.close();
    await h.cleanup();
  }
});

void test('REV-001: 任务准入和认证共用生命周期仲裁', { timeout: 20_000 }, async () => {
  const h = await harness('http', { FIXTURE_AUTH_DELAY: '200' });
  try {
    const session = await h.session();
    h.app.attachedChannels.add(h.alice.principalId);
    let entered!: () => void;
    const admission = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.app.tasks.capacityCleanup = async () => {
      entered();
      await paused;
    };
    const taskPromise = h.app.tasks.submit(h.alice, {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'slow' }],
      idempotencyKey: id('task'),
    });
    await admission;
    const runtime = await h.app.runtimes.get(h.alice, session.runtimeId);
    const accepted = await h.app.auth.authenticate(h.alice, {
      sessionId: session.sessionId,
      expectedRevision: runtime.revision,
      expectedConnectionGeneration: runtime.connectionGeneration,
      methodId: 'memory',
      interactionChannel: 'local_cli',
      idempotencyKey: id('auth'),
    });
    release();
    const task = await taskPromise;
    const operation = await until(async () => {
      const value = await h.app.operations.get(h.alice, accepted.operationId);
      return value.state === 'failed' ? value : null;
    });
    assert.equal(operation.error?.code, 'SESSION_BUSY');
    await h.app.tasks.cancel(h.alice, task.taskId);
    const audit = await readFile(join(h.path, 'audit.jsonl'), 'utf8');
    assert.equal(audit.includes('"method":"authenticate"'), false);
  } finally {
    await h.cleanup();
  }
});

void test('AC-026/027: 已接受取消的清理不受随后移交阻断', { timeout: 20_000 }, async () => {
  const h = await harness();
  try {
    const session = await h.session();
    const task = await h.app.tasks.submit(h.alice, {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'slow' }],
      idempotencyKey: id('task'),
    });
    await until(async () => (await h.app.tasks.get(h.alice, task.taskId)).state === 'running');
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancelOriginal = h.app.tasks.cancelInteractions;
    h.app.tasks.cancelInteractions = async (...args) => {
      entered();
      await gate;
      await cancelOriginal(...args);
    };
    const cancellation = h.app.tasks.cancel(h.alice, task.taskId);
    await reached;
    const before = await h.app.sessions.get(h.alice, session.sessionId);
    await h.app.sessions.ownership(h.alice, 'transfer', {
      sessionId: before.id,
      targetPrincipalId: h.bob.principalId,
      expectedRevision: before.revision,
      idempotencyKey: id('transfer'),
    });
    release();
    assert.equal((await cancellation).accepted, true);
    assert.equal((await h.taskDone(task.taskId, h.bob)).state, 'cancelled');
    assert.ok(
      (await readFile(join(h.path, 'audit.jsonl'), 'utf8')).includes('"method":"session/cancel"'),
    );
  } finally {
    await h.cleanup();
  }
});
