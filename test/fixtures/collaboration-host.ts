import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Container } from '../../src/bootstrap/container.js';
import { agentConfig } from '../../src/domain/schemas.js';
import type { RuntimeRecord } from '../../src/domain/models.js';

// 用独立宿主进程在事务边界退出，验证新实例只恢复通知，不重放已接受工作。
const [directory, point] = process.argv.slice(2);
const app = await Container.create({
  dataDir: join(directory!, 'data'),
  mode: 'stdio',
  settings: { minimumFreeBytes: 0 },
});
const ctx = {
  principalId: 'stdio:collaboration-recovery',
  mode: 'stdio' as const,
  serviceId: app.serviceId,
};
await app.configs.register(ctx, {
  idempotencyKey: 'fixture',
  config: agentConfig.parse({
    name: 'crash-fixture',
    origin: { kind: 'manual' },
    launch: {
      kind: 'command',
      executable: process.execPath,
      args: [resolve('.test-dist/test/fixtures/acp-agent.js')],
    },
    cwd: directory,
    environment: {
      values: { FIXTURE_AUDIT: { kind: 'literal', value: join(directory!, 'audit.jsonl') } },
    },
  }),
});
let stopped = false;
const commit = app.store.commit.bind(app.store);
app.store.commit = async (transaction) => {
  const result = await commit(transaction);
  if (
    !stopped &&
    point === 'terminal' &&
    transaction.puts?.some((r) => r.kind === 'collab_outbox')
  ) {
    stopped = true;
    process.stdout.write(JSON.stringify({ committed: true }) + '\n', () => process.exit(27));
    await new Promise<void>(() => {});
  }
  return result;
};
const member = await app.collaboration.spawn(ctx, {
  requestId: 'create',
  taskName: 'worker',
  message: point === 'running' ? 'slow operation' : 'visible output',
});
process.stdout.write(JSON.stringify(member) + '\n');
if (point === 'running') {
  for (;;) {
    const agent = await app.collaboration.agent(member.agentId);
    const view = await app.collaboration.view(agent);
    if (view.state === 'running') {
      await app.collaboration.followup(ctx, {
        requestId: 'queued',
        target: member.agentId,
        message: 'must remain queued',
      });
      const runtime = await app.store.get<RuntimeRecord>('runtime', agent.runtimeId!);
      stopped = true;
      process.stdout.write(JSON.stringify({ runtimePid: runtime?.pid }) + '\n', () =>
        process.exit(29),
      );
      break;
    }
    await delay(10);
  }
}
