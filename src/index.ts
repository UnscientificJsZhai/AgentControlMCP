/** 库入口只导出能力；创建容器、启动服务和安装退出钩子均由调用方显式触发。 */
export { Container } from './bootstrap/container.js';
export { createTools, invoke } from './transport/mcp/tools.js';
export { createMcpTools } from './transport/mcp/catalog.js';
export { startHttp, startStdio } from './transport/mcp/serve.js';
export { AppError } from './domain/errors.js';

export { resolveStoragePaths } from './infrastructure/storage/paths.js';
export type { StoragePaths } from './infrastructure/storage/paths.js';
