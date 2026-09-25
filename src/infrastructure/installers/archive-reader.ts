import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, link, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, relative } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Parser } from 'tar';
import type { ReadEntry } from 'tar';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';
import unbzip2 from 'unbzip2-stream';
import { fail } from '../../domain/errors.js';
import { inside } from '../platform/file-callbacks.js';

/** 统一拒绝目录穿越、绝对路径、Windows 设备名和易混淆后缀，产物需在各平台保持安全。 */
export function archivePath(name: string, root: string) {
  const stripped = name.replace(/^\.\//, '');
  if (
    !stripped ||
    isAbsolute(stripped) ||
    /[\\:\0]/.test(stripped) ||
    stripped
      .split('/')
      .some(
        (part) =>
          part === '..' ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
          /[. ]$/.test(part),
      )
  )
    fail('ARCHIVE_UNSAFE', '归档包含不安全的路径。');
  const target = resolve(root, stripped);
  if (!inside(root, target)) fail('ARCHIVE_UNSAFE', '归档路径越界。');
  return target;
}

/**
 * 流式展开 ZIP/TAR，并限制条目数、声明展开大小与压缩比。
 * 普通文件使用独占创建；链接推迟到所有文件写完后处理，避免后续条目沿链接写到根目录外。
 */
export async function extractArchive(
  file: string,
  url: string,
  root: string,
  compressedBytes: number,
  signal: AbortSignal,
) {
  root = await realpath(root);
  let count = 0;
  let total = 0;
  const seen = new Set<string>();
  const links: { target: string; source: string; hard: boolean }[] = [];
  const reserve = (name: string, size: number) => {
    signal.throwIfAborted();
    count++;
    total += size;
    if (count > 100_000 || total > 4 * 1024 ** 3 || total > Math.max(compressedBytes, 1) * 200)
      fail('ARCHIVE_UNSAFE', '归档条目数、展开大小或压缩比超过限制。');
    const target = archivePath(name, root);
    // 即使当前宿主大小写敏感，也拒绝在其他支持平台上会覆盖彼此的条目。
    const normalized = target.toLowerCase();
    if (seen.has(normalized)) fail('ARCHIVE_UNSAFE', '归档存在重复或大小写冲突路径。');
    seen.add(normalized);
    return target;
  };
  if (/\.zip$/i.test(new URL(url).pathname)) {
    const zip = await new Promise<ZipFile>((resolve, reject) =>
      yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) =>
        error || !zip ? reject(error ?? new Error('ZIP 无效')) : resolve(zip),
      ),
    );
    await new Promise<void>((resolvePromise, reject) => {
      zip.on('error', reject);
      zip.on('end', resolvePromise);
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          const target = reserve(entry.fileName, entry.uncompressedSize);
          const mode = entry.externalFileAttributes >>> 16;
          if (entry.isEncrypted()) fail('ARCHIVE_UNSAFE', '不支持加密归档。');
          if (entry.fileName.endsWith('/')) {
            await mkdir(target, { recursive: true, mode: 0o700 });
            zip.readEntry();
            return;
          }
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          const stream = await new Promise<Readable>((resolve, reject) =>
            zip.openReadStream(entry, (error, stream) =>
              error || !stream ? reject(error ?? new Error('ZIP 流无效')) : resolve(stream),
            ),
          );
          if ((mode & 0o170000) === 0o120000) {
            if (entry.uncompressedSize > 4096) fail('ARCHIVE_UNSAFE', '归档链接目标过长。');
            const chunks: Buffer[] = [];
            for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
            links.push({
              target,
              source: resolve(dirname(target), Buffer.concat(chunks).toString()),
              hard: false,
            });
          } else {
            await pipeline(
              stream,
              createWriteStream(target, { flags: 'wx', mode: mode & 0o111 ? 0o700 : 0o600 }),
              { signal },
            );
          }
          zip.readEntry();
        })().catch((error: unknown) => {
          zip.close();
          reject(error instanceof Error ? error : new Error('ZIP 解压失败'));
        });
      });
      zip.readEntry();
    });
  } else {
    const pending: Promise<void>[] = [];
    const activeEntries = new Set<ReadEntry>();
    const writes = new AbortController();
    const source = createReadStream(file);
    const sourceClosed = new Promise<void>((resolve) => source.once('close', resolve));
    const decompressor = /\.(tar\.bz2|tbz2)$/i.test(new URL(url).pathname) ? unbzip2() : undefined;
    let failure: Error | undefined;
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const stop = (error: unknown) => {
      if (failure) return;
      failure = error instanceof Error ? error : new Error('归档解压失败');
      source.unpipe();
      source.destroy();
      decompressor?.destroy();
      parser.abort(failure);
      // Parser.abort 不会结束条目流，必须同时取消写入，才能等待所有任务收敛。
      writes.abort(failure);
      for (const entry of activeEntries) entry.destroy();
      complete();
    };
    const track = (task: Promise<unknown>) => {
      // 立即消费每个拒绝；保留首个错误，等所有任务退出后再交给调用方。
      pending.push(task.then(() => {}, stop));
    };
    const parser = new Parser({
      strict: true,
      onReadEntry(entry) {
        if (failure) {
          entry.destroy();
          return;
        }
        activeEntries.add(entry);
        entry.once('end', () => activeEntries.delete(entry));
        try {
          if (entry.type === 'Directory' && ['.', './'].includes(entry.path)) {
            entry.resume();
            return;
          }
          const target = reserve(entry.path, entry.size);
          if (entry.type === 'Directory') {
            track(mkdir(target, { recursive: true, mode: 0o700 }));
            entry.resume();
          } else if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
            const source = resolve(
              entry.type === 'Link' ? root : dirname(target),
              entry.linkpath ?? '',
            );
            links.push({ target, source, hard: entry.type === 'Link' });
            entry.resume();
          } else if (
            entry.type === 'File' ||
            entry.type === 'OldFile' ||
            entry.type === 'ContiguousFile'
          ) {
            track(
              (async () => {
                await mkdir(dirname(target), { recursive: true, mode: 0o700 });
                writes.signal.throwIfAborted();
                await pipeline(
                  entry,
                  createWriteStream(target, {
                    flags: 'wx',
                    mode: entry.mode && entry.mode & 0o111 ? 0o700 : 0o600,
                  }),
                  { signal: writes.signal },
                );
              })(),
            );
          } else {
            entry.resume();
            fail('ARCHIVE_UNSAFE', '归档包含不支持的特殊文件。');
          }
        } catch (error) {
          stop(error);
        }
      },
    });
    parser.on('end', complete);
    parser.on('error', stop);
    source.on('error', stop);
    decompressor?.on('error', stop);
    const abort = () => stop(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) abort();
      else if (decompressor) source.pipe(decompressor).pipe(parser);
      else source.pipe(parser);
      await done;
    } catch (error) {
      stop(error);
    } finally {
      await Promise.all(pending);
      source.destroy();
      decompressor?.destroy();
      await sourceClosed;
      signal.removeEventListener('abort', abort);
    }
    if (failure) throw failure;
  }
  // 同时检查链接声明位置和目标真实路径，覆盖通过另一条符号链接间接逃逸的情况。
  for (const entry of links) {
    if (!inside(root, entry.source) || !inside(root, await realpath(entry.source)))
      fail('ARCHIVE_UNSAFE', '归档链接目标越界。');
    await mkdir(dirname(entry.target), { recursive: true });
    if (entry.hard) await link(entry.source, entry.target);
    else await symlink(relative(dirname(entry.target), entry.source), entry.target);
  }
  await writeFile(join(root, '.extracted'), String(total), { mode: 0o600 });
  return { entries: count, expandedBytes: total };
}

export async function ensureExecutable(path: string) {
  await chmod(path, 0o700);
}
