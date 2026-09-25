import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { npmLaunch, npmShimCommand } from '../../src/infrastructure/installers/npm-entry.js';

const script = '/with spaces/entry.cjs';

/**
 * 验证 env shebang 保留 Node 解释器参数与带空格的参数。
 *
 * @remarks
 * 引号包围的参数必须保持为单个参数，脚本路径应追加在解释器参数之后。
 */
void test('npm env shebangs preserve interpreter arguments and arguments containing spaces', () => {
  assert.deepEqual(
    npmLaunch(script, '#!/usr/bin/env -S node --expose-gc --require "./with spaces/init.cjs"\n'),
    {
      executable: process.execPath,
      prefixArgs: ['--expose-gc', '--require', './with spaces/init.cjs', script],
    },
  );
});

/**
 * 验证 Windows 下的 Node shebang 使用当前解释器并保留参数。
 *
 * @remarks
 * 类 Unix 解释器路径仅用于识别 Node，实际可执行文件应为当前 Node 路径。
 */
void test('Windows Node shebangs preserve interpreter arguments', () => {
  assert.deepEqual(npmLaunch(script, '#!/usr/bin/node --expose-gc\n', 'win32'), {
    executable: process.execPath,
    prefixArgs: ['--expose-gc', script],
  });
});

/**
 * 验证 Windows 原生程序使用原路径直接启动。
 *
 * @remarks
 * 带空格的可执行文件路径不得拆分，也无需增加 Node 前置参数。
 */
void test('Windows native executables launch directly', () => {
  assert.deepEqual(npmLaunch('C:\\with spaces\\agent.exe', 'MZ', 'win32'), {
    executable: 'C:\\with spaces\\agent.exe',
    prefixArgs: [],
  });
});

/**
 * 验证没有 shebang 的 JavaScript 入口仍通过 Node 启动。
 *
 * @remarks
 * 脚本路径应作为唯一前置参数传入当前解释器。
 */
void test('JavaScript entries without a shebang launch with Node', () => {
  assert.deepEqual(npmLaunch(script, 'console.log(1)', 'win32'), {
    executable: process.execPath,
    prefixArgs: [script],
  });
});

/**
 * 验证 Windows 批处理入口不能被误当作原生可执行程序。
 *
 * @remarks
 * 不受支持的入口类型必须明确失败，不能隐式交给命令解释器执行。
 */
void test('Windows cmd entries cannot launch as native executables', () => {
  assert.throws(() => npmLaunch('agent.cmd', '@echo off', 'win32'), {
    code: 'PLATFORM_UNSUPPORTED',
  });
});

for (const header of [
  '#!/usr/bin/env -u HOME node\n',
  '#!/usr/bin/env -S node --require $BOOTSTRAP\n',
  '#!/usr/bin/env -S node "unclosed',
]) {
  /**
   * 验证不安全或语法不完整的 shebang 被拒绝。
   *
   * @remarks
   * 覆盖 env 环境修改选项、变量展开和未闭合引号，避免产生含糊的启动参数。
   */
  void test('Unsafe or incomplete shebangs are rejected: ' + header.trim(), () => {
    assert.throws(() => npmLaunch(script, header), { code: 'CONFIG_INVALID' });
  });
}

for (const prefix of ['%~dp0', '%~dp0\\', '%dp0%\\']) {
  /**
   * 验证 Windows npm shim 的常见目录前缀均解析到 npm 脚本入口。
   *
   * @remarks
   * 带空格和 Shell 特殊字符的用户参数必须作为字面参数完整保留。
   */
  void test('Windows npm shims resolve directory prefixes: ' + prefix, () => {
    const root = resolve('with spaces');
    const args = ['--prefix', 'path with spaces', '& echo literal'];
    assert.deepEqual(
      npmShimCommand(
        join(root, 'npm.cmd'),
        '@echo off\n"' + prefix + 'node_modules\\npm\\bin\\npm-cli.js" %*\n',
        args,
      ),
      {
        executable: process.execPath,
        args: [join(root, 'node_modules/npm/bin/npm-cli.js'), ...args],
      },
    );
  });
}

/**
 * 验证 npm shim 解析能够识别 npx 脚本入口。
 *
 * @remarks
 * 解析结果应使用当前 Node 执行 shim 目录下的 npx 脚本。
 */
void test('npm shims recognize npx entry points', () => {
  const root = resolve('shim');
  assert.deepEqual(
    npmShimCommand(join(root, 'npx.cmd'), '"%dp0%\\node_modules\\npm\\bin\\npx-cli.js" %*', []),
    {
      executable: process.execPath,
      args: [join(root, 'node_modules/npm/bin/npx-cli.js')],
    },
  );
});

/**
 * 验证任意批处理内容不能伪装成受支持的 npm shim。
 *
 * @remarks
 * 无法识别合法脚本入口时应返回配置错误。
 */
void test('npm shims reject arbitrary cmd content', () => {
  assert.throws(() => npmShimCommand('unsafe.cmd', '@echo off\necho unsafe', []), {
    code: 'CONFIG_INVALID',
  });
});
