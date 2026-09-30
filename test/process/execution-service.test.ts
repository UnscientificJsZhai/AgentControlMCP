import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createServer, createConnection } from 'node:net';
import { PassThrough, Writable } from 'node:stream';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  readDescriptor,
  serviceCredentials,
  descriptorInstance,
} from '../../src/infrastructure/service/discovery.js';
import { resolveStoragePaths } from '../../src/infrastructure/storage/paths.js';
import { adminRequest } from '../../src/transport/admin/ipc.js';
import { readHandshake, connectMcpIpc } from '../../src/transport/mcp/ipc.js';
import { settingsSchema } from '../../src/domain/schemas.js';
import { isAlive } from '../../src/application/recovery-service.js';
import { Container } from '../../src/bootstrap/container.js';
import { proxyStdio } from '../../src/transport/mcp/stdio-proxy.js';

const entry = resolve('dist/cli/entry.js');
const fixture = resolve('test/fixtures/service-agent.mjs');

/** 有界状态门，不依赖固定启动延迟。 */
async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  } while (performance.now() < deadline);
  throw new Error('状态门超时');
}

async function cli(args: string[]) {
  const child = spawn(process.execPath, [entry, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (b: Buffer) => {
    stdout += b.toString();
  });
  child.stderr.on('data', (b: Buffer) => {
    stderr += b.toString();
  });
  const [code] = (await once(child, 'exit')) as [number | null];
  return { code, stdout, stderr };
}

async function environment(t: TestContext, overrides: Record<string, unknown> = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'acm-service-test-')));
  const settingsPath = join(dir, 'settings.json');
  const settings = settingsSchema.parse({ httpPort: 0, minimumFreeBytes: 0, ...overrides });
  await writeFile(settingsPath, JSON.stringify(settings));
  const clients: Client[] = [];
  const descriptor = () => until(() => readDescriptor(resolveStoragePaths({ dataDir: dir })));
  const admin = async <T>(name: string, args: unknown = {}) => {
    const d = await descriptor();
    const credentials = await serviceCredentials(d);
    const result = (await adminRequest(descriptorInstance(d, credentials.nonce), name, args))
      .data as { ok?: boolean; data?: T; error?: unknown };
    if (result.ok === false) throw new Error(JSON.stringify(result.error));
    return (result.ok === true ? result.data : result) as T;
  };
  t.after(async () => {
    await Promise.allSettled(clients.map((c) => c.close()));
    const d = await readDescriptor(resolveStoragePaths({ dataDir: dir }));
    if (d && isAlive(d.pid)) {
      await admin('_stop').catch(() => {});
      await until(() => Promise.resolve(!isAlive(d.pid) ? true : undefined)).catch(() => {
        if (isAlive(d.pid)) process.kill(d.pid, 'SIGKILL');
      });
    }
    await rm(dir, { recursive: true, force: true });
  });
  const connect = async (
    clientId = 'alice',
    toolset = 'legacy',
    modern = false,
    cwd = dir,
    dataDir = dir,
    file = settingsPath,
  ) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        entry,
        'serve',
        'stdio',
        '--data-dir',
        dataDir,
        '--settings',
        file,
        '--client-id',
        clientId,
        '--toolset',
        toolset,
      ],
      cwd,
      stderr: 'pipe',
      maxBufferSize: 17 * 1024 ** 2,
    });
    let stderr = '';
    transport.stderr!.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    const client = new Client(
      { name: 'process-test', version: '1.0.0' },
      {
        ...(modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}),
        capabilities: { elicitation: { form: {} } },
      },
    );
    clients.push(client);
    try {
      await client.connect(transport);
    } catch (error) {
      await delay(50);
      throw new Error(`代理 ${clientId} 连接失败：${stderr}`, { cause: error });
    }
    return { client, transport, stderr: () => stderr };
  };
  return { dir, settings, settingsPath, clients, descriptor, admin, connect };
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  const result = response.structuredContent as { ok: boolean; data: T; error?: unknown };
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.data;
}
async function info(client: Client) {
  return call<{ connectorInstanceId: string; principalId: string; mode: string }>(
    client,
    'management_read',
    { action: 'connector_info', arguments: {} },
  );
}
async function startTask(env: Awaited<ReturnType<typeof environment>>, client: Client) {
  const gate = join(env.dir, 'gate'),
    evidence = join(env.dir, 'prompt');
  const config = await call<{ configId: string }>(client, 'management_write', {
    action: 'agent_register',
    arguments: {
      config: {
        name: 'service-fixture',
        origin: { kind: 'manual' },
        launch: { kind: 'command', executable: process.execPath, args: [fixture, gate, evidence] },
        cwd: env.dir,
      },
      idempotencyKey: 'register',
    },
  });
  const created = await call<{ operationId: string }>(client, 'session_create', {
    configId: config.configId,
    cwd: env.dir,
    idempotencyKey: 'create',
  });
  const operation = await until(async () => {
    const op = await call<{ state: string; result?: { sessionId: string }; error?: unknown }>(
      client,
      'operation_get',
      { operationId: created.operationId },
    );
    if (op.state === 'failed') throw new Error(JSON.stringify(op.error));
    return op.state === 'completed' ? op : undefined;
  });
  const sessionId = operation.result!.sessionId;
  const submitted = await call<{ taskId: string }>(client, 'task_submit', {
    sessionId,
    prompt: [{ type: 'text', text: '中文🙂 task' }],
    idempotencyKey: 'submit',
  });
  await until(() =>
    readFile(evidence, 'utf8').then(
      (v) => (v === 'accepted' ? true : undefined),
      () => undefined,
    ),
  );
  return { ...submitted, sessionId, gate, evidence, configId: config.configId };
}

/** 十个真实 MCP 客户端并发启动，路径别名与协议/目录都不能创建第二个执行者。 */
void test('Concurrent proxies share one execution instance across aliases and toolsets', async (t) => {
  const env = await environment(t);
  const alias = join(env.dir, 'alias');
  await symlink(env.dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, index) =>
      env.connect(
        `client-${index}`,
        index % 2 ? 'management' : 'legacy',
        !!(index % 3),
        env.dir,
        index % 2 ? alias : env.dir,
      ),
    ),
  );
  const failures = results.filter((r) => r.status === 'rejected');
  assert.equal(failures.length, 0, failures.map((r) => String(r.reason)).join('\n'));
  const connected = results.map((r) => {
    assert.equal(r.status, 'fulfilled');
    return r.value;
  });
  const identities = await Promise.all(connected.map(({ client }) => info(client)));
  assert.equal(new Set(identities.map((i) => i.connectorInstanceId)).size, 1);
  assert.equal(new Set(identities.map((i) => i.principalId)).size, 10);
  assert.ok(identities.every((i) => i.mode === 'stdio'));
  for (const index of [0, 1]) {
    const tools = await connected[index]!.client.listTools();
    assert.equal(
      tools.tools.some((tool) => tool.name === 'session_create'),
      index === 0,
    );
  }
  const status = await env.admin<{ connections: number; workCount: number }>('_service_status');
  assert.equal(status.connections, 10);
  const instances = await cli(['service', 'instances', '--data-dir', alias]);
  assert.equal((JSON.parse(instances.stdout) as unknown[]).length, 1);
  const { client } = connected[0]!;
  const denied = await client.callTool({
    name: 'management_write',
    arguments: { action: '_stop', arguments: {} },
  });
  assert.equal(denied.isError, true);
});

for (const ending of ['close', 'SIGTERM', 'SIGKILL'] as const) {
  /** 已受理 prompt 在代理退出后继续，重连与幂等重放复用原 task。 */
  void test('Accepted work survives proxy termination: ' + ending, async (t) => {
    const env = await environment(t);
    const first = await env.connect('alice', 'legacy', ending === 'close');
    const task = await startTask(env, first.client);
    if (ending === 'close') await first.client.close();
    else process.kill(first.transport.pid!, ending);
    const next = await env.connect('alice', 'legacy', true);
    const state = await call<{ state: string }>(next.client, 'task_get', { taskId: task.taskId });
    assert.equal(state.state, 'running');
    const intruder = await env.connect('bob');
    const denied = (
      await intruder.client.callTool({ name: 'task_get', arguments: { taskId: task.taskId } })
    ).structuredContent as { ok: boolean };
    assert.equal(denied.ok, false);
    await writeFile(task.gate, 'finish');
    await until(async () =>
      (await call<{ state: string }>(next.client, 'task_get', { taskId: task.taskId })).state ===
      'completed'
        ? true
        : undefined,
    );
    const replay = await call<{ taskId: string }>(next.client, 'task_submit', {
      sessionId: task.sessionId,
      prompt: [{ type: 'text', text: '中文🙂 task' }],
      idempotencyKey: 'submit',
    });
    assert.equal(replay.taskId, task.taskId);
  });
}

/** 崩溃后监督进程清理 Agent；新实例只能查询 interrupted，不重发 prompt。 */
void test('Service crash cleans agents and preserves unknown outcomes without replay', async (t) => {
  const env = await environment(t);
  const { client } = await env.connect();
  const task = await startTask(env, client);
  const original = await env.descriptor();
  const pid = Number(await readFile(task.evidence + '.pid', 'utf8'));
  process.kill(original.pid, 'SIGKILL');
  await until(() => Promise.resolve(!isAlive(pid) ? true : undefined));
  const replacement = await env.connect();
  const current = await env.descriptor();
  assert.notEqual(current.instanceId, original.instanceId);
  assert.equal(current.serviceId, original.serviceId);
  const interrupted = await call<{ state: string; dispatchOutcome: string }>(
    replacement.client,
    'task_get',
    { taskId: task.taskId },
  );
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.dispatchOutcome, 'unknown');
  const replay = await call<{ taskId: string }>(replacement.client, 'task_submit', {
    sessionId: task.sessionId,
    prompt: [{ type: 'text', text: '中文🙂 task' }],
    idempotencyKey: 'submit',
  });
  assert.equal(replay.taskId, task.taskId);
  assert.equal(await readFile(task.evidence, 'utf8'), 'accepted');
});

/** HTTP 绑定失败保留 IPC 与空闲策略，成功接管才取消回收。 */
void test('HTTP takeover is transactional and foreground stop cleans accepted work', async (t) => {
  const occupied = createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  t.after(() => occupied.close());
  const port = (occupied.address() as { port: number }).port;
  const env = await environment(t, { httpPort: port });
  const first = await env.connect();
  const task = await startTask(env, first.client);
  type Status = {
    lifecyclePolicy: string;
    http: { available: boolean; url?: string };
    connections: number;
  };
  assert.equal((await env.admin<Status>('_service_status')).http.available, false);
  const failed = await cli(['serve', 'http', '--data-dir', env.dir, '--port', String(port)]);
  assert.notEqual(failed.code, 0);
  assert.equal((await env.admin<Status>('_service_status')).lifecyclePolicy, 'idle');
  const takeover = spawn(
    process.execPath,
    [entry, 'serve', 'http', '--data-dir', env.dir, '--port', '0'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  t.after(() => {
    if (takeover.exitCode === null) takeover.kill();
  });
  await until(async () =>
    (await env.admin<Status>('_service_status')).lifecyclePolicy === 'persistent'
      ? true
      : undefined,
  );
  const conflict = await cli(['serve', 'http', '--data-dir', env.dir, '--port', String(port)]);
  assert.notEqual(conflict.code, 0);
  const pid = Number(await readFile(task.evidence + '.pid', 'utf8'));
  const exiting = once(takeover, 'exit');
  takeover.kill('SIGTERM');
  await exiting;
  await until(() => Promise.resolve(!isAlive(pid) ? true : undefined));
});

/** 自动服务 HTTP 可直接使用原认证、Host/Origin 防护和 MCP 两代协议。 */
void test('Automatic HTTP serves MCP clients and rejects invalid origins and settings', async (t) => {
  const env = await environment(t, { httpAuth: 'none' });
  const { client } = await env.connect();
  await client.listTools();
  const status = await env.admin<{ http: { url: string } }>('_service_status');
  for (const modern of [false, true]) {
    const http = new Client(
      { name: 'http-test', version: '1' },
      modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
    );
    env.clients.push(http);
    await http.connect(
      new StreamableHTTPClientTransport(new URL(status.http.url), {
        requestInit: { headers: { 'x-agent-client-id': 'http-client' } },
      }),
    );
    assert.ok((await http.listTools()).tools.some((tool) => tool.name === 'spawn_agent'));
    await http.close();
  }
  const forbidden = await fetch(status.http.url, {
    method: 'POST',
    headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(forbidden.status, 403);
  const mismatch = join(env.dir, 'mismatch.json');
  await writeFile(mismatch, JSON.stringify({ ...env.settings, maxTasks: 1 }));
  const failure = await cli(['serve', 'stdio', '--data-dir', env.dir, '--settings', mismatch]);
  assert.notEqual(failure.code, 0);
  assert.equal(failure.stdout, '');
  assert.match(failure.stderr, /SERVICE_SETTINGS_CONFLICT/);
});

/** 私有握手处理剩余数据/分片，认证失败不会获得普通或管理员能力。 */
void test('IPC rejects wrong credentials, privilege injection and oversized messages', async (t) => {
  const env = await environment(t);
  await env.connect();
  const d = await env.descriptor(),
    c = await serviceCredentials(d);
  const hand = {
    version: 1,
    instanceId: d.instanceId,
    token: c.token,
    clientId: 'alice',
    toolset: 'legacy',
    startupCwd: env.dir,
  };
  for (const extra of [{ token: 'wrong' }, { admin: true }, { version: 2 }]) {
    const socket = createConnection(d.endpoint);
    socket.on('error', () => {});
    const response = readHandshake(socket);
    socket.write(JSON.stringify({ ...hand, ...extra }) + '\n');
    assert.equal(((await response) as { ok: boolean }).ok, false);
    socket.destroy();
  }
  const excessive = createConnection(d.endpoint);
  const rejected = readHandshake(excessive);
  excessive.write(Buffer.alloc(64 * 1024 + 1, 65));
  assert.equal(((await rejected) as { ok: boolean }).ok, false);
  excessive.destroy();
  const socket = await connectMcpIpc(d, c.token, 'alice', 'legacy', env.dir);
  const closed = once(socket, 'close');
  socket.on('error', () => {});
  socket.resume();
  socket.write(Buffer.alloc(17 * 1024 ** 2 + 1, 65));
  await closed;
  const state = await env.admin<{ connections: number }>('_service_status');
  assert.equal(state.connections, 1);
  const raw = await readFile(join(env.dir, 'state', 'execution-service.json'), 'utf8');
  assert.ok(!raw.includes(c.token));
  assert.ok(!raw.includes(c.nonce));
  const status = await cli(['service', 'status', '--data-dir', env.dir]);
  assert.ok(!status.stdout.includes(c.token));
  assert.ok(!status.stdout.includes(c.nonce));
});

/** 两个代理的 fallback cwd 在协作受理时固定，团队不会借用首个代理的目录。 */
void test('Collaboration fallback cwd belongs to the calling proxy', async (t) => {
  const env = await environment(t);
  const one = join(env.dir, 'one'),
    two = join(env.dir, 'two');
  await mkdir(one);
  await mkdir(two);
  const first = await env.connect('alice', 'collaboration', false, one);
  const second = await env.connect('bob', 'collaboration', true, two);
  const registered = await call<{ configId: string }>(first.client, 'setup_agent', {
    action: 'register',
    arguments: {
      config: {
        name: 'cwd-fixture',
        origin: { kind: 'manual' },
        launch: {
          kind: 'command',
          executable: process.execPath,
          args: [fixture, join(env.dir, 'gate'), join(env.dir, 'cwd-evidence')],
        },
      },
      idempotencyKey: 'cwd-config',
    },
  });
  const a = await call<{ teamId: string }>(first.client, 'spawn_agent', {
    requestId: 'a',
    taskName: 'a',
    message: 'wait',
    profile: registered.configId,
  });
  const b = await call<{ teamId: string }>(second.client, 'spawn_agent', {
    requestId: 'b',
    taskName: 'b',
    message: 'wait',
    profile: registered.configId,
  });
  const listed = await env.admin<{ items: { cwd: string }[] }>('session_list');
  assert.notEqual(a.teamId, b.teamId);
  await until(async () => {
    const sessions = await env.admin<{ items: { cwd: string }[] }>('session_list');
    return sessions.items.length === 2 ? sessions : undefined;
  }).then((sessions) =>
    assert.deepEqual(
      new Set(sessions.items.map((s) => resolve(s.cwd))),
      new Set([resolve(one), resolve(two)]),
    ),
  );
  assert.ok(listed.items.length <= 2);
});

/** Windows CI 真正创建允许/禁止 breakaway 的 Job；其他平台明确记录未运行。 */
void test(
  'Windows launcher obeys Job breakaway policy',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'acm-job-test-'));
    t.after(async () => rm(dir, { recursive: true, force: true }));
    const script = join(dir, 'child.mjs'),
      evidence = join(dir, 'pid');
    await writeFile(
      script,
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(evidence)}, String(process.pid)); setInterval(()=>{},1000);`,
    );
    const launcher = resolve(`native/win32-${process.arch}/service-launcher.exe`);
    for (const policy of ['allowed', 'denied']) {
      const child = spawn(launcher, ['--job', policy, process.execPath, script], {
        stdio: 'ignore',
      });
      const [code] = (await once(child, 'exit')) as [number | null];
      if (policy === 'allowed') {
        assert.equal(code, 0);
        const pid = await until(() => readFile(evidence, 'utf8').then(Number, () => undefined));
        assert.equal(isAlive(pid), true);
        process.kill(pid);
        await until(() => Promise.resolve(!isAlive(pid) ? true : undefined));
        await rm(evidence);
      } else {
        assert.equal(code, 73);
        await assert.rejects(readFile(evidence));
      }
    }
  },
);

/** 正常 EOF 与健康轮询不会保活；已有空闲会话/Runtime 也不能阻止服务回收。 */
void test('Idle service exits while status polling continues', async (t) => {
  const env = await environment(t, { serviceIdleTimeoutMs: 1000 });
  const { client } = await env.connect();
  const task = await startTask(env, client);
  await writeFile(task.gate, 'finish');
  await until(async () =>
    (await call<{ state: string }>(client, 'task_get', { taskId: task.taskId })).state ===
    'completed'
      ? true
      : undefined,
  );
  const d = await env.descriptor();
  await client.close();
  await until(async () => {
    if (!isAlive(d.pid)) return true;
    const credentials = await serviceCredentials(d).catch(() => undefined);
    if (credentials)
      await adminRequest(
        descriptorInstance(d, credentials.nonce),
        '_service_status',
        {},
        false,
        undefined,
        200,
      ).catch(() => {});
    return undefined;
  });
  await assert.rejects(readFile(join(env.dir, 'state', 'execution-service.json')));
  const reconnected = await env.connect();
  assert.equal(
    (await call<{ state: string }>(reconnected.client, 'task_get', { taskId: task.taskId })).state,
    'completed',
  );
});

/** 服务会消费 handshake 同包剩余字节，UTF-8 分片不改变 MCP 内容。 */
void test('Handshake remainder and fragmented MCP bytes reach the original SDK', async (t) => {
  const env = await environment(t);
  await env.connect();
  const d = await env.descriptor(),
    credentials = await serviceCredentials(d);
  const socket = createConnection(d.endpoint);
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  const ack = readHandshake(socket);
  const hello = JSON.stringify({
    version: 1,
    instanceId: d.instanceId,
    token: credentials.token,
    clientId: 'fragments',
    toolset: 'legacy',
    startupCwd: env.dir,
  });
  const init = JSON.stringify({
    jsonrpc: '2.0',
    id: 5,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: '中文🙂', version: '1' },
    },
  });
  const payload = Buffer.from(hello + '\n' + init + '\n');
  // 握手和部分 MCP 字节同包，随后从多字节字符中间拆开。
  const split = payload.indexOf(Buffer.from('🙂')) + 1;
  socket.write(payload.subarray(0, split));
  socket.write(payload.subarray(split));
  assert.equal(((await ack) as { ok: boolean }).ok, true);
  const response = (await readHandshake(socket)) as {
    id: number;
    result: { protocolVersion: string };
  };
  assert.equal(response.id, 5);
  assert.equal(response.result.protocolVersion, '2025-11-25');
});

/** 请求取消只终止等待，仍需显式 task_cancel 才结束已受理工作。 */
void test('Cancelling an MCP wait leaves accepted work running', async (t) => {
  const env = await environment(t);
  const { client } = await env.connect();
  const task = await startTask(env, client);
  const controller = new AbortController();
  const pending = client.callTool(
    { name: 'task_wait', arguments: { taskId: task.taskId, timeoutMs: 10000 } },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(pending);
  assert.equal(
    (await call<{ state: string }>(client, 'task_get', { taskId: task.taskId })).state,
    'running',
  );
  await call(client, 'task_cancel', { taskId: task.taskId });
  await until(async () =>
    (await call<{ state: string }>(client, 'task_get', { taskId: task.taskId })).state ===
    'cancelled'
      ? true
      : undefined,
  );
});

/** 未启动的手动 HTTP 前台服务可被 stdio 复用，绑定失败不会发布发现文件。 */
void test('Manual HTTP starts in the foreground and is reused by stdio', async (t) => {
  const env = await environment(t);
  const manual = spawn(
    process.execPath,
    [entry, 'serve', 'http', '--data-dir', env.dir, '--settings', env.settingsPath, '--port', '0'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  t.after(() => {
    if (manual.exitCode === null) manual.kill();
  });
  const d = await env.descriptor();
  assert.equal(d.pid, manual.pid);
  const { client } = await env.connect();
  assert.equal((await info(client)).connectorInstanceId, d.instanceId);
  assert.equal(
    (await env.admin<{ lifecyclePolicy: string }>('_service_status')).lifecyclePolicy,
    'persistent',
  );
  const exited = once(manual, 'exit');
  manual.kill('SIGTERM');
  await exited;
});

/** 停机宽限耗尽时即使下游拒绝取消，也结束服务并由监督进程清理进程树。 */
void test('Shutdown deadline forces service exit and preserves recoverable records', async (t) => {
  const env = await environment(t, { serviceShutdownTimeoutMs: 50 });
  const { client } = await env.connect();
  const task = await startTask(env, client);
  const d = await env.descriptor(),
    pid = Number(await readFile(task.evidence + '.pid', 'utf8'));
  await env.admin('_stop');
  await until(() => Promise.resolve(!isAlive(d.pid) ? true : undefined));
  await until(() => Promise.resolve(!isAlive(pid) ? true : undefined));
  const next = await env.connect();
  const result = await call<{ state: string }>(next.client, 'task_get', { taskId: task.taskId });
  assert.ok(['interrupted', 'cancelled', 'completed'].includes(result.state));
});

/** 现代 HTTP 的 inputRequired 跨 POST 重入，临时能力标识不得破坏稳定身份呈现。 */
for (const transportMode of ['stdio-legacy', 'stdio-modern', 'http-modern']) {
  void test('Interaction presentation through IPC and HTTP: ' + transportMode, async (t) => {
    const env = await environment(t, { httpAuth: 'none' });
    let client: Client;
    if (transportMode === 'http-modern') {
      const manual = spawn(
        process.execPath,
        [
          entry,
          'serve',
          'http',
          '--data-dir',
          env.dir,
          '--settings',
          env.settingsPath,
          '--port',
          '0',
          '--toolset',
          'legacy',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      t.after(() => {
        if (manual.exitCode === null) manual.kill();
      });
      await env.descriptor();
      const status = await env.admin<{ http: { url: string } }>('_service_status');
      client = new Client(
        { name: 'http-interaction', version: '1' },
        {
          versionNegotiation: { mode: { pin: '2026-07-28' } },
          capabilities: { elicitation: { form: {} } },
        },
      );
      env.clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(status.http.url), {
          requestInit: { headers: { 'x-agent-client-id': 'http-form' } },
        }),
      );
    } else {
      client = (await env.connect('form-client', 'legacy', transportMode === 'stdio-modern'))
        .client;
    }
    let presented = 0;
    client.setRequestHandler('elicitation/create', () => {
      presented++;
      return { action: 'accept', content: { answer: 'confirmed' } };
    });
    const templates = await client.listResourceTemplates();
    assert.equal(
      templates.resourceTemplates[0]?.uriTemplate,
      'agent-control://content/{objectId}/{contentId}',
    );
    await assert.rejects(
      client.readResource({ uri: 'agent-control://content/tsk_missing/missing' }),
    );
    const tools = await client.listTools();
    assert.equal(
      tools.tools.find((tool) => tool.name === 'task_get')?.annotations?.readOnlyHint,
      true,
    );
    const evidence = join(env.dir, 'form-evidence'),
      gate = join(env.dir, 'form-gate');
    await writeFile(gate, 'continue');
    const registered = await call<{ configId: string }>(client, 'management_write', {
      action: 'agent_register',
      arguments: {
        config: {
          name: 'form-fixture',
          origin: { kind: 'manual' },
          launch: {
            kind: 'command',
            executable: process.execPath,
            args: [fixture, gate, evidence, 'form'],
          },
          cwd: env.dir,
        },
        idempotencyKey: 'form-register',
      },
    });
    const created = await call<{ operationId: string }>(client, 'session_create', {
      configId: registered.configId,
      cwd: env.dir,
      interactionChannel: 'mcp_native',
      idempotencyKey: 'form-create',
    });
    const session = await until(async () => {
      const op = await call<{ state: string; result?: { sessionId: string }; error?: unknown }>(
        client,
        'operation_get',
        { operationId: created.operationId },
      );
      if (op.state === 'failed') throw new Error(JSON.stringify(op.error));
      return op.state === 'completed' ? op.result : undefined;
    });
    const submitted = await call<{ taskId: string }>(client, 'task_submit', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'form' }],
      idempotencyKey: 'form-submit',
    });
    const interaction = await until(async () => {
      const pending = await call<{ items: { id: string }[] }>(client, 'interaction_list', {});
      const task = await call<{ state: string; error?: unknown }>(client, 'task_get', {
        taskId: submitted.taskId,
      });
      assert.notEqual(task.state, 'failed', JSON.stringify(task.error));
      assert.notEqual(task.state, 'completed', '表单请求应等待真实呈现');
      return pending.items[0];
    });
    const answer = await call<Record<string, unknown>>(client, 'interaction_present', {
      interactionId: interaction.id,
    });
    assert.equal(presented, 1);
    await call(client, 'interaction_respond', answer);
    await until(async () =>
      (await call<{ state: string }>(client, 'task_get', { taskId: submitted.taskId })).state ===
      'completed'
        ? true
        : undefined,
    );
    const events = await call(client, 'task_events', { taskId: submitted.taskId });
    assert.match(JSON.stringify(events), /中文🙂:completed/);
  });
}

/** 真实 socket 上的慢消费者触发背压，双向转发必须保持每一个字节。 */
void test('Stdio proxy preserves bytes under bidirectional backpressure', async (t) => {
  const server = createServer((socket) => socket.pipe(socket));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const socket = createConnection(address.port, '127.0.0.1');
  await once(socket, 'connect');
  const input = new PassThrough({ highWaterMark: 1024 });
  const chunks: Buffer[] = [];
  const expected = Buffer.from('中文🙂 backpressure\n'.repeat(100_000));
  let received = 0;
  let complete!: () => void;
  const outputComplete = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const output = new Writable({
    highWaterMark: 1024,
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      received += chunk.length;
      setImmediate(() => {
        callback();
        if (received === expected.length) complete();
      });
    },
  });
  const proxy = proxyStdio(socket, input, output);
  input.write(expected);
  await outputComplete;
  assert.deepEqual(Buffer.concat(chunks), expected);
  input.end();
  await proxy;
});

/** 活动旧实例阻止新服务混用；旧设置文档在停止后使用新增默认值读取。 */
void test('Legacy active instances block execution service startup', async (t) => {
  const env = await environment(t);
  const legacy = await Container.create({
    dataDir: env.dir,
    mode: 'stdio',
    settings: env.settings,
  });
  try {
    const rejected = await cli(['serve', 'stdio', '--data-dir', env.dir]);
    assert.notEqual(rejected.code, 0);
    assert.equal(rejected.stdout, '');
    assert.match(rejected.stderr, /SERVICE_VERSION_CONFLICT/);
    const meta = (await legacy.store.get<{
      id: string;
      revision: number;
      createdAt: string;
      settings: Record<string, unknown>;
    }>('meta', 'connector'))!;
    const oldSettings = { ...meta.settings };
    delete oldSettings.serviceIdleTimeoutMs;
    delete oldSettings.serviceStartupTimeoutMs;
    delete oldSettings.serviceShutdownTimeoutMs;
    await legacy.store.put('meta', { ...meta, revision: meta.revision + 1, settings: oldSettings });
  } finally {
    await legacy.close();
  }
  const { client } = await env.connect();
  assert.equal((await info(client)).mode, 'stdio');
});

/** 手动 HTTP 与自动 stdio 同时竞选，由数据库单例决定唯一执行者。 */
void test('Manual HTTP racing automatic stdio produces one execution owner', async (t) => {
  const env = await environment(t);
  const manual = spawn(
    process.execPath,
    [entry, 'serve', 'http', '--data-dir', env.dir, '--settings', env.settingsPath, '--port', '0'],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  t.after(() => {
    if (manual.exitCode === null) manual.kill();
  });
  const { client } = await env.connect();
  const d = await env.descriptor();
  await until(async () =>
    (await env.admin<{ lifecyclePolicy: string }>('_service_status')).lifecyclePolicy ===
    'persistent'
      ? true
      : undefined,
  );
  assert.equal((await info(client)).connectorInstanceId, d.instanceId);
  const instances = await cli(['service', 'instances', '--data-dir', env.dir]);
  assert.equal((JSON.parse(instances.stdout) as unknown[]).length, 1);
  assert.equal(manual.exitCode, null);
});

/** 超时受读取器配置约束，不等待真实认证期限；生产仍采用固定 10 秒。 */
void test('Private handshake closes on its authentication deadline', async (t) => {
  const server = createServer((socket) => {
    void readHandshake(socket, 20).then(
      () => assert.fail('无握手不能认证'),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, 'TIMEOUT');
        socket.destroy();
      },
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const socket = createConnection(address.port, '127.0.0.1');
  await once(socket, 'close');
});
