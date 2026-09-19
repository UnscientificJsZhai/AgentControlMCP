import { z } from 'zod';

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
    return {
      code: 'CONFIG_INVALID',
      message: '输入不符合 Schema。',
      details: { issues: error.issues.map(({ path, message }) => ({ path, message })) },
      retryable: false,
      nextAction: '根据字段错误修改输入。',
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
