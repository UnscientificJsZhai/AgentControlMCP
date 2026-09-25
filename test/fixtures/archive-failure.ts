import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { ReadStream, WriteStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { mock } from 'node:test';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { extractArchive } from '../../src/infrastructure/installers/archive-reader.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function tarEntry(path: string, type: 'File' | 'Directory', data = Buffer.alloc(0)) {
  const header = Buffer.alloc(512);
  new Header({ path, type, size: data.length, mode: 0o700 }).encode(header);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

const [scenario, directory] = process.argv.slice(2);
assert.ok(directory);
assert.ok(['directory', 'file', 'cancel'].includes(scenario ?? ''));
await fsPromises.mkdir(join(directory, 'stage'));
const stage = await fsPromises.realpath(join(directory, 'stage'));
const large = randomBytes(4 * 1024 * 1024);
const entries = [tarEntry('pending/', 'Directory')];
if (scenario === 'directory') {
  entries.unshift(tarEntry('blocked', 'File', Buffer.from('blocked')));
  entries.push(tarEntry('blocked/child/', 'Directory'), tarEntry('large', 'File', large));
} else if (scenario === 'file') {
  await fsPromises.writeFile(join(stage, 'exists'), 'existing');
  entries.push(tarEntry('exists', 'File', large));
} else {
  entries.push(tarEntry('late/large', 'File', large));
}
const bytes = gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
const archive = join(directory, 'archive.tar.gz');
await fsPromises.writeFile(archive, bytes);

const pendingStarted = gate();
const fileMkdirStarted = gate();
const releaseMkdir = gate();
const largeOpened = gate();
const sourceClosed = gate();
const streams = new Set<ReadStream | WriteStream>();
const controller = new AbortController();
let originalError: unknown;
let pendingMkdir = 0;
let lateWrites = 0;
let largeStream: WriteStream | undefined;
let operation: Promise<unknown> | undefined;
const mkdir = fsPromises.mkdir;
const createReadStream = fs.createReadStream;
const createWriteStream = fs.createWriteStream;

try {
  mock.method(fsPromises, 'mkdir', async (...args: Parameters<typeof mkdir>) => {
    pendingMkdir++;
    try {
      const path = String(args[0]);
      if (path === join(stage, 'pending')) {
        pendingStarted.release();
        await releaseMkdir.promise;
      } else if (scenario === 'cancel' && path === join(stage, 'late')) {
        fileMkdirStarted.release();
        await releaseMkdir.promise;
      } else if (path === join(stage, 'blocked', 'child')) {
        // 先让后续大文件进入写入背压，再用真实文件/目录冲突触发 mkdir 拒绝。
        await largeOpened.promise;
        try {
          return await mkdir(...args);
        } catch (error) {
          originalError = error;
          throw error;
        }
      }
      return await mkdir(...args);
    } finally {
      pendingMkdir--;
    }
  });
  mock.method(fs, 'createReadStream', (...args: Parameters<typeof createReadStream>) => {
    const stream = createReadStream(...args);
    streams.add(stream);
    stream.once('close', () => {
      streams.delete(stream);
      sourceClosed.release();
    });
    return stream;
  });
  mock.method(fs, 'createWriteStream', (...args: Parameters<typeof createWriteStream>) => {
    const stream = createWriteStream(...args);
    streams.add(stream);
    stream.once('close', () => streams.delete(stream));
    if (String(args[0]) === join(stage, 'large')) {
      largeStream = stream;
      // 固定背压时序，保证解析器尚未读完；取消必须真正关闭活动写入才能退出。
      stream.cork();
      stream.once('open', largeOpened.release);
    } else if (String(args[0]) === join(stage, 'exists')) {
      stream.once('error', (error) => {
        originalError = error;
      });
    } else if (String(args[0]) === join(stage, 'late', 'large')) {
      lateWrites++;
    }
    return stream;
  });
  syncBuiltinESMExports();

  let settled = false;
  operation = extractArchive(
    archive,
    'https://example.test/archive.tar.gz',
    stage,
    bytes.length,
    controller.signal,
  ).then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await pendingStarted.promise;
  if (scenario === 'cancel') {
    await fileMkdirStarted.promise;
    originalError = new Error('fixture cancelled');
    controller.abort(originalError);
  }
  await sourceClosed.promise;
  await setImmediate();
  assert.equal(settled, false, '已有目录任务尚未退出时，调用方不能开始清理暂存目录');
  assert.ok(pendingMkdir > 0);
  releaseMkdir.release();
  const error = await operation;
  assert.ok(error instanceof Error);
  assert.equal(error, originalError, '保留首次失败或取消原因');
  assert.equal(pendingMkdir, 0);
  assert.equal(streams.size, 0, '返回前关闭输入及所有输出文件句柄');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(lateWrites, 0, '取消后才完成的 mkdir 不能再启动文件写入');
  if (scenario === 'directory') {
    assert.ok(largeStream?.closed);
    assert.ok(largeStream.bytesWritten < large.length);
  }
  await assert.rejects(fsPromises.access(join(stage, '.extracted')), { code: 'ENOENT' });
  await fsPromises.rm(stage, { recursive: true });
  await fsPromises.mkdir(stage);
  await fsPromises.writeFile(join(stage, 'cleanup-marker'), 'clean');
  await setImmediate();
  assert.deepEqual(await fsPromises.readdir(stage), ['cleanup-marker']);
  process.stdout.write('caught-and-cleaned\n');
} finally {
  releaseMkdir.release();
  await operation;
  mock.restoreAll();
  syncBuiltinESMExports();
}
