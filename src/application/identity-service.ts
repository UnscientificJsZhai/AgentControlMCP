import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { id, now } from '../domain/ids.js';
import { fail } from '../domain/errors.js';
import type { Context, Credential, Principal } from '../domain/models.js';
import type { SqliteStore } from '../infrastructure/storage/sqlite-store.js';
import { row } from '../infrastructure/storage/sqlite-store.js';

const hash = (salt: string, secret: string) =>
  createHash('sha256').update(salt).update(secret).digest();

/** 将长期身份与可撤销凭据分开管理；共享会话关联身份，令牌轮换不会改变会话归属。 */
export class IdentityService {
  constructor(
    readonly store: SqliteStore,
    readonly serviceId: string,
  ) {}

  async create(name: string) {
    const principal: Principal = {
      id: `auth:${id('principal')}`,
      revision: 1,
      createdAt: now(),
      name,
      enabled: true,
    };
    await this.store.put('principal', principal);
    return this.issue(principal.id);
  }

  /** 高熵随机令牌仅返回一次，存储带盐哈希；轮换时原凭据撤销与新凭据写入同事务提交。 */
  async issue(principalId: string, rotate = false) {
    const principal = await this.store.get<Principal>('principal', principalId);
    if (!principal?.enabled) fail('OBJECT_NOT_FOUND', '身份不存在或已停用。');
    const secret = randomBytes(32).toString('base64url');
    const salt = randomBytes(16).toString('hex');
    const credential: Credential = {
      id: id('token'),
      revision: 1,
      createdAt: now(),
      principalId,
      salt,
      hash: hash(salt, secret).toString('hex'),
      revoked: false,
    };
    const previous = rotate
      ? (await this.store.list<Credential>('credential')).filter(
          (item) => item.principalId === principalId && !item.revoked,
        )
      : [];
    await this.store.commit({
      checks: previous.map((item) => ({
        kind: 'credential',
        id: item.id,
        revision: item.revision,
      })),
      puts: [
        row('credential', credential),
        ...previous.map((item) =>
          row('credential', { ...item, revision: item.revision + 1, revoked: true }),
        ),
      ],
    });
    return { principalId, credentialId: credential.id, token: `${credential.id}.${secret}` };
  }

  async revoke(credentialId: string) {
    const credential = await this.store.get<Credential>('credential', credentialId);
    if (!credential) fail('OBJECT_NOT_FOUND', '令牌记录不存在。');
    await this.store.commit({
      checks: [{ kind: 'credential', id: credentialId, revision: credential.revision }],
      puts: [
        row('credential', { ...credential, revision: credential.revision + 1, revoked: true }),
      ],
    });
    return { revoked: true };
  }

  async authenticate(authorization: string | undefined): Promise<Context> {
    const match = /^Bearer ([^.]+)\.([A-Za-z0-9_-]+)$/.exec(authorization ?? '');
    if (!match) fail('UNAUTHENTICATED', '需要有效的 Bearer 令牌。');
    const credential = await this.store.get<Credential>('credential', match[1]!);
    if (
      !credential ||
      credential.revoked ||
      !timingSafeEqual(hash(credential.salt, match[2]!), Buffer.from(credential.hash, 'hex'))
    )
      fail('UNAUTHENTICATED', '令牌无效或已撤销。');
    const ctx: Context = {
      principalId: credential.principalId,
      credentialId: credential.id,
      mode: 'http',
      serviceId: this.serviceId,
    };
    await this.check(ctx);
    return ctx;
  }

  /** 长轮询和后续调用也需检查凭据有效性，不能只信任请求进入时缓存的认证结果。 */
  async check(ctx: Context) {
    if (ctx.admin || !ctx.principalId.startsWith('auth:')) return;
    const principal = await this.store.get<Principal>('principal', ctx.principalId);
    const credential = ctx.credentialId
      ? await this.store.get<Credential>('credential', ctx.credentialId)
      : null;
    if (
      !principal?.enabled ||
      !credential ||
      credential.revoked ||
      credential.principalId !== principal.id
    )
      fail('UNAUTHENTICATED', '当前访问身份或令牌已失效。');
  }

  /** 匿名身份按服务隔离，仅供允许匿名访问的本地 HTTP 入口使用；clientId 本身不是凭据。 */
  async registerAnonymous(clientId: string) {
    if (!/^[\w.-]{1,128}$/.test(clientId))
      fail('CONFIG_INVALID', '需要 1～128 字符的稳定客户端标识。');
    const principalId = `anon:${this.serviceId}:${clientId}`;
    if (!(await this.store.get('principal', principalId)))
      await this.store.put('principal', {
        id: principalId,
        revision: 1,
        createdAt: now(),
        name: clientId,
        enabled: true,
      });
    return { principalId, mode: 'http' as const, serviceId: this.serviceId };
  }
}
