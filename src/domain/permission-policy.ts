import type { PermissionPolicy } from './schemas.js';
import { canonical } from './ids.js';

/** 可可靠识别的宿主操作；不能从自由文本推断出的请求应传入 null 并进入人工确认。 */
export interface OperationDescription {
  operation: 'read' | 'write' | 'delete' | 'execute';
  paths: string[];
  command?: { executable: string; args: string[]; env?: Record<string, string> };
}

/**
 * 按规则声明顺序选择首个匹配项，所有目标路径都必须落在该规则允许的根目录内。
 * 执行放行还要求请求覆盖环境完全一致；未声明 env 的拒绝规则仍覆盖任意环境。
 * 无匹配或信息不足统一返回 ask。
 * 路径规范化由调用方注入，领域规则无需访问文件系统。
 */
export function decide(
  policy: PermissionPolicy,
  operation: OperationDescription | null,
  matchesRoot: (path: string, roots: string[]) => boolean,
  normalizeEnvironment: (env: Record<string, string>) => Record<string, string> = (env) => env,
): 'allow_once' | 'ask' | 'deny' {
  if (!operation || !operation.paths.length) return 'ask';
  for (const rule of policy.rules) {
    if (
      !rule.operations.includes(operation.operation) ||
      !operation.paths.every((path) => matchesRoot(path, rule.roots))
    )
      continue;
    if (operation.operation === 'execute') {
      if (
        !rule.command ||
        !operation.command ||
        rule.command.executable !== operation.command.executable ||
        JSON.stringify(rule.command.args) !== JSON.stringify(operation.command.args)
      )
        continue;
      if (
        (rule.effect === 'allow_once' || rule.command.env !== undefined) &&
        canonical(normalizeEnvironment(rule.command.env ?? {})) !==
          canonical(normalizeEnvironment(operation.command.env ?? {}))
      )
        continue;
    }
    return rule.effect;
  }
  return 'ask';
}
