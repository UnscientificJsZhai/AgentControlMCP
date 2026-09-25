import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../../src/domain/permission-policy.js';
import { permissionPolicy } from '../../src/domain/schemas.js';
import { normalizeEnvironment } from '../../src/infrastructure/platform/environment.js';
import { inside } from '../../src/infrastructure/platform/file-callbacks.js';
import type { OperationDescription } from '../../src/domain/permission-policy.js';
import type { PermissionPolicy } from '../../src/domain/schemas.js';

const command = { executable: 'fixture', args: ['approved'] };
/**
 * 构造当前工作目录内的固定命令执行请求。
 *
 * @param env - 可选的请求环境覆盖，用于验证命令授权与环境授权的边界。
 * @returns 包含命令、路径和可选环境覆盖的操作描述。
 */
const operation = (env?: Record<string, string>): OperationDescription => ({
  operation: 'execute',
  paths: [process.cwd()],
  command: { ...command, ...(env ? { env } : {}) },
});
/**
 * 为固定测试命令创建权限策略。
 *
 * @param effect - 命令匹配时采用的权限决策。
 * @param env - 规则要求完整匹配的环境覆盖。
 * @returns 通过配置校验且默认回退到人工询问的策略。
 */
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

/**
 * 验证命令放行不隐式批准额外环境，而命令拒绝仍约束带环境的请求。
 *
 * @remarks
 * 附加环境可能改变程序行为；混合规则中拒绝必须优先于放行。
 */
void test('Command approval does not authorize extra environment overrides while denials still apply', () => {
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

/**
 * 验证环境覆盖按完整键值集合匹配，不受键顺序影响。
 *
 * @remarks
 * 值变化、缺项或多项都应回退到询问；未提供环境与空环境视为等价。
 */
void test('Environment overrides require exact key-value matches regardless of key order', () => {
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

/**
 * 验证 Windows 环境合并和权限审批采用一致的键名大小写规则。
 *
 * @remarks
 * 键名大小写差异不能阻止等价环境匹配，实际值变化仍须重新审批。
 */
void test('Windows environment merging and approval use the same case normalization', () => {
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

/**
 * 验证路径授权按目录边界、全部请求路径和操作类型共同匹配。
 *
 * @remarks
 * 同名前缀目录、越界路径、空路径和未声明操作不能放行，写入与删除遵循拒绝规则。
 */
void test('Path authorization enforces directory boundaries, complete path coverage, and operation types', () => {
  const root = '/workspace/project';
  const matchesRoot = (path: string, roots: string[]) =>
    (roots.length ? roots : [root]).some((r) => inside(r, path));

  const readPolicy: PermissionPolicy = {
    rules: [
      {
        id: 'rule-read',
        effect: 'allow_once',
        operations: ['read'],
        roots: [root],
      },
      {
        id: 'rule-deny-write',
        effect: 'deny',
        operations: ['write', 'delete'],
        roots: [root],
      },
    ],
    fallback: 'ask',
    timeoutMs: null,
  };

  // 子路径与子目录完全命中
  assert.equal(
    decide(readPolicy, { operation: 'read', paths: ['/workspace/project/file.txt'] }, matchesRoot),
    'allow_once',
  );
  assert.equal(
    decide(
      readPolicy,
      { operation: 'read', paths: ['/workspace/project/sub/dir/file.txt'] },
      matchesRoot,
    ),
    'allow_once',
  );

  // 同名前缀目录（/workspace/project-other）严格隔离，不应匹配
  assert.equal(
    decide(
      readPolicy,
      { operation: 'read', paths: ['/workspace/project-other/file.txt'] },
      matchesRoot,
    ),
    'ask',
  );

  // 路径逃逸（.. 越界）不应匹配
  assert.equal(
    decide(
      readPolicy,
      { operation: 'read', paths: ['/workspace/project/../file.txt'] },
      matchesRoot,
    ),
    'ask',
  );

  // 多路径请求：所有路径必须全部合法才放行
  assert.equal(
    decide(
      readPolicy,
      {
        operation: 'read',
        paths: ['/workspace/project/a.txt', '/workspace/project/b.txt'],
      },
      matchesRoot,
    ),
    'allow_once',
  );
  // 其中一条路径越界则不获准
  assert.equal(
    decide(
      readPolicy,
      {
        operation: 'read',
        paths: ['/workspace/project/a.txt', '/etc/passwd'],
      },
      matchesRoot,
    ),
    'ask',
  );

  // 操作类型匹配与拒绝规则
  assert.equal(
    decide(readPolicy, { operation: 'write', paths: ['/workspace/project/file.txt'] }, matchesRoot),
    'deny',
  );
  assert.equal(
    decide(
      readPolicy,
      { operation: 'delete', paths: ['/workspace/project/file.txt'] },
      matchesRoot,
    ),
    'deny',
  );
  // 未声明的操作（如 execute）回退到 ask
  assert.equal(
    decide(
      readPolicy,
      {
        operation: 'execute',
        paths: ['/workspace/project/bin'],
        command: { executable: 'bin', args: [] },
      },
      matchesRoot,
    ),
    'ask',
  );

  // 空路径或 null 操作统一返回 ask
  assert.equal(decide(readPolicy, { operation: 'read', paths: [] }, matchesRoot), 'ask');
  assert.equal(decide(readPolicy, null, matchesRoot), 'ask');
});
