import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { Container } from '../../src/bootstrap/container.js';
import { agentConfig } from '../../src/domain/schemas.js';
import { id } from '../../src/domain/ids.js';
import type { Context, WorkRecord } from '../../src/domain/models.js';
import { createTools, invoke } from '../../src/transport/mcp/tools.js';

/**
 * 每个测试使用独立数据目录、数据库和 ACP 子进程；alice/bob 用于验证权限隔离。
 * 仅放宽测试目录的最低剩余空间要求，协议、存储和进程生命周期仍走真实实现。
 */
export async function harness(mode: Context['mode'] = 'http', env: Record<string, string> = {}) {
  const path = await mkdtemp(join(tmpdir(), 'acm-test-'));
  const app = await Container.create({
    dataDir: join(path, 'data'),
    mode,
    settings: { minimumFreeBytes: 0 },
  });
  const alice = await app.identities.registerAnonymous('alice');
  const bob = await app.identities.registerAnonymous('bob');
  await writeFile(join(path, 'input.txt'), 'fixture input\nsecond line\n');
  const config = agentConfig.parse({
    name: '独立 ACP fixture',
    origin: { kind: 'manual' },
    launch: {
      kind: 'command',
      executable: process.execPath,
      args: [resolve('.test-dist/test/fixtures/acp-agent.js')],
    },
    cwd: path,
    environment: {
      values: Object.fromEntries(
        Object.entries({ FIXTURE_AUDIT: join(path, 'audit.jsonl'), ...env }).map(([key, value]) => [
          key,
          { kind: 'literal', value },
        ]),
      ),
    },
  });
  const registered = await app.configs.register(alice, { config, idempotencyKey: id('test') });
  const definitions = createTools(app);
  const call = async <T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown> = {},
    ctx = alice,
  ): Promise<T> => {
    const response = await invoke(app, definitions, ctx, name, args);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.ok ? (response.data as T) : (undefined as T);
  };
  // 不把返回 operationId 视为完成：等待持久化终态并断言成功，再向测试返回业务结果。
  const operation = async <T = Record<string, unknown>>(
    accepted: unknown,
    ctx = alice,
  ): Promise<T> => {
    const { operationId } = (await accepted) as { operationId: string };
    const record = await until(async () => {
      const value = await app.operations.get(ctx, operationId);
      return ['completed', 'failed', 'cancelled', 'interrupted'].includes(value.state)
        ? value
        : null;
    });
    assert.equal(record.state, 'completed', JSON.stringify(record));
    return record.result as T;
  };
  const session = async () =>
    operation<{ sessionId: string; runtimeId: string }>(
      app.sessions.create(alice, { configId: registered.configId, idempotencyKey: id('test') }),
    );
  const taskDone = async (taskId: string, ctx = alice) =>
    until(async () => {
      const value = await app.tasks.get(ctx, taskId);
      return ['completed', 'cancelled', 'failed', 'interrupted'].includes(value.state)
        ? value
        : null;
    });
  return {
    path,
    app,
    alice,
    bob,
    registered,
    call,
    operation,
    session,
    taskDone,
    // 先关闭容器以等待 Worker 与受管进程退出，再移除测试目录。
    cleanup: async () => {
      await app.close();
      await rm(path, { recursive: true, force: true });
    },
  };
}

/** 轮询可观测状态代替固定长延迟；真值表示条件满足，每轮结束后检查累计耗时。 */
export async function until<T>(
  fn: () => Promise<T | null | false | undefined> | (T | null | false | undefined),
  timeout = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await fn();
    if (value) return value;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error('等待验收状态超时');
}

export function completed(record: WorkRecord) {
  assert.equal(record.state, 'completed', JSON.stringify(record));
}
