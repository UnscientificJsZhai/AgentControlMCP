import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { ClientRuntime } from '../../src/infrastructure/acp/client-runtime.js';
import type { CallbackPorts } from '../../src/infrastructure/acp/client-runtime.js';
import { AppError } from '../../src/domain/errors.js';
import { deferred } from '../helpers/deferred.js';

/**
 * 使用内存字节流连接真实 ACP 客户端与固定协议响应端。
 *
 * @remarks
 * 每次提示请求先发送两条通知，再返回成功或失败响应；清理时等待响应端结束并传播错误。
 *
 * @param notify - 客户端收到通知时执行的处理函数。
 * @param failed - 是否让提示请求返回协议错误。
 * @param framing - 将通知与响应合包发送，或从 UTF-8 字符内部拆分发送。
 * @returns 客户端、已收到的请求方法列表及完整清理函数。
 */
function wireClient(
  notify: CallbackPorts['notify'],
  failed: boolean,
  framing: 'coalesced' | 'fragmented' = 'coalesced',
) {
  const closed = deferred<void>();
  const stdin = new PassThrough();
  const frames = createInterface({ input: stdin, crlfDelay: Infinity });
  const host = {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    closed: closed.promise,
    stop: () => {
      frames.close();
      host.stdin.destroy();
      host.stdout.destroy();
      host.stderr.destroy();
      closed.resolve();
      return Promise.resolve();
    },
  };
  const ports: CallbackPorts = {
    request: () => Promise.resolve({}),
    notify,
    responded: async () => {},
    exited: async () => {},
  };
  // 只用内存字节流替代宿主进程；保留真实 ClientRuntime 构造和 SDK 分发链。
  const runtime = Reflect.construct(ClientRuntime, [host, [], ports]) as ClientRuntime;
  const requests: string[] = [];
  // readline 缓存不完整行并处理粘包；解析异常通过异步任务传播到用例清理。
  const serving = (async () => {
    for await (const frame of frames) {
      const request = JSON.parse(frame) as { method: string; id: number };
      requests.push(request.method);
      if (request.method !== 'session/prompt') continue;
      const update = (text: string) => ({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 's',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        },
      });
      // 响应排在两条输出通知之后，再按用例选择合包或从 UTF-8 字符内部切开。
      const response = Buffer.from(
        [
          update('first中'),
          update('second'),
          {
            jsonrpc: '2.0',
            id: request.id,
            ...(failed
              ? { error: { code: -32603, message: 'fixture error' } }
              : { result: { stopReason: 'end_turn' } }),
          },
        ]
          .map((message) => JSON.stringify(message))
          .join('\n') + '\n',
      );
      if (framing === 'fragmented') {
        const split = response.indexOf(Buffer.from('中')) + 1;
        host.stdout.write(response.subarray(0, split));
        host.stdout.write(response.subarray(split));
      } else host.stdout.write(response);
    }
  })();
  // 尽早处理拒绝并关闭连接；after 仍会等待原 Promise，不能吞掉 fixture 的错误。
  void serving.catch(() => host.stop());
  return {
    runtime,
    requests,
    close: async () => {
      await runtime.close();
      await serving;
    },
  };
}

for (const framing of ['coalesced', 'fragmented'] as const) {
  /**
   * 验证 ACP 成功响应返回前已处理全部前序通知。
   *
   * @remarks
   * 合包和跨 UTF-8 字符分片均通过真实 SDK 分发，通知顺序和正文必须完整保留。
   */
  void test('In-memory ACP success drains preceding notifications: ' + framing, async (t) => {
    const received: unknown[] = [];
    const { runtime, close } = wireClient(
      (_method, params) => {
        received.push(params);
        return Promise.resolve();
      },
      false,
      framing,
    );
    t.after(close);
    await runtime.request('session/prompt', { sessionId: 's', prompt: [] });
    assert.deepEqual(
      received.map(
        (params) => (params as { update: { content: { text: string } } }).update.content.text,
      ),
      ['first中', 'second'],
    );
  });
}

/**
 * 验证 ACP 请求失败后可通过显式屏障排空前序通知。
 *
 * @remarks
 * 错误响应应保留协议错误码，等待屏障后两条通知仍按发送顺序可见。
 */
void test('An explicit barrier drains preceding notifications after an in-memory ACP error', async (t) => {
  const received: unknown[] = [];
  const { runtime, close } = wireClient((_method, params) => {
    received.push(params);
    return Promise.resolve();
  }, true);
  t.after(close);
  await assert.rejects(runtime.request('session/prompt', { sessionId: 's', prompt: [] }), {
    code: 'PROTOCOL_ERROR',
  });
  await runtime.barrier();
  assert.deepEqual(
    received.map(
      (params) => (params as { update: { content: { text: string } } }).update.content.text,
    ),
    ['first中', 'second'],
  );
});

/**
 * 验证通知持久化失败会阻断下游成功响应。
 *
 * @remarks
 * 请求和后续显式屏障都应传播持久化错误，不能将未可靠保存的输出报告为成功。
 */
void test('In-memory ACP notification persistence failures block success and propagate through barriers', async (t) => {
  const { runtime, close } = wireClient(
    () => Promise.reject(new AppError('PERSISTENCE_FAILED', '通知持久化失败')),
    false,
  );
  t.after(close);
  await assert.rejects(
    runtime.request('session/prompt', { sessionId: 's', prompt: [] }),
    /通知持久化失败/,
  );
  await assert.rejects(runtime.barrier(), /通知持久化失败/);
});

/**
 * 验证预先取消的请求在写入 ACP 字节流前被拒绝。
 *
 * @remarks
 * 后续正常请求仍须可用，响应端只应观察到该后续请求。
 */
void test('Pre-cancelled requests do not write to the ACP byte stream', async (t) => {
  const { runtime, requests, close } = wireClient(async () => {}, false);
  t.after(close);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    runtime.request('session/new', { cwd: '/tmp', mcpServers: [] }, 100, abort.signal),
    { code: 'CANCELLED' },
  );
  await runtime.request('session/prompt', { sessionId: 's', prompt: [] });
  assert.deepEqual(requests, ['session/prompt']);
});
