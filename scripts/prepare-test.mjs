import { cp, access } from 'node:fs/promises';

// 测试编译保留 src/ 层级，原生宿主随测试产物复制到相同相对位置。
if (process.platform === 'win32') {
  const path = `native/win32-${process.arch}`;
  await access(`${path}/process-host.exe`);
  await cp(path, `.test-dist/${path}`, { recursive: true });
}
