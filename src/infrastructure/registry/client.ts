import { z } from 'zod';
import { digest, id, now } from '../../domain/ids.js';
import { AppError, fail } from '../../domain/errors.js';
import type {
  Context,
  RegistryAgent,
  RegistrySnapshot,
  RegistrySource,
} from '../../domain/models.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import { row } from '../storage/sqlite-store.js';
import { idem } from '../../application/common.js';

export const officialSourceId = 'src_b329792d-fb77-4b36-a593-8c67a5351b43';
const manifestSchema = z
  .object({
    agents: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string(),
          version: z.string().min(1),
          distribution: z
            .object({
              binary: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
              npx: z.record(z.string(), z.unknown()).optional(),
              uvx: z.record(z.string(), z.unknown()).optional(),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** 来源声明只接受 HTTP(S) 且禁止嵌入凭据；明文 HTTP 必须由本地设置显式放行。 */
export function validateUrl(value: string, allowInsecure: boolean) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.protocol === 'http:' && !allowInsecure)
  )
    fail('CONFIG_INVALID', '来源必须是无嵌入凭据的 HTTPS URL；HTTP 需在本地显式允许。');
  return url;
}

/** 在读取过程中累计正文大小，避免只信任 Content-Length；同时支持调用方取消和超时。 */
export async function fetchBytes(
  url: string,
  options: {
    signal?: AbortSignal | undefined;
    headers?: Record<string, string>;
    maxBytes?: number;
  } = {},
) {
  const response = await fetch(url, {
    signal: AbortSignal.any([
      AbortSignal.timeout(60_000),
      ...(options.signal ? [options.signal] : []),
    ]),
    ...(options.headers ? { headers: options.headers } : {}),
  });
  if (response.status === 304) return { response, bytes: Buffer.alloc(0) };
  if (!response.ok)
    throw new AppError('REGISTRY_UNAVAILABLE', '远程资源获取失败。', { status: response.status });
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!response.body) fail('REGISTRY_UNAVAILABLE', '远程响应缺少正文。');
  for await (const value of response.body) {
    const chunk = value as Uint8Array;
    size += chunk.length;
    if (size > (options.maxBytes ?? 16 * 1024 ** 2))
      fail('CAPACITY_EXCEEDED', '远程内容超过限制。');
    chunks.push(chunk);
  }
  return { response, bytes: Buffer.concat(chunks) };
}

/** 管理 Registry 来源与保留快照；来源刷新和安装目标选择分开，确保方案可引用固定内容。 */
export class RegistryClient {
  constructor(
    readonly store: SqliteStore,
    readonly allowInsecure: boolean,
  ) {}

  async initialize() {
    if (!(await this.store.get('source', officialSourceId))) {
      try {
        await this.store.commit({
          checks: [{ kind: 'source', id: officialSourceId, absent: true }],
          puts: [
            row('source', {
              id: officialSourceId,
              revision: 1,
              createdAt: now(),
              name: '官方 ACP Registry',
              url: 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
              enabled: true,
            }),
          ],
        });
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'REVISION_CONFLICT')) throw error;
      }
    }
  }

  sources() {
    return this.store.list<RegistrySource>('source');
  }

  async configure(
    ctx: Context,
    args: {
      url?: string | undefined;
      name?: string | undefined;
      enabled?: boolean | undefined;
      sourceId?: string | undefined;
      expectedRevision?: number | undefined;
      patch?:
        | { name?: string | undefined; url?: string | undefined; enabled?: boolean | undefined }
        | undefined;
      idempotencyKey: string;
    },
  ) {
    const previous = args.sourceId
      ? await this.store.get<RegistrySource>('source', args.sourceId)
      : null;
    if (args.sourceId && !previous) fail('OBJECT_NOT_FOUND', 'Registry 来源不存在。');
    const source: RegistrySource = previous
      ? {
          ...previous,
          ...Object.fromEntries(
            Object.entries(args.patch ?? {}).filter(([, value]) => value !== undefined),
          ),
          revision: previous.revision + 1,
        }
      : {
          id: id('src'),
          revision: 1,
          createdAt: now(),
          name: args.name!,
          url: args.url!,
          enabled: args.enabled ?? true,
        };
    validateUrl(source.url, this.allowInsecure);
    // URL 改变后缓存与 ETag 不再属于同一资源，必须一并失效。
    if (previous && source.url !== previous.url) {
      delete source.snapshotId;
      delete source.etag;
      delete source.fetchedAt;
    }
    const result = await this.store.commit({
      checks: previous
        ? [{ kind: 'source', id: previous.id, revision: args.expectedRevision! }]
        : [],
      puts: [row('source', source)],
      idempotency: idem(ctx, 'registry_configure', args, source),
    });
    return result.response;
  }

  /** 六小时内复用缓存，过期后用 ETag 条件请求；刷新失败保留旧快照，不改写固定版本。 */
  async refresh(sourceId: string, signal?: AbortSignal, force = false) {
    const source = await this.store.get<RegistrySource>('source', sourceId);
    if (!source) return fail('OBJECT_NOT_FOUND', 'Registry 来源不存在。');
    if (
      !force &&
      source.fetchedAt &&
      Date.parse(source.fetchedAt) > Date.now() - 6 * 3600_000 &&
      source.snapshotId
    )
      return this.store.get<RegistrySnapshot>('registry_snapshot', source.snapshotId);
    try {
      validateUrl(source.url, this.allowInsecure);
      const fetched = await fetchBytes(source.url, {
        signal,
        headers: source.etag ? { 'If-None-Match': source.etag } : {},
      });
      if (fetched.response.status === 304 && source.snapshotId) {
        await this.store.put('source', {
          ...source,
          revision: source.revision + 1,
          fetchedAt: now(),
        });
        return this.store.get<RegistrySnapshot>('registry_snapshot', source.snapshotId);
      }
      const manifest = manifestSchema.parse(JSON.parse(fetched.bytes.toString('utf8')) as unknown);
      if (new Set(manifest.agents.map((agent) => agent.id)).size !== manifest.agents.length)
        fail('CONFIG_INVALID', '同一来源内 Agent ID 重复。');
      const snapshot: RegistrySnapshot = {
        id: id('snapshot'),
        revision: 1,
        createdAt: now(),
        sourceId,
        url: source.url,
        digest: digest(manifest),
        agents: manifest.agents as RegistryAgent[],
      };
      const next: RegistrySource = {
        ...source,
        revision: source.revision + 1,
        snapshotId: snapshot.id,
        fetchedAt: now(),
      };
      delete next.error;
      const etag = fetched.response.headers.get('etag');
      if (etag) next.etag = etag;
      await this.store.commit({
        checks: [{ kind: 'source', id: source.id, revision: source.revision }],
        puts: [row('source', next), row('registry_snapshot', snapshot)],
      });
      return snapshot;
    } catch (error) {
      const current = await this.store.get<RegistrySource>('source', sourceId);
      if (current?.revision === source.revision)
        await this.store.put('source', {
          ...source,
          revision: source.revision + 1,
          error: '刷新失败；保留原缓存与固定版本。',
        });
      throw error;
    }
  }

  async get(sourceId: string, registryAgentId: string, snapshotId?: string) {
    const source = await this.store.get<RegistrySource>('source', sourceId);
    if (!source) fail('OBJECT_NOT_FOUND', '来源不存在。');
    const snapshot =
      snapshotId || source.snapshotId
        ? await this.store.get<RegistrySnapshot>(
            'registry_snapshot',
            snapshotId ?? source.snapshotId!,
          )
        : await this.store.locked(`registry-initialize:${sourceId}`, () => this.refresh(sourceId));
    if (!snapshot || snapshot.sourceId !== sourceId) fail('OBJECT_NOT_FOUND', '来源快照不存在。');
    const agent = snapshot.agents.find((agent) => agent.id === registryAgentId);
    if (!agent) fail('OBJECT_NOT_FOUND', '来源没有此 Agent。');
    return { sourceId, snapshotId: snapshot.id, cachedAt: snapshot.createdAt, agent };
  }

  /** 搜索仅遍历启用来源的已有快照，不在每次搜索时隐式发起网络刷新。 */
  async search(sourceId?: string, query = '', platform?: string) {
    const items = [];
    for (const source of await this.sources()) {
      if ((sourceId && source.id !== sourceId) || !source.enabled || !source.snapshotId) continue;
      const snapshot = await this.store.get<RegistrySnapshot>(
        'registry_snapshot',
        source.snapshotId,
      );
      for (const agent of snapshot?.agents ?? [])
        if (
          `${agent.id} ${agent.name} ${agent.description ?? ''}`
            .toLowerCase()
            .includes(query.toLowerCase()) &&
          (!platform ||
            agent.distribution.binary?.[platform] ||
            agent.distribution.npx ||
            agent.distribution.uvx)
        )
          items.push({
            ...agent,
            registryAgentId: agent.id,
            id: `${source.id}:${agent.id}`,
            sourceId: source.id,
            snapshotId: snapshot!.id,
          });
    }
    return items;
  }
}
