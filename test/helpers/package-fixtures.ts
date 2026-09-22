import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { create } from 'tar';

/** 生成无依赖 npm 包和纯 Python wheel，真实安装测试无需访问公开 Registry。 */
export async function createPackageFixtures(root: string) {
  const packageDir = join(root, 'package');
  await mkdir(packageDir);
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: 'fixture-agent',
      version: '1.0.0',
      bin: { 'fixture-agent': 'entry.cjs' },
    }),
  );
  await writeFile(
    join(packageDir, 'entry.cjs'),
    '#!/usr/bin/env -S node --expose-gc\nglobal.gc();\nconsole.log("offline-fixture-1.0.0", JSON.stringify(process.argv.slice(2)));\n',
  );
  const npm = join(root, 'fixture-agent.tgz');
  await create({ gzip: true, file: npm, cwd: root }, ['package']);
  const entries: Record<string, string> = {
    'fixture_agent.py':
      'import sys, json\ndef main():\n    print("offline-fixture-1.0.0", json.dumps(sys.argv[1:]))\n',
    'fixture_agent-1.0.0.dist-info/METADATA':
      'Metadata-Version: 2.1\nName: fixture-agent\nVersion: 1.0.0\n',
    'fixture_agent-1.0.0.dist-info/WHEEL':
      'Wheel-Version: 1.0\nGenerator: storage-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
    'fixture_agent-1.0.0.dist-info/entry_points.txt':
      '[console_scripts]\nfixture-agent = fixture_agent:main\n',
  };
  const record = 'fixture_agent-1.0.0.dist-info/RECORD';
  entries[record] =
    Object.entries(entries)
      .map(
        ([name, value]) =>
          `${name},sha256=${createHash('sha256').update(value).digest('base64url')},${Buffer.byteLength(value)}`,
      )
      .join('\n') + `\n${record},,\n`;
  const wheel = join(root, 'fixture_agent-1.0.0-py3-none-any.whl');
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const filename = Buffer.from(name);
    const content = Buffer.from(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(content), 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, filename, content);
    centrals.push(central, filename);
    offset += local.length + filename.length + content.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  await writeFile(wheel, Buffer.concat([...locals, directory, end]));
  return { npm, wheel };
}
