import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { Container } from '../../src/bootstrap/container.js';
import { createMcpTools, describeTool } from '../../src/transport/mcp/catalog.js';

void test('CLI 保留原命令、call、自动幂等键，并提供 tools --mcp', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'acm-cli-'));
  const run = async (...args: string[]): Promise<unknown> => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [resolve('dist/cli/entry.js'), ...args, '--data-dir', join(root, 'data')],
      { maxBuffer: 4 * 1024 * 1024, timeout: 10_000 },
    );
    return JSON.parse(stdout) as unknown;
  };
  try {
    const definitions = z.array(z.object({ name: z.string() }));
    const original = definitions.parse(await run('tools'));
    assert.equal(original.length, 62);
    assert.ok(original.some((tool) => tool.name === 'agent_register'));
    const published = await run('tools', '--mcp');
    assert.deepEqual(published, createMcpTools({} as Container).map(describeTool));
    assert.equal(definitions.parse(published).length, 30);
    const created = z.object({ configId: z.string(), revision: z.number() }).parse(
      await run(
        'agent',
        'register',
        '--input',
        JSON.stringify({
          config: {
            name: 'CLI 兼容',
            origin: { kind: 'manual' },
            launch: { kind: 'command', executable: process.execPath, args: [] },
          },
        }),
      ),
    );
    await run(
      'call',
      'agent_update',
      '--input',
      JSON.stringify({
        configId: created.configId,
        patch: { name: '旧操作名兼容' },
        expectedRevision: created.revision,
      }),
    );
    const current = z
      .object({ config: z.object({ name: z.string() }), revision: z.number() })
      .parse(await run('agent', 'get', '--config', created.configId));
    assert.equal(current.config.name, '旧操作名兼容');
    assert.equal(current.revision, 2);
    assert.ok(z.object({ items: z.array(z.unknown()) }).parse(await run('registry', 'sources')));
    assert.deepEqual(
      await run(
        'call',
        'agent_remove',
        '--input',
        JSON.stringify({
          configId: created.configId,
          expectedRevision: current.revision,
        }),
      ),
      { removed: true },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
