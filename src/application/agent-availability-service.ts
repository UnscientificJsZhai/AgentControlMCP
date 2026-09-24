import { access, stat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, delimiter, resolve, join } from 'node:path';
import { fingerprint } from '../adapters/local/codex.js';
import { AppError, errorDetail, fail } from '../domain/errors.js';
import type { ErrorDetail } from '../domain/errors.js';
import type { ConfigRecord, Context, InstallationRecord } from '../domain/models.js';
import type { ManagedAgentRecord, TeamRecord } from '../domain/collaboration.js';
import type { AgentConfig } from '../domain/schemas.js';
import type { SqliteStore } from '../infrastructure/storage/sqlite-store.js';
import { resolveEnvironment } from '../infrastructure/platform/environment.js';
import { which } from '../infrastructure/platform/process-host.js';
import { platformKey } from '../infrastructure/installers/installer.js';
import { Serial } from './common.js';

export type AgentAvailability = { ready: true } | { ready: false; reason: ErrorDetail };
export type AgentToolPhase = 'bootstrap' | 'ready' | 'recovery';
export interface AgentAvailabilitySnapshot {
  profiles: { record: ConfigRecord; availability: AgentAvailability }[];
  installations: InstallationRecord[];
  /** 只用于按身份派生目录，不将其他团队的归属暴露给调用者。 */
  recordOwners: string[];
}

const runners = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'uv', 'uvx']);
const wrappers = new Set(['env', 'cmd', 'powershell', 'pwsh', 'xargs', 'sudo', 'su', 'doas']);
const executableName = (path: string) =>
  basename(path)
    .toLowerCase()
    .replace(/\.(exe|com|cmd)$/, '');

async function file(path: string, executable = false) {
  if (!(await stat(path)).isFile()) fail('LOCAL_EXECUTABLE_UNAVAILABLE', '启动入口不是文件。');
  await access(path, executable ? constants.X_OK : constants.R_OK);
}

/** 解释器本身不代表 Agent 已安装；只接受能定位到本地脚本的启动方式。 */
function scriptArgument(args: string[], interpreter: string) {
  if (['bun', 'deno'].includes(interpreter) && args[0] === 'run') args = args.slice(1);
  const takesValue = new Set([
    '-r',
    '--require',
    '--import',
    '--loader',
    '--experimental-loader',
    '--conditions',
    '-C',
    '--inspect-port',
    '--input-type',
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (
      ['-e', '--eval', '-p', '--print', '-c', '-m', '-Command', '-EncodedCommand'].includes(arg) ||
      /^(--eval|--print)=|^-[epc].+/.test(arg)
    )
      return undefined;
    if (arg === '--') return args[i + 1];
    if (takesValue.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

/** 无网络、无子进程的启动前检查；不把本地文件可用等同于 ACP/认证成功。 */
export class AgentAvailabilityService {
  private readonly listeners = new Set<() => void>();
  private readonly serial = new Serial();
  private timer: NodeJS.Timeout | undefined;
  private signature: string | undefined;
  private polling = false;
  private closed = false;

  constructor(readonly store: SqliteStore) {}

  async inspect(
    config: AgentConfig,
    configId?: string,
    installations?: InstallationRecord[],
  ): Promise<AgentAvailability> {
    try {
      if (!config.enabled) fail('AGENT_DISABLED', '此 profile 已停用。');
      const launch = config.launch;
      const installation =
        launch.kind === 'installation'
          ? (installations ?? (await this.store.list<InstallationRecord>('installation'))).find(
              (item) => item.id === launch.installationId,
            )
          : undefined;
      if (launch.kind === 'installation' && installation?.state !== 'ready')
        fail('INSTALLATION_UNAVAILABLE', '引用的安装不存在或尚未 ready。');
      if (installation && installation.platform !== platformKey())
        fail('PLATFORM_UNSUPPORTED', '安装产物不适用于当前平台。');
      const { env } = await resolveEnvironment(config.environment, installation?.env);
      if (installation?.binDir) env.PATH = `${installation.binDir}${delimiter}${env.PATH ?? ''}`;
      const command = launch.kind === 'command' ? launch.executable : installation!.executable;
      const executable = await which(command, env);
      await file(executable, true);
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable))
        fail(
          'LOCAL_EXECUTABLE_UNAVAILABLE',
          '此 Windows shim 不能直接启动，请配置 node 与本地 Agent 脚本入口。',
        );
      // 真实路径只用于分类，不替换启动路径，以免破坏 Python 虚拟环境识别。
      const names = [executableName(executable), executableName(await realpath(executable))];
      const name = names.find((value) =>
        /^(node(?:js)?|python(?:\d+(?:\.\d+)*)?|bash|sh|zsh|fish|bun|deno)$/.test(value),
      );
      if (names.some((value) => runners.has(value) || /^(npm-cli|npx-cli)\.js$/.test(value)))
        fail('AGENT_INSTALL_REQUIRED', '包运行器不代表 Agent 已安装；请使用已落地入口或明确安装。');
      if (names.some((value) => wrappers.has(value)))
        fail(
          'LOCAL_EXECUTABLE_UNAVAILABLE',
          '不能从命令包装器确认 Agent 已安装，请直接配置本地程序或脚本入口。',
        );
      const args = [
        ...(installation?.prefixArgs ?? []),
        ...(launch.args ?? installation?.args ?? []),
      ];
      if (name) {
        const script = scriptArgument(args, name);
        if (!script || script === '-' || /^(npm-cli|npx-cli)\.js$/.test(basename(script)))
          fail('LOCAL_EXECUTABLE_UNAVAILABLE', '需要明确的本地 Agent 脚本入口，不能仅提供解释器。');
        const path = resolve(config.cwd ?? process.cwd(), script);
        await file(path);
        if (
          [executableName(path), executableName(await realpath(path))].some(
            (value) =>
              runners.has(value) || /^(npm|npx|pnpm|pnpx|yarn)(-cli)?\.[cm]?js$/.test(value),
          )
        )
          fail('AGENT_INSTALL_REQUIRED', '解释器参数指向包运行器，请改用已安装的 Agent 入口。');
      }
      if (installation) {
        await file(join(installation.path, 'installation.json'));
        if (installation.distribution === 'npx' && installation.prefixArgs.length)
          await file(installation.prefixArgs.at(-1)!);
        if (installation.distribution === 'uvx' && installation.binDir)
          await file(
            join(installation.binDir, process.platform === 'win32' ? 'python.exe' : 'python'),
            true,
          );
      }
      if ('CODEX_PATH' in env) {
        const path = env.CODEX_PATH;
        if (!path) fail('LOCAL_EXECUTABLE_UNAVAILABLE', '绑定的 CODEX_PATH 无法解析。');
        await file(path, true);
        const binding = configId
          ? await this.store.get<{ candidate: { path: string; fingerprint: string } }>(
              'local_binding',
              configId,
            )
          : null;
        if (
          binding?.candidate.path === path &&
          (await fingerprint(path)) !== binding.candidate.fingerprint
        )
          fail('LOCAL_EXECUTABLE_UNAVAILABLE', '绑定的 Codex 文件已变化，请重新生成复用方案。');
      }
      return { ready: true };
    } catch (error) {
      return {
        ready: false,
        reason: errorDetail(
          error instanceof AppError
            ? error
            : new AppError(
                'LOCAL_EXECUTABLE_UNAVAILABLE',
                '启动文件或已知依赖不存在、不可读或不可执行。',
              ),
        ),
      };
    }
  }

  async snapshot(): Promise<AgentAvailabilitySnapshot> {
    const [records, installations, teams, agents] = await Promise.all([
      this.store.list<ConfigRecord>('config'),
      this.store.list<InstallationRecord>('installation'),
      this.store.list<TeamRecord>('collab_team'),
      this.store.list<ManagedAgentRecord>('collab_agent'),
    ]);
    const teamIds = new Set(agents.map((agent) => agent.teamId));
    return {
      profiles: await Promise.all(
        records.map(async (record) => ({
          record,
          availability: await this.inspect(record.config, record.id, installations),
        })),
      ),
      installations,
      recordOwners: [
        ...new Set(teams.filter((team) => teamIds.has(team.id)).map((team) => team.ownerId)),
      ].sort(),
    };
  }

  phase(ctx: Context, snapshot: AgentAvailabilitySnapshot): AgentToolPhase {
    if (snapshot.profiles.some((profile) => profile.availability.ready)) return 'ready';
    return snapshot.recordOwners.some((owner) => ctx.admin || owner === ctx.principalId)
      ? 'recovery'
      : 'bootstrap';
  }

  /** 轮询只比较影响工具集合的投影，增添第二个可用 profile 不产生目录通知。 */
  refresh() {
    return this.serial.run('availability', async () => {
      if (this.closed) return;
      const snapshot = await this.snapshot();
      const signature = JSON.stringify(
        snapshot.profiles.some((item) => item.availability.ready)
          ? ['ready']
          : ['unavailable', snapshot.recordOwners],
      );
      const changed = this.signature !== undefined && this.signature !== signature;
      this.signature = signature;
      if (changed)
        for (const listener of this.listeners) {
          try {
            listener();
          } catch {
            /* 一个连接失效不能阻止其他观察者刷新。 */
          }
        }
    });
  }

  async observe(listener: () => void) {
    await this.refresh();
    if (this.closed) return () => {};
    this.listeners.add(listener);
    this.timer ??= setInterval(() => {
      if (this.polling) return;
      this.polling = true;
      void this.refresh()
        .catch(() => {})
        .finally(() => {
          this.polling = false;
        });
    }, 1000);
    this.timer.unref();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.listeners.clear();
    await this.serial.run('availability', async () => {});
  }
}
