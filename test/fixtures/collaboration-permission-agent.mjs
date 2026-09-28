import { Readable, Writable } from 'node:stream';
import { existsSync, watch } from 'node:fs';
import { dirname } from 'node:path';
import { agent, ndJsonStream, methods } from '@agentclientprotocol/sdk';

const gatePath = process.argv[2];
const waitForGate = () =>
  new Promise((resolve) => {
    if (!gatePath || existsSync(gatePath)) return resolve();
    const watcher = watch(dirname(gatePath), () => {
      if (existsSync(gatePath)) {
        watcher.close();
        resolve();
      }
    });
    if (existsSync(gatePath)) {
      watcher.close();
      resolve();
    }
  });

// 固定 ACP 响应端：提示轮次等待真实连接上的权限答复后才结束。
agent()
  .onRequest(methods.agent.initialize, ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentCapabilities: { loadSession: false },
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, () => ({ sessionId: 'fixture-session' }))
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    await waitForGate();
    const permission = await client.request(methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: 'fixture-permission',
        title: 'Fixture operation',
        kind: 'execute',
        status: 'pending',
        content: [],
      },
      options: [
        { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
      ],
    });
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `fixture:${permission.outcome.outcome}` },
      },
    });
    return { stopReason: 'end_turn' };
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
