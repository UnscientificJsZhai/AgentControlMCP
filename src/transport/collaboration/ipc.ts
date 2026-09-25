import { createServer, connect } from 'node:net';
import type { Server, Socket } from 'node:net';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { z } from 'zod';
import type { McpServer } from '@agentclientprotocol/sdk';
import type { Container } from '../../bootstrap/container.js';
import type { Context, RuntimeRecord, SessionRecord, WorkRecord } from '../../domain/models.js';
import { errorDetail, fail } from '../../domain/errors.js';
import type { TeamRecord } from '../../domain/collaboration.js';
import { collaborationBridge } from '../../domain/collaboration.js';
import { digest, id } from '../../domain/ids.js';
import { createCollaborationTools } from '../mcp/collaboration-tools.js';

export const bindingSchema = z.strictObject({ endpoint: z.string(), token: z.string() });
const requestSchema = z.strictObject({
  token: z.string(),
  name: z.string(),
  arguments: z.unknown().optional(),
});
interface MemberCredential {
  agentId: string;
  teamId: string;
  runtimeId: string;
  generation: number;
  path: string;
}

/** 专用、最小权限的 IPC。凭据不复用管理 nonce，不传递管理员 Context。 */
export class CollaborationIpc {
  private readonly credentials = new Map<string, MemberCredential>();
  private server: Server | undefined;
  private starting: Promise<void> | undefined;
  private readonly sockets = new Set<Socket>();
  readonly endpoint: string;
  constructor(readonly app: Container) {
    this.endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\agentcontrol-collaboration-${app.instanceId}`
        : join(app.paths.runtimeDir, 'collaboration.sock');
  }

  private async start() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const server = createServer((socket) => {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => {});
        socket.setTimeout(35_000, () => socket.destroy());
        const abort = new AbortController();
        socket.on('close', () => abort.abort());
        let length = 0;
        const chunks: Buffer[] = [];
        let handled = false;
        socket.on('data', (chunk: Buffer) => {
          if (handled) return;
          length += chunk.length;
          if (length > 17 * 1024 ** 2) {
            socket.destroy();
            return;
          }
          chunks.push(chunk);
          if (!chunk.includes(10)) return;
          handled = true;
          void (async () => {
            try {
              const request = requestSchema.parse(
                JSON.parse(Buffer.concat(chunks).toString().trim()) as unknown,
              );
              const ctx = await this.authenticate(request.token);
              const data =
                request.name === 'handshake'
                  ? await this.connected(request.token)
                  : await this.call(
                      { ...ctx, signal: abort.signal },
                      request.name,
                      request.arguments,
                    );
              await this.authenticate(request.token);
              socket.end(JSON.stringify({ ok: true, data }) + '\n');
            } catch (error) {
              socket.end(JSON.stringify({ ok: false, error: errorDetail(error) }) + '\n');
            }
          })();
        });
      });
      server.listen(this.endpoint);
      await once(server, 'listening');
      if (process.platform !== 'win32') await chmod(this.endpoint, 0o600);
      this.server = server;
    })();
    return this.starting;
  }

  async bind(ctx: Context, runtime: RuntimeRecord): Promise<McpServer[]> {
    if (!ctx.managedAgentId) return [];
    await this.start();
    const agent = await this.app.collaboration.agent(ctx.managedAgentId);
    await this.revoke(agent.id);
    const token = randomBytes(32).toString('base64url');
    const path = join(this.app.paths.runtimeDir, `member-${agent.id}.json`);
    this.credentials.set(digest(token), {
      agentId: agent.id,
      teamId: agent.teamId,
      runtimeId: runtime.id,
      generation: runtime.connectionGeneration,
      path,
    });
    await writeFile(path, JSON.stringify({ endpoint: this.endpoint, token }), {
      mode: 0o600,
      flag: 'wx',
      flush: true,
    });
    this.app.runtimes.handle(runtime).secrets.push(token);
    return [
      {
        name: collaborationBridge.serverName,
        command: process.execPath,
        args: [
          fileURLToPath(new URL('../../cli/entry.js', import.meta.url)),
          'bridge',
          '--binding',
          path,
        ],
        env: [],
      },
    ];
  }

  /** 凭据随 Runtime 绑定存活；每次请求都重新校验连接代次、成员状态及上游身份。 */
  private async authenticate(token: string): Promise<Context> {
    const credential = this.credentials.get(digest(token));
    if (!credential) fail('UNAUTHENTICATED', '成员绑定不存在或已撤销。');
    const agent = await this.app.collaboration.agent(credential.agentId);
    const runtime = await this.app.store.get<RuntimeRecord>('runtime', credential.runtimeId);
    if (
      !runtime ||
      runtime.state === 'closed' ||
      runtime.connectionGeneration !== credential.generation ||
      ['closing', 'closed'].includes(agent.lifecycle) ||
      !this.app.runtimes.live.has(runtime.id)
    )
      fail('UNAUTHENTICATED', '成员连接已失效。');
    const team = await this.app.store.get<TeamRecord>('collab_team', credential.teamId);
    if (!team || team.instanceId !== this.app.instanceId)
      fail('UNAUTHENTICATED', '团队不属于此实例。');
    const ctx: Context = {
      ...team.context,
      nativeInteraction: false,
      collaborationMember: { agentId: agent.id, teamId: team.id },
    };
    await this.app.identities.check(ctx);
    return ctx;
  }

  private async call(ctx: Context, name: string, args: unknown) {
    const definition = createCollaborationTools(this.app).find((tool) => tool.name === name);
    if (!definition) fail('ACCESS_DENIED', 'Bridge 仅提供协作工具。');
    const member = ctx.collaborationMember!;
    const agent = await this.app.collaboration.agent(member.agentId);
    // 固定调用开始时的任务归属，长等待跨轮次返回时不能记到后续任务。
    const session = agent.sessionId
      ? await this.app.store.get<SessionRecord>('session', agent.sessionId)
      : null;
    const task = session?.activeTaskId
      ? await this.app.store.get<WorkRecord>('task', session.activeTaskId)
      : null;
    const callContext: Context = {
      ...ctx,
      collaborationCall:
        task?.collaboration?.agentId === agent.id
          ? { taskId: task.id, intentId: task.collaboration.intentId }
          : {},
    };
    const callId = id('bridge');
    const record = async (outcome: 'started' | 'succeeded' | 'failed', messageId?: string) => {
      if (!session) return;
      await this.app.events.append(session, 'collaboration_bridge_call', {
        callId,
        tool: `${collaborationBridge.toolPrefix}${name}`,
        outcome,
        ...(messageId ? { messageId } : {}),
      });
    };
    await record('started');
    await this.app.collaboration.storage.serial.run(member.teamId, async () => {
      const agent = await this.app.collaboration.agent(member.agentId);
      if (agent.bridge !== 'used') await this.app.collaboration.update(agent, { bridge: 'used' });
    });
    try {
      const result = await definition.run(callContext, args);
      const messageId = (result as { messageId?: string } | undefined)?.messageId;
      await record('succeeded', messageId);
      return result;
    } catch (error) {
      await record('failed');
      throw error;
    }
  }

  async connected(token: string) {
    const ctx = await this.authenticate(token);
    const member = ctx.collaborationMember!;
    await this.app.collaboration.storage.serial.run(member.teamId, async () => {
      const agent = await this.app.collaboration.agent(member.agentId);
      if (agent.bridge === 'unconnected')
        await this.app.collaboration.update(agent, { bridge: 'connected' });
    });
    const agent = await this.app.collaboration.agent(member.agentId);
    return {
      connected: true,
      channel: collaborationBridge.serverName,
      teamId: agent.teamId,
      agentId: agent.id,
      path: agent.path,
      parentId: agent.parentId,
      rootTarget: '/root',
      configId: agent.configId,
      configRevision: agent.configRevision,
    };
  }

  async revoke(agentId: string) {
    for (const [key, value] of this.credentials)
      if (value.agentId === agentId) {
        this.credentials.delete(key);
        await rm(value.path, { force: true });
      }
  }
  async close() {
    for (const value of [...this.credentials.values()]) await this.revoke(value.agentId);
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}

export async function bridgeRequest(
  binding: z.infer<typeof bindingSchema>,
  name: string,
  args?: unknown,
) {
  return new Promise<unknown>((resolve, reject) => {
    const socket = connect(binding.endpoint);
    let size = 0;
    const chunks: Buffer[] = [];
    socket.setTimeout(35_000, () => socket.destroy(new Error('Bridge 超时')));
    socket.on('error', reject);
    socket.on('connect', () =>
      socket.write(JSON.stringify({ token: binding.token, name, arguments: args }) + '\n'),
    );
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 17 * 1024 ** 2) socket.destroy(new Error('Bridge 响应过大'));
      else chunks.push(chunk);
    });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()) as unknown);
      } catch {
        reject(new Error('Bridge 响应无效'));
      }
    });
  });
}
