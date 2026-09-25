import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ClientRuntime } from '../../src/infrastructure/acp/client-runtime.js';
import type { CallbackPorts } from '../../src/infrastructure/acp/client-runtime.js';
import { AppError } from '../../src/domain/errors.js';

function wireClient(notify: CallbackPorts['notify'], failed: boolean) {
  let resolveClosed = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const host = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    closed,
    stop: () => {
      host.stdin.destroy();
      host.stdout.destroy();
      host.stderr.destroy();
      resolveClosed();
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
  host.stdin.on('data', (raw: Buffer) => {
    const request = JSON.parse(raw.toString()) as { method: string; id: number };
    if (request.method !== 'session/prompt') return;
    const update = (text: string) => ({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      },
    });
    // 同一个输入 chunk 中，响应必须排在两条输出通知之后。
    host.stdout.write(
      [
        update('first'),
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
  });
  return runtime;
}

void test('真实 ACP 字节流成功时在请求完成前排空前序输出通知', async () => {
  const received: unknown[] = [];
  const runtime = wireClient((_method, params) => {
    received.push(params);
    return Promise.resolve();
  }, false);
  try {
    // 成功路径下 request 内部在返回前排空屏障，调用方返回时已收到全部通知
    await runtime.request('session/prompt', { sessionId: 's', prompt: [] });
    assert.deepEqual(
      received.map(
        (params) => (params as { update: { content: { text: string } } }).update.content.text,
      ),
      ['first', 'second'],
    );
  } finally {
    await runtime.close();
  }
});

void test('真实 ACP 字节流返回错误响应时，调用方显式调用屏障可排空已收到的前序通知', async () => {
  const received: unknown[] = [];
  const runtime = wireClient((_method, params) => {
    received.push(params);
    return Promise.resolve();
  }, true);
  try {
    // 错误响应快速退出，上层捕获后可通过屏障排空前序通知
    await assert.rejects(runtime.request('session/prompt', { sessionId: 's', prompt: [] }), {
      code: 'PROTOCOL_ERROR',
    });
    await runtime.barrier();
    assert.deepEqual(
      received.map(
        (params) => (params as { update: { content: { text: string } } }).update.content.text,
      ),
      ['first', 'second'],
    );
  } finally {
    await runtime.close();
  }
});

void test('真实 ACP 通知持久化失败会阻断成功请求并通过屏障传播', async () => {
  // 下游响应成功，但通知持久化失败；验证内部屏障阻断成功响应并传播持久化错误
  const runtime = wireClient(
    () => Promise.reject(new AppError('PERSISTENCE_FAILED', '通知持久化失败')),
    false,
  );
  try {
    await assert.rejects(
      runtime.request('session/prompt', { sessionId: 's', prompt: [] }),
      /通知持久化失败/,
    );
    await assert.rejects(runtime.barrier(), /通知持久化失败/);
  } finally {
    await runtime.close();
  }
});
