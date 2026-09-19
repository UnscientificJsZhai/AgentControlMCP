import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, gzipSync } from 'node:zlib';
import BZip2 from '@digitaldefiance/bzip2-wasm';
import { Header } from 'tar';

const agent = Buffer.from("#!/usr/bin/env node\nconsole.log('binary-fixture-1.0.0');\n");

// 生成单文件、未压缩的 ZIP，便于分别验证安全路径和目录逃逸。
function zip(path: string): Buffer {
  const name = Buffer.from(path);
  const checksum = crc32(agent);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0021, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(agent.length, 18);
  local.writeUInt32LE(agent.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0021, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(agent.length, 20);
  central.writeUInt32LE(agent.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100755 * 2 ** 16) >>> 0, 38);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + agent.length, 16);
  return Buffer.concat([local, name, agent, central, name, end]);
}

/** 手工构造普通文件及内部符号链接，验证两种 TAR 压缩方式都保留可用链接。 */
function tar(): Buffer {
  const file = Buffer.alloc(512);
  new Header({ path: 'bin/agent', type: 'File', size: agent.length, mode: 0o755 }).encode(file);
  const link = Buffer.alloc(512);
  new Header({ path: 'alias', type: 'SymbolicLink', linkpath: 'bin/agent', mode: 0o777 }).encode(
    link,
  );
  return Buffer.concat([
    file,
    agent,
    Buffer.alloc((512 - (agent.length % 512)) % 512),
    link,
    Buffer.alloc(1024),
  ]);
}

/** 在测试目录内生成多种分发格式和一个穿越样本，不依赖外部归档工具或远程下载。 */
export async function createArchiveFixtures(
  directory: string,
): Promise<{ archives: Map<string, string>; unsafe: string }> {
  const raw = tar();
  const gzip = gzipSync(raw);
  const compressor = new BZip2();
  await compressor.init();
  const bzip = compressor.compress(raw, 1, raw.length + Math.ceil(raw.length * 0.01) + 600);
  const samples: Record<string, Uint8Array> = {
    zip: zip('bin/agent'),
    'tar.gz': gzip,
    tgz: gzip,
    'tar.bz2': bzip,
    tbz2: bzip,
  };
  const archives = new Map<string, string>();
  for (const [extension, bytes] of Object.entries(samples)) {
    const path = join(directory, `fixture.${extension}`);
    await writeFile(path, bytes);
    archives.set(extension, path);
  }
  const unsafe = join(directory, 'unsafe.zip');
  await writeFile(unsafe, zip('../escape'));
  return { archives, unsafe };
}
