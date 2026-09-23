import type { WorkRecord } from '../../domain/models.js';
import type { EventService } from '../event-service.js';

/** 只汇总本轮可见回答；思考、工具输出及 load 历史段不进入协作结果。 */
export async function collectResult(events: EventService, work: WorkRecord, objectId: string) {
  const blocks: unknown[] = [];
  let text = '';
  let after = '0';
  let contentComplete = work.outputComplete !== false;
  if (work.sessionId && work.kind === 'task') {
    for (;;) {
      const page = await events.store.readEvents({
        streamId: work.sessionId,
        taskId: work.id,
        after,
        limit: 500,
      });
      if (page.missing.length) contentComplete = false;
      const selected = page.items.slice(0, 500);
      for (const item of selected) {
        if (item.kind !== 'agent_message_chunk') continue;
        let payload = item.payload as {
          representation?: string;
          contentId?: string;
          content?: { type: string; text?: string };
        };
        if (payload.representation === 'resource' && payload.contentId) {
          try {
            const chunks: Buffer[] = [];
            let offset = 0;
            for (;;) {
              const chunk = await events.content(work.id, payload.contentId, offset, 256 * 1024);
              chunks.push(Buffer.from(chunk.data, 'base64'));
              if (chunk.eof) break;
              offset = chunk.nextOffset;
            }
            payload = JSON.parse(Buffer.concat(chunks).toString()) as typeof payload;
          } catch (error) {
            if (
              !['ENOENT', 'CONTENT_UNAVAILABLE'].includes(
                (error as { code?: string }).code ?? '',
              ) &&
              !(error instanceof SyntaxError)
            )
              throw error;
            // 缺失或损坏的历史正文不应让整个完成通知永远卡在 outbox。
            contentComplete = false;
            continue;
          }
        }
        if (payload.content?.type === 'text') text += payload.content.text ?? '';
        else if (payload.content) blocks.push(payload.content);
      }
      if (page.items.length <= 500) break;
      after = selected.at(-1)!.seq;
    }
  }
  const result = await events.externalize(objectId, {
    kind: 'assistant_output',
    text,
    ...(blocks.length ? { content: blocks } : {}),
    contentComplete,
    ...(work.sessionId ? { source: { sessionId: work.sessionId, taskId: work.id } } : {}),
  });
  return { ...(result as Record<string, unknown>), contentComplete };
}
