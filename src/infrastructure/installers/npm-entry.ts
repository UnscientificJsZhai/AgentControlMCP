import { basename } from 'node:path';
import { fail } from '../../domain/errors.js';

/** 只解析参数，不执行 shell；不支持 env 的变量替换和其他环境修改选项。 */
function words(line: string) {
  const result: string[] = [];
  let word = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '$' || char === '`') fail('CONFIG_INVALID', 'npm 入口 shebang 不支持变量展开。');
    if (char === '\\' && quote !== "'") {
      const next = line[++i];
      if (!next) fail('CONFIG_INVALID', 'npm 入口 shebang 转义不完整。');
      word += next;
      started = true;
    } else if (quote) {
      if (char === quote) quote = '';
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) result.push(word);
      word = '';
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) fail('CONFIG_INVALID', 'npm 入口 shebang 引号未闭合。');
  if (started) result.push(word);
  return result;
}

/** Node 脚本保留解释器参数；原生入口直接执行，避免依赖 npm 缓存和 shell 包装器。 */
export function npmLaunch(executable: string, header: string, platform = process.platform) {
  const line = header.split('\n')[0]?.replace(/\r$/, '') ?? '';
  let nodeArgs: string[] | undefined;
  if (line.startsWith('#!')) {
    const parts = words(line.slice(2));
    let interpreter = parts.shift() ?? '';
    if (basename(interpreter) === 'env') {
      if (parts[0] === '-S' || parts[0] === '--split-string') parts.shift();
      interpreter = parts.shift() ?? '';
      if (interpreter.startsWith('-') || interpreter.includes('='))
        fail('CONFIG_INVALID', 'npm 入口 shebang 使用了不支持的 env 选项。');
    }
    if (basename(interpreter) === 'node') nodeArgs = parts;
  } else if (/\.[cm]?js$/i.test(executable)) nodeArgs = [];
  if (nodeArgs) return { executable: process.execPath, prefixArgs: [...nodeArgs, executable] };
  if (platform === 'win32' && !/\.(exe|com)$/i.test(executable))
    fail('PLATFORM_UNSUPPORTED', 'Windows 包入口需要 Node 脚本或原生可执行文件。');
  return { executable, prefixArgs: [] };
}
