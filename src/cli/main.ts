import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Container, defaultDataDir } from '../bootstrap/container.js';
import { startHttp, startStdio, validateHttpOptions } from '../transport/mcp/serve.js';
import { adminCommand } from '../transport/admin/commands.js';
import { adminRequest, startAdmin } from '../transport/admin/ipc.js';
import { SqliteStore } from '../infrastructure/storage/sqlite-store.js';
import { resolveEnvironment } from '../infrastructure/platform/environment.js';
import { which } from '../infrastructure/platform/process-host.js';
import { agentConfig, settingsSchema } from '../domain/schemas.js';
import type { InstanceRecord, InteractionRecord } from '../domain/models.js';
import { AppError, errorDetail, fail } from '../domain/errors.js';
import { id } from '../domain/ids.js';
import { createTools } from '../transport/mcp/tools.js';
import { createMcpTools, describeTool } from '../transport/mcp/catalog.js';

const help = `agent-control-mcp 1.0.0 — 管理宿主机 ACP Agent\n\nserve stdio --client-id <稳定标识>\nserve http --host 127.0.0.1 --port 7331 --auth token|none\nservice instances|status|stop [--instance <id>]\nidentity create --name <名称> | list | rotate --principal <id> | revoke --credential <id>\nconfig validate|apply --file <文档> | edit|export --id <配置> | migrate\nagent / registry / runtime / installation / session / task / operation / permission / interaction / history / content <子命令>\nlocal scan codex | plan --file <参数> | apply --file <已确认方案>\ninteraction attach --instance <id> （宿主交互终端）\ncall <完整工具名> --input '<JSON>' 或 --file <JSON 文件>\ntools （输出全部 CLI 操作及参数 Schema）\ntools --mcp （输出实际公开的 MCP 工具及参数 Schema）\n\n全局选项：--data-dir <目录> --instance <id> --json --no-wait\n复杂输入使用 --file；写操作自动生成幂等键，也可显式传 --idempotency-key。\n运行态命令须连接存活实例；身份/配置/安装命令也可离线运行。\n`;
const flags = new Set(['json', 'help', 'no-wait', 'interactive', 'yes', 'mcp']);

/** 将位置参数与选项分开；复杂结构交给 --file/--input 的 JSON 和具体工具 Schema 校验。 */
function parse(argv: string[]) {
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const [key, inline] = value.slice(2).split('=', 2);
    if (flags.has(key!)) options[key!] = true;
    else {
      const next = inline ?? argv[++index];
      if (next === undefined || next.startsWith('--'))
        fail('CONFIG_INVALID', `选项 --${key!} 缺少值。`);
      options[key!] = next;
    }
  }
  return { positional, options };
}

const unwrap = (value: unknown): unknown => {
  const record = value as {
    ok?: boolean;
    data?: unknown;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
  if (record?.ok === false)
    throw new AppError(record.error!.code, record.error!.message, record.error!.details);
  return record?.ok === true ? record.data : value;
};
const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

/** 统一处理服务启动、本地管理与工具调用；优先通过 IPC 使用已有实例中的活动资源。 */
export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--version')) {
    process.stdout.write('1.0.0\n');
    return;
  }
  const { positional, options } = parse(argv);
  const [group, sub, extra] = positional;
  if (!group || options.help || group === 'help') {
    process.stdout.write(help);
    return;
  }
  if (group === '--version' || group === 'version') {
    process.stdout.write('1.0.0\n');
    return;
  }
  const dataDir = resolve(String(options['data-dir'] ?? defaultDataDir()));
  if (group === 'serve') {
    if (sub !== 'stdio' && sub !== 'http') fail('CONFIG_INVALID', '请选择 stdio 或 http。');
    const requestedHttp = {
      host: String(options.host ?? '127.0.0.1'),
      port: Number(options.port ?? 7331),
      noAuth: options.auth === 'none',
    };
    if (sub === 'http') {
      if (options.auth !== undefined && options.auth !== 'none' && options.auth !== 'token')
        fail('CONFIG_INVALID', '--auth 仅支持 token 或 none。');
      validateHttpOptions(requestedHttp);
    }
    const settings = options.settings
      ? settingsSchema.parse(
          JSON.parse(await readFile(String(options.settings), 'utf8')) as unknown,
        )
      : undefined;
    const app = await Container.create({ dataDir, mode: sub, ...(settings ? { settings } : {}) });
    const stop = () => {
      void app.close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await startAdmin(app);
      if (sub === 'stdio') startStdio(app, String(options['client-id'] ?? 'default'));
      else {
        const http = {
          host: String(options.host ?? app.settings.httpHost),
          port: Number(options.port ?? app.settings.httpPort),
          noAuth: (options.auth ?? app.settings.httpAuth) === 'none',
        };
        const endpoint = await startHttp(app, http);
        process.stderr.write(
          JSON.stringify({ listening: endpoint.url, instanceId: app.instanceId }) + '\n',
        );
      }
    } catch (error) {
      await app.close();
      throw error;
    }
    return;
  }
  // 目录构造不会访问容器，可在没有数据目录或运行实例时输出工具 Schema。
  if (group === 'tools') {
    output(
      options.mcp
        ? createMcpTools({} as Container).map(describeTool)
        : createTools({} as Container).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: z.toJSONSchema(tool.schema),
          })),
    );
    return;
  }
  await mkdir(join(dataDir, 'state'), { recursive: true, mode: 0o700 });
  const store = await SqliteStore.open(join(dataDir, 'state/state.db'));
  let instances: InstanceRecord[];
  try {
    instances = (await store.list<InstanceRecord>('instance')).filter((instance) => {
      if (instance.state !== 'active') return false;
      try {
        process.kill(instance.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
      }
    });
  } finally {
    await store.close();
  }
  // 默认优先选择 HTTP 服务；多个 stdio 实例并存时不能猜测目标，需明确指定。
  const instance = options.instance
    ? instances.find((item) => item.id === options.instance)
    : (instances.find((item) => item.mode === 'http') ??
      (instances.length === 1 ? instances[0] : undefined));
  if (options.instance && !instance) fail('INSTANCE_UNAVAILABLE', '指定实例不存在或已退出。');
  if (group === 'service' && (sub === 'instances' || sub === 'status')) {
    output(instances.map(({ nonce: _nonce, ...item }) => item));
    return;
  }
  if (group === 'interaction' && sub === 'attach') {
    if (!instance) fail('INSTANCE_UNAVAILABLE', '请用 --instance 指定存活实例。');
    await attach(instance);
    return;
  }
  let app: Container | undefined;
  const call = async (name: string, args: unknown) =>
    unwrap(
      instance
        ? (await adminRequest(instance, name, args)).data
        : await adminCommand(app!, name, args),
    );
  const aliases: Record<string, string> = {
    'service.stop': '_stop',
    'identity.create': '_identity_create',
    'identity.list': '_identity_list',
    'identity.rotate': '_identity_rotate',
    'identity.revoke': '_identity_revoke',
    'registry.sources': 'registry_list_sources',
    'registry.get': 'registry_get_agent',
    'session.options': 'session_get_options',
    'agent.auth': 'agent_authenticate',
    'local.scan': 'local_agent_scan',
    'local.plan': 'local_agent_plan',
    'local.apply': 'local_agent_apply',
    'doctor.': 'connector_diagnose',
    'recovery.inspect': '_recovery_inspect',
    'recovery.adopt-session': '_recovery_adopt',
    'recovery.resolve': '_recovery_resolve',
  };
  if (group === 'call' && sub?.startsWith('_')) fail('CONFIG_INVALID', 'call 只接受公开工具名。');
  let name =
    group === 'call'
      ? sub!
      : group === 'config'
        ? `_config_${sub!}`
        : (aliases[`${group}.${sub ?? ''}`] ?? `${group}_${sub ?? ''}`.replaceAll('-', '_'));
  const args: Record<string, unknown> =
    options.file && group !== 'config'
      ? z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(await readFile(String(options.file), 'utf8')) as unknown)
      : options.input
        ? z.record(z.string(), z.unknown()).parse(JSON.parse(String(options.input)) as unknown)
        : {};
  // 人用短选项映射为协议字段；完整 JSON 输入则直接沿用工具契约。
  const keyAliases: Record<string, string> = {
    config: 'configId',
    runtime: 'runtimeId',
    session: 'sessionId',
    task: 'taskId',
    operation: 'operationId',
    revision: 'expectedRevision',
    generation: 'expectedConnectionGeneration',
    'runtime-revision': 'expectedRuntimeRevision',
    principal: 'principalId',
    credential: 'credentialId',
    plan: 'planId',
    digest: 'planDigest',
  };
  const globals = new Set([
    'data-dir',
    'instance',
    'json',
    'no-wait',
    'file',
    'input',
    'interactive',
    'yes',
  ]);
  for (const [key, value] of Object.entries(options))
    if (!globals.has(key)) {
      const field =
        keyAliases[key] ?? key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      args[field] =
        value === 'true'
          ? true
          : value === 'false'
            ? false
            : typeof value === 'string' && /^\d+$/.test(value)
              ? Number(value)
              : value;
    }
  if (group === 'config') {
    if (options.file) args.file = options.file;
    if (args.id) {
      args.configId = args.id;
      delete args.id;
    }
  }
  if (name === 'local_agent_scan') args.adapter = extra ?? 'codex';
  if (name === 'agent_register' && !args.config && args.name) {
    const config = { ...args };
    for (const key of Object.keys(args)) delete args[key];
    args.config = config;
  }
  if (options.interactive) args.interactionChannel = 'local_cli';
  // 单次 CLI 写调用默认取得新幂等键；跨进程重试需要用户复用显式提供的键。
  const definition = createTools({} as Container).find((item) => item.name === name);
  if (
    definition &&
    JSON.stringify(z.toJSONSchema(definition.schema)).includes('idempotencyKey') &&
    !args.idempotencyKey
  )
    args.idempotencyKey = id('cli');
  if (
    !instance &&
    /^(runtime_|session_create|session_load|session_resume|agent_authenticate|task_submit)/.test(
      name,
    )
  )
    fail(
      'INSTANCE_UNAVAILABLE',
      '运行态操作需要存活服务，请先启动 serve http，再指定 --instance。',
    );
  let attached: { data: unknown; close: () => void } | undefined;
  try {
    if (!instance) app = await Container.create({ dataDir, mode: 'cli' });
    if (options.interactive) {
      if (!process.stdin.isTTY || !process.stdout.isTTY || !instance)
        fail('INTERACTION_CHANNEL_UNAVAILABLE', '--interactive 需要宿主真实终端和存活实例。');
      attached = await adminRequest(instance, '', {}, true);
    }
    if (group === 'config' && sub === 'migrate') {
      output({
        schemaVersion: 1,
        migrated: false,
        message: '当前格式无需迁移；未知版本会拒绝打开。',
      });
      return;
    }
    if (group === 'config' && sub === 'edit') {
      const exported = (await call('_config_edit', args)) as { path: string };
      const editor = await which(process.env.EDITOR ?? 'vi');
      const child = spawn(editor, [exported.path], { stdio: 'inherit', shell: false });
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0 ? resolve() : reject(new Error('编辑器未成功退出')),
        );
      });
      name = '_config_apply';
      args.file = exported.path;
      delete args.configId;
    }
    if (name === 'local_agent_apply' && !options.yes) {
      if (!process.stdin.isTTY) fail('CONFIRMATION_REQUIRED', '请审阅方案后通过 --yes 明确应用。');
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const answer = await rl.question(
        `应用方案 ${String(args.planId)}，摘要 ${String(args.planDigest)}？输入 yes：`,
      );
      rl.close();
      if (answer !== 'yes') fail('CANCELLED', '已取消应用。');
    }
    if (['_recovery_adopt', '_recovery_resolve'].includes(name) && !options.yes)
      fail(
        'CONFIRMATION_REQUIRED',
        '请先审阅 recovery inspect 及目标参数，再通过 --yes 显式认领或处置。',
      );
    if (name === 'interaction_present' && instance) {
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        fail('INTERACTION_CHANNEL_UNAVAILABLE', 'present 需要真实终端。');
      attached ??= await adminRequest(instance, '', {}, true);
      const item = (await call('_interaction_get', args)) as InteractionRecord;
      await presentOne(
        instance,
        item,
        (attached.data as { presentationSession: string }).presentationSession,
      );
      output({ presented: true, interactionId: item.id });
      return;
    }
    let response = await call(name, args);
    const op = response as { operationId?: string; state?: string; revision?: number };
    // 默认等待耗时操作；缺少真实交互附着时返回 waiting_interaction，让用户决定下一步。
    if (op.operationId && !options['no-wait']) {
      for (;;) {
        response = await call('operation_wait', { operationId: op.operationId, timeoutMs: 1000 });
        const current = response as {
          state: string;
          error?: { code: string; message: string };
          result?: unknown;
        };
        if (current.state === 'waiting_interaction' && options.interactive && instance)
          await presentPending(
            instance,
            (attached!.data as { presentationSession: string }).presentationSession,
          );
        else if (
          ['completed', 'failed', 'cancelled', 'interrupted', 'waiting_interaction'].includes(
            current.state,
          )
        ) {
          if (current.error) throw new AppError(current.error.code, current.error.message);
          break;
        }
      }
    }
    output(response);
  } finally {
    attached?.close();
    await app?.close();
  }
}

async function presentPending(instance: InstanceRecord, presentationSession: string) {
  const response = unwrap(
    (await adminRequest(instance, 'interaction_list', { state: 'pending' })).data,
  ) as { items: InteractionRecord[] };
  for (const item of response.items) await presentOne(instance, item, presentationSession);
}

/** 在真实终端展示请求并收集输入，通过附着凭证取得收据后再提交答复。 */
async function presentOne(
  instance: InstanceRecord,
  item: InteractionRecord,
  presentationSession: string,
) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    fail('INTERACTION_CHANNEL_UNAVAILABLE', '用户交互需要真实终端。');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let decision: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> } = {
    action: 'decline',
  };
  try {
    process.stderr.write(
      JSON.stringify(
        { interactionId: item.id, runtimeId: item.runtimeId, request: item.request },
        null,
        2,
      ) + '\n',
    );
    if ((await rl.question('审阅上述请求。接受请输入 yes，其余输入拒绝：')) !== 'yes')
      decision = { action: 'decline' };
    else if (item.type === 'form') {
      const raw = await rl.question('输入表单 JSON：');
      const content = z.record(z.string(), z.unknown()).parse(JSON.parse(raw) as unknown);
      z.fromJSONSchema(
        item.request.requestedSchema as Parameters<typeof z.fromJSONSchema>[0],
      ).parse(content);
      decision = { action: 'accept', content };
    } else if (item.type === 'url') {
      await rl.question('请在浏览器完成上方 URL 的交互，完成后按回车：');
      decision = { action: 'accept' };
    } else if (item.type === 'terminal_auth') {
      // 认证子进程继承终端，参数保持 argv 数组；退出码由认证服务决定是否可以重建连接。
      rl.close();
      const config = agentConfig.parse(item.request.snapshot);
      const method = item.request.method as { args?: string[]; env?: Record<string, string> };
      const runtime = unwrap(
        (await adminRequest(instance, 'runtime_get', { runtimeId: item.runtimeId })).data,
      ) as { launchSnapshot: z.output<typeof agentConfig> };
      let executable: string;
      let prefixArgs: string[] = [];
      let defaults: Record<string, string> = {};
      if (runtime.launchSnapshot.launch.kind === 'command') {
        executable = runtime.launchSnapshot.launch.executable;
        prefixArgs = runtime.launchSnapshot.launch.args;
      } else {
        const installs = unwrap((await adminRequest(instance, 'installation_list', {})).data) as {
          items: {
            id: string;
            executable: string;
            prefixArgs: string[];
            args: string[];
            env: Record<string, string>;
          }[];
        };
        const found = installs.items.find(
          (value) =>
            value.id ===
            (runtime.launchSnapshot.launch as { installationId: string }).installationId,
        );
        if (!found) fail('CONFIG_INVALID', '认证安装缺失。');
        executable = found.executable;
        prefixArgs = [...found.prefixArgs, ...(runtime.launchSnapshot.launch.args ?? found.args)];
        defaults = found.env;
      }
      const resolved = await resolveEnvironment(config.environment, defaults);
      const child = spawn(
        await which(executable, resolved.env),
        [...prefixArgs, ...(method.args ?? [])],
        {
          cwd: String(item.request.cwd),
          env: { ...resolved.env, ...method.env },
          stdio: 'inherit',
          shell: false,
        },
      );
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      });
      decision = { action: 'accept', content: { exitCode } };
    }
  } finally {
    rl.close();
  }
  const receipt =
    decision.action === 'accept'
      ? ((
          await adminRequest(
            instance,
            '_present_receipt',
            { interactionId: item.id, response: decision },
            false,
            presentationSession,
          )
        ).data as { presentationReceipt: string })
      : {};
  unwrap(
    (
      await adminRequest(instance, 'interaction_respond', {
        interactionId: item.id,
        expectedRevision: item.revision,
        idempotencyKey: id('cli'),
        ...decision,
        ...receipt,
      })
    ).data,
  );
}

/** 持有一个附着连接并轮询交互；Ctrl-C 只结束附着，不停止被管理的服务实例。 */
async function attach(instance: InstanceRecord) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    fail('INTERACTION_CHANNEL_UNAVAILABLE', 'attach 需要真实宿主终端。');
  const attachment = await adminRequest(instance, '', {}, true);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.stderr.write(`已连接宿主实例 ${instance.id}；Ctrl-C 结束交互附着。\n`);
  try {
    while (!abort.signal.aborted) {
      await presentPending(
        instance,
        (attachment.data as { presentationSession: string }).presentationSession,
      );
      await delay(500, undefined, { signal: abort.signal }).catch(() => {});
    }
  } finally {
    attachment.close();
    process.removeListener('SIGINT', stop);
  }
}

/** 错误统一写 stderr，避免污染 stdio MCP 输出；区分输入错误、用户取消和执行失败退出码。 */
export function reportFailure(error: unknown) {
  const detail = errorDetail(error);
  process.stderr.write(JSON.stringify({ ok: false, error: detail }) + '\n');
  process.exitCode = detail.code === 'CONFIG_INVALID' ? 2 : detail.code === 'CANCELLED' ? 130 : 1;
}
