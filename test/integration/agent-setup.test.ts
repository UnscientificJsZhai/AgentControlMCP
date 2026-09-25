import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { createMcpTools } from '../../src/transport/mcp/catalog.js';
import { invoke } from '../../src/transport/mcp/tools.js';
import { agentConfig } from '../../src/domain/schemas.js';
import type { WorkRecord, InstallationRecord, ConfigRecord } from '../../src/domain/models.js';
import { terminalStates } from '../../src/domain/models.js';
import { setupHarness } from '../helpers/agent-setup.js';
import { harness, until } from '../helpers/harness.js';
import { id, now } from '../../src/domain/ids.js';
import { fingerprint } from '../../src/adapters/local/codex.js';
import type { LocalCandidate } from '../../src/adapters/local/codex.js';

void test('接入注册和更新幂等重试先于环境预检，不依赖环境仍然可用', async () => {
  const h = await harness();
  try {
    const definitions = createMcpTools(h.app);
    const file = join(h.path, 'private.env');
    await writeFile(file, 'TEST_VALUE=fixture-value\n', { mode: 0o600 });
    const existing = (await h.app.configs.get(h.registered.configId)).config;
    const input = {
      action: 'register',
      arguments: {
        config: {
          ...existing,
          name: '重放测试',
          environment: {
            values: { TEST_VALUE: { kind: 'env_file', path: file, key: 'TEST_VALUE' } },
          },
        },
        idempotencyKey: 'register-once',
      },
    };
    const result = await invoke(h.app, definitions, h.alice, 'setup_agent', input);
    assert.ok(result.ok, JSON.stringify(result));
    const created = result.data as { configId: string; revision: number };
    const update = {
      action: 'update',
      arguments: {
        configId: created.configId,
        expectedRevision: 1,
        patch: { name: '已更新' },
        idempotencyKey: 'update-once',
      },
    };
    const firstUpdate = await invoke(h.app, definitions, h.alice, 'setup_agent', update);
    assert.equal(firstUpdate.ok, true);
    await rm(file);
    const registerReplay = await invoke(h.app, definitions, h.alice, 'setup_agent', input);
    assert.ok(registerReplay.ok, JSON.stringify(registerReplay));
    assert.deepEqual(registerReplay.data, { configId: created.configId, revision: 1 });
    const updateReplay = await invoke(h.app, definitions, h.alice, 'setup_agent', update);
    assert.equal(updateReplay.ok, true, JSON.stringify(updateReplay));
    assert.equal((await h.app.configs.get(created.configId)).revision, 2);
    assert.equal((await h.app.configs.list()).length, 2);
    const fresh = await invoke(h.app, definitions, h.alice, 'setup_agent', {
      action: 'register',
      arguments: {
        config: {
          ...existing,
          name: '全新失效配置',
          environment: {
            values: { TEST_VALUE: { kind: 'env_file', path: file, key: 'TEST_VALUE' } },
          },
        },
        idempotencyKey: 'fresh-fail',
      },
    });
    assert.equal(fresh.ok, false);
  } finally {
    await h.cleanup();
  }
});

void test('下载成功但注册失败保留产物；显式注册不再次下载', { timeout: 40_000 }, async () => {
  const h = await setupHarness();
  try {
    const definitions = createMcpTools(h.app);
    const request = (action: string, args: Record<string, unknown>) =>
      invoke(h.app, definitions, h.app.admin, 'setup_agent', { action, arguments: args });
    const accepted = await request('install', {
      ...h.target,
      profile: {
        ...h.profile,
        mcpServers: [
          { type: 'stdio', name: '禁止递归', command: 'agent-control-mcp', args: [], env: {} },
        ],
      },
      idempotencyKey: 'invalid-register',
    });
    assert.ok(accepted.ok, JSON.stringify(accepted));
    const { operationId } = accepted.data as { operationId: string };
    const failed = await until(async () => {
      const operation = await h.app.operations.get(h.app.admin, operationId);
      return terminalStates.has(operation.state) ? operation : null;
    }, 30_000);
    assert.equal(failed.state, 'failed', JSON.stringify(failed));
    assert.equal(failed.error?.code, 'CONFIG_INVALID');
    const installation = (await h.app.installations.list())[0]!;
    assert.equal(installation.state, 'ready');
    assert.equal(
      (failed.error as { details: { installationId: string } }).details.installationId,
      installation.id,
    );
    assert.equal((await h.app.configs.list()).length, 0);
    assert.equal(
      h.app.availability.phase(h.app.admin, await h.app.availability.snapshot()),
      'bootstrap',
    );
    const registered = await request('register', {
      config: {
        ...h.profile,
        origin: { kind: 'manual' },
        launch: { kind: 'installation', installationId: installation.id },
      },
      idempotencyKey: 'reuse-installation',
    });
    assert.equal(registered.ok, true, JSON.stringify(registered));
    assert.equal(h.downloads, 1);
    assert.equal(
      h.app.availability.phase(h.app.admin, await h.app.availability.snapshot()),
      'ready',
    );
    let changes = 0;
    const stop = await h.app.availability.observe(() => changes++);
    await rm(installation.prefixArgs.at(-1)!);
    await until(() => changes >= 1);
    assert.equal(
      h.app.availability.phase(h.app.admin, await h.app.availability.snapshot()),
      'bootstrap',
    );
    stop();
  } finally {
    await h.cleanup();
  }
});

void test(
  '并发接入共享安装但独立取消；提交终态、权限和幂等保持一致',
  { timeout: 40_000 },
  async () => {
    const h = await setupHarness();
    try {
      const a = await h.app.identities.registerAnonymous('alice');
      const b = await h.app.identities.registerAnonymous('bob');
      const profile = agentConfig.omit({ origin: true, launch: true }).parse(h.profile);
      const input = { ...h.target, profile, idempotencyKey: 'install-a' };
      h.holdDownloads();
      const first = await h.app.setup.install(a, input);
      const secondInput = {
        ...input,
        profile: { ...profile, name: '保留的 profile' },
        idempotencyKey: 'install-b',
      };
      const second = await h.app.setup.install(b, secondInput);
      await until(async () => {
        const operations = await Promise.all([
          h.app.operations.get(a, first.operationId),
          h.app.operations.get(b, second.operationId),
        ]);
        return h.downloads === 1 && operations.every((op) => op.step === 'npm_install');
      });
      await assert.rejects(h.app.setup.wait(a, { operationId: second.operationId, timeoutMs: 0 }), {
        code: 'OBJECT_NOT_FOUND',
      });
      await assert.rejects(h.app.operations.cancel(a, second.operationId), {
        code: 'OBJECT_NOT_FOUND',
      });
      await h.app.operations.cancel(a, first.operationId);
      h.releaseDownload();
      const terminal = async (operationId: string, ctx: typeof a) =>
        until(async () => {
          const value = await h.app.operations.get(ctx, operationId);
          return terminalStates.has(value.state) ? value : null;
        }, 30_000);
      assert.equal((await terminal(first.operationId, a)).state, 'cancelled');
      const completed = await terminal(second.operationId, b);
      assert.equal(completed.state, 'completed', JSON.stringify(completed));
      assert.equal(completed.commitState, 'committed');
      assert.equal(h.downloads, 1);
      const records = await h.app.configs.list();
      assert.equal(records.length, 1);
      assert.equal(records[0]!.config.name, '保留的 profile');
      assert.deepEqual(await h.app.setup.install(b, secondInput), second);
      await assert.rejects(
        h.app.setup.install(b, { ...secondInput, profile: { ...profile, name: '冲突' } }),
        { code: 'IDEMPOTENCY_CONFLICT' },
      );
    } finally {
      await h.cleanup();
    }
  },
);

void test(
  '提交后的投影失败不会丢失成功 operation 或产生第二份配置',
  { timeout: 40_000 },
  async () => {
    const h = await setupHarness();
    try {
      const profile = agentConfig.omit({ origin: true, launch: true }).parse(h.profile);
      let projectedRecord: ConfigRecord | undefined;
      const project = h.app.configs.project.bind(h.app.configs);
      h.app.configs.project = (record) => {
        projectedRecord = record;
        return Promise.reject(new Error('模拟提交后进程中断'));
      };
      const input = { ...h.target, profile, idempotencyKey: id('atomic') };
      const accepted = await h.app.setup.install(h.app.admin, input);
      await until(() => projectedRecord !== undefined);
      const committed = (await h.app.store.list<WorkRecord>('operation')).find(
        (op) => op.type === 'agent_setup_install',
      );
      assert.ok(committed);
      assert.equal(committed.state, 'completed');
      assert.equal(committed.commitState, 'committed');
      assert.ok(projectedRecord);
      assert.equal((await h.app.configs.get(projectedRecord.id)).config.name, profile.name);
      const events = await h.app.store.readEvents({
        streamId: committed.id,
        after: '0',
        limit: 100,
      });
      assert.equal((events.items.at(-1)?.payload as { state: string }).state, 'completed');
      const result = (await h.app.operations.get(h.app.admin, accepted.operationId)).result as {
        configId: string;
        installationId: string;
      };
      assert.equal((await h.app.configs.get(result.configId)).config.launch.kind, 'installation');
      assert.equal(
        (await h.app.store.get<InstallationRecord>('installation', result.installationId))?.state,
        'ready',
      );
      h.app.configs.project = project;
      assert.deepEqual(await h.app.setup.install(h.app.admin, input), accepted);
      assert.equal((await h.app.configs.list()).length, 1);
      assert.equal(h.downloads, 1);
      const opEvents = await h.app.store.readEvents({
        streamId: accepted.operationId,
        after: '0',
        limit: 100,
      });
      assert.equal(
        opEvents.items.filter((event) => (event.payload as { state: string }).state === 'completed')
          .length,
        1,
      );
    } finally {
      await h.cleanup();
    }
  },
);

void test(
  '安装器失败不发布 profile，固定目录中的创建工具仍拒绝执行',
  { timeout: 40_000 },
  async () => {
    const h = await setupHarness();
    try {
      h.failDownloads();
      const accepted = await h.app.setup.install(h.app.admin, {
        ...h.target,
        profile: agentConfig.omit({ origin: true, launch: true }).parse(h.profile),
        idempotencyKey: 'failed-download',
      });
      const failed = await until(async () => {
        const value = await h.app.operations.get(h.app.admin, accepted.operationId);
        return terminalStates.has(value.state) ? value : null;
      }, 30_000);
      assert.equal(failed.state, 'failed');
      assert.equal((await h.app.configs.list()).length, 0);
      assert.equal((await h.app.installations.list()).length, 0);
      const phase = h.app.availability.phase(h.app.admin, await h.app.availability.snapshot());
      assert.equal(phase, 'bootstrap');
      const response = await invoke(h.app, createMcpTools(h.app), h.app.admin, 'spawn_agent', {
        requestId: 'after-failed-install',
        taskName: 'blocked',
        message: '不能隐式接入',
      });
      assert.equal(response.ok, false);
      if (!response.ok) assert.equal(response.error.code, 'AGENT_SETUP_REQUIRED');
      assert.equal(h.downloads, 1);
    } finally {
      await h.cleanup();
    }
  },
);

void test('本地复用重新绑定新指纹，并原子提交成功事件和配置', { timeout: 40_000 }, async () => {
  const h = await setupHarness();
  try {
    const path = join(h.root, 'codex-fixture');
    await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const candidate: LocalCandidate = {
      id: id('candidate'),
      revision: 1,
      createdAt: now(),
      path,
      aliases: [path],
      fingerprint: await fingerprint(path),
      version: 'fixture',
      probeStatus: 'available',
      compatibility: 'unknown',
      evidence: '隔离的本地候选 fixture',
    };
    await h.app.store.put('local_candidate', candidate);
    const planArgs = {
      candidateId: candidate.id,
      sourceId: h.target.sourceId,
      registryAgentId: 'codex-acp',
      targetVersion: h.target.targetVersion,
    };
    const firstPlan = await h.app.local.plan(h.app.admin, {
      ...planArgs,
      target: {
        kind: 'new',
        config: agentConfig.omit({ origin: true, launch: true }).parse(h.profile),
      },
    });
    assert.equal(h.downloads, 0);
    const apply = async (plan: { planId: string; planDigest: string }, key: string) => {
      const args = {
        planId: plan.planId,
        planDigest: plan.planDigest,
        acceptUnknownCompatibility: true,
        idempotencyKey: key,
      };
      const accepted = await h.app.local.apply(h.app.admin, args);
      const operation = await until(async () => {
        const value = await h.app.operations.get(h.app.admin, accepted.operationId);
        return terminalStates.has(value.state) ? value : null;
      }, 30_000);
      assert.equal(operation.state, 'completed', JSON.stringify(operation));
      assert.equal(operation.commitState, 'committed');
      assert.deepEqual(await h.app.local.apply(h.app.admin, args), accepted);
      const events = await h.app.store.readEvents({
        streamId: accepted.operationId,
        after: '0',
        limit: 100,
      });
      assert.equal(
        events.items.filter((event) => (event.payload as { state: string }).state === 'completed')
          .length,
        1,
      );
      return operation.result as { configId: string; revision: number };
    };
    const first = await apply(firstPlan, 'bind-first');
    await writeFile(path, '#!/bin/sh\n# 新的本地版本\nexit 0\n');
    const updated = { ...candidate, revision: 2, fingerprint: await fingerprint(path) };
    assert.equal(
      (
        await h.app.availability.inspect(
          (await h.app.configs.get(first.configId)).config,
          first.configId,
        )
      ).ready,
      false,
    );
    await h.app.store.put('local_candidate', updated);
    const nextPlan = await h.app.local.plan(h.app.admin, {
      ...planArgs,
      target: { kind: 'existing', configId: first.configId, expectedRevision: first.revision },
    });
    const second = await apply(nextPlan, 'bind-new-fingerprint');
    assert.equal(second.configId, first.configId);
    assert.equal(second.revision, first.revision + 1);
    const record = await h.app.configs.get(second.configId);
    assert.equal((await h.app.availability.inspect(record.config, record.id)).ready, true);
    assert.equal((await h.app.configs.list()).length, 1);
    assert.equal(h.downloads, 1);
    const stalePlan = await h.app.local.plan(h.app.admin, {
      ...planArgs,
      target: { kind: 'existing', configId: record.id, expectedRevision: record.revision },
    });
    await h.app.configs.update(h.app.admin, {
      configId: record.id,
      expectedRevision: record.revision,
      patch: { name: '保留并发修改' },
      idempotencyKey: 'concurrent-change',
    });
    const rejected = await h.app.local.apply(h.app.admin, {
      planId: stalePlan.planId,
      planDigest: stalePlan.planDigest,
      acceptUnknownCompatibility: true,
      idempotencyKey: 'reject-stale-plan',
    });
    const failed = await until(async () => {
      const op = await h.app.operations.get(h.app.admin, rejected.operationId);
      return terminalStates.has(op.state) ? op : null;
    });
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error?.code, 'REVISION_CONFLICT');
    assert.ok(failed.error?.details?.installationId);
    assert.match(failed.error?.nextAction ?? '', /安装产物已保留/);
    assert.equal((await h.app.configs.get(record.id)).config.name, '保留并发修改');
    assert.equal(h.downloads, 1);
  } finally {
    await h.cleanup();
  }
});
