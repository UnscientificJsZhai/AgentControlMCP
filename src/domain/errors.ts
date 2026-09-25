import { z } from 'zod';

/** 可跨 CLI、MCP 和管理 IPC 返回的业务错误；details 必须由调用方确保不含敏感值。 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly nextAction = '检查相关对象的当前状态，修正输入后重新操作。',
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function fail(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new AppError(code, message, details);
}

/** 将业务错误、输入校验错误和未知异常转换为稳定的对外结构，不自动建议重试副作用。 */
export function errorDetail(error: unknown) {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
      retryable: false,
      nextAction: error.nextAction,
    };
  }
  if (error instanceof z.ZodError) {
    const flatten = (
      issues: z.core.$ZodIssue[],
      prefix: PropertyKey[] = [],
    ): { path: PropertyKey[]; message: string }[] =>
      issues.flatMap((issue) => {
        const path = [...prefix, ...issue.path];
        return issue.code === 'invalid_union' && issue.errors.length
          ? issue.errors.flatMap((branch) => flatten(branch, path))
          : [{ path, message: issue.message }];
      });
    const issues = flatten(error.issues);
    return {
      code: 'CONFIG_INVALID',
      message: '输入不符合 Schema。',
      details: { issues },
      retryable: false,
      nextAction: '根据 details.issues 中的完整字段路径修正输入。',
    };
  }
  // 不将第三方异常原文直接返回；其中可能含命令环境或认证信息。
  return {
    code: 'INTERNAL_ERROR',
    message: '操作失败。请使用本地诊断检查运行状态。',
    retryable: false,
    nextAction: '运行 agent-control-mcp doctor。',
  };
}

export type ErrorDetail = ReturnType<typeof errorDetail>;
