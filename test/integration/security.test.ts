import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { harness, until } from '../helpers/harness.js';
import { id } from '../../src/domain/ids.js';
import { adminCommand } from '../../src/transport/admin/commands.js';
import { createTools, invoke } from '../../src/transport/mcp/tools.js';
import type { RuntimeRecord } from '../../src/domain/models.js';
import { SettingsService } from '../../src/application/settings-service.js';
import { RecoveryAdminService } from '../../src/application/recovery-admin-service.js';
import { SqliteStore } from '../../src/infrastructure/storage/sqlite-store.js';
import { fingerprint } from '../../src/adapters/local/codex.js';
import { now } from '../../src/domain/ids.js';

void test('AC-022: 绑定的本地文件丢失后明确失败并保留原配置', async () => {
  const h = await harness();
  try {
    const path = join(h.path, 'codex-test');
    await writeFile(path, 'test executable', { mode: 0o700 });
    const identity = await fingerprint(path);
    await h.app.store.put('local_binding', {
      id: h.registered.configId,
      revision: 1,
      createdAt: now(),
      candidate: { path, fingerprint: identity },
    });
    const original = await h.app.configs.get(h.registered.configId);
    await h.app.configs.update(h.alice, {
      configId: original.id,
      expectedRevision: original.revision,
      patch: {
        environment: {
          ...original.config.environment,
          values: {
            ...original.config.environment.values,
            CODEX_PATH: { kind: 'literal', value: path },
          },
        },
      },
      idempotencyKey: id('bind'),
    });
    await rm(path);
    const accepted = await h.app.runtimes.prepare(h.alice, {
      configId: original.id,
      idempotencyKey: id('prepare'),
    });
    const operation = await until(async () => {
      const current = await h.app.operations.get(h.alice, accepted.operationId);
      return current.state === 'failed' ? current : null;
    });
    assert.equal(operation.error?.code, 'LOCAL_EXECUTABLE_UNAVAILABLE');
    assert.deepEqual((await h.app.configs.get(original.id)).config.environment.values.CODEX_PATH, {
      kind: 'literal',
      value: path,
    });
    assert.equal((await h.app.store.list('runtime_slot')).length, 0);
  } finally {
    await h.cleanup();
  }
});

void test(
  'AC-021: 外置大内容计入容量，活动任务保护仍在，其他归属占用不泄漏',
  { timeout: 20_000 },
  async () => {
    const h = await harness();
    try {
      const first = await h.session();
      const second = await h.session();
      const task = await h.app.tasks.submit(h.alice, {
        sessionId: first.sessionId,
        prompt: [{ type: 'text', text: 'slow large' }],
        idempotencyKey: id('large'),
      });
      await until(async () => (await h.app.history.usage(h.alice)).contentBytes > 100_000);
      assert.equal((await h.app.history.usage(h.bob)).contentBytes, 0);
      h.app.settings.historyMaxBytes = 100_000;
      await assert.rejects(
        h.app.tasks.submit(h.alice, {
          sessionId: second.sessionId,
          prompt: [{ type: 'text', text: 'must-not-run' }],
          idempotencyKey: id('blocked'),
        }),
        { code: 'STORAGE_FULL' },
      );
      assert.equal((await h.app.tasks.get(h.alice, task.taskId)).state, 'running');
    } finally {
      await h.cleanup();
    }
  },
);

for (const action of ['cancel', 'shutdown'] as const)
  void test(
    `AC-006/025/027: 终端认证重连初始化期间 ${action} 不遗留新进程`,
    { timeout: 20_000 },
    async () => {
      const h = await harness('http', { FIXTURE_INIT_DELAY: '700' });
      try {
        h.app.attachedChannels.add(h.alice.principalId);
        const runtime = await h.operation<RuntimeRecord>(
          h.app.runtimes.prepare(h.alice, {
            configId: h.registered.configId,
            interactionChannel: 'local_cli',
            idempotencyKey: id('prepare'),
          }),
        );
        const accepted = await h.app.auth.authenticate(h.alice, {
          runtimeId: runtime.id,
          expectedRevision: runtime.revision,
          expectedConnectionGeneration: 1,
          methodId: 'terminal',
          interactionChannel: 'local_cli',
          idempotencyKey: id('auth'),
        });
        const interaction = await until(
          async () =>
            (
              await h.app.interactions.list(h.alice, { operationId: accepted.operationId }, false)
            )[0],
        );
        const response = { action: 'accept' as const, content: { exitCode: 0 } };
        await h.app.interactions.respondInteraction(h.alice, {
          interactionId: interaction.id,
          expectedRevision: interaction.revision,
          idempotencyKey: id('respond'),
          ...response,
          presentationReceipt: h.app.interactions.receipt(h.alice, interaction.id, response),
        });
        const spawned = await until(async () => {
          const lines = (await readFile(join(h.path, 'audit.jsonl'), 'utf8'))
            .split('\n')
            .filter(Boolean)
            .map((line: string) => JSON.parse(line) as { method?: string; pid: number })
            .filter((item) => item.method === 'initialize');
          return lines.length === 2 ? lines[1] : null;
        });
        if (action === 'shutdown') await h.app.close();
        else {
          await h.app.operations.cancel(h.alice, accepted.operationId);
          await until(
            async () => (await h.app.runtimes.get(h.alice, runtime.id)).state === 'closed',
          );
        }
        await until(() => {
          try {
            process.kill(spawned.pid, 0);
            return Promise.resolve(false);
          } catch (error) {
            return Promise.resolve((error as NodeJS.ErrnoException).code === 'ESRCH');
          }
        });
        assert.equal(h.app.runtimes.live.has(runtime.id), false);
        const store =
          action === 'shutdown'
            ? await SqliteStore.open(join(h.app.dataDir, 'state/state.db'))
            : h.app.store;
        try {
          assert.equal((await store.get<RuntimeRecord>('runtime', runtime.id))?.state, 'closed');
          assert.equal((await store.list('runtime_slot')).length, 0);
        } finally {
          if (action === 'shutdown') await store.close();
        }
      } finally {
        await h.cleanup();
      }
    },
  );

void test(
  'AC-025/027: 终端认证取消后保持终态，死连接退役并释放槽位',
  { timeout: 20_000 },
  async () => {
    const h = await harness();
    try {
      h.app.attachedChannels.add(h.alice.principalId);
      const runtime = await h.operation<RuntimeRecord>(
        h.app.runtimes.prepare(h.alice, {
          configId: h.registered.configId,
          interactionChannel: 'local_cli',
          idempotencyKey: id('prepare'),
        }),
      );
      const accepted = await h.app.auth.authenticate(h.alice, {
        runtimeId: runtime.id,
        expectedRevision: runtime.revision,
        expectedConnectionGeneration: 1,
        methodId: 'terminal',
        interactionChannel: 'local_cli',
        idempotencyKey: id('auth'),
      });
      const interaction = await until(
        async () =>
          (await h.app.interactions.list(h.alice, { operationId: accepted.operationId }, false))[0],
      );
      await assert.rejects(
        adminCommand(h.app, '_present_receipt', {
          interactionId: interaction.id,
          response: { action: 'accept', content: { exitCode: 0 } },
        }),
        { code: 'INTERACTION_CHANNEL_UNAVAILABLE' },
      );
      await h.app.operations.cancel(h.alice, accepted.operationId);
      await until(
        async () =>
          (await h.app.operations.get(h.alice, accepted.operationId)).state === 'cancelled',
      );
      await delay(100);
      assert.equal((await h.app.operations.get(h.alice, accepted.operationId)).state, 'cancelled');
      assert.equal((await h.app.runtimes.get(h.alice, runtime.id)).state, 'closed');
      assert.equal((await h.app.store.list('runtime_slot')).length, 0);
    } finally {
      await h.cleanup();
    }
  },
);

void test('AC-026: 内容读取返回前复核移交 ACL，control 权限不授予清理所有权', async () => {
  const h = await harness();
  try {
    const session = await h.session();
    const content = (await h.app.events.externalize(session.sessionId, {
      text: 'large'.repeat(20000),
    })) as { contentId: string };
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = h.app.events.content.bind(h.app.events);
    h.app.events.content = async (...args) => {
      entered();
      await paused;
      return original(...args);
    };
    const request = invoke(h.app, createTools(h.app), h.alice, 'content_read', {
      objectType: 'session',
      objectId: session.sessionId,
      contentId: content.contentId,
    });
    await reached;
    let current = await h.app.sessions.get(h.alice, session.sessionId);
    await h.app.sessions.ownership(h.alice, 'share', {
      sessionId: current.id,
      principalId: h.bob.principalId,
      access: 'control',
      expectedRevision: current.revision,
      idempotencyKey: id('share'),
    });
    assert.equal(
      (await h.app.history.plan(h.bob, { scope: { kind: 'operations' } })).candidates.length,
      0,
    );
    current = await h.app.sessions.get(h.alice, current.id);
    await h.app.sessions.ownership(h.alice, 'transfer', {
      sessionId: current.id,
      targetPrincipalId: h.bob.principalId,
      expectedRevision: current.revision,
      idempotencyKey: id('transfer'),
    });
    release();
    const result = await request;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'SESSION_NOT_FOUND');
  } finally {
    await h.cleanup();
  }
});

void test('AC-013/024: 编辑入口保留人工草稿，编辑副本失败不覆盖原文', async () => {
  const h = await harness();
  try {
    const path = join(h.app.dataDir, 'config/agents', `${h.registered.configId}.json`);
    const draft = (await readFile(path, 'utf8')).replace('独立 ACP fixture', '人工草稿');
    await writeFile(path, draft);
    const editor = (await adminCommand(h.app, '_config_edit', {
      configId: h.registered.configId,
    })) as { path: string };
    assert.notEqual(editor.path, path);
    assert.equal(await readFile(editor.path, 'utf8'), draft);
    assert.equal(await readFile(path, 'utf8'), draft);
    await rm(dirname(editor.path), { recursive: true, force: true });
  } finally {
    await h.cleanup();
  }
});

void test(
  'AC-025/027: 控制槽阻止认证，取消认证关闭仍执行请求的连接',
  { timeout: 20_000 },
  async () => {
    const h = await harness('http', { FIXTURE_CONTROL_DELAY: '250', FIXTURE_AUTH_DELAY: '2000' });
    try {
      const session = await h.session();
      h.app.attachedChannels.add(h.alice.principalId);
      const current = await h.app.sessions.get(h.alice, session.sessionId);
      const control = h.app.sessions.setMode(h.alice, {
        sessionId: session.sessionId,
        modeId: 'code',
        expectedRevision: current.revision,
        idempotencyKey: id('mode'),
      });
      await until(async () =>
        (await readFile(join(h.path, 'audit.jsonl'), 'utf8')).includes(
          '"method":"session/set_mode"',
        ),
      );
      let runtime = await h.app.runtimes.get(h.alice, session.runtimeId);
      const blocked = await h.app.auth.authenticate(h.alice, {
        sessionId: session.sessionId,
        expectedRevision: runtime.revision,
        expectedConnectionGeneration: runtime.connectionGeneration,
        methodId: 'memory',
        interactionChannel: 'local_cli',
        idempotencyKey: id('auth'),
      });
      const failed = await until(async () => {
        const op = await h.app.operations.get(h.alice, blocked.operationId);
        return op.state === 'failed' ? op : null;
      });
      assert.equal(failed.error?.code, 'SESSION_BUSY');
      await control;
      runtime = await h.app.runtimes.get(h.alice, session.runtimeId);
      const accepted = await h.app.auth.authenticate(h.alice, {
        sessionId: session.sessionId,
        expectedRevision: runtime.revision,
        expectedConnectionGeneration: runtime.connectionGeneration,
        methodId: 'memory',
        interactionChannel: 'local_cli',
        idempotencyKey: id('auth'),
      });
      await until(async () =>
        (await readFile(join(h.path, 'audit.jsonl'), 'utf8')).includes('"method":"authenticate"'),
      );
      await h.app.operations.cancel(h.alice, accepted.operationId);
      await until(async () => (await h.app.runtimes.get(h.alice, runtime.id)).state === 'closed');
      await assert.rejects(
        h.app.tasks.submit(h.alice, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'must-not-run' }],
          idempotencyKey: id('task'),
        }),
      );
    } finally {
      await h.cleanup();
    }
  },
);

void test('AC-013/018/019/024: 身份轮换原子撤销旧凭据，服务文档 CAS，孤儿处置不误杀', async () => {
  const h = await harness();
  try {
    const original = await h.app.identities.create('测试身份');
    const current = await h.app.identities.authenticate(`Bearer ${original.token}`);
    const rotated = await h.app.identities.issue(original.principalId, true);
    assert.equal(rotated.principalId, original.principalId);
    await assert.rejects(h.app.identities.check(current), { code: 'UNAUTHENTICATED' });
    await h.app.identities.authenticate(`Bearer ${rotated.token}`);
    const settings = new SettingsService(h.app.store, h.app.dataDir);
    const doc = await settings.document();
    await settings.apply({ ...doc, value: { ...doc.value, retentionDays: 7 } });
    await assert.rejects(settings.apply(doc), { code: 'REVISION_CONFLICT' });
    assert.equal((await settings.document()).value.retentionDays, 7);
    await assert.rejects(
      settings.apply({
        ...(await settings.document()),
        value: { ...doc.value, httpHost: '0.0.0.0', httpAuth: 'none' },
      }),
      { code: 'CONFIG_INVALID' },
    );
    await assert.rejects(
      new RecoveryAdminService(h.app).resolve({
        instanceId: h.app.instance.id,
        expectedRevision: h.app.instance.revision,
      }),
      { code: 'RECOVERY_CONFLICT' },
    );
    assert.equal((await h.app.history.usage(h.bob)).contentBytes, 0);
  } finally {
    await h.cleanup();
  }
});
