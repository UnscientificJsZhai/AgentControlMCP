import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// 发布前同时检查两种 Windows 架构的 PE 头；文件存在不能证明它是匹配架构的可执行产物。
for (const [arch, machine] of [
  ['x64', 0x8664],
  ['arm64', 0xaa64],
]) {
  const path = `native/win32-${arch}/process-host.exe`;
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    throw new Error(`发布包缺少 ${path}；请先构建 Windows 宿主或取得同一源码的 CI 构建产物。`);
  }
  assert.equal(bytes.toString('ascii', 0, 2), 'MZ', path);
  const pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt32LE(pe), 0x4550, path);
  assert.equal(bytes.readUInt16LE(pe + 4), machine, path);
}
console.error('发布包所需 Windows x64/ARM64 进程宿主均存在且 PE 架构正确。');
