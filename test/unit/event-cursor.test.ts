import test from 'node:test';
import assert from 'node:assert/strict';
import { EventService } from '../../src/application/event-service.js';
import type { SqliteStore } from '../../src/infrastructure/storage/sqlite-store.js';
import type { EventRecord } from '../../src/domain/models.js';
import type { StoragePaths } from '../../src/infrastructure/storage/paths.js';
import { digest } from '../../src/domain/ids.js';

/**
 * 创建使用固定签名密钥的事件服务。
 *
 * @param readEvents - 可选的事件读取替身；仅测试游标签名时无需提供。
 * @returns 不连接真实数据库的事件服务。
 */
function service(readEvents?: SqliteStore['readEvents']) {
  return new EventService({ readEvents } as SqliteStore, {} as StoragePaths, 'unit-key');
}
/**
 * 构造带有准确 UTF-8 字节数的事件记录。
 *
 * @param seq - 事件的十进制序号。
 * @param text - 用于分页字节预算的文本内容。
 * @returns 属于固定测试流的事件记录。
 */
const item = (seq: string, text = 'chunk'): EventRecord => ({
  streamId: 'stream',
  seq,
  kind: 'chunk',
  payload: { text },
  createdAt: '2026-01-01T00:00:00.000Z',
  taskId: null,
  segmentId: null,
  activationId: null,
  bytes: Buffer.byteLength(text),
});

for (const scenario of [
  'tampered signature',
  'different stream',
  'changed filter',
  'invalid sequence',
] as const) {
  /**
   * 验证事件游标绑定签名、事件流、筛选条件和合法序号。
   *
   * @remarks
   * 任一约束不满足都应报告游标失效，不能继续读取其他上下文的事件。
   */
  void test('Event cursors reject an invalid context: ' + scenario, () => {
    const events = service();
    const cursor = events.encode({
      streamId: 'stream',
      after: scenario === 'invalid sequence' ? '-1' : '99',
      filter: 'filter',
    });
    assert.throws(
      () =>
        events.decode(
          scenario === 'tampered signature' ? 'x' + cursor : cursor,
          scenario === 'different stream' ? 'other' : 'stream',
          scenario === 'changed filter' ? 'other' : 'filter',
        ),
      { code: 'CURSOR_EXPIRED' },
    );
  });
}

/**
 * 验证分页从最后交付的序号继续，筛选结果为空时推进到高水位。
 *
 * @remarks
 * 同时检查存储读取参数和返回游标，避免重复交付或在空页上停滞。
 */
void test('Event pagination resumes after the last item and advances empty filtered pages to the high watermark', async () => {
  const calls: Parameters<SqliteStore['readEvents']>[0][] = [];
  const pages = [
    { items: [item('99'), item('100'), item('101')], highWatermark: '105', missing: [] },
    { items: [], highWatermark: '105', missing: [] },
  ];
  const events = service((args) => {
    calls.push(args);
    return Promise.resolve(pages.shift()!);
  });
  const first = await events.read('stream', { limit: 2, taskId: 'task' });
  assert.deepEqual(
    first.items.map((record) => record.seq),
    ['99', '100'],
  );
  assert.equal(first.hasMore, true);
  const next = await events.read('stream', { cursor: first.nextCursor, limit: 2, taskId: 'task' });
  assert.deepEqual(calls, [
    { streamId: 'stream', after: '0', limit: 2, taskId: 'task' },
    { streamId: 'stream', after: '100', limit: 2, taskId: 'task' },
  ]);
  assert.equal(next.hasMore, false);
  assert.equal(events.decode(next.nextCursor, 'stream', digest({ taskId: 'task' })), '105');
});

/**
 * 验证事件页达到字节预算后截断，并将缺口范围限制到当前游标。
 *
 * @remarks
 * 尚未交付区间的缺口不能提前报告；截断页仍须声明后续可读和内容不完整。
 */
void test('Event byte limits truncate pages and report gaps only through the current cursor', async () => {
  const events = service(() =>
    Promise.resolve({
      items: [item('9', 'x'.repeat(600 * 1024)), item('10', 'x'.repeat(600 * 1024))],
      highWatermark: '100',
      missing: [
        { from: '2', to: '10' },
        { from: '99', to: '100' },
      ],
    }),
  );
  const result = await events.read('stream', {});
  assert.deepEqual(
    result.items.map((record) => record.seq),
    ['9'],
  );
  assert.equal(result.hasMore, true);
  assert.equal(result.contentComplete, false);
  assert.equal(result.cursorStatus, 'expired');
  assert.deepEqual(result.missingRanges, [{ from: '2', to: '9' }]);
  assert.equal(events.decode(result.nextCursor, 'stream', digest({})), '9');
});
