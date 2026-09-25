import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { CreateTerminalRequest } from '@agentclientprotocol/sdk';
import type { AppError } from '../../src/domain/errors.js';
import { isAlive } from '../../src/application/recovery-service.js';
import { ProcessHost } from '../../src/infrastructure/platform/process-host.js';
import { TerminalManager } from '../../src/infrastructure/platform/terminal-manager.js';
import { harness, until } from '../helpers/harness.js';

function gate() {
  let release = () => {};
  let reject!: (reason: unknown) => void;
  const wait = new Promise<void>((resolve, fail) => {
    release = resolve;
    reject = fail;
  });
  return { wait, release, reject };
}

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'acm-terminal-'));
  const terminals = new TerminalManager();
  const runtimeIds = new Set<string>();
  return {
    path,
    terminals,
    create(
      runtimeId: string,
      authorize: Parameters<TerminalManager['create']>[4] = () => Promise.resolve(),
      overrides: Partial<CreateTerminalRequest> = {},
    ) {
      runtimeIds.add(runtimeId);
      const result = terminals.create(
        runtimeId,
        {
          sessionId: 'downstream-session',
          command: process.execPath,
          args: ['-e', 'console.log(JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)'],
          cwd: path,
          ...overrides,
        },
        process.env,
        [path],
        authorize,
      );
      void result.catch(() => {});
      return result;
    },
    async cleanup() {
      await Promise.all([...runtimeIds].map((runtimeId) => terminals.close(runtimeId)));
      await rm(path, { recursive: true, force: true });
    },
  };
}

async function terminalPid(terminals: TerminalManager, runtimeId: string, terminalId: string) {
  return until(() => {
    const output = terminals.output(runtimeId, terminalId).output;
    return output.includes('\n') ? (JSON.parse(output) as { pid: number }).pid : null;
  });
}

for (const scope of ['runtime', 'global'] as const)
  for (const stage of ['authorize', 'start'] as const)
    void test(
      `${scope} 配额包含路径、${stage} 等待且失败后可全部复用`,
      { timeout: 20_000 },
      async (t) => {
        const h = await fixture();
        const limit = scope === 'runtime' ? 4 : 16;
        const runtimeId = (index: number) => (scope === 'runtime' ? 'runtime' : `runtime-${index}`);
        let entered = gate();
        let resume = gate();
        let arrivals = 0;
        const failure = new Error('受控创建失败');
        const blocked = async () => {
          if (++arrivals === limit) entered.release();
          await resume.wait;
          throw failure;
        };
        if (stage === 'start') t.mock.method(ProcessHost, 'start', blocked);
        const authorize = stage === 'authorize' ? blocked : () => Promise.resolve();
        let pending: Promise<unknown>[] = [];
        try {
          for (let round = 0; round < 2; round++) {
            pending = Array.from({ length: limit }, (_, index) =>
              h.create(runtimeId(index), authorize),
            );
            // 尚未让出事件循环，前面的请求都停在路径检查；预约必须已经可见。
            await assert.rejects(h.create(runtimeId(limit), authorize), {
              code: 'CAPACITY_EXCEEDED',
            });
            await entered.wait;
            await assert.rejects(h.create(runtimeId(limit), authorize), {
              code: 'CAPACITY_EXCEEDED',
            });
            assert.equal(arrivals, limit);
            resume.release();
            const results = await Promise.allSettled(pending);
            for (const result of results) {
              assert.equal(result.status, 'rejected');
              if (result.status === 'rejected') assert.equal(result.reason, failure);
            }
            entered = gate();
            resume = gate();
            arrivals = 0;
          }
        } finally {
          resume.release();
          await Promise.allSettled(pending);
          await h.cleanup();
        }
      },
    );

for (const scope of ['runtime', 'global'] as const)
  void test(
    `${scope} 已发布终端与预约共用预算，kill 保留容量而 release 归还`,
    { timeout: 20_000 },
    async () => {
      const h = await fixture();
      const resume = gate();
      const failure = new Error('撤回未启动请求');
      const authorize = async () => {
        await resume.wait;
        throw failure;
      };
      const runtimeId = (index: number) => (scope === 'runtime' ? 'owner' : `other-${index}`);
      const limit = scope === 'runtime' ? 4 : 16;
      const pending: Promise<unknown>[] = [];
      try {
        const terminal = await h.create('owner');
        const pid = await terminalPid(h.terminals, 'owner', terminal.terminalId);
        assert.equal(isAlive(pid), true);
        for (let index = 1; index < limit; index++)
          pending.push(h.create(runtimeId(index), authorize));
        await assert.rejects(h.create(runtimeId(limit), authorize), { code: 'CAPACITY_EXCEEDED' });
        assert.throws(() => h.terminals.output('intruder', terminal.terminalId), {
          code: 'OBJECT_NOT_FOUND',
        });
        await assert.rejects(h.terminals.kill('intruder', terminal.terminalId), {
          code: 'OBJECT_NOT_FOUND',
        });
        await assert.rejects(h.terminals.release('intruder', terminal.terminalId), {
          code: 'OBJECT_NOT_FOUND',
        });
        await h.terminals.kill('owner', terminal.terminalId);
        assert.equal(isAlive(pid), false);
        await h.terminals.wait('owner', terminal.terminalId, new AbortController().signal);
        assert.ok(h.terminals.output('owner', terminal.terminalId).exitStatus);
        await assert.rejects(h.create(runtimeId(limit), authorize), { code: 'CAPACITY_EXCEEDED' });
        await h.terminals.release('owner', terminal.terminalId);
        const replacement = await h.create('owner');
        assert.equal(
          isAlive(await terminalPid(h.terminals, 'owner', replacement.terminalId)),
          true,
        );
        await assert.rejects(h.create(runtimeId(limit), authorize), { code: 'CAPACITY_EXCEEDED' });
        resume.release();
        for (const result of await Promise.allSettled(pending)) {
          assert.equal(result.status, 'rejected');
          if (result.status === 'rejected') assert.equal(result.reason, failure);
        }
      } finally {
        resume.release();
        await Promise.allSettled(pending);
        await h.cleanup();
      }
    },
  );

void test(
  '路径及真实启动失败释放预约，后续仍可占满 Runtime 配额',
  { timeout: 20_000 },
  async () => {
    const h = await fixture();
    const resume = gate();
    const failure = new Error('结束容量验证');
    let pending: Promise<unknown>[] = [];
    try {
      const file = join(h.path, 'not-a-directory');
      await writeFile(file, 'fixture');
      for (const [cwd, code] of [
        [join(h.path, 'missing'), 'OBJECT_NOT_FOUND'],
        [file, 'DOWNSTREAM_EXITED'],
      ]) {
        const results = await Promise.allSettled(
          Array.from({ length: 4 }, () => h.create('runtime', undefined, { cwd: cwd! })),
        );
        for (const result of results) {
          assert.equal(result.status, 'rejected');
          if (result.status === 'rejected') assert.equal((result.reason as AppError).code, code);
        }
      }
      const entered = gate();
      let count = 0;
      const authorize = async () => {
        if (++count === 4) entered.release();
        await resume.wait;
        throw failure;
      };
      pending = Array.from({ length: 4 }, () => h.create('runtime', authorize));
      await entered.wait;
      await assert.rejects(h.create('runtime'), { code: 'CAPACITY_EXCEEDED' });
      resume.release();
      for (const result of await Promise.allSettled(pending)) {
        assert.equal(result.status, 'rejected');
        if (result.status === 'rejected') assert.equal(result.reason, failure);
      }
    } finally {
      resume.release();
      await Promise.allSettled(pending);
      await h.cleanup();
    }
  },
);

void test('关闭不等待挂起审批，晚到批准或拒绝都不能启动进程', { timeout: 20_000 }, async (t) => {
  const h = await fixture();
  const start = t.mock.method(ProcessHost, 'start');
  try {
    for (const outcome of ['allow', 'reject']) {
      const entered = gate();
      const approval = gate();
      let creationSignal: AbortSignal | undefined;
      const creating = h.create(outcome, (_description, signal) => {
        creationSignal = signal;
        entered.release();
        return approval.wait;
      });
      try {
        await entered.wait;
        await h.terminals.close(outcome);
        await assert.rejects(creating, { code: 'DOWNSTREAM_EXITED' });
        assert.equal(creationSignal?.aborted, true);
        if (outcome === 'allow') approval.release();
        else approval.reject(new Error('迟到审批拒绝'));
        // 给迟到的 Promise 回调及未处理拒绝检测一次事件循环机会。
        await setImmediate();
        assert.equal(start.mock.callCount(), 0);
      } finally {
        approval.release();
        await Promise.allSettled([creating]);
      }
    }
  } finally {
    await h.cleanup();
  }
});

void test(
  '关闭等待尚未发布的真实进程清理，并保持其他 Runtime 终端存活',
  { timeout: 20_000 },
  async (t) => {
    const h = await fixture();
    const entered = gate();
    const resume = gate();
    const marker = join(h.path, 'started.pid');
    const start = ProcessHost.start.bind(ProcessHost);
    let startingHost: ProcessHost | undefined;
    let creating: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    try {
      const other = await h.create('other');
      const otherPid = await terminalPid(h.terminals, 'other', other.terminalId);
      t.mock.method(ProcessHost, 'start', async (...args: Parameters<typeof start>) => {
        startingHost = await start(...args);
        entered.release();
        await resume.wait;
        return startingHost;
      });
      creating = h.create('closing', undefined, {
        args: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`,
        ],
      });
      await entered.wait;
      const pid = await until(async () => Number(await readFile(marker, 'utf8').catch(() => '')));
      assert.equal(isAlive(pid), true);
      let finished = false;
      closing = h.terminals.close('closing').then(() => {
        finished = true;
      });
      await assert.rejects(h.create('closing'), { code: 'DOWNSTREAM_EXITED' });
      await setImmediate();
      assert.equal(finished, false, '不能在启动句柄返回前宣称已经回收进程');
      resume.release();
      await closing;
      await assert.rejects(creating, { code: 'DOWNSTREAM_EXITED' });
      assert.equal(isAlive(pid), false);
      assert.equal(isAlive(startingHost!.process.pid!), false);
      assert.equal(isAlive(otherPid), true);
      assert.equal(h.terminals.output('other', other.terminalId).exitStatus, undefined);
    } finally {
      resume.release();
      await Promise.allSettled([creating, closing]);
      await h.cleanup();
    }
  },
);

void test('Runtime 关闭后才读完会话的终端回调不能进入创建', { timeout: 20_000 }, async (t) => {
  const h = await harness();
  const entered = gate();
  const resume = gate();
  let runtimeId: string | undefined;
  let creating: Promise<unknown> | undefined;
  try {
    const created = await h.session();
    runtimeId = created.runtimeId;
    const session = await h.app.sessions.get(h.alice, created.sessionId);
    const get = h.app.store.get.bind(h.app.store);
    let blocked = false;
    t.mock.method(h.app.store, 'get', async <T>(kind: string, recordId: string) => {
      const wait = !blocked && kind === 'session' && recordId === session.id;
      if (wait) blocked = true;
      const record = await get<T>(kind, recordId);
      if (wait) {
        entered.release();
        await resume.wait;
      }
      return record;
    });
    const create = t.mock.method(h.app.terminals, 'create');
    creating = h.app.callback(
      runtimeId,
      'terminal/create',
      {
        sessionId: session.downstreamSessionId,
        command: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: h.path,
      },
      new AbortController().signal,
      'late-terminal-create',
    );
    void creating.catch(() => {});
    await entered.wait;
    await h.app.runtimes.closeNow(runtimeId);
    resume.release();
    await assert.rejects(creating, { code: 'DOWNSTREAM_EXITED' });
    assert.equal(create.mock.callCount(), 0);
  } finally {
    resume.release();
    await Promise.allSettled([creating]);
    if (runtimeId) await h.app.terminals.close(runtimeId);
    await h.cleanup();
  }
});
