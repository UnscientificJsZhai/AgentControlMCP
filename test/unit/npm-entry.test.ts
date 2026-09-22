import test from 'node:test';
import assert from 'node:assert/strict';
import { npmLaunch } from '../../src/infrastructure/installers/npm-entry.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executableCommand } from '../../src/infrastructure/platform/process-host.js';

void test('npm 入口保留 Node 参数和空格路径，并区分 Windows 原生程序', () => {
  const script = '/with spaces/entry.cjs';
  assert.deepEqual(
    npmLaunch(script, '#!/usr/bin/env -S node --expose-gc --require "./with spaces/init.cjs"\n'),
    {
      executable: process.execPath,
      prefixArgs: ['--expose-gc', '--require', './with spaces/init.cjs', script],
    },
  );
  assert.deepEqual(npmLaunch(script, '#!/usr/bin/node --expose-gc\n', 'win32').prefixArgs, [
    '--expose-gc',
    script,
  ]);
  assert.equal(
    npmLaunch('C:\\with spaces\\agent.exe', 'MZ', 'win32').executable,
    'C:\\with spaces\\agent.exe',
  );
  assert.deepEqual(npmLaunch(script, 'console.log(1)', 'win32').prefixArgs, [script]);
  assert.throws(() => npmLaunch('agent.cmd', '@echo off', 'win32'), {
    code: 'PLATFORM_UNSUPPORTED',
  });
  assert.throws(() => npmLaunch(script, '#!/usr/bin/env -u HOME node\n'), {
    code: 'CONFIG_INVALID',
  });
  assert.throws(() => npmLaunch(script, '#!/usr/bin/env -S node --require ${BOOTSTRAP}\n'), {
    code: 'CONFIG_INVALID',
  });
});

void test('Windows 官方 npm 和 cmd-shim 入口安全转换为 Node argv', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acm npm shim '));
  try {
    const cmd = join(root, 'npm.cmd');
    const entry = join(root, 'node_modules/npm/bin/npm-cli.js');
    await mkdir(join(root, 'node_modules/npm/bin'), { recursive: true });
    await writeFile(entry, '');
    for (const prefix of ['%~dp0', '%~dp0\\', '%dp0%\\']) {
      await writeFile(cmd, `@echo off\n"${prefix}node_modules\\npm\\bin\\npm-cli.js" %*\n`, {
        mode: 0o700,
      });
      assert.deepEqual(
        await executableCommand(cmd, ['--prefix', 'path with spaces'], process.env, 'win32'),
        { executable: process.execPath, args: [entry, '--prefix', 'path with spaces'] },
      );
    }
    await rm(entry);
    await assert.rejects(executableCommand(cmd, [], process.env, 'win32'), {
      code: 'DEPENDENCY_MISSING',
    });
    await writeFile(cmd, '@echo off\necho unsafe');
    await assert.rejects(executableCommand(cmd, [], process.env, 'win32'), {
      code: 'CONFIG_INVALID',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
