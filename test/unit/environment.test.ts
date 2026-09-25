import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEnvironment,
  parseEnvFile,
  redact,
} from '../../src/infrastructure/platform/environment.js';

/**
 * 验证 env 文件按字面值解析，并拒绝无效键和未闭合引号。
 *
 * @remarks
 * Shell 表达式、行内井号和空值应原样保留，解析过程不能执行命令替换。
 */
void test('Env parsing preserves shell expressions and literals while rejecting invalid keys and quotes', () => {
  assert.deepEqual(
    parseEnvFile(
      '# 注释\r\nKEY="$(touch /tmp/never)"\r\nSECOND=value # literal\nEMPTY=\nSINGLE=\'quoted value\'\n',
    ),
    { KEY: '$(touch /tmp/never)', SECOND: 'value # literal', EMPTY: '', SINGLE: 'quoted value' },
  );
  for (const source of ['invalid line', '1KEY=value', 'KEY="unclosed'])
    assert.throws(() => parseEnvFile(source), { code: 'CONFIG_INVALID' });
});

/**
 * 验证环境配置的覆盖顺序、显式继承和缺失引用错误。
 *
 * @remarks
 * 未授权的宿主变量不能泄露到启动环境，继承及引用的值应加入脱敏列表。
 */
void test('Environment resolution enforces precedence, explicit inheritance, and missing-reference errors', async () => {
  const value = await resolveEnvironment(
    {
      values: {
        TEST: { kind: 'literal', value: 'configured' },
        TOKEN: { kind: 'host_env', name: 'TOKEN' },
      },
      inherit: ['EXPLICIT'],
    },
    { TEST: 'default' },
    { TEST: 'host', TOKEN: 'secret', EXPLICIT: 'inherited', HIDDEN: 'private' },
  );
  assert.deepEqual(value.env, { TEST: 'configured', TOKEN: 'secret', EXPLICIT: 'inherited' });
  assert.deepEqual(value.secrets, ['secret', 'inherited']);
  await assert.rejects(
    resolveEnvironment(
      { values: { TEST: { kind: 'host_env', name: 'ABSENT' } }, inherit: [] },
      {},
      {},
    ),
    { code: 'ENV_REFERENCE_UNRESOLVED' },
  );
});

/**
 * 验证嵌套对象和数组中的秘密按长度优先进行脱敏。
 *
 * @remarks
 * 重叠秘密必须先替换较长值，以免留下后缀，同时保留不相关内容。
 */
void test('Nested redaction matches longer secrets first and preserves unrelated values', () => {
  assert.deepEqual(
    redact({ headers: { auth: 'Bearer secret-token' }, values: ['secret', 'safe'] }, [
      'secret',
      'secret-token',
    ]),
    { headers: { auth: 'Bearer [REDACTED]' }, values: ['[REDACTED]', 'safe'] },
  );
});
