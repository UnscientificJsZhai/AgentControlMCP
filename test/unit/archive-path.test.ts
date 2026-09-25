import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { archivePath } from '../../src/infrastructure/installers/archive-reader.js';

/**
 * 验证归档条目只能解析到目标根目录内的安全路径。
 *
 * @remarks
 * 同时覆盖目录穿越、绝对路径、Windows 设备名和合法相对路径。
 */
void test('Archive paths reject traversal, absolute paths, and Windows device names', () => {
  const root = resolve('archive-root');
  for (const path of ['../escape', '/root/escape', 'C:\\escape', 'CON', 'a/../../b'])
    assert.throws(() => archivePath(path, root), { code: 'ARCHIVE_UNSAFE' });
  assert.equal(archivePath('./bin/agent', root), resolve(root, 'bin/agent'));
});
