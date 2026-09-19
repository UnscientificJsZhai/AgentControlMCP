import { rm } from 'node:fs/promises';

const targets = {
  build: ['dist'],
  test: ['.test-dist'],
  all: ['dist', '.test-dist'],
};
const [target = 'all', ...extraArgs] = process.argv.slice(2);

if (!Object.hasOwn(targets, target) || extraArgs.length > 0) {
  console.error('用法：node scripts/clean.mjs [build|test|all]');
  process.exitCode = 1;
} else {
  // 仅清理仓库内固定的产物目录，不接收任意文件路径。
  for (const directory of targets[target]) {
    await rm(new URL(`../${directory}`, import.meta.url), { recursive: true, force: true });
  }
}
