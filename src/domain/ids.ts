import { createHash, randomUUID } from 'node:crypto';

export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const now = () => new Date().toISOString();

/**
 * 为可 JSON 序列化的数据生成稳定表示：对象键排序、忽略 undefined 字段，数组保持原顺序。
 * 幂等请求和方案摘要依赖此表示，不能用对象的插入顺序判断请求是否相同。
 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 摘要用于标识内容或配置，不代替凭据哈希及签名。 */
export const digest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
export const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
