import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../helpers/harness.js';
import { id } from '../../src/domain/ids.js';
import { createMcpTools } from '../../src/transport/mcp/catalog.js';
import { invoke } from '../../src/transport/mcp/tools.js';

void test('管理入口保留原操作的参数校验、幂等、修订和单层返回', async () => {
  const h = await harness();
  try {
    const definitions = createMcpTools(h.app, 'legacy');
    const request = (name: string, args: unknown) =>
      invoke(h.app, definitions, h.alice, name, args);
    const config = (await h.app.configs.get(h.registered.configId)).config;
    const args = { config: { ...config, name: '经管理入口注册' }, idempotencyKey: id('register') };
    const created = await request('management_write', {
      action: 'agent_register',
      arguments: args,
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    if (!created.ok) assert.fail();
    const data = created.data as { configId: string; revision: number };
    assert.ok(data.configId);
    assert.equal(data.revision, 1);
    assert.deepEqual(Object.keys(created).sort(), ['data', 'meta', 'ok']);
    assert.equal('ok' in data, false);
    assert.ok(created.meta.requestId);
    const replay = await request('management_write', { action: 'agent_register', arguments: args });
    assert.equal(replay.ok, true);
    const replayData = { configId: data.configId, revision: data.revision };
    // 首次注册额外报告文件投影；重放只返回已持久化的标识和修订。
    if (replay.ok) assert.deepEqual(replay.data, replayData);
    // 旧内部调用与新入口共用同一个幂等操作名称。
    assert.deepEqual(await h.call('agent_register', args), replayData);
    assert.equal(
      (await h.app.configs.list()).filter((item) => item.id === data.configId).length,
      1,
    );

    const update = {
      configId: data.configId,
      patch: { name: '经管理入口更新' },
      expectedRevision: 1,
      idempotencyKey: id('update'),
    };
    const updated = await request('management_write', {
      action: 'agent_update',
      arguments: update,
    });
    assert.equal(updated.ok, true);
    assert.equal((await h.app.configs.get(data.configId)).config.name, update.patch.name);
    const conflict = await request('management_write', {
      action: 'agent_update',
      arguments: { ...update, idempotencyKey: id('conflict') },
    });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.error.code, 'REVISION_CONFLICT');

    const before = await h.app.configs.list();
    for (const [name, input] of [
      ['management_read', { action: 'agent_register', arguments: args }],
      ['management_write', { action: 'agent_remove', arguments: {} }],
      ['management_write', { action: '_identity_create', arguments: { name: '禁止' } }],
      ['management_write', { action: 'management_write', arguments: {} }],
      ['management_write', { action: 'task_submit', arguments: {} }],
      ['management_write', { action: 'missing', arguments: {} }],
      ['management_write', { action: 'agent_register', arguments: { ...args, extra: true } }],
      ['management_write', { action: 'agent_register', arguments: { config: {} } }],
      ['agent_register', args],
    ] as const) {
      const result = await request(name, input);
      assert.equal(result.ok, false, JSON.stringify(input));
      if (!result.ok) assert.equal(result.error.code, 'CONFIG_INVALID');
    }
    assert.deepEqual(await h.app.configs.list(), before);
    const invalid = await request('management_write', {
      action: 'agent_register',
      arguments: { config: {} },
    });
    if (invalid.ok) assert.fail();
    assert.ok('details' in invalid.error && 'issues' in invalid.error.details);
  } finally {
    await h.cleanup();
  }
});

void test('破坏性入口保留引用保护及历史清理计划校验', { timeout: 20_000 }, async () => {
  const h = await harness();
  try {
    const definitions = createMcpTools(h.app, 'legacy');
    const request = (action: string, args: unknown) =>
      invoke(h.app, definitions, h.alice, 'management_destructive', { action, arguments: args });
    const session = await h.session();
    const removed = await request('agent_remove', {
      configId: h.registered.configId,
      expectedRevision: 1,
      idempotencyKey: id('remove'),
    });
    assert.equal(removed.ok, false);
    if (!removed.ok) assert.equal(removed.error.code, 'OBJECT_IN_USE');

    const task = await h.app.tasks.submit(h.alice, {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: '清理验收' }],
      idempotencyKey: id('task'),
    });
    assert.equal((await h.taskDone(task.taskId)).state, 'completed');
    const preview = await request('history_cleanup', {
      scope: { kind: 'tasks', sessionId: session.sessionId },
      idempotencyKey: id('plan'),
    });
    if (!preview.ok) assert.fail(JSON.stringify(preview));
    const plan = preview.data as {
      cleanupPlanId: string;
      planDigest: string;
      dryRun: boolean;
      candidates: { id: string }[];
    };
    assert.equal(plan.dryRun, true);
    assert.ok(plan.candidates.some((item) => item.id === task.taskId));
    const bad = await request('history_cleanup', {
      mode: 'apply',
      cleanupPlanId: plan.cleanupPlanId,
      planDigest: '错误摘要',
      idempotencyKey: id('bad'),
    });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.error.code, 'PLAN_CHANGED');
    const applied = await request('history_cleanup', {
      mode: 'apply',
      cleanupPlanId: plan.cleanupPlanId,
      planDigest: plan.planDigest,
      idempotencyKey: id('apply'),
    });
    if (!applied.ok) assert.fail(JSON.stringify(applied));
    assert.equal((applied.data as { dryRun: boolean }).dryRun, false);
    assert.equal((await h.app.history.get(h.alice, 'task', task.taskId)).purged, true);
    const current = await h.app.sessions.get(h.alice, session.sessionId);
    await h.operation(
      h.app.sessions.close(h.alice, {
        sessionId: current.id,
        expectedRevision: current.revision,
        idempotencyKey: id('close'),
      }),
    );
    const deleted = await request('agent_remove', {
      configId: h.registered.configId,
      expectedRevision: 1,
      idempotencyKey: id('delete'),
    });
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
  } finally {
    await h.cleanup();
  }
});

void test(
  '管理查询完成 ACL 复核后不会因外层异步检查泄露已移交的数据',
  { timeout: 20_000 },
  async () => {
    const h = await harness();
    try {
      const session = await h.session();
      const task = await h.app.tasks.submit(h.alice, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '移交后不得返回的历史' }],
        idempotencyKey: id('task'),
      });
      await h.taskDone(task.taskId);
      let reads = 0;
      let transferred = false;
      const get = h.app.history.get.bind(h.app.history);
      h.app.history.get = async (...args) => {
        const data = await get(...args);
        reads++;
        return data;
      };
      const check = h.app.identities.check.bind(h.app.identities);
      h.app.identities.check = async (ctx) => {
        await check(ctx);
        // 若错误地嵌套执行，内层读取和 ACL 复核完成后还会进入外层身份检查。
        if (reads >= 2 && !transferred) {
          const current = await h.app.sessions.get(h.alice, session.sessionId);
          await h.app.sessions.ownership(h.alice, 'transfer', {
            sessionId: current.id,
            targetPrincipalId: h.bob.principalId,
            expectedRevision: current.revision,
            idempotencyKey: id('transfer'),
          });
          transferred = true;
        }
      };
      const result = await invoke(
        h.app,
        createMcpTools(h.app, 'legacy'),
        h.alice,
        'management_read',
        {
          action: 'history_get',
          arguments: { kind: 'task', id: task.taskId },
        },
      );
      if (transferred) {
        assert.equal(result.ok, false, '身份检查期间已移交的私有历史不得返回');
      } else {
        assert.equal(result.ok, true);
        assert.ok(reads >= 2, '正常查询也必须执行结果 ACL 复核');
      }
    } finally {
      await h.cleanup();
    }
  },
);

for (const action of ['history_get', 'history_list'] as const)
  void test(`管理只读入口 ${action} 在移交期间按原操作复核 ACL`, { timeout: 20_000 }, async () => {
    const h = await harness();
    let release = () => {};
    try {
      const session = await h.session();
      const task = await h.app.tasks.submit(h.alice, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '仅原所有者可见' }],
        idempotencyKey: id('task'),
      });
      await h.taskDone(task.taskId);
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      let first = true;
      const pause = async () => {
        if (!first) return;
        first = false;
        entered();
        await paused;
      };
      if (action === 'history_get') {
        const original = h.app.history.get.bind(h.app.history);
        h.app.history.get = async (...args) => {
          const data = await original(...args);
          await pause();
          return data;
        };
      } else {
        const original = h.app.history.list.bind(h.app.history);
        h.app.history.list = async (...args) => {
          const data = await original(...args);
          await pause();
          return data;
        };
      }
      const definitions = createMcpTools(h.app, 'legacy');
      const pending = invoke(h.app, definitions, h.alice, 'management_read', {
        action,
        arguments: action === 'history_get' ? { kind: 'task', id: task.taskId } : { kind: 'task' },
      });
      await reached;
      const current = await h.app.sessions.get(h.alice, session.sessionId);
      const transferred = await invoke(h.app, definitions, h.alice, 'management_write', {
        action: 'session_transfer',
        arguments: {
          sessionId: current.id,
          targetPrincipalId: h.bob.principalId,
          expectedRevision: current.revision,
          idempotencyKey: id('transfer'),
        },
      });
      assert.equal(transferred.ok, true, JSON.stringify(transferred));
      release();
      const result = await pending;
      if (action === 'history_get') {
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, 'SESSION_NOT_FOUND');
      } else {
        if (!result.ok) assert.fail(JSON.stringify(result));
        assert.deepEqual((result.data as { items: unknown[] }).items, []);
      }
    } finally {
      release();
      await h.cleanup();
    }
  });
