import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../../src/domain/permission-policy.js';
import { permissionPolicy } from '../../src/domain/schemas.js';
import { normalizeEnvironment } from '../../src/infrastructure/platform/environment.js';
import type { OperationDescription } from '../../src/domain/permission-policy.js';

const command = { executable: 'fixture', args: ['approved'] };
const operation = (env?: Record<string, string>): OperationDescription => ({
  operation: 'execute',
  paths: [process.cwd()],
  command: { ...command, ...(env ? { env } : {}) },
});
const policy = (effect: 'allow_once' | 'ask' | 'deny', env?: Record<string, string>) =>
  permissionPolicy.parse({
    rules: [
      {
        id: 'command',
        effect,
        operations: ['execute'],
        roots: [process.cwd()],
        command: { ...command, ...(env ? { env } : {}) },
      },
    ],
    fallback: 'ask',
    timeoutMs: null,
  });

void test('命令放行不隐含批准请求环境，原命令拒绝仍覆盖附加环境', () => {
  assert.equal(
    decide(policy('allow_once'), operation(), () => true),
    'allow_once',
  );
  assert.equal(
    decide(policy('allow_once'), operation({}), () => true),
    'allow_once',
  );
  const request = operation({ NODE_OPTIONS: '--require=extra-code.cjs' });
  assert.equal(
    decide(policy('allow_once'), request, () => true),
    'ask',
  );
  assert.equal(
    decide(policy('deny'), request, () => true),
    'deny',
  );
  const combined = policy('allow_once');
  combined.rules.push(...policy('deny').rules);
  assert.equal(
    decide(combined, request, () => true),
    'deny',
  );
});

void test('环境覆盖完整匹配与键顺序无关，值变化、缺项和多项均不获准', () => {
  const allowed = policy('allow_once', { FIRST: 'one', SECOND: 'two' });
  assert.equal(
    decide(allowed, operation({ SECOND: 'two', FIRST: 'one' }), () => true),
    'allow_once',
  );
  for (const env of [
    {},
    { FIRST: 'one' },
    { FIRST: 'changed', SECOND: 'two' },
    { FIRST: 'one', SECOND: 'two', EXTRA: 'three' },
  ])
    assert.equal(
      decide(allowed, operation(env), () => true),
      'ask',
    );
  assert.equal(
    decide(policy('allow_once', {}), operation(), () => true),
    'allow_once',
  );
});

void test('Windows 环境名称合并与审批使用相同大小写规则', () => {
  const normalize = (env: Record<string, string>) => normalizeEnvironment(env, 'win32');
  const base = normalize({ Path: 'base', Safe: 'inherited' });
  const overrides = normalize({ PATH: 'approved', safe: 'requested' });
  assert.deepEqual({ ...base, ...overrides }, { PATH: 'approved', SAFE: 'requested' });
  assert.equal(
    decide(
      policy('allow_once', { Path: 'approved' }),
      operation({ PATH: 'approved' }),
      () => true,
      normalize,
    ),
    'allow_once',
  );
  assert.equal(
    decide(
      policy('allow_once', { Path: 'approved' }),
      operation({ path: 'changed' }),
      () => true,
      normalize,
    ),
    'ask',
  );
  assert.equal(
    decide(policy('deny'), operation({ path: 'changed' }), () => true, normalize),
    'deny',
  );
});
