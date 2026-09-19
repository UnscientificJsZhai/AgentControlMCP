import type { PermissionPolicy } from './schemas.js';

/** 可可靠识别的宿主操作；不能从自由文本推断出的请求应传入 null 并进入人工确认。 */
export interface OperationDescription {
  operation: 'read' | 'write' | 'delete' | 'execute';
  paths: string[];
  command?: { executable: string; args: string[] };
}

/**
 * 按规则声明顺序选择首个匹配项，所有目标路径都必须落在该规则允许的根目录内。
 * 执行命令额外要求可执行文件及完整参数数组一致；无匹配或信息不足统一返回 ask。
 * 路径规范化由调用方注入，领域规则无需访问文件系统。
 */
export function decide(
  policy: PermissionPolicy,
  operation: OperationDescription | null,
  matchesRoot: (path: string, roots: string[]) => boolean,
): 'allow_once' | 'ask' | 'deny' {
  if (!operation || !operation.paths.length) return 'ask';
  for (const rule of policy.rules) {
    if (
      !rule.operations.includes(operation.operation) ||
      !operation.paths.every((path) => matchesRoot(path, rule.roots))
    )
      continue;
    if (
      operation.operation === 'execute' &&
      (!rule.command ||
        !operation.command ||
        rule.command.executable !== operation.command.executable ||
        JSON.stringify(rule.command.args) !== JSON.stringify(operation.command.args))
    )
      continue;
    return rule.effect;
  }
  return 'ask';
}
