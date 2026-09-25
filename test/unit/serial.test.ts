import test from 'node:test';
import assert from 'node:assert/strict';
import { Serial } from '../../src/application/common.js';
import { deferred } from '../helpers/deferred.js';

/**
 * 验证同一对象的任务按 FIFO 执行，不同对象可独立推进。
 *
 * @remarks
 * 使用显式开始和释放信号固定执行顺序，避免通过延时猜测任务是否阻塞。
 */
void test('Tasks for the same object run in FIFO order while other objects proceed independently', async (t) => {
  const serial = new Serial();
  const release = deferred<void>();
  const started = deferred<void>();
  const order: string[] = [];
  const first = serial.run('agent', async () => {
    order.push('first');
    started.resolve();
    await release.promise;
  });
  const second = serial.run('agent', () => {
    order.push('second');
    return Promise.resolve();
  });
  t.after(async () => {
    release.resolve();
    await Promise.allSettled([first, second]);
  });
  await started.promise;
  await serial.run('other', () => {
    order.push('other');
    return Promise.resolve();
  });
  assert.deepEqual(order, ['first', 'other']);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'other', 'second']);
});

/**
 * 验证前一个任务失败后，同一对象的后续任务仍可执行。
 *
 * @remarks
 * 前次拒绝应保留原错误，队列继续返回下一任务的正常结果。
 */
void test('A failed task does not block later tasks for the same object', async () => {
  const serial = new Serial();
  const failure = new Error('failed');
  const first = serial.run('agent', () => Promise.reject(failure));
  const rejected = assert.rejects(first, (error) => error === failure);
  const second = serial.run('agent', () => Promise.resolve('next'));
  await rejected;
  assert.equal(await second, 'next');
});
