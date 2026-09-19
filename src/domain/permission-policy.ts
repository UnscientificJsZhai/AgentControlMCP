import type { PermissionPolicy } from './schemas.js';

export interface OperationDescription {
  operation: 'read' | 'write' | 'delete' | 'execute';
  paths: string[];
  command?: { executable: string; args: string[] };
}
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
