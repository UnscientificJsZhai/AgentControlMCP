import { id } from '../domain/ids.js';
import type { Context } from '../domain/models.js';

/** 连接能力只保存在内存；断连后后台调度不能继续借用旧连接的呈现能力。 */
export class InteractionChannelRegistry {
  private readonly admissions = new Map<string, string>();
  private readonly channels = new Map<string, { principalId: string; native: boolean }>();
  register(connectionId: string, principalId: string) {
    this.channels.set(connectionId, { principalId, native: false });
  }
  update(ctx: Context) {
    if (!ctx.connectionId) return;
    const channel = this.channels.get(ctx.connectionId);
    if (channel?.principalId === ctx.principalId) channel.native = ctx.nativeInteraction === true;
  }
  remove(connectionId: string) {
    this.channels.delete(connectionId);
  }
  /** HTTP 响应结束不撤销已受理工作的准入；后续交互仍必须经新请求或 CLI 呈现。 */
  retainAccepted(ctx: Context) {
    if (ctx.mode !== 'http' || !this.available(ctx)) return () => {};
    const token = id('interaction_admission');
    this.admissions.set(token, ctx.principalId);
    ctx.interactionAdmissionId = token;
    return () => this.admissions.delete(token);
  }
  available(ctx: Context) {
    if (
      ctx.interactionAdmissionId &&
      this.admissions.get(ctx.interactionAdmissionId) === ctx.principalId
    )
      return true;
    if (ctx.connectionId) {
      const channel = this.channels.get(ctx.connectionId);
      return channel?.principalId === ctx.principalId && channel.native;
    }
    return [...this.channels.values()].some((c) => c.principalId === ctx.principalId && c.native);
  }
}
