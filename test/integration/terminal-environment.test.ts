import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, until } from '../helpers/harness.js';
import { id } from '../../src/domain/ids.js';
import { runCommand } from '../../src/infrastructure/platform/process-host.js';

void test('终端环境覆盖必须单独获准，审批脱敏且批准后传递实际值', { timeout: 30_000 }, async () => {
  const h = await harness('http', {
    ACM_BASE_ENV: 'private-inherited-value',
    ACM_TERMINAL_VALUE: 'inherited',
  });
  try {
    const command = {
      executable: process.execPath,
      args: [
        '-e',
        'console.log(JSON.stringify({value:process.env.ACM_TERMINAL_VALUE,token:process.env.ACM_API_TOKEN,base:process.env.ACM_BASE_ENV}))',
      ],
    };
    await h.app.configs.update(h.alice, {
      configId: h.registered.configId,
      expectedRevision: 1,
      idempotencyKey: id('policy'),
      patch: {
        permissionPolicy: {
          rules: [
            {
              id: 'command-only',
              effect: 'allow_once',
              operations: ['execute'],
              roots: [h.path],
              command,
            },
          ],
          fallback: 'ask',
          timeoutMs: null,
        },
      },
    });
    const created = await h.session();
    const session = await h.app.sessions.get(h.alice, created.sessionId);
    for (const value of ['first', 'second']) {
      let started = false;
      const request = h.app
        .callback(
          created.runtimeId,
          'terminal/create',
          {
            sessionId: session.downstreamSessionId,
            command: command.executable,
            args: command.args,
            cwd: h.path,
            env: [
              {
                name: process.platform === 'win32' ? 'acm_terminal_value' : 'ACM_TERMINAL_VALUE',
                value,
              },
              { name: 'ACM_API_TOKEN', value: 'synthetic-private-token' },
            ],
          },
          new AbortController().signal,
          'terminal-environment',
        )
        .then((result) => {
          started = true;
          return result as { terminalId: string };
        });
      void request.catch(() => {});
      const permission = await until(async () => {
        assert.equal(started, false, '附带环境的请求不能沿用纯命令自动放行');
        return (await h.app.interactions.list(h.alice, { sessionId: session.id }, true))[0];
      });
      const description = permission.request.command as { env: Record<string, string> };
      assert.deepEqual(description.env, {
        ACM_TERMINAL_VALUE: value,
        ACM_API_TOKEN: '[REDACTED]',
      });
      assert.equal(JSON.stringify(permission).includes('private-inherited-value'), false);
      assert.equal(JSON.stringify(permission).includes('synthetic-private-token'), false);
      assert.equal(
        await h.app.interactions.mayDelegateApproval(created.runtimeId, permission, {
          kind: 'host',
          allow: true,
        }),
        false,
      );
      await h.app.interactions.respondPermission(h.alice, {
        interactionId: permission.id,
        expectedRevision: permission.revision,
        idempotencyKey: id('approve'),
        decision: { kind: 'host', allow: true },
      });
      const terminal = await request;
      const status = await h.app.terminals.wait(
        created.runtimeId,
        terminal.terminalId,
        new AbortController().signal,
      );
      assert.equal(status.exitCode, 0);
      assert.deepEqual(
        JSON.parse(h.app.terminals.output(created.runtimeId, terminal.terminalId).output),
        {
          value,
          token: 'synthetic-private-token',
          base: 'private-inherited-value',
        },
      );
      await h.app.terminals.release(created.runtimeId, terminal.terminalId);
    }
  } finally {
    await h.cleanup();
  }
});

void test('目标 NODE_OPTIONS 只影响获准目标，不注入 supervisor', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'acm process env '));
  const marker = join(root, 'preload.jsonl');
  const preload = join(root, 'preload.cjs');
  try {
    await writeFile(
      preload,
      `require('node:fs').appendFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,value:process.env.ACM_TARGET_ENV})+'\\n');`,
    );
    const env = {
      ...process.env,
      NODE_OPTIONS: `--require ${JSON.stringify(preload.replaceAll('\\', '/'))}`,
      ACM_TARGET_ENV: 'approved-target-value',
    };
    const output = await runCommand({
      executable: process.execPath,
      args: [
        '-e',
        'console.log(JSON.stringify({pid:process.pid,value:process.env.ACM_TARGET_ENV}))',
      ],
      cwd: root,
      env,
    });
    const target = JSON.parse(output) as { pid: number; value: string };
    assert.equal(target.value, 'approved-target-value');
    assert.deepEqual(
      (await readFile(marker, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown),
      [target],
    );
    if (process.platform !== 'win32') {
      await rm(marker);
      assert.equal(
        await runCommand({ executable: '/bin/echo', args: ['approved-command'], cwd: root, env }),
        'approved-command\n',
      );
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
