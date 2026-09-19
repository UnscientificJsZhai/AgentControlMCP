import { readFile, stat } from 'node:fs/promises';
import type { Environment, EnvValue } from '../../domain/schemas.js';
import { fail } from '../../domain/errors.js';

const posix = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE'];
const windows = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
];

/** 解析最小 KEY=VALUE 格式，只去掉成对引号；不执行 shell、不展开变量或转义表达式。 */
export function parseEnvFile(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) fail('CONFIG_INVALID', '私有 env 文件格式错误。');
    let value = match[2] ?? '';
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    else if (/^["']|["']$/.test(value)) fail('CONFIG_INVALID', '私有 env 文件引号未配对。');
    // env 文件是数据，不求值或展开任何 shell 表达式。
    values[match[1]!] = value;
  }
  return values;
}

/** 延迟解析环境引用，私有文件限制体积及 POSIX 权限；失败错误不包含实际值。 */
export async function resolveValue(
  ref: EnvValue,
  host: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (ref.kind === 'literal') return ref.value;
  if (ref.kind === 'host_env') {
    const value = host[ref.name];
    if (value === undefined)
      fail('ENV_REFERENCE_UNRESOLVED', '宿主环境变量不存在。', { name: ref.name });
    return value;
  }
  try {
    const info = await stat(ref.path);
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      fail('ENV_REFERENCE_UNRESOLVED', '私有 env 文件必须仅当前用户可读写。', { path: ref.path });
    if (info.size > 1024 * 1024) fail('CONFIG_INVALID', '私有 env 文件过大。');
    const value = parseEnvFile(await readFile(ref.path, 'utf8'))[ref.key];
    if (value === undefined)
      fail('ENV_REFERENCE_UNRESOLVED', '私有 env 文件缺少引用键。', { key: ref.key });
    return value;
  } catch {
    return fail('ENV_REFERENCE_UNRESOLVED', '无法解析私有 env 文件引用。', {
      path: ref.path,
      key: ref.key,
    });
  }
}

/**
 * 仅继承平台基础变量与显式允许项，再按分发默认值、注册配置的顺序覆盖。
 * Windows 环境键统一大写；引用值及显式继承值加入脱敏集合，literal 视为显式配置数据。
 */
export async function resolveEnvironment(
  config: Environment,
  defaults: Record<string, string> = {},
  host: NodeJS.ProcessEnv = process.env,
) {
  const env: Record<string, string> = {};
  const secrets: string[] = [];
  const normalize = (key: string) => (process.platform === 'win32' ? key.toUpperCase() : key);
  const source = Object.fromEntries(
    Object.entries(host).map(([key, value]) => [normalize(key), value]),
  );
  for (const key of [...(process.platform === 'win32' ? windows : posix), ...config.inherit]) {
    const value = source[normalize(key)];
    if (value !== undefined) env[normalize(key)] = value;
  }
  for (const [key, value] of Object.entries(defaults)) env[normalize(key)] = value;
  for (const [key, ref] of Object.entries(config.values)) {
    const value = await resolveValue(ref, host);
    env[normalize(key)] = value;
    if (ref.kind !== 'literal' && value) secrets.push(value);
  }
  for (const key of config.inherit) {
    const value = source[normalize(key)];
    if (value) secrets.push(value);
  }
  return { env, secrets };
}

/** 对可 JSON 序列化的数据按已知秘密原值脱敏，先替换长值以避免短值破坏长值匹配。 */
export function redact<T>(value: T, secrets: string[]): T {
  let serialized = JSON.stringify(value);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
  return JSON.parse(serialized) as T;
}
