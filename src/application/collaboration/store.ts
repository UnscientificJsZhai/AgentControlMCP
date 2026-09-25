import { statfs } from 'node:fs/promises';
import { bytes, digest, now } from '../../domain/ids.js';
import { fail } from '../../domain/errors.js';
import type { Context, WorkRecord } from '../../domain/models.js';
import type {
  CompletionRecord,
  MessageRecord,
  TeamRecord,
  TaskIntentRecord,
  AcceptanceResult,
} from '../../domain/collaboration.js';
import type { SqliteStore } from '../../infrastructure/storage/sqlite-store.js';
import { row } from '../../infrastructure/storage/sqlite-store.js';
import type { Transaction } from '../../infrastructure/storage/protocol.js';
import type { EventService } from '../event-service.js';
import { Serial } from '../common.js';

/** 纯记录生成函数，正常结束、派发前取消和崩溃恢复使用同一个事务契约。 */
export function completionRows(work: WorkRecord) {
  const binding =
    work.collaboration ??
    (work.state !== 'completed' && work.error?.code !== 'AUTH_REQUIRED'
      ? work.collaborationSetup
      : undefined);
  if (!binding) return [];
  const record: CompletionRecord = {
    id: binding.intentId,
    revision: 1,
    createdAt: work.endedAt ?? now(),
    ...binding,
    work,
    delivered: false,
  };
  return [{ ...row('collab_outbox', record), ifAbsent: true }];
}

export class CollaborationStore {
  readonly serial = new Serial();
  constructor(
    readonly db: SqliteStore,
    readonly events: EventService,
  ) {}

  request(ctx: Context, method: string, args: { requestId: string }, response: unknown = null) {
    return {
      principal: `${ctx.principalId}:${ctx.collaborationMember?.agentId ?? 'root'}`,
      method: `collaboration:${method}`,
      key: args.requestId,
      digest: digest(args),
      response,
    };
  }

  async capacity(additional: number, maxBytes: number, minimumFreeBytes: number) {
    const usage = await this.db.call<{ bytes: number }>('logicalUsage', {});
    const space = await statfs(this.events.paths.stateDir);
    if (
      usage.bytes + additional > maxBytes ||
      space.bavail * space.bsize < minimumFreeBytes + additional
    )
      fail('STORAGE_FULL', '存储容量不足，未接受协作请求。');
  }

  async intents(agentId: string) {
    return (await this.db.list<TaskIntentRecord>('collab_intent'))
      .filter((item) => item.agentId === agentId)
      .sort((a, b) => (BigInt(a.order) < BigInt(b.order) ? -1 : 1));
  }

  /** 调用者持有团队串行锁，序号与消息、去重标志一同提交。 */
  async append(team: TeamRecord, messages: Omit<MessageRecord, 'seq'>[], extra: Transaction = {}) {
    let seq = BigInt(team.sequence);
    const records = messages.map((message) => ({ ...message, seq: String(++seq) }));
    await this.db.commit({
      ...extra,
      checks: [
        { kind: 'collab_team', id: team.id, revision: team.revision },
        ...(extra.checks ?? []),
      ],
      puts: [
        row('collab_team', { ...team, sequence: String(seq), revision: team.revision + 1 }),
        ...records.map((message) => row('collab_message', message)),
        ...(extra.puts ?? []),
      ],
    });
    return records;
  }

  async mailbox(teamId: string, recipient: string, cursor?: string, afterOverride?: string) {
    const streamId = `mailbox:${teamId}:${recipient}`;
    const filter = digest({ recipient, teamId });
    const after = afterOverride ?? (cursor ? this.events.decode(cursor, streamId, filter) : '0');
    const available = (await this.db.list<MessageRecord>('collab_message'))
      .filter(
        (m) => m.teamId === teamId && m.recipient === recipient && BigInt(m.seq) > BigInt(after),
      )
      .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
    const messages: MessageRecord[] = [];
    let size = 0;
    for (const message of available) {
      const length = bytes(message);
      if (messages.length >= 50 || (messages.length > 0 && size + length > 64 * 1024)) break;
      messages.push(message);
      size += length;
    }
    const last = messages.at(-1)?.seq ?? after;
    return {
      messages,
      nextCursor: this.events.encode({ streamId, filter, after: last }),
      hasMore: messages.length < available.length,
      after: last,
    };
  }

  async acknowledge(teamId: string, recipient: string, cursor: string) {
    const after = this.events.decode(
      cursor,
      `mailbox:${teamId}:${recipient}`,
      digest({ recipient, teamId }),
    );
    await this.serial.run(teamId, async () => {
      const key = `${teamId}:${recipient}`;
      const previous = await this.db.get<{ revision: number; after: string }>('collab_ack', key);
      if (BigInt(after) <= BigInt(previous?.after ?? '0')) return;
      await this.db.put('collab_ack', {
        id: key,
        revision: (previous?.revision ?? 0) + 1,
        createdAt: now(),
        after,
      });
    });
  }

  async protectedWork(work: WorkRecord) {
    const binding = work.collaboration ?? work.collaborationSetup;
    if (!binding) return false;
    const completion = await this.db.get<CompletionRecord>('collab_outbox', binding.intentId);
    if (!completion?.delivered) return true;
    const messages = (await this.db.list<MessageRecord>('collab_message')).filter(
      (m) => m.intentId === binding.intentId,
    );
    for (const message of messages) {
      const ack = await this.db.get<{ after: string }>(
        'collab_ack',
        `${message.teamId}:${message.recipient}`,
      );
      if (BigInt(message.seq) > BigInt(ack?.after ?? '0')) return true;
    }
    return false;
  }

  async retain(teamId: string, days: number) {
    const before = new Date(Date.now() - days * 86400_000).toISOString();
    const units = new Set<string>();
    for (const message of await this.db.list<MessageRecord>('collab_message')) {
      if (
        message.teamId !== teamId ||
        message.createdAt >= before ||
        (message.body as { purged?: boolean }).purged
      )
        continue;
      const ack = await this.db.get<{ after: string }>(
        'collab_ack',
        `${teamId}:${message.recipient}`,
      );
      if (BigInt(message.seq) > BigInt(ack?.after ?? '0')) continue;
      const summary = message.body as {
        configId?: string;
        configRevision?: number;
        acceptance?: AcceptanceResult;
      };
      await this.db.put('collab_message', {
        ...message,
        revision: message.revision + 1,
        body: {
          purged: true,
          contentComplete: false,
          ...(message.channel === 'framework' && summary.acceptance
            ? {
                configId: summary.configId,
                configRevision: summary.configRevision,
                completionScope: 'acp_turn',
                acceptance: summary.acceptance,
              }
            : {}),
        },
      });
      // 普通消息即使关联任务，外置正文仍归属于 messageId。
      if (message.type === 'MESSAGE') units.add(message.id);
      if (message.intentId) {
        const remaining = (await this.db.list<MessageRecord>('collab_message')).some(
          (m) => m.intentId === message.intentId && !(m.body as { purged?: boolean }).purged,
        );
        if (!remaining) units.add(message.intentId);
      } else units.add(message.id);
    }
    for (const intentId of units) {
      const intent = await this.db.get<TaskIntentRecord>('collab_intent', intentId);
      if (intent?.state === 'settled' && intent.message)
        await this.db.put('collab_intent', {
          ...intent,
          message: '',
          completionCriteria: undefined,
          revision: intent.revision + 1,
        });
    }
    await this.events.releaseContentUnits(units);
  }
}
