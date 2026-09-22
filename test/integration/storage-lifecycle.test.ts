import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Container } from '../../src/bootstrap/container.js';
import { id, now } from '../../src/domain/ids.js';
import { AppError } from '../../src/domain/errors.js';
import type {
  InstallationJob,
  InstallationRecord,
  RegistrySnapshot,
} from '../../src/domain/models.js';
import type { Transaction } from '../../src/infrastructure/storage/protocol.js';
import { row } from '../../src/infrastructure/storage/sqlite-store.js';
import { platformKey } from '../../src/infrastructure/installers/installer.js';
import { runCommand } from '../../src/infrastructure/platform/process-host.js';
import { agentConfig } from '../../src/domain/schemas.js';
import { isAlive, recover } from '../../src/application/recovery-service.js';
import { until } from '../helpers/harness.js';

interface Preview {
  cleanupPlanId: string;
  planDigest: string;
  candidates: { name: string }[];
}
const preview = async (app: Container, scope: 'cache' | 'orphans' = 'orphans') =>
  app.storage.plan(app.admin, { scope, idempotencyKey: id('plan') }) as Promise<Preview>;
const apply = (app: Container, plan: Preview, key = id('apply')) =>
  app.storage.apply(app.admin, {
    cleanupPlanId: plan.cleanupPlanId,
    planDigest: plan.planDigest,
    idempotencyKey: key,
  });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'acm-storage-'));
  const app = await Container.create({
    dataDir: join(root, 'data'),
    settings: { minimumFreeBytes: 0 },
  });
  return {
    root,
    app,
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function seed(app: Container, key = id('key')) {
  const path = join(app.paths.installationsDir, key);
  await mkdir(path);
  const record: InstallationRecord = {
    id: id('ins'),
    revision: 1,
    createdAt: now(),
    key,
    state: 'ready',
    sourceId: 'source',
    registryAgentId: 'fixture',
    distribution: 'binary',
    platform: platformKey(),
    version: '1.0.0',
    resolvedPackageVersion: '1.0.0',
    manifest: {},
    path,
    executable: process.execPath,
    prefixArgs: [resolve('.test-dist/test/fixtures/acp-agent.js')],
    args: [],
    env: {},
    integrity: 'not_provided',
  };
  await writeFile(join(path, 'installation.json'), JSON.stringify(record));
  await app.store.put('installation', record);
  return record;
}
async function registry(app: Container) {
  const source = {
    id: 'source',
    revision: 1,
    createdAt: now(),
    enabled: true,
    name: 'fixture',
    url: 'https://fixture.invalid/registry',
    snapshotId: 'snapshot',
  };
  const snapshot: RegistrySnapshot = {
    id: 'snapshot',
    revision: 1,
    createdAt: now(),
    sourceId: source.id,
    url: source.url,
    digest: 'fixture',
    agents: [
      {
        id: 'fixture',
        name: 'fixture',
        version: '1.0.0',
        distribution: {
          binary: { [platformKey()]: { archive: 'https://fixture.invalid/agent', cmd: 'agent' } },
        },
      },
    ],
  };
  await app.store.put('source', source);
  await app.store.put('registry_snapshot', snapshot);
  return {
    sourceId: source.id,
    registryAgentId: 'fixture',
    targetVersion: '1.0.0',
    distribution: 'binary' as const,
  };
}

void test('卸载失败保留 removing 事实；配置和 Runtime 引用均受保护，成功结果只在最终提交后保存', async (t) => {
  const h = await setup();
  const { app, root } = h;
  try {
    const record = await seed(app);
    const config = await app.configs.register(app.admin, {
      config: agentConfig.parse({
        name: 'fixture',
        origin: {
          kind: 'registry',
          sourceId: record.sourceId,
          registryAgentId: record.registryAgentId,
        },
        launch: { kind: 'installation', installationId: record.id },
        cwd: root,
      }),
      idempotencyKey: id('config'),
    });
    const args = { installationId: record.id, idempotencyKey: id('remove') };
    await assert.rejects(app.installations.remove(app.admin, args), { code: 'OBJECT_IN_USE' });
    const runtime = await app.runtimes.prepareNow(
      app.admin,
      { configId: config.configId },
      id('op'),
      new AbortController().signal,
    );
    await app.configs.update(app.admin, {
      configId: config.configId,
      expectedRevision: 1,
      patch: { launch: { kind: 'command', executable: process.execPath, args: [] } },
      idempotencyKey: id('update'),
    });
    await assert.rejects(app.installations.remove(app.admin, args), { code: 'OBJECT_IN_USE' });
    await app.runtimes.closeNow(runtime.id);
    const cleanup = t.mock.method(app.installations.installer, 'cleanup', () => {
      throw new Error('disk failure');
    });
    await assert.rejects(app.installations.remove(app.admin, args), /disk failure/);
    assert.equal(
      (await app.store.get<InstallationRecord>('installation', record.id))?.state,
      'removing',
    );
    await assert.rejects(
      app.configs.update(app.admin, {
        configId: config.configId,
        expectedRevision: 2,
        patch: { launch: { kind: 'installation', installationId: record.id } },
        idempotencyKey: id('update'),
      }),
      { code: 'CONFIG_INVALID' },
    );
    await assert.rejects(
      app.runtimes.prepareNow(
        app.admin,
        { configId: config.configId, configRevision: 1 },
        id('op'),
        new AbortController().signal,
      ),
      { code: 'CONFIG_INVALID' },
    );
    cleanup.mock.restore();
    const commit = app.store.commit.bind(app.store);
    const failure = t.mock.method(app.store, 'commit', async (tx: Transaction) => {
      if (tx.deletes?.some((item) => item.kind === 'installation'))
        throw new Error('database failure');
      return commit(tx);
    });
    await assert.rejects(app.installations.remove(app.admin, args), /database failure/);
    assert.equal(
      await lstat(record.path).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(
      (await app.store.get<InstallationRecord>('installation', record.id))?.state,
      'removing',
    );
    failure.mock.restore();
    assert.deepEqual(await app.installations.remove(app.admin, args), { removed: true });
    assert.deepEqual(await app.installations.remove(app.admin, args), { removed: true });
    assert.equal(await app.store.get('installation', record.id), null);
  } finally {
    await h.close();
  }
});

void test('清理统计分类、计划过期/改动/活动保护、重试与符号链接边界', async (t) => {
  const h = await setup();
  const { app, root } = h;
  try {
    const planArgs = { idempotencyKey: id('concurrent_plan') };
    const [firstPlan, secondPlan] = await Promise.all([
      app.storage.plan(app.admin, planArgs),
      app.storage.plan(app.admin, planArgs),
    ]);
    assert.deepEqual(firstPlan, secondPlan);
    assert.ok(await app.store.get('storage_cleanup_plan', (secondPlan as Preview).cleanupPlanId));
    const installed = await seed(app, 'ready');
    for (const [base, name] of [
      [app.paths.installationsDir, 'orphan'],
      [app.paths.cacheDir, 'ready'],
      [app.paths.stagingDir, 'stage'],
    ] as const) {
      await mkdir(join(base, name));
      await writeFile(join(base, name, 'data'), '12345');
    }
    await writeFile(join(app.paths.contentDir, 'content'), 'history');
    await writeFile(join(root, 'outside'), 'protected');
    // Windows 使用无需开发者模式的 junction；两种链接都不得遍历到应用根外。
    const outside = join(root, 'outside-dir');
    await mkdir(outside);
    await writeFile(join(outside, 'sentinel'), 'external');
    await symlink(
      outside,
      join(app.paths.cacheDir, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const usage = await app.storage.usage();
    assert.equal(usage.categories.content?.bytes, 7);
    assert.equal(usage.categories.cache?.bytes, 5);
    assert.equal(usage.categories.cache?.reclaimableBytes, 5);
    assert.equal(usage.categories.staging?.bytes, 5);
    assert.ok(usage.categories.installations!.protectedBytes > 0);
    assert.ok(usage.categories.database!.bytes > 0);
    assert.ok(usage.volumes.every((volume) => volume.freeBytes > 0));
    const stale = await preview(app, 'cache');
    await writeFile(join(app.paths.cacheDir, 'ready/data'), 'changed');
    await assert.rejects(apply(app, stale), { code: 'STORAGE_PLAN_STALE' });
    const busy = await preview(app, 'cache');
    const job: InstallationJob = {
      id: 'job',
      revision: 1,
      createdAt: now(),
      instanceId: app.instanceId,
      key: installed.key,
      lockHolder: `${process.pid}:job`,
      state: 'running',
      paths: app.installations.installer.locations(installed.key, 'job'),
    };
    await app.store.put('installation_job', job);
    await assert.rejects(apply(app, busy), { code: 'STORAGE_PLAN_STALE' });
    assert.equal(
      (await preview(app, 'cache')).candidates.some((item) => item.name === 'ready'),
      false,
    );
    await app.store.put('installation_job', { ...job, revision: 2, state: 'ended' });
    const expired = await preview(app);
    const saved = (await app.store.get<{ id: string; revision: number; createdAt: string }>(
      'storage_cleanup_plan',
      expired.cleanupPlanId,
    ))!;
    await app.store.put('storage_cleanup_plan', { ...saved, expiresAt: '2000-01-01T00:00:00Z' });
    await assert.rejects(apply(app, expired), { code: 'STORAGE_PLAN_STALE' });
    const plan = await preview(app, 'cache');
    const commit = app.store.commit.bind(app.store);
    const failure = t.mock.method(app.store, 'commit', async (tx: Transaction) => {
      if (tx.puts?.some((item) => item.kind === 'storage_cleanup_plan'))
        throw new Error('progress failure');
      return commit(tx);
    });
    await assert.rejects(apply(app, plan), /progress failure/);
    failure.mock.restore();
    const key = id('apply');
    assert.deepEqual(await apply(app, plan, key), await apply(app, plan, key));
    await apply(app, await preview(app));
    assert.deepEqual(await readdir(app.paths.cacheDir), []);
    assert.deepEqual(await readdir(app.paths.stagingDir), []);
    assert.deepEqual(await readdir(app.paths.installationsDir), ['ready']);
    assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'external');
  } finally {
    await h.close();
  }
});

void test('跨实例安装共用锁，发布与作业终态原子提交；提交失败清理产物', async (t) => {
  const h = await setup();
  const { app } = h;
  const other = await Container.create({ dataDir: app.dataDir, settings: { minimumFreeBytes: 0 } });
  try {
    const target = await registry(app);
    let downloads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.mock.method(globalThis, 'fetch', async () => {
      downloads++;
      await gate;
      return new Response('fixture');
    });
    const first = app.installations.acquire(target, id('op'), new AbortController().signal);
    const second = other.installations.acquire(target, id('op'), new AbortController().signal);
    await until(
      async () =>
        downloads === 1 && (await app.store.list<InstallationJob>('installation_job')).length === 2,
    );
    assert.equal((await preview(app)).candidates.length, 0);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.id, b.id);
    assert.equal(downloads, 1);
    assert.ok(
      (await app.store.list<InstallationJob>('installation_job')).every(
        (job) => job.state === 'ended',
      ),
    );
    await app.installations.remove(app.admin, {
      installationId: a.id,
      idempotencyKey: id('remove'),
    });
    const commit = app.store.commit.bind(app.store);
    const failure = t.mock.method(app.store, 'commit', async (tx: Transaction) => {
      if (tx.puts?.some((item) => item.kind === 'installation')) {
        assert.ok(
          tx.puts.some(
            (item) =>
              item.kind === 'installation_job' && (item.data as InstallationJob).state === 'ended',
          ),
        );
        throw new Error('publish failure');
      }
      return commit(tx);
    });
    await assert.rejects(
      app.installations.acquire(target, id('op'), new AbortController().signal),
      /publish failure/,
    );
    failure.mock.restore();
    assert.deepEqual(await readdir(app.paths.installationsDir), []);
    assert.deepEqual(await readdir(app.paths.cacheDir), []);
    assert.ok(
      (await app.store.list<InstallationJob>('installation_job')).every(
        (job) => job.state === 'ended',
      ),
    );
  } finally {
    await other.close();
    await h.close();
  }
});

void test('失败清理保留作业，重启恢复和手动清理可解除阻塞', async (t) => {
  const h = await setup();
  const { app } = h;
  try {
    const target = await registry(app);
    t.mock.method(globalThis, 'fetch', () => Promise.reject(new Error('network fixture')));
    const failure = t.mock.method(app.installations.installer, 'remove', () => {
      throw new Error('disk fixture');
    });
    await assert.rejects(
      app.installations.acquire(target, id('op'), new AbortController().signal),
      { code: 'INSTALL_CLEANUP_PENDING' },
    );
    failure.mock.restore();
    let job = (await app.store.list<InstallationJob>('installation_job'))[0]!;
    assert.equal(job.state, 'cleanup_pending');
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(child, 'exit');
    await app.store.put('instance', { ...app.instance, id: 'dead', pid: child.pid!, revision: 1 });
    await app.store.put('installation_job', {
      ...job,
      revision: job.revision + 1,
      instanceId: 'dead',
      state: 'running',
      lockHolder: `${child.pid!}:job`,
    });
    await app.store.commit({
      claims: [{ key: `install:${job.key}`, holder: `${child.pid!}:job` }],
    });
    await recover(app.store);
    job = (await app.store.get<InstallationJob>('installation_job', job.id))!;
    assert.equal(job.state, 'cleanup_pending');
    assert.equal(await app.store.claim(`install:${job.key}`), null);
    assert.ok((await app.storage.diagnose()).pendingJobs.includes(job.id));
    await apply(app, await preview(app));
    assert.equal(
      (await app.store.get<InstallationJob>('installation_job', job.id))?.state,
      'ended',
    );
    assert.deepEqual(await readdir(app.paths.cacheDir), []);
  } finally {
    await h.close();
  }
});

void test('取消安装先等待真实子进程退出，再删除本次临时产物', async (t) => {
  const h = await setup();
  const { app, root } = h;
  try {
    const installer = app.installations.installer;
    const pidFile = join(root, 'child-pid');
    const abort = new AbortController();
    t.mock.method(
      installer,
      'run',
      (spec: Parameters<typeof runCommand>[0], options: Parameters<typeof runCommand>[1]) =>
        runCommand(
          {
            ...spec,
            executable: process.execPath,
            args: [
              '-e',
              `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
            ],
          },
          options,
        ),
    );
    const pending = installer.install(
      {
        sourceId: 'source',
        registryAgentId: 'fixture',
        targetVersion: '1.0.0',
        distribution: 'npx',
      },
      { package: 'fixture-agent@1.0.0' },
      '1.0.0',
      'cancelled',
      abort.signal,
      async () => {},
    );
    const pid = await until(
      async () => Number(await readFile(pidFile, 'utf8').catch(() => '')) || null,
    );
    const remove = installer.remove;
    t.mock.method(installer, 'remove', (...args: Parameters<typeof remove>) => {
      assert.equal(isAlive(pid), false);
      return remove(...args);
    });
    abort.abort();
    await assert.rejects(pending, { code: 'CANCELLED' });
    for (const path of [app.paths.stagingDir, app.paths.installationsDir, app.paths.cacheDir])
      assert.deepEqual(await readdir(path), []);
  } finally {
    await h.close();
  }
});

void test('配置和 Runtime 的状态检查与引用提交不可被并发卸载穿过', async (t) => {
  const h = await setup();
  const { app, root } = h;
  try {
    const installed = await seed(app);
    const config = agentConfig.parse({
      name: 'race',
      origin: {
        kind: 'registry',
        sourceId: installed.sourceId,
        registryAgentId: installed.registryAgentId,
      },
      launch: { kind: 'installation', installationId: installed.id },
      cwd: root,
    });
    const commit = app.store.commit.bind(app.store);
    const intercept = (kind: string) =>
      t.mock.method(app.store, 'commit', async (tx: Transaction) => {
        if (tx.puts?.some((item) => item.kind === kind))
          await commit({
            puts: [row('installation', { ...installed, revision: 2, state: 'removing' })],
          });
        return commit(tx);
      });
    const registerRace = intercept('config');
    await assert.rejects(
      app.configs.register(app.admin, { config, idempotencyKey: id('config') }),
      { code: 'REVISION_CONFLICT' },
    );
    registerRace.mock.restore();
    assert.deepEqual(await app.configs.list(), []);
    await app.store.put('installation', installed);
    const registered = await app.configs.register(app.admin, {
      config,
      idempotencyKey: id('config'),
    });
    const runtimeRace = intercept('runtime');
    await assert.rejects(
      app.runtimes.prepareNow(
        app.admin,
        { configId: registered.configId },
        id('op'),
        new AbortController().signal,
      ),
      { code: 'REVISION_CONFLICT' },
    );
    runtimeRace.mock.restore();
    assert.deepEqual(await app.store.list('runtime'), []);
    assert.deepEqual(await app.store.list('runtime_slot'), []);
  } finally {
    await h.close();
  }
});

void test('运行中的安装在磁盘低于门槛时终止并回收产物', async (t) => {
  const h = await setup();
  const { app } = h;
  try {
    let checks = 0;
    const installer = app.installations.installer;
    t.mock.method(installer, 'checkSpace', () =>
      ++checks > 1
        ? Promise.reject(new AppError('CAPACITY_EXCEEDED', 'fixture disk full'))
        : Promise.resolve(),
    );
    t.mock.method(
      installer,
      'run',
      (_spec: unknown, options: { signal: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          const abort = () => reject(new AppError('CANCELLED', 'fixture stopped'));
          options.signal.addEventListener('abort', abort, { once: true });
          if (options.signal.aborted) abort();
        }),
    );
    await assert.rejects(
      installer.install(
        {
          sourceId: 'source',
          registryAgentId: 'fixture',
          targetVersion: '1.0.0',
          distribution: 'npx',
        },
        { package: 'fixture-agent@1.0.0' },
        '1.0.0',
        'low_space',
        new AbortController().signal,
        async () => {},
      ),
      { code: 'CAPACITY_EXCEEDED' },
    );
    for (const dir of [app.paths.installationsDir, app.paths.cacheDir, app.paths.stagingDir])
      assert.deepEqual(await readdir(dir), []);
  } finally {
    await h.close();
  }
});

void test('并发清理计划可以共同完成已无文件的遗留作业', async () => {
  const h = await setup();
  const { app } = h;
  try {
    const job: InstallationJob = {
      id: 'empty_job',
      revision: 1,
      createdAt: now(),
      key: 'empty',
      instanceId: app.instanceId,
      lockHolder: `${process.pid}:empty`,
      state: 'cleanup_pending',
      paths: app.installations.installer.locations('empty', 'empty_job'),
    };
    await app.store.put('installation_job', job);
    const [first, second] = await Promise.all([preview(app), preview(app)]);
    await Promise.all([apply(app, first), apply(app, second)]);
    assert.equal(
      (await app.store.get<InstallationJob>('installation_job', job.id))?.state,
      'ended',
    );
  } finally {
    await h.close();
  }
});

void test('并发复用同一幂等键的不同删除请求在文件副作用前拒绝冲突', async () => {
  const h = await setup();
  const { app } = h;
  const checkConflict = (results: PromiseSettledResult<unknown>[]) => {
    assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
    const rejected = results.find((item) => item.status === 'rejected');
    assert.ok(rejected?.status === 'rejected');
    assert.equal((rejected.reason as AppError).code, 'IDEMPOTENCY_CONFLICT');
  };
  try {
    await seed(app, 'ready');
    await mkdir(join(app.paths.cacheDir, 'ready'));
    await writeFile(join(app.paths.cacheDir, 'ready/data'), 'cache');
    await mkdir(join(app.paths.stagingDir, 'orphan'));
    await writeFile(join(app.paths.stagingDir, 'orphan/data'), 'orphan');
    const [cache, orphan] = await Promise.all([preview(app, 'cache'), preview(app)]);
    const key = id('shared');
    checkConflict(await Promise.allSettled([apply(app, cache, key), apply(app, orphan, key)]));
    assert.equal(
      (await readdir(app.paths.cacheDir)).length + (await readdir(app.paths.stagingDir)).length,
      1,
    );
    const a = await seed(app, 'remove_a');
    const b = await seed(app, 'remove_b');
    const removeKey = id('shared');
    checkConflict(
      await Promise.allSettled(
        [a, b].map((item) =>
          app.installations.remove(app.admin, {
            installationId: item.id,
            idempotencyKey: removeKey,
          }),
        ),
      ),
    );
    assert.equal(
      (await readdir(app.paths.installationsDir)).filter((name) => name.startsWith('remove_'))
        .length,
      1,
    );
    assert.equal(
      (await app.installations.list()).filter((item) => item.key.startsWith('remove_')).length,
      1,
    );
  } finally {
    await h.close();
  }
});
