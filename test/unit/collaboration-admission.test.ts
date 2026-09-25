import test from 'node:test';
import assert from 'node:assert/strict';
import { CollaborationController } from '../../src/application/collaboration/controller.js';
import type { CollaborationDependencies } from '../../src/application/collaboration/controller.js';
import type { CompletionCriteria } from '../../src/domain/collaboration.js';

const limit = 256;
const profileQuery = new Error('已通过准入并到达 profile 查询');

/**
 * 创建仅用于验证输入准入边界的协作控制器。
 *
 * @remarks
 * 通过准入后立即在配置查询处抛出固定错误，区分输入校验失败与进入后续流程。
 *
 * @returns 禁止写入成员且使用固定字节上限的控制器。
 */
function controller() {
  return new CollaborationController(
    {
      tasks: { sessions: {} },
      settings: {},
      store: {
        replay: () => Promise.resolve(null),
        commit: () => assert.fail('准入用例不能写入成员'),
      },
      availability: { snapshot: () => Promise.reject(profileQuery) },
    } as unknown as CollaborationDependencies,
    limit,
  );
}

for (const criteria of [
  undefined,
  { requiredMessage: { target: '/root', text: '完成："是"\n' } },
] satisfies (CompletionCriteria | undefined)[]) {
  const label = criteria ? 'Message with completion criteria' : 'Message only';
  const overhead = Buffer.byteLength(
    JSON.stringify([
      { type: 'text', text: '' },
      ...(criteria ? [{ type: 'text', text: JSON.stringify(criteria) }] : []),
    ]),
  );
  for (const delta of [-1, 0, 1]) {
    /**
     * 验证准入限制按完整序列化内容的字节数判断。
     *
     * @remarks
     * 覆盖上限前一字节、恰好达到上限和超出一字节，并计入中文与完成条件的转义开销。
     */
    void test(`${label} enforces the serialized byte limit: limit ${delta >= 0 ? '+' : ''}${delta}`, async () => {
      // 中文占三个 UTF-8 字节，不能按 JavaScript 字符数判定；完成条件还包含 JSON 转义。
      const message = '中' + 'x'.repeat(limit - overhead - 3 + delta);
      await assert.rejects(
        controller().spawn(
          { principalId: 'unit', serviceId: 'unit', mode: 'stdio' },
          {
            requestId: 'request',
            taskName: 'boundary',
            message,
            completionCriteria: criteria,
          },
        ),
        delta > 0 ? { code: 'CONFIG_INVALID' } : (error) => error === profileQuery,
      );
    });
  }
}
