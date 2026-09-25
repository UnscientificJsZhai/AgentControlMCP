import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Container } from '../../src/bootstrap/container.js';
import type { StoragePaths } from '../../src/infrastructure/storage/paths.js';
import { startAdmin, adminRequest } from '../../src/transport/admin/ipc.js';

const cli = resolve('dist/cli/entry.js');
void test('CLI 与库使用同一覆盖目录，socket、数据库权限和运行目录生命周期正确', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acm-storage-cli-'));
  const app = await Container.create({
    dataDir: join(root, 'data'),
    settings: { minimumFreeBytes: 0 },
  });
  try {
    const paths = app.paths;
    assert.ok(isAbsolute(paths.runtimeDir));
    assert.ok((await lstat(paths.runtimeDir)).isDirectory());
    await startAdmin(app);
    const response = await adminRequest(app.instance, 'connector_info', {});
    assert.ok(response.data);
    await app.close();
    await assert.rejects(lstat(paths.runtimeDir), { code: 'ENOENT' });
    if (process.platform !== 'win32') {
      assert.equal((await lstat(paths.databasePath)).mode & 0o777, 0o600);
    }
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [cli, 'call', 'connector_info'],
      { cwd: root, env: { ...process.env, AGENT_CONTROL_MCP_DATA_DIR: 'data' } },
    );
    const fromCli = (JSON.parse(stdout) as { paths: StoragePaths }).paths;
    for (const key of Object.keys(paths) as (keyof StoragePaths)[])
      if (key !== 'runtimeDir') assert.equal(fromCli[key], paths[key]);
    assert.equal(fromCli.dataDir, await realpath(join(root, 'data')));
    assert.ok(isAbsolute(fromCli.runtimeDir));
    assert.notEqual(fromCli.runtimeDir, paths.runtimeDir);
    await assert.rejects(lstat(fromCli.runtimeDir), { code: 'ENOENT' });
    const usage = await promisify(execFile)(
      process.execPath,
      [cli, 'storage', 'usage', '--data-dir', 'data'],
      { cwd: root },
    );
    assert.ok((JSON.parse(usage.stdout) as { categories: unknown }).categories);
    const preview = await promisify(execFile)(
      process.execPath,
      [cli, 'storage', 'cleanup', '--data-dir', 'data'],
      { cwd: root },
    );
    const plan = JSON.parse(preview.stdout) as {
      cleanupPlanId: string;
      planDigest: string;
      dryRun: boolean;
    };
    assert.equal(plan.dryRun, true);
    const applied = await promisify(execFile)(
      process.execPath,
      [
        cli,
        'storage',
        'cleanup',
        '--mode',
        'apply',
        '--cleanup-plan-id',
        plan.cleanupPlanId,
        '--plan-digest',
        plan.planDigest,
        '--data-dir',
        'data',
      ],
      { cwd: root },
    );
    assert.equal((JSON.parse(applied.stdout) as { dryRun: boolean }).dryRun, false);
    await assert.rejects(
      promisify(execFile)(process.execPath, [cli, 'storage', 'usage', '--data-dir='], {
        cwd: root,
      }),
      (error: unknown) => {
        assert.match((error as { stderr: string }).stderr, /CONFIG_INVALID/);
        return true;
      },
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

// POSIX 可执行 fixture 验证真实编辑器流程；Windows 的可执行文件解析由入口测试覆盖。
if (process.platform !== 'win32')
  void test('配置编辑成功删除临时副本，应用失败返回可恢复副本', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acm-editor-'));
    let retained: string | undefined;
    try {
      const trace = join(root, 'editor-path');
      const editor = join(root, 'editor');
      await writeFile(
        editor,
        '#!/usr/bin/env node\nconst fs=require("node:fs");fs.writeFileSync(process.env.ACM_EDITOR_TRACE,process.argv[2]);if(process.env.ACM_EDITOR_INVALID)fs.writeFileSync(process.argv[2],"invalid JSON");',
        { mode: 0o700 },
      );
      const args = [cli, 'config', 'edit', '--id', 'connector', '--data-dir', join(root, 'data')];
      const env = { ...process.env, EDITOR: editor, ACM_EDITOR_TRACE: trace };
      await promisify(execFile)(process.execPath, args, { env });
      await assert.rejects(lstat(dirname(await readFile(trace, 'utf8'))), { code: 'ENOENT' });
      await assert.rejects(
        promisify(execFile)(process.execPath, args, { env: { ...env, ACM_EDITOR_INVALID: '1' } }),
        (error: unknown) => {
          const stderr = (error as { stderr: string }).stderr;
          const response = JSON.parse(stderr.slice(stderr.indexOf('{'))) as {
            error: { details: { recoveryPath: string } };
          };
          retained = response.error.details.recoveryPath;
          return true;
        },
      );
      assert.ok(retained);
      assert.equal(await readFile(retained, 'utf8'), 'invalid JSON');
      assert.equal((await lstat(retained)).mode & 0o777, 0o600);
    } finally {
      if (retained) await rm(dirname(retained), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
