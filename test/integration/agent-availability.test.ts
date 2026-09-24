import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { harness } from '../helpers/harness.js';
import { agentConfig } from '../../src/domain/schemas.js';
import { id } from '../../src/domain/ids.js';
import { createMcpTools } from '../../src/transport/mcp/catalog.js';
import { invoke } from '../../src/transport/mcp/tools.js';
import { which } from '../../src/infrastructure/platform/process-host.js';

void test('可用性检查真实入口、禁用、依赖和环境；查询不运行安装器或 ACP', async () => {
  const h = await harness();
  try {
    h.app.installations.acquire = () => {
      assert.fail('查询不能安装');
    };
    const config = (await h.app.configs.get(h.registered.configId)).config;
    assert.equal((await h.app.availability.inspect(config)).ready, true);
    const directory = join(h.path, 'directory');
    await mkdir(directory);
    for (const patch of [
      { enabled: false },
      { launch: { kind: 'command', executable: process.execPath, args: [] } },
      { launch: { kind: 'command', executable: process.execPath, args: ['--version'] } },
      {
        launch: {
          kind: 'command',
          executable: process.execPath,
          args: ['-e', 'throw Error("不可执行")'],
        },
      },
      {
        launch: {
          kind: 'command',
          executable: process.execPath,
          args: [join(h.path, 'missing.js')],
        },
      },
      { launch: { kind: 'command', executable: directory, args: [] } },
      { launch: { kind: 'command', executable: 'npm', args: ['exec', 'fixture'] } },
      { launch: { kind: 'installation', installationId: 'missing' } },
      {
        environment: {
          values: { TOKEN: { kind: 'env_file', path: join(h.path, 'missing.env'), key: 'TOKEN' } },
        },
      },
      {
        environment: {
          values: { CODEX_PATH: { kind: 'literal', value: join(h.path, 'missing-codex') } },
        },
      },
    ])
      assert.equal(
        (await h.app.availability.inspect(agentConfig.parse({ ...config, ...patch }))).ready,
        false,
        JSON.stringify(patch),
      );
    const npmScript = await which('npx');
    assert.equal(
      (
        await h.app.availability.inspect(
          agentConfig.parse({
            ...config,
            launch: {
              kind: 'command',
              executable: process.execPath,
              args: [npmScript, '--yes', 'uninstalled-agent'],
            },
          }),
        )
      ).ready,
      false,
    );
    if (process.platform !== 'win32') {
      assert.equal(
        (
          await h.app.availability.inspect(
            agentConfig.parse({
              ...config,
              launch: { kind: 'command', executable: '/usr/bin/env', args: [process.execPath] },
            }),
          )
        ).ready,
        false,
      );
      const alias = join(h.path, 'interpreter-alias');
      await symlink(process.execPath, alias);
      assert.equal(
        (
          await h.app.availability.inspect(
            agentConfig.parse({
              ...config,
              launch: { kind: 'command', executable: alias, args: [] },
            }),
          )
        ).ready,
        false,
      );
      for (const name of ['bun', 'deno']) {
        const interpreter = join(h.path, name);
        await symlink(process.execPath, interpreter);
        const script = join(h.path, 'local-agent.js');
        await writeFile(script, 'throw new Error("只读检查不得执行");');
        assert.equal(
          (
            await h.app.availability.inspect(
              agentConfig.parse({
                ...config,
                launch: { kind: 'command', executable: interpreter, args: ['run', script] },
              }),
            )
          ).ready,
          true,
        );
      }
    } else {
      const shim = join(h.path, 'agent.cmd');
      await writeFile(shim, '@echo off\r\n');
      assert.equal(
        (
          await h.app.availability.inspect(
            agentConfig.parse({
              ...config,
              launch: { kind: 'command', executable: shim, args: [] },
            }),
          )
        ).ready,
        false,
      );
    }
    const previousCodex = process.env.CODEX_PATH;
    try {
      process.env.CODEX_PATH = join(h.path, 'missing-inherited-codex');
      assert.equal(
        (
          await h.app.availability.inspect(
            agentConfig.parse({ ...config, environment: { inherit: ['CODEX_PATH'] } }),
          )
        ).ready,
        false,
      );
    } finally {
      if (previousCodex === undefined) delete process.env.CODEX_PATH;
      else process.env.CODEX_PATH = previousCodex;
    }

    await h.app.configs.register(h.alice, {
      config: agentConfig.parse({
        ...config,
        name: '未接入的解释器',
        launch: { kind: 'command', executable: process.execPath, args: [] },
      }),
      idempotencyKey: id('broken'),
    });
    const definitions = createMcpTools(h.app);
    const discovery = await invoke(h.app, definitions, h.alice, 'discover_agents', {});
    assert.ok(discovery.ok, JSON.stringify(discovery));
    const data = discovery.data as { profiles: { ready: boolean }[]; phase: string };
    assert.equal(data.phase, 'ready');
    assert.deepEqual(data.profiles.map((p) => p.ready).sort(), [false, true]);
    assert.equal((await h.app.store.list('local_candidate')).length, 0);

    await h.app.configs.update(h.alice, {
      configId: h.registered.configId,
      expectedRevision: 1,
      patch: { enabled: false },
      idempotencyKey: id('disable'),
    });
    assert.equal(
      h.app.availability.phase(h.alice, await h.app.availability.snapshot()),
      'bootstrap',
    );
    await assert.rejects(
      h.app.collaboration.spawn(h.alice, {
        requestId: 'not-installed',
        taskName: 'missing',
        message: '不能补装',
      }),
    );
  } finally {
    await h.cleanup();
  }
});

void test('协作只选择可用 profile；显式失效目标不切换到其他 Agent', async () => {
  const h = await harness();
  try {
    const config = (await h.app.configs.get(h.registered.configId)).config;
    const broken = await h.app.configs.register(h.alice, {
      config: agentConfig.parse({
        ...config,
        name: 'broken',
        launch: { kind: 'command', executable: process.execPath, args: [] },
      }),
      idempotencyKey: id('broken'),
    });
    const list = (await h.app.collaboration.list(h.alice, {})) as {
      profiles: { profile: string }[];
    };
    assert.deepEqual(
      list.profiles.map((p) => p.profile),
      [h.registered.configId],
    );
    await assert.rejects(
      h.app.collaboration.spawn(h.alice, {
        requestId: 'broken',
        taskName: 'broken',
        message: '明确选择',
        profile: broken.configId,
      }),
    );
    const spawned = await h.app.collaboration.spawn(h.alice, {
      requestId: 'available',
      taskName: 'available',
      message: '唯一可用目标',
    });
    assert.equal(
      (await h.app.collaboration.agent(spawned.agentId)).configId,
      h.registered.configId,
    );
    await h.app.configs.update(h.alice, {
      configId: h.registered.configId,
      expectedRevision: 1,
      patch: { enabled: false },
      idempotencyKey: id('disable'),
    });
    const state = await h.app.availability.snapshot();
    assert.equal(h.app.availability.phase(h.alice, state), 'recovery');
    assert.equal(h.app.availability.phase(h.bob, state), 'bootstrap');
  } finally {
    await h.cleanup();
  }
});
