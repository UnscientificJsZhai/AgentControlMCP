import { createInterface } from 'node:readline';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

type RpcId = string | number;
interface RpcMessage {
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
}
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}
interface FixtureSession {
  sessionId: string;
  cwd: string;
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), '需要对象');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  assert.ok(typeof value === 'string', '需要字符串');
  return value;
}
function parseMessage(line: string): RpcMessage {
  const value = object(JSON.parse(line) as unknown);
  assert.ok(
    value.id === undefined || typeof value.id === 'string' || typeof value.id === 'number',
    '无效的 JSON-RPC 标识',
  );
  if (value.method !== undefined) string(value.method);
  if (value.params !== undefined) object(value.params);
  if (value.error !== undefined) string(object(value.error).message);
  return value;
}

// 独立 JSON-RPC 对端：不复用被测连接器的 ACP 客户端或领域实现。
const input = createInterface({ input: process.stdin });
let authenticated = process.env.FIXTURE_REQUIRE_AUTH !== '1';
let nextId = 0;
let option: boolean | string = false;
const pending = new Map<RpcId, PendingRequest>();
const prompts = new Map<string, AbortController>();
const sessions = new Map<string, FixtureSession>();
const audit = async (message: Record<string, unknown>) => {
  if (process.env.FIXTURE_AUDIT)
    await appendFile(
      process.env.FIXTURE_AUDIT,
      JSON.stringify({ pid: process.pid, ...message }) + '\n',
    );
};
const send = (value: Record<string, unknown>) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const callback = (method: string, params: Record<string, unknown>) => {
  void audit({ callback: method });
  return new Promise<unknown>((resolve, reject) => {
    const id = `agent:${++nextId}`;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
};
const update = (sessionId: string, value: Record<string, unknown>) =>
  send({ method: 'session/update', params: { sessionId, update: value } });
const options = () => [
  { id: 'thinking', name: '思考', type: 'boolean', currentValue: option },
  {
    id: 'model',
    name: '模型',
    type: 'select',
    currentValue: 'small',
    options: [
      { value: 'small', name: '小' },
      { value: 'large', name: '大' },
    ],
  },
];
const modes = {
  currentModeId: 'ask',
  availableModes: [
    { id: 'ask', name: '询问' },
    { id: 'code', name: '编写' },
  ],
};
const state = () => ({ configOptions: options(), modes });
async function save(id: string, cwd: string) {
  const value: FixtureSession = { sessionId: id, cwd };
  sessions.set(id, value);
  await writeFile(join(cwd, `.fixture-${id}.json`), JSON.stringify(value));
}
async function handle(message: RpcMessage) {
  if (!message.method) {
    await audit({ callbackResult: message });
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request?.reject(new Error(message.error.message));
    else request?.resolve(message.result);
    return;
  }
  await audit({ method: message.method, params: message.params });
  const params = message.params ?? {};
  let result: Record<string, unknown> = {};
  switch (message.method) {
    case 'initialize':
      if (process.env.FIXTURE_INIT_DELAY) await delay(Number(process.env.FIXTURE_INIT_DELAY));
      result = {
        protocolVersion: 1,
        agentInfo: { name: 'independent-fixture', version: '1.0.0' },
        authMethods: [
          { id: 'memory', name: '连接内认证' },
          ...(object(object(params.clientCapabilities ?? {}).auth ?? {}).terminal
            ? [{ id: 'terminal', name: '交互终端认证', type: 'terminal', args: ['--login'] }]
            : []),
        ],
        agentCapabilities: process.env.FIXTURE_NO_CAPS
          ? {}
          : {
              loadSession: true,
              auth: { logout: {} },
              promptCapabilities: { image: true, audio: true, embeddedContext: true },
              mcpCapabilities: { http: true, sse: true },
              sessionCapabilities: {
                list: {},
                delete: {},
                close: {},
                resume: {},
                additionalDirectories: {},
              },
            },
      };
      break;
    case 'authenticate':
      if (params.methodId !== 'memory') throw new Error('unsupported auth');
      if (process.env.FIXTURE_AUTH_DELAY) await delay(Number(process.env.FIXTURE_AUTH_DELAY));
      authenticated = true;
      break;
    case 'logout':
      authenticated = false;
      break;
    case 'session/new':
      if (!authenticated) {
        send({ id: message.id, error: { code: -32000, message: 'Authentication required' } });
        return;
      }
      {
        const id = randomUUID();
        await save(id, string(params.cwd));
        result = { sessionId: id, ...state() };
      }
      break;
    case 'session/load':
    case 'session/resume': {
      if (!authenticated) {
        send({ id: message.id, error: { code: -32000, message: 'Authentication required' } });
        return;
      }
      const sessionId = string(params.sessionId);
      const saved = object(
        JSON.parse(
          await readFile(join(string(params.cwd), `.fixture-${sessionId}.json`), 'utf8'),
        ) as unknown,
      );
      sessions.set(sessionId, { sessionId: string(saved.sessionId), cwd: string(saved.cwd) });
      if (message.method === 'session/load')
        for (let index = 0; index < 4; index++)
          update(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '历史重放' },
          });
      result = state();
      break;
    }
    case 'session/list':
      result = { sessions: [...sessions.values()] };
      break;
    case 'session/delete':
      sessions.delete(string(params.sessionId));
      break;
    case 'session/close':
      prompts.get(string(params.sessionId))?.abort();
      break;
    case 'session/set_mode':
      if (process.env.FIXTURE_CONTROL_DELAY) await delay(Number(process.env.FIXTURE_CONTROL_DELAY));
      modes.currentModeId = string(params.modeId);
      update(string(params.sessionId), {
        sessionUpdate: 'current_mode_update',
        currentModeId: params.modeId,
      });
      break;
    case 'session/set_config_option':
      assert.ok(typeof params.value === 'boolean' || typeof params.value === 'string');
      option = params.value;
      update(string(params.sessionId), {
        sessionUpdate: 'config_option_update',
        configOptions: options(),
      });
      result = { configOptions: options() };
      break;
    case 'session/cancel':
      if (!process.env.FIXTURE_IGNORE_CANCEL) prompts.get(string(params.sessionId))?.abort();
      return;
    case '$/cancel_request':
      return;
    case 'session/prompt': {
      const sessionId = string(params.sessionId);
      const abort = new AbortController();
      prompts.set(sessionId, abort);
      assert.ok(Array.isArray(params.prompt), 'prompt 必须是内容块数组');
      const text = (params.prompt as unknown[])
        .map(object)
        .filter((block) => block.type === 'text')
        .map((block) => string(block.text))
        .join('');
      const cwd = sessions.get(sessionId)?.cwd ?? process.cwd();
      if (text.includes('tree')) {
        const child = spawn(
          process.execPath,
          ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'],
          { stdio: 'ignore' },
        );
        await audit({ grandchildPid: child.pid });
      }
      for (const kind of ['user_message_chunk', 'agent_thought_chunk', 'agent_message_chunk'])
        update(sessionId, {
          sessionUpdate: kind,
          content: {
            type: 'text',
            text: kind === 'agent_message_chunk' ? `fixture:${text}` : '过程',
          },
        });
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: '读取',
        kind: 'read',
        status: 'in_progress',
      });
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
      });
      update(sessionId, {
        sessionUpdate: 'plan',
        entries: [{ content: '完成任务', priority: 'medium', status: 'completed' }],
      });
      update(sessionId, {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'fixture', description: '测试命令' }],
      });
      update(sessionId, {
        sessionUpdate: 'current_mode_update',
        currentModeId: modes.currentModeId,
      });
      update(sessionId, { sessionUpdate: 'config_option_update', configOptions: options() });
      update(sessionId, { sessionUpdate: 'session_info_update', title: '独立验收' });
      update(sessionId, { sessionUpdate: 'usage_update', used: 12, size: 1000 });
      if (text.includes('permission'))
        await callback('session/request_permission', {
          sessionId,
          toolCall: {
            toolCallId: 'approval-1',
            title: '写入文件',
            kind: 'edit',
            status: 'pending',
            locations: [{ path: join(cwd, 'result.txt') }],
          },
          options: [
            { optionId: 'once', kind: 'allow_once', name: '仅一次' },
            { optionId: 'always', kind: 'allow_always', name: '始终' },
            { optionId: 'no', kind: 'reject_once', name: '拒绝' },
          ],
        });
      if (text.includes('read-auto'))
        await callback('session/request_permission', {
          sessionId,
          toolCall: {
            toolCallId: 'read-1',
            title: '读取文件',
            kind: 'read',
            status: 'pending',
            locations: [{ path: join(cwd, 'input.txt') }],
          },
          options: [{ optionId: 'once', kind: 'allow_once', name: '仅一次' }],
        });
      if (text.includes('files')) {
        const value = object(
          await callback('fs/read_text_file', {
            sessionId,
            path: join(cwd, 'input.txt'),
          }),
        );
        await callback('fs/write_text_file', {
          sessionId,
          path: join(cwd, 'output.txt'),
          content: string(value.content),
        });
      }
      if (text.includes('terminal')) {
        const terminal = object(
          await callback('terminal/create', {
            sessionId,
            command: process.execPath,
            args: ['-e', 'console.log("terminal-ok")'],
            cwd,
            outputByteLimit: 100,
          }),
        );
        const terminalId = string(terminal.terminalId);
        await callback('terminal/wait_for_exit', { sessionId, terminalId });
        const value = object(await callback('terminal/output', { sessionId, terminalId }));
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: string(value.output) },
        });
        await callback('terminal/kill', { sessionId, terminalId });
        await callback('terminal/release', { sessionId, terminalId });
      }
      if (text.includes('form'))
        await callback('elicitation/create', {
          sessionId,
          mode: 'form',
          message: '测试表单',
          requestedSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        });
      if (text.includes('url')) {
        await callback('elicitation/create', {
          sessionId,
          mode: 'url',
          message: '测试 URL',
          url: 'https://example.com/approval',
          elicitationId: 'url-1',
        });
        send({ method: 'elicitation/complete', params: { elicitationId: 'url-1' } });
      }
      if (text.includes('large'))
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '大'.repeat(50000) },
        });
      if (text.includes('crash')) process.exit(21);
      await delay(text.includes('slow') || text.includes('tree') ? 60000 : 20, undefined, {
        signal: abort.signal,
      }).catch(() => {});
      prompts.delete(sessionId);
      result = { stopReason: abort.signal.aborted ? 'cancelled' : 'end_turn' };
      break;
    }
    default:
      if ('id' in message)
        send({ id: message.id, error: { code: -32601, message: 'Unsupported method' } });
      return;
  }
  if ('id' in message) send({ id: message.id, result });
}
input.on('line', (line) => {
  let message: RpcMessage;
  try {
    message = parseMessage(line);
  } catch {
    return;
  }
  void handle(message).catch((error: unknown) => {
    send({
      id: message.id,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    });
  });
});
if (process.argv.includes('--login')) {
  console.error('fixture terminal login');
  process.exit(0);
}
