import { lstat, readdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from '../../domain/ids.js';

/** 文件大小是可解释的逻辑磁盘用量；不跟随链接，不把 APFS 克隆误称为物理独占空间。 */
export async function inspectTree(root: string, seen = new Set<string>()) {
  let bytes = 0;
  const entries: unknown[] = [];
  async function visit(path: string, relative: string) {
    let info;
    try {
      info = await lstat(path, { bigint: true });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    entries.push([
      relative,
      String(info.dev),
      String(info.ino),
      String(info.size),
      String(info.mtimeNs),
      String(info.ctimeNs),
      String(info.mode),
    ]);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      let names: string[];
      try {
        names = await readdir(path);
      } catch (error) {
        // 统计期间安装取消或清理可能删除目录，忽略已消失项但不吞掉权限和 IO 错误。
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
        throw error;
      }
      for (const name of names.sort()) await visit(join(path, name), `${relative}/${name}`);
    } else if (info.isFile()) {
      const key = `${info.dev}:${info.ino}`;
      if (!seen.has(key)) {
        seen.add(key);
        bytes += Number(info.size);
      }
    }
  }
  await visit(root, '');
  return { bytes, fingerprint: digest(entries), exists: entries.length !== 0 };
}

export async function diskSpace(roots: string[]) {
  const devices = new Map<string, { paths: string[]; freeBytes: number }>();
  for (const root of new Set(roots)) {
    const info = await lstat(root);
    const device = String(info.dev);
    const existing = devices.get(device);
    if (existing) existing.paths.push(root);
    else {
      const space = await statfs(root, { bigint: true });
      devices.set(device, { paths: [root], freeBytes: Number(space.bavail * space.bsize) });
    }
  }
  return [...devices.values()];
}
