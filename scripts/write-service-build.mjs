import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// 打包时固定完整运行产物、锁定依赖与原生源码摘要，运行包不需要包含 package-lock.json。
const root = new URL('../dist/', import.meta.url);
const files = (await readdir(root, { recursive: true }))
  .filter((file) => file.endsWith('.js'))
  .sort();
const hash = createHash('sha256');
for (const file of files) {
  hash.update(JSON.stringify(file));
  hash.update(await readFile(new URL(file, root)));
}
for (const file of [
  'package-lock.json',
  'native/windows/process-host.c',
  'native/windows/service-launcher.c',
]) {
  hash.update(file);
  hash.update(await readFile(new URL('../' + file, import.meta.url)));
}
await writeFile(
  new URL('service-build.json', root),
  JSON.stringify({ buildId: hash.digest('hex') }) + '\n',
);
