import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { create } from 'tar';
import { Container } from '../../src/bootstrap/container.js';
import { now } from '../../src/domain/ids.js';

/** 真实本地 npm Registry：包入口接入独立 ACP fixture，不安装任何真实 Agent。 */
export async function setupHarness() {
  const root = await mkdtemp(join(tmpdir(), 'acm-setup-'));
  const home = join(root, 'home');
  const packageDir = join(root, 'package');
  await mkdir(home);
  await mkdir(packageDir);
  const metadata = {
    name: 'fixture-setup-agent',
    version: '1.0.0',
    bin: { 'fixture-setup-agent': 'entry.cjs' },
  };
  await writeFile(join(packageDir, 'package.json'), JSON.stringify(metadata));
  await writeFile(
    join(packageDir, 'entry.cjs'),
    `#!/usr/bin/env node\nvoid import(${JSON.stringify(pathToFileURL(resolve('.test-dist/test/fixtures/acp-agent.js')).href)});\n`,
  );
  const archive = join(root, 'fixture.tgz');
  await create({ file: archive, gzip: true, cwd: root }, ['package']);
  const bytes = await readFile(archive);
  let downloads = 0;
  let refreshes = 0;
  let releaseDownload: (() => void) | undefined;
  let holdDownloads = false;
  let failDownloads = false;
  let url = '';
  const server = createServer((req, res) => {
    if (req.url === '/registry') {
      refreshes++;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          agents: ['fixture-setup-agent', 'codex-acp'].map((id) => ({
            id,
            name: '独立 ACP fixture',
            version: '1.0.0',
            distribution: { npx: { package: 'fixture-setup-agent@1.0.0' } },
          })),
        }),
      );
    } else if (req.url === '/fixture.tgz') {
      downloads++;
      const send = () => {
        if (!res.destroyed) {
          if (failDownloads) res.statusCode = 503;
          res.end(failDownloads ? 'fixture 安装失败' : bytes);
        }
      };
      if (holdDownloads) releaseDownload = send;
      else send();
    } else if (req.url === '/fixture-setup-agent') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          name: metadata.name,
          'dist-tags': { latest: metadata.version },
          versions: {
            [metadata.version]: {
              ...metadata,
              dist: {
                tarball: `${url}/fixture.tgz`,
                integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
              },
            },
          },
        }),
      );
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture Registry 地址不可用');
  url = `http://127.0.0.1:${address.port}`;
  await writeFile(join(home, '.npmrc'), `registry=${url}/\nfetch-retries=0\nignore-scripts=true\n`);
  const app = await Container.create({
    dataDir: join(root, 'data'),
    mode: 'cli',
    settings: { allowInsecureRegistry: true, minimumFreeBytes: 0 },
  });
  // HTTP 测试的安装进程也使用隔离 npm 配置；仍执行真正的 npm 安装器。
  const run = app.installations.installer.run;
  app.installations.installer.run = (spec, options) =>
    run(
      {
        ...spec,
        env: { ...spec.env, NPM_CONFIG_USERCONFIG: join(home, '.npmrc') },
      },
      options,
    );
  await app.store.put('source', {
    id: 'src-setup-fixture',
    revision: 1,
    createdAt: now(),
    name: 'fixture Registry',
    url: `${url}/registry`,
    enabled: true,
  });
  return {
    root,
    home,
    app,
    get downloads() {
      return downloads;
    },
    get refreshes() {
      return refreshes;
    },
    holdDownloads() {
      holdDownloads = true;
    },
    failDownloads() {
      failDownloads = true;
    },
    releaseDownload() {
      releaseDownload?.();
    },
    target: {
      sourceId: 'src-setup-fixture',
      registryAgentId: 'fixture-setup-agent',
      targetVersion: '1.0.0',
      distribution: 'npx' as const,
    },
    profile: { name: '接入 fixture', cwd: root },
    async cleanup() {
      releaseDownload?.();
      await app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
