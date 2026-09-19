import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fail } from '../../domain/errors.js';

export function inside(root: string, path: string) {
  const suffix = relative(root, path);
  return (
    suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
  );
}
export async function checkedPath(path: string, roots: string[], write = false): Promise<string> {
  if (!isAbsolute(path)) fail('ACCESS_DENIED', '文件回调只接受宿主绝对路径。');
  const canonicalRoots = await Promise.all(roots.map((root) => realpath(root)));
  let target: string;
  try {
    target = await realpath(path);
  } catch {
    if (!write) return fail('OBJECT_NOT_FOUND', '文件不存在。');
    // 不创建父目录；确保真正打开时的父目录已经存在且仍在授权范围内。
    target = resolve(await realpath(dirname(path)), relative(dirname(path), path));
  }
  if (!canonicalRoots.some((root) => inside(root, target)))
    fail('ACCESS_DENIED', '文件路径超出会话授权目录。');
  return target;
}
export async function readText(
  path: string,
  roots: string[],
  line?: number | null,
  limit?: number | null,
) {
  const target = await checkedPath(path, roots);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    const current = await lstat(await checkedPath(path, roots));
    if (!info.isFile() || info.ino !== current.ino || info.dev !== current.dev)
      fail('ACCESS_DENIED', '文件在检查后变化。');
    if (info.size > 16 * 1024 ** 2) fail('CAPACITY_EXCEEDED', '文件超过读取上限。');
    const text = await handle.readFile('utf8');
    if (line == null && limit == null) return { content: text };
    return {
      content: text
        .split('\n')
        .slice((line ?? 1) - 1, limit == null ? undefined : (line ?? 1) - 1 + limit)
        .join('\n'),
    };
  } finally {
    await handle.close();
  }
}
export async function writeText(path: string, content: string, roots: string[]) {
  if (Buffer.byteLength(content) > 16 * 1024 ** 2) fail('CAPACITY_EXCEEDED', '写入内容超过上限。');
  const target = await checkedPath(path, roots, true);
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const info = await handle.stat();
    const current = await lstat(await checkedPath(path, roots));
    if (!info.isFile() || info.ino !== current.ino || info.dev !== current.dev)
      fail('ACCESS_DENIED', '文件在检查后变化。');
    await handle.truncate(0);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    return {};
  } finally {
    await handle.close();
  }
}
