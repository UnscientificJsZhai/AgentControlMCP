import { resolveStoragePaths } from '../../src/infrastructure/storage/paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../../src/infrastructure/storage/sqlite-store.js';
import { EventService } from '../../src/application/event-service.js';

void test('AC-003/021: 事件跨 9/10/99/100 按整数排序，分页不跳号、不重复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acm-cursor-'));
  const store = await SqliteStore.open(join(dir, 'db'));
  try {
    const events = new EventService(store, resolveStoragePaths({ dataDir: dir }), 'fixture-key');
    for (let index = 1; index <= 120; index++)
      await store.appendEvent({
        streamId: 'stream',
        taskId: index % 2 === 0 ? 'even' : 'odd',
        kind: 'chunk',
        payload: { index },
      });
    for (const taskId of [undefined, 'even']) {
      const seen: number[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await events.read('stream', { cursor, limit: 7, taskId });
        seen.push(...page.items.map((item) => Number(item.seq)));
        cursor = page.nextCursor;
        if (!page.hasMore) break;
        assert.ok(seen.length <= 120, '游标必须前进');
      }
      assert.deepEqual(
        seen,
        Array.from({ length: 120 }, (_, index) => index + 1).filter(
          (index) => !taskId || index % 2 === 0,
        ),
      );
      assert.equal((await events.read('stream', { cursor, taskId })).items.length, 0);
    }
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
