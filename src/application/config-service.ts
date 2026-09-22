import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentConfig, agentPatch } from '../domain/schemas.js';
import type { AgentConfig, AgentPatch } from '../domain/schemas.js';
import { fail } from '../domain/errors.js';
import { digest, id, now } from '../domain/ids.js';
import type { ConfigRecord, Context, InstallationRecord, WorkRecord } from '../domain/models.js';
import type { SqliteStore } from '../infrastructure/storage/sqlite-store.js';
import { row } from '../infrastructure/storage/sqlite-store.js';
import { idem, Serial } from './common.js';

/** 以数据库为配置事实来源，保留不可变修订快照，并维护供本地编辑的 JSON 投影。 */
export class ConfigService {
  private readonly serial = new Serial();

  constructor(
    readonly store: SqliteStore,
    readonly configDir: string,
  ) {}

  /** 显式版本读取历史快照，省略版本读取当前配置；运行中的 Runtime 使用自己的快照。 */
  async get(configId: string, revision?: number): Promise<ConfigRecord> {
    const record = await this.store.get<ConfigRecord>(
      revision ? 'config_revision' : 'config',
      revision ? `${configId}:${revision}` : configId,
    );
    if (!record) return fail('OBJECT_NOT_FOUND', '注册配置不存在。');
    return record;
  }

  list() {
    return this.store.list<ConfigRecord>('config');
  }

  private async validate(config: AgentConfig) {
    if (config.launch.kind === 'installation') {
      const install = await this.store.get<InstallationRecord>(
        'installation',
        config.launch.installationId,
      );
      if (install?.state !== 'ready') fail('CONFIG_INVALID', '只能引用 ready 安装。');
    }
    for (const server of config.mcpServers)
      if (
        server.type === 'stdio' &&
        /agent-control-mcp/.test([server.command, ...server.args].join(' '))
      )
        fail('CONFIG_INVALID', '下游不能递归挂载连接器自身。');
  }

  async register(ctx: Context, args: { config: AgentConfig; idempotencyKey: string }) {
    const config = agentConfig.parse(args.config);
    await this.validate(config);
    const record: ConfigRecord = { id: id('cfg'), revision: 1, createdAt: now(), config };
    const response = { configId: record.id, revision: 1 };
    const result = await this.store.commit({
      puts: [row('config', record), { ...row('config_revision', record), id: `${record.id}:1` }],
      checks:
        config.launch.kind === 'installation'
          ? [{ kind: 'installation', id: config.launch.installationId, state: 'ready' }]
          : [],
      claims:
        config.launch.kind === 'installation'
          ? [
              {
                key: `installation:${config.launch.installationId}:config:${record.id}`,
                holder: record.id,
              },
            ]
          : [],
      idempotency: idem(ctx, 'agent_register', args, response),
    });
    const projection = !result.replayed ? await this.project(record) : {};
    return { ...(result.response as typeof response), ...projection };
  }

  /** 合并顶层 Patch 后整体校验，原子切换安装引用；可同时记录版本切换操作的提交点。 */
  async update(
    ctx: Context,
    args: { configId: string; patch: AgentPatch; expectedRevision: number; idempotencyKey: string },
    operation?: WorkRecord,
  ) {
    const replay = await this.store.replay(idem(ctx, 'agent_update', args, null));
    if (replay)
      return replay as {
        configId: string;
        revision: number;
        appliesTo: string;
        exportPending?: boolean;
      };
    const previous = await this.get(args.configId);
    const patch = agentPatch.parse(args.patch);
    const merged = { ...previous.config, ...patch };
    if (merged.cwd === null) delete merged.cwd;
    if (merged.sessionNamespace === null) delete merged.sessionNamespace;
    const config = agentConfig.parse(merged);
    await this.validate(config);
    const record = { ...previous, config, revision: args.expectedRevision + 1 };
    const response = { configId: record.id, revision: record.revision, appliesTo: 'new_sessions' };
    const result = await this.store.commit({
      checks: [
        { kind: 'config', id: record.id, revision: args.expectedRevision },
        ...(operation
          ? [{ kind: 'operation', id: operation.id, revision: operation.revision }]
          : []),
        ...(config.launch.kind === 'installation'
          ? [{ kind: 'installation', id: config.launch.installationId, state: 'ready' }]
          : []),
      ],
      puts: [
        row('config', record),
        { ...row('config_revision', record), id: `${record.id}:${record.revision}` },
        ...(operation
          ? [
              row('operation', {
                ...operation,
                revision: operation.revision + 1,
                commitState: 'committed',
              }),
            ]
          : []),
      ],
      releases:
        previous.config.launch.kind === 'installation'
          ? [
              {
                key: `installation:${previous.config.launch.installationId}:config:${record.id}`,
                holder: record.id,
              },
            ]
          : [],
      claims:
        config.launch.kind === 'installation'
          ? [
              {
                key: `installation:${config.launch.installationId}:config:${record.id}`,
                holder: record.id,
              },
            ]
          : [],
      idempotency: idem(ctx, 'agent_update', args, response),
    });
    const projection = !result.replayed ? await this.project(record) : {};
    return { ...(result.response as typeof response), ...projection };
  }

  /** 仅移除当前注册项；存在活动 Runtime 时拒绝，历史修订保留供审计和显式恢复使用。 */
  async remove(
    ctx: Context,
    args: { configId: string; expectedRevision: number; idempotencyKey: string },
  ) {
    const replay = await this.store.replay(idem(ctx, 'agent_remove', args, null));
    if (replay) return replay;
    const previous = await this.get(args.configId);
    const result = await this.store.commit({
      checks: [{ kind: 'config', id: previous.id, revision: args.expectedRevision }],
      absentClaimPrefixes: [`config:${previous.id}:runtime:`],
      deletes: [{ kind: 'config', id: previous.id }],
      releases:
        previous.config.launch.kind === 'installation'
          ? [
              {
                key: `installation:${previous.config.launch.installationId}:config:${previous.id}`,
                holder: previous.id,
              },
            ]
          : [],
      idempotency: idem(ctx, 'agent_remove', args, { removed: true }),
    });
    return result.response;
  }

  document(record: ConfigRecord) {
    return {
      schemaVersion: 1,
      documentId: record.id,
      kind: 'agent',
      revision: record.revision,
      value: record.config,
    };
  }

  /**
   * 导出失败不撤销已经提交的配置，而是返回 exportPending 供管理入口修复。
   * 写入前比较上次导出的文件摘要，默认保护用户在磁盘上的手工编辑；force 表示显式覆盖。
   */
  async project(record: ConfigRecord, force = false) {
    return this.serial.run(record.id, async () => {
      const lock = `projection:${record.id}`;
      const holder = `${process.pid}:${id('export')}`;
      const occupied = await this.store.claim(lock);
      if (occupied) {
        let alive = true;
        try {
          process.kill(Number(occupied.split(':')[0]), 0);
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
        if (!alive) await this.store.commit({ releases: [{ key: lock, holder: occupied }] });
      }
      try {
        await this.store.commit({ claims: [{ key: lock, holder }] });
      } catch {
        return { applied: true, exportPending: true, warning: 'CONFIG_EXPORT_CONFLICT' };
      }
      try {
        // 取得跨实例投影锁后重读最新修订，避免慢导出把较旧的配置写回磁盘。
        record = await this.get(record.id);
        const dir = join(this.configDir, 'agents');
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const path = join(dir, `${record.id}.json`);
        const old = await this.store.get<{ digest: string }>('projection', record.id);
        let file: string | null = null;
        try {
          file = await readFile(path, 'utf8');
        } catch {
          /* 首次导出。 */
        }
        if (!force && file !== null && digest(file) !== old?.digest)
          return { applied: true, exportPending: true, warning: 'CONFIG_EXPORT_CONFLICT' };
        const content = JSON.stringify(this.document(record), null, 2) + '\n';
        const temp = `${path}.${id('tmp')}`;
        await writeFile(temp, content, { mode: 0o600, flush: true });
        await rename(temp, path);
        await this.store.put('projection', {
          id: record.id,
          revision: record.revision,
          createdAt: now(),
          digest: digest(content),
        } as ConfigRecord & { digest: string });
        return { applied: true, exportPending: false, path };
      } catch {
        return { applied: true, exportPending: true, warning: 'CONFIG_EXPORT_PENDING' };
      } finally {
        await this.store.commit({ releases: [{ key: lock, holder }] });
      }
    });
  }
}
