import { Readable, Writable } from 'node:stream';
import { existsSync, watch, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { agent, ndJsonStream, methods } from '@agentclientprotocol/sdk';

const [gate, evidence, form] = process.argv.slice(2);
const waitForGate = () =>
  new Promise((resolve) => {
    if (!gate || existsSync(gate)) return resolve();
    const watcher = watch(dirname(gate), () => {
      if (existsSync(gate)) {
        watcher.close();
        resolve();
      }
    });
    if (existsSync(gate)) {
      watcher.close();
      resolve();
    }
  });
// 写入无凭证的进程证据，供断连、幂等和崩溃恢复的真实进程断言使用。
writeFileSync(evidence + '.pid', String(process.pid));
agent()
  .onRequest(methods.agent.initialize, ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentCapabilities: { loadSession: false },
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, () => ({ sessionId: 'fixture-session' }))
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    writeFileSync(evidence, 'accepted');
    await waitForGate();
    if (form)
      await client.request('elicitation/create', {
        sessionId: params.sessionId,
        mode: 'form',
        message: 'Fixture form',
        requestedSchema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
        },
      });
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '中文🙂:completed' },
      },
    });
    return {
      stopReason: gate && readFileSync(gate, 'utf8') === 'cancelled' ? 'cancelled' : 'end_turn',
    };
  })
  .onNotification(methods.agent.session.cancel, () => {
    if (gate) writeFileSync(gate, 'cancelled');
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
