import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { digest, id, now } from '../../domain/ids.js';
import { fail } from '../../domain/errors.js';
import { resolveEnvironment } from '../../infrastructure/platform/environment.js';
import { runCommand } from '../../infrastructure/platform/process-host.js';

export interface LocalCandidate {
  id: string;
  revision: number;
  createdAt: string;
  path: string;
  aliases: string[];
  fingerprint: string;
  version: string | null;
  probeStatus: 'available' | 'failed';
  compatibility: 'unknown' | 'verified' | 'incompatible';
  evidence: string;
}
export async function fingerprint(path: string) {
  try {
    const actual = await realpath(path);
    const info = await stat(actual);
    if (!info.isFile()) fail('LOCAL_EXECUTABLE_UNAVAILABLE', '候选不是普通文件。');
    await access(actual, constants.X_OK);
    return digest({
      path: actual,
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtime: info.mtimeMs,
    });
  } catch {
    return fail(
      'LOCAL_EXECUTABLE_UNAVAILABLE',
      '绑定的本地可执行文件不存在或不可执行，请重新扫描；原配置不会自动回退。',
    );
  }
}
export async function scanCodex(paths: string[] = []): Promise<LocalCandidate[]> {
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'];
  const roots = [
    ...(process.env.PATH ?? '').split(delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    join(homedir(), '.local/bin'),
    join(homedir(), '.npm-global/bin'),
    '/Applications/Codex.app/Contents/Resources',
    ...(process.platform === 'win32'
      ? [
          join(process.env.APPDATA ?? '', 'npm'),
          join(process.env.LOCALAPPDATA ?? '', 'Microsoft/WinGet/Links'),
          join(homedir(), 'scoop/shims'),
        ]
      : []),
  ];
  const candidates = new Map<string, LocalCandidate>();
  const { env } = await resolveEnvironment({ values: {}, inherit: [] });
  for (const path of new Set([
    ...paths,
    ...roots.flatMap((root) => names.map((name) => join(root, name))),
  ])) {
    let actual: string;
    let identity: string;
    try {
      actual = await realpath(path);
      identity = await fingerprint(actual);
    } catch {
      continue;
    }
    const old = candidates.get(identity);
    if (old) {
      old.aliases.push(path);
      continue;
    }
    let version: string | null = null;
    let status: LocalCandidate['probeStatus'] = 'available';
    try {
      version = (
        await runCommand(
          { executable: actual, args: ['--version'], cwd: homedir(), env },
          { timeoutMs: 3000, maxBytes: 4096 },
        )
      ).trim();
    } catch {
      status = 'failed';
    }
    candidates.set(identity, {
      id: id('candidate'),
      revision: 1,
      createdAt: now(),
      path: actual,
      aliases: [path],
      fingerprint: identity,
      version,
      probeStatus: status,
      compatibility: status === 'failed' || /\.cmd$/i.test(actual) ? 'incompatible' : 'unknown',
      evidence:
        status === 'available'
          ? '已通过有时限的版本探测；尚未以此 Codex/Adapter 组合完成真实任务。'
          : '版本探测失败，不可绑定此候选。',
    });
  }
  return [...candidates.values()];
}
