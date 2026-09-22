import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Container } from '../../src/bootstrap/container.js';
import { Installer } from '../../src/infrastructure/installers/installer.js';
import { runCommand } from '../../src/infrastructure/platform/process-host.js';
import { resolveEnvironment } from '../../src/infrastructure/platform/environment.js';
import { createPackageFixtures } from '../helpers/package-fixtures.js';
import { id } from '../../src/domain/ids.js';

interface Preview {
  cleanupPlanId: string;
  planDigest: string;
  candidates: unknown[];
}

for (const distribution of ['npx', 'uvx', 'binary'] as const) {
  void test(
    `真实 ${distribution} 安装清空下载缓存后仍可离线启动（含空格路径）`,
    { timeout: 60_000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'acm package space '));
      const app = await Container.create({
        dataDir: join(root, 'data space'),
        settings: { minimumFreeBytes: 0 },
      });
      try {
        const packages = await createPackageFixtures(root);
        const installer = app.installations.installer;
        t.mock.method(
          installer,
          'run',
          (spec: Parameters<typeof runCommand>[0], options?: Parameters<typeof runCommand>[1]) => {
            if (spec.executable === 'npm' && spec.args.includes('install'))
              spec = {
                ...spec,
                args: [...spec.args.slice(0, -1), packages.npm, '--offline', '--ignore-scripts'],
              };
            if (spec.executable === 'uv' && spec.args.includes('install'))
              spec = { ...spec, args: [...spec.args.slice(0, -1), packages.wheel, '--no-index'] };
            return runCommand(spec, options);
          },
        );
        const bytes =
          process.platform === 'win32'
            ? await readFile(process.execPath)
            : Buffer.from('#!/usr/bin/env node\nconsole.log("offline-fixture-1.0.0");\n');
        t.mock.method(globalThis, 'fetch', () =>
          Promise.resolve(new Response(new Uint8Array(bytes))),
        );
        const manifest =
          distribution === 'binary'
            ? {
                archive: 'https://fixture.invalid/agent',
                cmd: process.platform === 'win32' ? 'bin/agent.exe' : 'bin/agent',
              }
            : { package: distribution === 'npx' ? 'fixture-agent@1.0.0' : 'fixture-agent==1.0.0' };
        const record = await installer.install(
          { sourceId: 'fixture', registryAgentId: 'fixture', targetVersion: '1.0.0', distribution },
          manifest,
          '1.0.0',
          `fixture_${distribution}`,
          new AbortController().signal,
          async () => {},
        );
        await app.store.put('installation', record);
        const plan = (await app.storage.plan(app.admin, {
          scope: 'cache',
          idempotencyKey: id('plan'),
        })) as Preview;
        assert.equal(plan.candidates.length, 1);
        await app.storage.apply(app.admin, {
          cleanupPlanId: plan.cleanupPlanId,
          planDigest: plan.planDigest,
          idempotencyKey: id('apply'),
        });
        assert.deepEqual(await readdir(app.paths.cacheDir), []);
        const { env } = await resolveEnvironment({ values: {}, inherit: [] }, record.env);
        const args =
          distribution === 'binary' && process.platform === 'win32'
            ? ['--version']
            : ['argument with spaces'];
        const result = await runCommand({
          executable: record.executable,
          args: [...record.prefixArgs, ...args],
          cwd: root,
          env,
        });
        assert.match(
          result,
          distribution === 'binary' && process.platform === 'win32'
            ? /^v\d+/
            : /offline-fixture-1\.0\.0/,
        );
        if (distribution !== 'binary') assert.match(result, /argument with spaces/);
        assert.ok(record.path.startsWith(app.paths.installationsDir));
        assert.deepEqual(await readdir(app.paths.stagingDir), []);
        if (distribution !== 'binary') {
          await assert.rejects(
            installer.install(
              {
                sourceId: 'fixture',
                registryAgentId: 'fixture',
                targetVersion: '2.0.0',
                distribution,
              },
              manifest,
              '2.0.0',
              `mismatch_${distribution}`,
              new AbortController().signal,
              async () => {},
            ),
            { code: 'INTEGRITY_MISMATCH' },
          );
          assert.deepEqual(await readdir(app.paths.installationsDir), [`fixture_${distribution}`]);
          assert.deepEqual(await readdir(app.paths.cacheDir), []);
        } else {
          await assert.rejects(
            installer.install(
              {
                sourceId: 'fixture',
                registryAgentId: 'fixture',
                targetVersion: '1.0.0',
                distribution,
              },
              manifest,
              '1.0.0',
              'failed_publish',
              new AbortController().signal,
              (step) => {
                if (step === 'ready') throw new Error('after rename');
                return Promise.resolve();
              },
            ),
            { code: 'INSTALL_FAILED' },
          );
          assert.deepEqual(await readdir(app.paths.installationsDir), ['fixture_binary']);
        }
        const entry =
          record.distribution === 'npx' && record.prefixArgs.length
            ? record.prefixArgs.at(-1)!
            : record.executable;
        assert.ok(entry.startsWith(record.path));
        await rm(entry);
        assert.ok((await app.storage.diagnose()).missingInstallations.includes(record.id));
      } finally {
        await app.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

void test('安装失败只回收本作业产物，预存缓存和已安装目录受到保护', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'acm-owned-'));
  const app = await Container.create({ dataDir: root, settings: { minimumFreeBytes: 0 } });
  try {
    const installer = new Installer(app.paths, false);
    const target = {
      sourceId: 'fixture',
      registryAgentId: 'fixture',
      targetVersion: '1.0.0',
      distribution: 'npx' as const,
    };
    const manifest = { package: 'fixture-agent@1.0.0' };
    t.mock.method(installer, 'run', () => {
      throw new Error('fixture failure');
    });
    await assert.rejects(
      installer.install(
        target,
        manifest,
        '1.0.0',
        'failed',
        new AbortController().signal,
        async () => {},
      ),
      { code: 'INSTALL_FAILED' },
    );
    for (const dir of [app.paths.stagingDir, app.paths.cacheDir, app.paths.installationsDir])
      assert.deepEqual(await readdir(dir), []);
    await mkdir(join(app.paths.cacheDir, 'existing'));
    await writeFile(join(app.paths.cacheDir, 'existing/sentinel'), 'keep');
    await assert.rejects(
      installer.install(
        target,
        manifest,
        '1.0.0',
        'existing',
        new AbortController().signal,
        async () => {},
      ),
      { code: 'STORAGE_CLEANUP_REQUIRED' },
    );
    assert.equal(await readFile(join(app.paths.cacheDir, 'existing/sentinel'), 'utf8'), 'keep');
    await mkdir(join(app.paths.installationsDir, 'installed'));
    await writeFile(join(app.paths.installationsDir, 'installed/sentinel'), 'keep');
    await assert.rejects(
      installer.install(
        target,
        manifest,
        '1.0.0',
        'installed',
        new AbortController().signal,
        async () => {},
      ),
      { code: 'STORAGE_CLEANUP_REQUIRED' },
    );
    assert.equal(
      await readFile(join(app.paths.installationsDir, 'installed/sentinel'), 'utf8'),
      'keep',
    );
    const full = new Installer(app.paths, false, Number.MAX_SAFE_INTEGER);
    await assert.rejects(
      full.install(target, manifest, '1.0.0', 'full', new AbortController().signal, async () => {}),
      { code: 'CAPACITY_EXCEEDED' },
    );
    assert.equal((await readdir(app.paths.installationsDir)).includes('full'), false);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
