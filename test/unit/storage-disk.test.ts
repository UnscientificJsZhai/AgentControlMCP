import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectTree } from '../../src/infrastructure/storage/disk.js';

void test('统计按 inode 去重，并容忍目录在 lstat 后消失', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'acm-disk-'));
  const original = fs.readdir;
  try {
    await fs.writeFile(join(root, 'data'), '12345');
    await fs.link(join(root, 'data'), join(root, 'hardlink'));
    assert.equal((await inspectTree(root)).bytes, 5);
    const disposable = join(root, 'disposable');
    await fs.mkdir(disposable);
    t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      if (args[0] === disposable) await fs.rm(disposable, { recursive: true });
      return original(...args);
    });
    syncBuiltinESMExports();
    assert.equal((await inspectTree(disposable)).bytes, 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
