import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { bytes, digest, id, now } from '../domain/ids.js';
import { fail } from '../domain/errors.js';
import { access } from '../domain/access-control.js';
import type { Context, SegmentRecord, SessionRecord } from '../domain/models.js';
import type { SqliteStore } from '../infrastructure/storage/sqlite-store.js';

/** 游标绑定流和筛选摘要，不能跨会话或改筛选条件继续翻页。 */
interface Cursor {
  streamId: string;
  after: string;
  filter: string;
}

/** 组织会话事件、无任务事件段和大内容引用，并生成可验证且能感知清理缺口的游标。 */
export class EventService {
  readonly replay = new Map<string, string>();

  constructor(
    readonly store: SqliteStore,
    readonly dataDir: string,
    private readonly cursorKey: string,
  ) {}

  encode(cursor: Cursor) {
    const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return `${body}.${createHmac('sha256', this.cursorKey).update(body).digest('base64url')}`;
  }

  /** 先验证 HMAC 再使用游标字段；签名只保证完整性，访问授权由上层单独执行。 */
  decode(value: string, streamId: string, filter: string) {
    try {
      const [body, signature] = value.split('.');
      if (!body || !signature) throw new Error();
      const expected = createHmac('sha256', this.cursorKey).update(body).digest();
      const actual = Buffer.from(signature, 'base64url');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
        throw new Error();
      const cursor = JSON.parse(Buffer.from(body, 'base64url').toString()) as Cursor;
      if (cursor.streamId !== streamId || cursor.filter !== filter || !/^\d+$/.test(cursor.after))
        throw new Error();
      return cursor.after;
    } catch {
      return fail('CURSOR_EXPIRED', '游标无效或与当前流及筛选条件不匹配。');
    }
  }

  /**
   * 超过 64 KiB 的 JSON 写入按内容寻址的文件，返回资源引用以限制事件与结果体积。
   * objectId 决定读取归属，unitId 关联可清理的任务或事件段；共享内容由引用共同保活。
   */
  async externalize(objectId: string, payload: unknown, unitId = objectId) {
    if (bytes(payload) <= 64 * 1024) return payload;
    const contentId = digest(payload);
    const content = JSON.stringify(payload);
    const path = join(this.dataDir, 'content', contentId);
    return this.store.locked(`content:${contentId}`, async () => {
      await mkdir(join(this.dataDir, 'content'), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${id('tmp')}`;
      await writeFile(tmp, content, { mode: 0o600, flush: true });
      await rename(tmp, path);
      await this.store.put('content_ref', {
        id: `${objectId}:${contentId}`,
        revision: 1,
        createdAt: now(),
        objectId,
        contentId,
        bytes: Buffer.byteLength(content),
      });
      await this.store.put('content_unit', {
        id: `${unitId}:${objectId}:${contentId}`,
        revision: 1,
        createdAt: now(),
        unitId,
        objectId,
        contentId,
      });
      return {
        representation: 'resource',
        contentId,
        uri: `agent-control://content/${objectId}/${contentId}`,
        mimeType: 'application/json',
        bytes: Buffer.byteLength(content),
        contentComplete: true,
      };
    });
  }

  /** ambient 段按 8 MiB 或一小时滚动封口；history_replay 每次恢复单独建段。 */
  async segment(session: SessionRecord, kind: SegmentRecord['kind'] = 'ambient') {
    if (kind === 'ambient') {
      const existing = (await this.store.list<SegmentRecord>('segment')).find(
        (item) =>
          item.sessionId === session.id &&
          item.activationId === session.activationId &&
          item.kind === kind &&
          item.state === 'open',
      );
      if (
        existing &&
        existing.bytes < 8 * 1024 ** 2 &&
        Date.parse(existing.createdAt) > Date.now() - 3600_000
      )
        return existing.id;
      if (existing) await this.seal(existing.id);
    }
    const segment: SegmentRecord = {
      id: id('seg'),
      revision: 1,
      createdAt: now(),
      sessionId: session.id,
      activationId: session.activationId,
      runtimeId: session.runtimeId,
      kind,
      state: 'open',
      bytes: 0,
    };
    await this.store.put('segment', segment);
    return segment.id;
  }

  async seal(segmentId: string) {
    const segment = await this.store.get<SegmentRecord>('segment', segmentId);
    if (segment?.state === 'open')
      await this.store.put('segment', {
        ...segment,
        revision: segment.revision + 1,
        state: 'sealed',
        sealedAt: now(),
      });
  }

  async closeActivation(activationId: string) {
    for (const segment of await this.store.list<SegmentRecord>('segment'))
      if (segment.activationId === activationId) await this.seal(segment.id);
  }

  /** 回放优先于活动任务归属，其余通知分别进入当前 task 或可独立清理的 ambient 段。 */
  async append(
    session: SessionRecord,
    kind: string,
    payload: unknown,
    projection?: Record<string, unknown>,
  ) {
    const replay = this.replay.get(session.runtimeId);
    const taskId = replay ? undefined : session.activeTaskId;
    const segmentId = taskId ? undefined : (replay ?? (await this.segment(session)));
    return this.store.appendEvent({
      streamId: session.id,
      ...(taskId ? { taskId } : { segmentId: segmentId! }),
      activationId: session.activationId,
      kind,
      payload: await this.externalize(taskId ?? session.id, payload, taskId ?? segmentId!),
      ...(projection ? { projection } : {}),
    });
  }

  /** 兼顾条数和 1 MiB 页大小上限；墓碑区间会明确报告历史不完整，不伪装成空页。 */
  async read(
    streamId: string,
    args: {
      cursor?: string | undefined;
      limit?: number | undefined;
      taskId?: string | undefined;
      segmentId?: string | undefined;
      activationId?: string | undefined;
    },
  ) {
    const filters = {
      ...(args.taskId ? { taskId: args.taskId } : {}),
      ...(args.segmentId ? { segmentId: args.segmentId } : {}),
      ...(args.activationId ? { activationId: args.activationId } : {}),
    };
    const filter = digest(filters);
    const after = args.cursor ? this.decode(args.cursor, streamId, filter) : '0';
    const result = await this.store.readEvents({
      streamId,
      after,
      limit: args.limit ?? 100,
      ...filters,
    });
    let size = 0;
    const items = result.items.slice(0, args.limit ?? 100).filter((item) => {
      size += bytes(item);
      return size <= 1024 ** 2;
    });
    const hasMore = items.length < result.items.length;
    // 无更多匹配项时推进到流高水位，避免筛选后的空区间被反复扫描。
    const last = hasMore ? (items.at(-1)?.seq ?? after) : result.highWatermark;
    const missing = result.missing
      .filter((range) => BigInt(range.from) <= BigInt(last))
      .map((range) => ({
        from: range.from,
        to: BigInt(range.to) > BigInt(last) ? last : range.to,
      }));
    return {
      items,
      nextCursor: this.encode({ streamId, after: last, filter }),
      hasMore,
      highWatermark: result.highWatermark,
      cursorStatus: missing.length ? 'expired' : 'valid',
      contentComplete: missing.length === 0,
      missingRanges: missing,
      earliestAvailableCursor: this.encode({ streamId, after: '0', filter }),
    };
  }

  async sessionRead(ctx: Context, sessionId: string, args: Parameters<EventService['read']>[1]) {
    const session = await this.store.get<SessionRecord>('session', sessionId);
    if (!session) return fail('SESSION_NOT_FOUND', '会话不存在。');
    access(ctx, session);
    if (args.segmentId) {
      const segment = await this.store.get<SegmentRecord>('segment', args.segmentId);
      if (
        !segment ||
        segment.sessionId !== sessionId ||
        (args.activationId && segment.activationId !== args.activationId)
      )
        fail('CONFIG_INVALID', '事件段与会话或激活代次不匹配。');
    }
    return this.read(sessionId, args);
  }

  /** 校验对象确实引用该内容；按字节分页并返回 base64，避免 UTF-8 字符跨页被破坏。 */
  async content(objectId: string, contentId: string, offset = 0, maxBytes = 64 * 1024) {
    if (
      !/^[a-f0-9]{64}$/.test(contentId) ||
      !(await this.store.get('content_ref', `${objectId}:${contentId}`))
    )
      fail('CONTENT_UNAVAILABLE', '此对象没有引用所请求的内容。');
    const buffer = await readFile(join(this.dataDir, 'content', contentId));
    const chunk = buffer.subarray(offset, offset + Math.min(maxBytes, 256 * 1024));
    return {
      contentId,
      mimeType: 'application/json',
      offset,
      nextOffset: offset + chunk.length,
      encoding: 'base64',
      data: chunk.toString('base64'),
      eof: offset + chunk.length >= buffer.length,
    };
  }
}
