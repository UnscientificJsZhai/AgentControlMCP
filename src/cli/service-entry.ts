import { writeFile, rename } from 'node:fs/promises';
import { ExecutionService } from '../bootstrap/execution-service.js';
import type { StoragePaths } from '../infrastructure/storage/paths.js';
import { settingsSchema } from '../domain/schemas.js';
import { AppError, errorDetail } from '../domain/errors.js';

let startupFile: string | undefined;
let startupTimer: NodeJS.Timeout | undefined;
// 仅自动启动进程执行本入口，库入口始终无启动副作用。候选失败不能清理胜出者资源。
try {
  const options = JSON.parse(process.argv[2] ?? '{}') as {
    paths: StoragePaths;
    settings?: unknown;
    startupFile?: string;
  };
  startupFile = options.startupFile;
  startupTimer = setTimeout(
    () => process.exit(1),
    settingsSchema.parse(options.settings ?? {}).serviceStartupTimeoutMs,
  );
  await ExecutionService.start({
    paths: options.paths,
    source: 'auto_stdio',
    ...(options.settings ? { settings: settingsSchema.parse(options.settings) } : {}),
  });
} catch (error) {
  if (!(error instanceof AppError && error.code === 'RESOURCE_CONFLICT')) {
    const detail = errorDetail(error);
    if (startupFile) {
      const path = startupFile;
      const temp = path + '.tmp';
      await writeFile(temp, JSON.stringify({ error: detail }), { mode: 0o600 })
        .then(() => rename(temp, path))
        .catch(() => {});
    }
    process.stderr.write(JSON.stringify({ error: detail }) + '\n');
  }
  process.exitCode = 1;
} finally {
  clearTimeout(startupTimer);
}
