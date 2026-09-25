import test from 'node:test';
import assert from 'node:assert/strict';
import { CollaborationStore } from '../../src/application/collaboration/store.js';
import { EventService } from '../../src/application/event-service.js';
import type { SqliteStore } from '../../src/infrastructure/storage/sqlite-store.js';
import type { StoragePaths } from '../../src/infrastructure/storage/paths.js';
import type { WorkRecord } from '../../src/domain/models.js';
import { recordingStore } from '../helpers/recording-store.js';

/**
 * 使用给定内存记录装配协作存储及其事件服务。
 *
 * @param records - 按记录类型分组的测试数据。
 * @returns 只读取给定数据、不启动真实数据库的协作存储。
 */
function fixture(records: Record<string, unknown[]>) {
  const { store } = recordingStore(records);
  const db = store as SqliteStore;
  return new CollaborationStore(db, new EventService(db, {} as StoragePaths, 'unit-key'));
}

/**
 * 验证邮箱使用整数序号排序和排他游标，并隔离团队与接收者。
 *
 * @remarks
 * 混合不同位数的序号可暴露字典序错误；已读完的游标应保持稳定且不能跨团队复用。
 */
void test('Mailbox ordering uses numeric sequences and exclusive cursors with team and recipient isolation', async () => {
  const rows = ['100', '9', '99', '10'].map((seq) => ({
    id: seq,
    teamId: 'team',
    recipient: 'root',
    seq,
    body: 'message',
  }));
  const service = fixture({
    collab_message: [...rows, { ...rows[0], teamId: 'other' }, { ...rows[0], recipient: 'other' }],
  });
  const page = await service.mailbox('team', 'root');
  assert.deepEqual(
    page.messages.map((message) => message.seq),
    ['9', '10', '99', '100'],
  );
  const next = await service.mailbox('team', 'root', page.nextCursor);
  assert.deepEqual(next.messages, []);
  assert.equal(next.nextCursor, page.nextCursor);
  await assert.rejects(service.mailbox('other', 'root', page.nextCursor), {
    code: 'CURSOR_EXPIRED',
  });
});

/**
 * 验证邮箱达到单页条数限制后仍可继续读取剩余消息。
 *
 * @remarks
 * 使用比单页上限多一条的数据，检查下一页游标和是否还有后续消息的标记。
 */
void test('Mailbox pagination preserves messages beyond the page limit', async () => {
  const service = fixture({
    collab_message: Array.from({ length: 51 }, (_, index) => ({
      id: String(index + 1),
      seq: String(index + 1),
      teamId: 'team',
      recipient: 'root',
      body: 'message',
    })),
  });
  const page = await service.mailbox('team', 'root');
  assert.equal(page.messages.length, 50);
  assert.equal(page.hasMore, true);
  const next = await service.mailbox('team', 'root', page.nextCursor);
  assert.deepEqual(
    next.messages.map((message) => message.seq),
    ['51'],
  );
  assert.equal(next.hasMore, false);
});

for (const scenario of [
  { name: 'undelivered', delivered: false, ack: '100', protected: true },
  { name: 'unacknowledged', delivered: true, ack: '9', protected: true },
  { name: 'delivered and acknowledged', delivered: true, ack: '100', protected: false },
]) {
  /**
   * 验证协作结果仅在交付且确认消费后才允许被历史清理移除。
   *
   * @remarks
   * 交付状态和确认游标分别限制清理，任一条件未满足都必须保留对应工作记录。
   */
  void test('History cleanup protects collaboration results: ' + scenario.name, async () => {
    const service = fixture({
      collab_outbox: [{ id: 'intent', delivered: scenario.delivered }],
      collab_message: [
        { id: 'message', intentId: 'intent', teamId: 'team', recipient: 'root', seq: '10' },
      ],
      collab_ack: [{ id: 'team:root', after: scenario.ack }],
    });
    assert.equal(
      await service.protectedWork({
        collaboration: { teamId: 'team', agentId: 'agent', intentId: 'intent' },
      } as WorkRecord),
      scenario.protected,
    );
  });
}
