import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

for (const [scenario, description] of [
  ['directory', '目录创建失败并中止后续大文件'],
  ['file', '文件写入失败'],
  ['cancel', '取消仍在等待目录创建的文件'],
]) {
  void test(
    `TAR ${description}：严格拒绝策略下等待任务退出再清理`,
    { timeout: 20_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'acm-archive-failure-'));
      try {
        const { stdout } = await promisify(execFile)(
          process.execPath,
          [
            '--unhandled-rejections=strict',
            fileURLToPath(new URL('../fixtures/archive-failure.js', import.meta.url)),
            scenario!,
            root,
          ],
          { timeout: 15_000 },
        );
        assert.equal(stdout, 'caught-and-cleaned\n');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
