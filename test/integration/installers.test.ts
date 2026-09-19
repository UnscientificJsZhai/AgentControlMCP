import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { extractArchive } from '../../src/infrastructure/installers/archive-reader.js';
import { Installer, platformKey } from '../../src/infrastructure/installers/installer.js';
import { Container } from '../../src/bootstrap/container.js';
import { id, now } from '../../src/domain/ids.js';
import { until } from '../helpers/harness.js';
import { createArchiveFixtures } from '../helpers/archive-fixtures.js';
import type {
  RegistrySnapshot,
  RegistrySource,
  InstallationRecord,
} from '../../src/domain/models.js';
import { agentConfig } from '../../src/domain/schemas.js';

void test('AC-016: ZIP、tar.gz、tgz、tar.bz2、tbz2 解压和搬迁后的符号链接', async () => {
  const { mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'acm-archive-'));
  try {
    const { archives, unsafe } = await createArchiveFixtures(root);
    for (const [ext, file] of archives) {
      const stage = join(root, ext);
      await mkdir(stage);
      const data = await readFile(file);
      await extractArchive(
        file,
        `https://example.test/archive.${ext}`,
        stage,
        data.length,
        new AbortController().signal,
      );
      await rename(stage, `${stage}-ready`);
      assert.ok(
        (await readFile(join(`${stage}-ready`, 'bin/agent'), 'utf8')).includes('binary-fixture'),
      );
      if (ext !== 'zip')
        assert.ok(
          (await readFile(join(`${stage}-ready`, 'alias'), 'utf8')).includes('binary-fixture'),
        );
    }
    await assert.rejects(
      extractArchive(
        unsafe,
        'https://example.test/unsafe.zip',
        root,
        100,
        new AbortController().signal,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test(
  'REV-003/AC-016/024: 同目标只下载一次，身份独立取消，SHA 失败保留已安装版本',
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'acm-install-'));
    const app = await Container.create({
      dataDir: root,
      settings: { allowInsecureRegistry: true },
    });
    const a = { ...app.admin, admin: false, principalId: 'stdio:a' };
    const b = { ...a, principalId: 'stdio:b' };
    const bytes = Buffer.from("#!/usr/bin/env node\nconsole.log('binary-fixture-1.0.0');\n");
    let downloads = 0;
    const server = createServer((_req, res) => {
      downloads++;
      setTimeout(() => {
        res.writeHead(200);
        res.end(bytes);
      }, 1000);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const source: RegistrySource = {
      id: 'src-test',
      revision: 1,
      createdAt: now(),
      name: 'fixture',
      enabled: true,
      url: `http://127.0.0.1:${port}/registry`,
      snapshotId: 'snapshot-test',
    };
    const snapshot: RegistrySnapshot = {
      id: source.snapshotId!,
      revision: 1,
      createdAt: now(),
      sourceId: source.id,
      url: source.url,
      digest: 'fixed',
      agents: [
        {
          id: 'fixture',
          name: 'fixture',
          version: '1.0.0',
          distribution: {
            binary: {
              [platformKey()]: {
                archive: `http://127.0.0.1:${port}/agent`,
                cmd: 'bin/agent',
                sha256: createHash('sha256').update(bytes).digest('hex'),
              },
            },
          },
        },
      ],
    };
    try {
      await app.store.put('source', source);
      await app.store.put('registry_snapshot', snapshot);
      const target = {
        sourceId: source.id,
        registryAgentId: 'fixture',
        targetVersion: '1.0.0',
        distribution: 'binary' as const,
      };
      const first = await app.installations.install(a, { ...target, idempotencyKey: id('a') });
      const second = await app.installations.install(b, { ...target, idempotencyKey: id('b') });
      await until(
        async () =>
          downloads === 1 && Boolean((await app.operations.get(b, second.operationId)).step),
      );
      await assert.rejects(app.operations.get(a, second.operationId), { code: 'OBJECT_NOT_FOUND' });
      await app.operations.cancel(a, first.operationId);
      const finished = await until(async () => {
        const op = await app.operations.get(b, second.operationId);
        return op.state === 'completed' || op.state === 'failed' ? op : null;
      });
      assert.equal(finished.state, 'completed', JSON.stringify(finished));
      assert.equal(downloads, 1);
      assert.equal((await app.operations.get(a, first.operationId)).state, 'cancelled');
      const record = finished.result as InstallationRecord;
      assert.ok((await readFile(record.executable, 'utf8')).includes('binary-fixture'));
      const config = await app.configs.register(a, {
        config: agentConfig.parse({
          name: '安装引用保护',
          origin: { kind: 'registry', sourceId: source.id, registryAgentId: 'fixture' },
          launch: { kind: 'installation', installationId: record.id },
          cwd: root,
        }),
        idempotencyKey: id('register'),
      });
      await app.configs.update(a, {
        configId: config.configId,
        expectedRevision: config.revision,
        patch: { name: '只改名称' },
        idempotencyKey: id('update'),
      });
      await assert.rejects(
        app.installations.remove(a, { installationId: record.id, idempotencyKey: id('remove') }),
        { code: 'OBJECT_IN_USE' },
      );
      const secondInstall: InstallationRecord = {
        ...record,
        id: id('ins'),
        revision: 1,
        key: id('key'),
        version: '2.0.0',
      };
      await app.store.put('installation', secondInstall);
      const rolled = await app.installations.switch(
        a,
        {
          configId: config.configId,
          expectedRevision: 2,
          target: { installationId: secondInstall.id },
          idempotencyKey: id('rollback'),
        },
        true,
      );
      await until(
        async () => (await app.operations.get(a, rolled.operationId)).state === 'completed',
      );
      const restored = await app.installations.switch(
        a,
        {
          configId: config.configId,
          expectedRevision: 3,
          target: { installationId: record.id },
          idempotencyKey: id('rollback'),
        },
        true,
      );
      await until(
        async () => (await app.operations.get(a, restored.operationId)).state === 'completed',
      );
      assert.equal((await app.configs.get(config.configId)).config.launch.kind, 'installation');
      const installer = new Installer(root, true);
      await assert.rejects(
        installer.install(
          target,
          { ...snapshot.agents[0]!.distribution.binary![platformKey()]!, sha256: '0'.repeat(64) },
          '1.0.0',
          id('bad'),
          new AbortController().signal,
          async () => {
            await delay(0);
          },
        ),
        { code: 'INTEGRITY_MISMATCH' },
      );
      assert.ok(await readFile(record.executable));
      assert.equal((await app.installations.list()).length, 2);
    } finally {
      await app.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
