import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { TerminalManager } from '../../src/infrastructure/platform/terminal-manager.js';
import { deferred } from '../helpers/deferred.js';

/**
 * 创建可显式停止的内存终端进程替身。
 *
 * @remarks
 * 停止时关闭输出流并完成退出信号，用于验证终端释放和关闭时序。
 *
 * @returns 包含输出流、退出状态和停止方法的进程句柄。
 */
function host() {
  const exit = deferred<void>();
  const result = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    closed: exit.promise,
    exitCode: null as number | null,
    exitSignal: null as string | null,
    stop: () => {
      result.exitCode = 0;
      result.stdout.destroy();
      result.stderr.destroy();
      exit.resolve();
      return Promise.resolve();
    },
  };
  return result;
}
const request = { sessionId: 'session', command: 'unit-command' };
/**
 * 为不关注审批流程的测试提供立即通过的授权回调。
 *
 * @returns 立即完成的授权 Promise。
 */
const authorize = async () => {};

/**
 * 写入输出片段，并等待终端管理器有机会消费该片段。
 *
 * @remarks
 * 管理器的监听器先注册；观察到 data 后才能断言片段已进入输出缓存。
 *
 * @param stream - 终端的标准输出或标准错误流。
 * @param chunk - 待写入的原始字节片段。
 * @returns 观察到本次 data 事件后完成的 Promise。
 */
async function writeOutput(stream: PassThrough, chunk: Buffer) {
  const received = once(stream, 'data');
  stream.write(chunk);
  await received;
}

for (const scope of ['runtime', 'global'] as const) {
  /**
   * 验证终端在异步路径检查前预留 Runtime 或全局配额。
   *
   * @remarks
   * 挂起路径检查以填满配额，超额请求不能继续检查路径；关闭后挂起创建均须失败。
   */
  void test(
    'Terminals reserve ' + scope + ' capacity before asynchronous path checks',
    async (t) => {
      const path = deferred<string>();
      const reached = deferred<void>();
      const count = scope === 'runtime' ? 4 : 16;
      let checked = 0;
      const manager = new TerminalManager({
        checkedPath: () => {
          if (++checked === count) reached.resolve();
          return path.promise;
        },
        start: () => assert.fail('挂起的路径检查只能预留配额，不能启动终端'),
      });
      const runtimeIds = Array.from({ length: count }, (_, index) =>
        scope === 'runtime' ? 'runtime' : 'runtime-' + Math.floor(index / 4),
      );
      const pending = Promise.allSettled(
        runtimeIds.map((id) => manager.create(id, request, {}, ['/workspace'], authorize)),
      );
      t.after(async () => {
        const closing = Promise.all(
          [...new Set([...runtimeIds, 'other'])].map((id) => manager.close(id)),
        );
        path.resolve('/workspace');
        await Promise.all([closing, pending]);
      });
      await reached.promise;
      await assert.rejects(
        manager.create(
          scope === 'runtime' ? 'runtime' : 'other',
          request,
          {},
          ['/workspace'],
          authorize,
        ),
        { code: 'CAPACITY_EXCEEDED' },
      );
      assert.equal(checked, count, '超额请求不能进入路径检查');
      await Promise.all([...new Set(runtimeIds)].map((id) => manager.close(id)));
      for (const result of await pending) {
        assert.equal(result.status, 'rejected');
        if (result.status === 'rejected')
          assert.equal((result.reason as { code: string }).code, 'DOWNSTREAM_EXITED');
      }
    },
  );
}

for (const scope of ['runtime', 'global'] as const) {
  /**
   * 验证已发布终端持续占用配额，直到显式释放。
   *
   * @remarks
   * 终止进程后仍应阻止超额创建；释放终端句柄后才允许再次创建。
   */
  void test(
    'Published terminals retain ' + scope + ' capacity after kill until release',
    async (t) => {
      const manager = new TerminalManager({
        checkedPath: (path) => Promise.resolve(path),
        start: () => Promise.resolve(host()),
      });
      const count = scope === 'runtime' ? 4 : 16;
      const runtimeIds = Array.from({ length: count }, (_, index) =>
        scope === 'runtime' ? 'runtime' : 'runtime-' + Math.floor(index / 4),
      );
      const extraRuntime = scope === 'runtime' ? runtimeIds[0]! : 'other';
      t.after(() =>
        Promise.all([...new Set([...runtimeIds, extraRuntime])].map((id) => manager.close(id))),
      );
      const created: { terminalId: string }[] = [];
      for (const id of runtimeIds)
        created.push(await manager.create(id, request, {}, ['/workspace'], authorize));
      const extra = () => manager.create(extraRuntime, request, {}, ['/workspace'], authorize);
      await assert.rejects(extra(), { code: 'CAPACITY_EXCEEDED' });
      await manager.kill(runtimeIds[0]!, created[0]!.terminalId);
      await assert.rejects(extra(), { code: 'CAPACITY_EXCEEDED' });
      await manager.release(runtimeIds[0]!, created[0]!.terminalId);
      assert.ok((await extra()).terminalId);
    },
  );
}

/**
 * 验证审批失败会归还终端预留配额。
 *
 * @remarks
 * 连续拒绝次数超过单 Runtime 上限后，后续合法请求仍须能够成功启动。
 */
void test('Denied approvals release terminal capacity for subsequent creation', async (t) => {
  let starts = 0;
  const manager = new TerminalManager({
    checkedPath: (path) => Promise.resolve(path),
    start: () => {
      starts++;
      return Promise.resolve(host());
    },
  });
  t.after(() => manager.close('runtime'));
  const failure = new Error('denied');
  // 超过单 Runtime 配额的拒绝次数，不应积累预约。
  for (let index = 0; index < 5; index++) {
    await assert.rejects(
      manager.create('runtime', request, {}, ['/workspace'], () => Promise.reject(failure)),
      (error) => error === failure,
    );
  }
  const result = await manager.create('runtime', request, {}, ['/workspace'], authorize);
  assert.ok(result.terminalId);
  assert.equal(starts, 1);
});

/**
 * 验证关闭 Runtime 会取消挂起的终端审批。
 *
 * @remarks
 * 审批随后即使通过，也不能启动终端；原创建请求应报告下游已退出。
 */
void test('Closing cancels pending approval and prevents late approval from starting a terminal', async (t) => {
  const approval = deferred<void>();
  const reached = deferred<void>();
  let starts = 0;
  const manager = new TerminalManager({
    checkedPath: (path) => Promise.resolve(path),
    start: () => {
      starts++;
      return Promise.resolve(host());
    },
  });
  t.after(() => {
    approval.resolve();
    return manager.close('runtime');
  });
  const creating = manager.create('runtime', request, {}, ['/workspace'], () => {
    reached.resolve();
    return approval.promise;
  });
  const rejected = assert.rejects(creating, { code: 'DOWNSTREAM_EXITED' });
  await reached.promise;
  await manager.close('runtime');
  approval.resolve();
  await rejected;
  assert.equal(starts, 0);
});

/**
 * 验证关闭流程等待在途启动返回，并等待未发布句柄停止。
 *
 * @remarks
 * 使用独立信号控制启动与停止，确保关闭 Promise 不会在资源回收完成前返回。
 */
void test('Closing waits for in-flight startup and for unpublished handles to stop', async (t) => {
  const starting = deferred<ReturnType<typeof host>>();
  const reached = deferred<void>();
  const stopping = deferred<void>();
  const stopped = deferred<void>();
  const process = host();
  const originalStop = process.stop;
  process.stop = async () => {
    stopping.resolve();
    await stopped.promise;
    await originalStop();
  };
  const manager = new TerminalManager({
    checkedPath: (path) => Promise.resolve(path),
    start: () => {
      reached.resolve();
      return starting.promise;
    },
  });
  t.after(async () => {
    starting.resolve(process);
    stopped.resolve();
    await manager.close('runtime');
  });
  const creating = manager.create('runtime', request, {}, ['/workspace'], authorize);
  const rejected = assert.rejects(creating, { code: 'DOWNSTREAM_EXITED' });
  await reached.promise;
  let closed = false;
  const closing = manager.close('runtime').then(() => {
    closed = true;
  });
  await assert.rejects(manager.create('runtime', request, {}, ['/workspace'], authorize), {
    code: 'DOWNSTREAM_EXITED',
  });
  starting.resolve(process);
  await stopping.promise;
  assert.equal(closed, false);
  stopped.resolve();
  await Promise.all([closing, rejected]);
  assert.equal(process.exitCode, 0);
});

/**
 * 验证审批仅展示请求环境覆盖，启动使用审批前捕获的完整环境快照。
 *
 * @remarks
 * 审批等待期间修改宿主环境不能影响实际启动参数，宿主秘密也不应进入审批描述。
 */
void test('Terminal approval exposes only overrides while startup uses the pre-approval environment snapshot', async (t) => {
  const approval = deferred<void>();
  const reached = deferred<void>();
  const env = { SECRET: 'host-secret', KEEP: 'original' };
  let approvedEnv: Record<string, string> | undefined;
  let startedEnv: NodeJS.ProcessEnv | undefined;
  const manager = new TerminalManager({
    checkedPath: (path) => Promise.resolve(path),
    start: (spec) => {
      startedEnv = spec.env;
      return Promise.resolve(host());
    },
  });
  const pending = manager.create(
    'runtime',
    { ...request, env: [{ name: 'OVERRIDE', value: 'approved' }] },
    env,
    ['/workspace'],
    (description) => {
      approvedEnv = description.command?.env;
      reached.resolve();
      return approval.promise;
    },
  );
  t.after(async () => {
    approval.resolve();
    await Promise.allSettled([pending, manager.close('runtime')]);
  });
  await reached.promise;
  assert.deepEqual(approvedEnv, { OVERRIDE: 'approved' });
  env.KEEP = 'changed';
  approval.resolve();
  await pending;
  assert.deepEqual(startedEnv, { SECRET: 'host-secret', KEEP: 'original', OVERRIDE: 'approved' });
});

/**
 * 验证终端正确拼接 UTF-8 分片，并对标准输出和标准错误共用字节预算。
 *
 * @remarks
 * 在中文字符内部切分字节可检测解码错误；超限内容应截断，其他 Runtime 不能读取输出。
 */
void test('Terminal output reassembles UTF-8 fragments and shares a byte limit across stdout and stderr', async (t) => {
  const process = host();
  const manager = new TerminalManager({
    checkedPath: (path) => Promise.resolve(path),
    start: () => Promise.resolve(process),
  });
  t.after(() => manager.close('runtime'));
  const { terminalId } = await manager.create(
    'runtime',
    { ...request, outputByteLimit: 4 },
    {},
    ['/workspace'],
    authorize,
  );
  const chunk = Buffer.from('中');
  await writeOutput(process.stdout, chunk.subarray(0, 1));
  await writeOutput(process.stdout, chunk.subarray(1));
  await writeOutput(process.stderr, Buffer.from('ab'));
  assert.deepEqual(manager.output('runtime', terminalId), { output: '中a', truncated: true });
  assert.throws(() => manager.output('other', terminalId), { code: 'OBJECT_NOT_FOUND' });
});

/**
 * 验证取消等待仅结束等待操作，终端释放才停止命令并移除读取入口。
 *
 * @remarks
 * 取消后进程应仍存活；释放后退出状态与不可读取状态必须同时成立。
 */
void test('Cancelling a terminal wait leaves the command running while release stops it and removes output access', async () => {
  const process = host();
  const manager = new TerminalManager({
    checkedPath: (path) => Promise.resolve(path),
    start: () => Promise.resolve(process),
  });
  const { terminalId } = await manager.create('runtime', request, {}, ['/workspace'], authorize);
  try {
    const abort = new AbortController();
    const waiting = manager.wait('runtime', terminalId, abort.signal);
    const rejected = assert.rejects(waiting);
    abort.abort();
    await rejected;
    assert.equal(process.exitCode, null);
    await manager.release('runtime', terminalId);
    assert.equal(process.exitCode, 0);
    assert.throws(() => manager.output('runtime', terminalId), { code: 'OBJECT_NOT_FOUND' });
  } finally {
    await manager.close('runtime');
  }
});
