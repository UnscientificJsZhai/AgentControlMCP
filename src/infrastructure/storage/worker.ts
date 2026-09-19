import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import type { RpcRequest, RpcResponse, Transaction } from './protocol.js';
import { AppError, fail } from '../../domain/errors.js';
import { now } from '../../domain/ids.js';

const { path } = workerData as { path: string };
const db = new DatabaseSync(path);
db.exec(
  'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
);
const version = db.prepare('PRAGMA user_version').get()?.user_version;
if (typeof version !== 'number' || version > 1) throw new Error('不支持此数据库格式');
db.exec(`BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
CREATE TABLE IF NOT EXISTS claims(key TEXT PRIMARY KEY, holder TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency(principal TEXT, method TEXT, key TEXT, digest TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(principal,method,key));
CREATE TABLE IF NOT EXISTS streams(id TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS events(stream_id TEXT NOT NULL, seq INTEGER NOT NULL, task_id TEXT, segment_id TEXT, activation_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(stream_id,seq));
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, seq);
CREATE INDEX IF NOT EXISTS events_segment ON events(segment_id, seq);
CREATE TABLE IF NOT EXISTS tombstones(stream_id TEXT NOT NULL, seq INTEGER NOT NULL, task_id TEXT, segment_id TEXT, activation_id TEXT, PRIMARY KEY(stream_id,seq));
PRAGMA user_version=1;
COMMIT;`);

function decode(row: Record<string, unknown> | undefined): unknown {
  return row ? (JSON.parse(row.data as string) as unknown) : null;
}
function transaction(input: Transaction) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const idem = input.idempotency;
    if (idem) {
      const old = db
        .prepare('SELECT digest,response FROM idempotency WHERE principal=? AND method=? AND key=?')
        .get(idem.principal, idem.method, idem.key);
      if (old) {
        if (old.digest !== idem.digest) fail('IDEMPOTENCY_CONFLICT', '幂等标识已用于不同参数。');
        db.exec('COMMIT');
        return { replayed: true, response: JSON.parse(old.response as string) as unknown };
      }
    }
    for (const check of input.checks ?? []) {
      const row = db
        .prepare('SELECT revision FROM records WHERE kind=? AND id=?')
        .get(check.kind, check.id);
      if (
        check.absent
          ? !!row
          : !row || (check.revision !== undefined && row.revision !== check.revision)
      )
        fail('REVISION_CONFLICT', '对象修订已变化。', {
          id: check.id,
          currentRevision: row?.revision,
        });
    }
    for (const limit of input.limits ?? []) {
      const count = db
        .prepare('SELECT count(*) AS n FROM records WHERE kind=? AND json_extract(data,?)=?')
        .get(limit.kind, `$.${limit.path}`, limit.value)?.n;
      if (typeof count === 'number' && count >= limit.max)
        fail('CAPACITY_EXCEEDED', '已达到并发上限。');
    }
    for (const prefix of input.absentClaimPrefixes ?? []) {
      const refs = db
        .prepare('SELECT key,holder FROM claims WHERE substr(key,1,?)=?')
        .all(prefix.length, prefix);
      if (refs.length) fail('OBJECT_IN_USE', '对象仍有活动引用。', { references: refs });
    }
    for (const claim of input.claims ?? []) {
      const previous = db.prepare('SELECT holder FROM claims WHERE key=?').get(claim.key);
      if (
        previous &&
        previous.holder !== claim.holder &&
        !input.releases?.some(
          (release) => release.key === claim.key && release.holder === previous.holder,
        )
      )
        fail('RESOURCE_CONFLICT', '资源已被占用。', { key: claim.key, holder: previous.holder });
    }
    for (const row of input.puts ?? [])
      db.prepare(
        'INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,data=excluded.data',
      ).run(row.kind, row.id, row.revision, JSON.stringify(row.data));
    for (const row of input.deletes ?? [])
      db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(row.kind, row.id);
    for (const claim of input.releases ?? [])
      db.prepare('DELETE FROM claims WHERE key=? AND holder=?').run(claim.key, claim.holder);
    for (const claim of input.claims ?? [])
      db.prepare('INSERT OR IGNORE INTO claims VALUES (?,?)').run(claim.key, claim.holder);
    if (idem)
      db.prepare('INSERT INTO idempotency VALUES (?,?,?,?,?)').run(
        idem.principal,
        idem.method,
        idem.key,
        idem.digest,
        JSON.stringify(idem.response),
      );
    db.exec('COMMIT');
    return { replayed: false, response: idem?.response };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function eventAppend(args: {
  streamId: string;
  taskId?: string;
  segmentId?: string;
  activationId?: string;
  kind: string;
  payload: unknown;
  projection?: Record<string, unknown>;
}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR IGNORE INTO streams(id) VALUES (?)').run(args.streamId);
    db.prepare('UPDATE streams SET seq=seq+1 WHERE id=?').run(args.streamId);
    const seq = db.prepare('SELECT seq FROM streams WHERE id=?').get(args.streamId)?.seq as number;
    const payload = JSON.stringify(args.payload);
    const size = Buffer.byteLength(payload);
    db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)').run(
      args.streamId,
      seq,
      args.taskId ?? null,
      args.segmentId ?? null,
      args.activationId ?? null,
      args.kind,
      payload,
      now(),
      size,
    );
    if (args.segmentId)
      db.prepare(
        "UPDATE records SET revision=revision+1,data=json_set(data,'$.bytes',json_extract(data,'$.bytes')+?,'$.revision',revision+1) WHERE kind='segment' AND id=?",
      ).run(size, args.segmentId);
    if (args.projection) {
      const session = decode(
        db.prepare("SELECT data FROM records WHERE kind='session' AND id=?").get(args.streamId),
      ) as Record<string, unknown> | null;
      if (session) {
        Object.assign(session, args.projection);
        session.revision = Number(session.revision) + 1;
        if ('options' in args.projection || 'modes' in args.projection)
          session.controlVersion = Number(session.controlVersion) + 1;
        db.prepare("UPDATE records SET data=?,revision=? WHERE kind='session' AND id=?").run(
          JSON.stringify(session),
          Number(session.revision),
          args.streamId,
        );
      }
    }
    db.exec('COMMIT');
    return String(seq);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function eventRead(args: {
  streamId: string;
  after: string;
  limit: number;
  taskId?: string;
  segmentId?: string;
  activationId?: string;
}) {
  db.exec('BEGIN');
  try {
    const high =
      (db.prepare('SELECT CAST(seq AS TEXT) AS seq FROM streams WHERE id=?').get(args.streamId)
        ?.seq as string | undefined) ?? '0';
    const where = ['stream_id=?', 'seq>?', 'seq<=?'];
    const values: (string | number)[] = [args.streamId, args.after, high];
    for (const [key, column] of [
      ['taskId', 'task_id'],
      ['segmentId', 'segment_id'],
      ['activationId', 'activation_id'],
    ] as const)
      if (args[key]) {
        where.push(`${column}=?`);
        values.push(args[key]);
      }
    const rows = db
      .prepare(
        `SELECT CAST(seq AS TEXT) AS seq,stream_id AS streamId,task_id AS taskId,segment_id AS segmentId,activation_id AS activationId,kind,payload,created_at AS createdAt,bytes FROM events WHERE ${where.join(' AND ')} ORDER BY events.seq LIMIT ?`,
      )
      .all(...values, args.limit + 1);
    values[2] = rows.length > args.limit ? ((rows[args.limit - 1]?.seq as string) ?? high) : high;
    const missing = db
      .prepare(
        `WITH gaps AS (SELECT seq,seq-row_number() OVER (ORDER BY seq) AS grp FROM tombstones WHERE ${where.join(' AND ')}) SELECT CAST(min(seq) AS TEXT) AS 'from',CAST(max(seq) AS TEXT) AS 'to' FROM gaps GROUP BY grp ORDER BY min(seq)`,
      )
      .all(...values);
    db.exec('COMMIT');
    return {
      items: rows.map((row) => ({ ...row, payload: JSON.parse(row.payload as string) as unknown })),
      missing,
      highWatermark: high,
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function purge(args: {
  taskIds: string[];
  operationIds: string[];
  segmentIds: string[];
  checks: Transaction['checks'];
}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const check of args.checks ?? []) {
      const row = db
        .prepare('SELECT revision FROM records WHERE kind=? AND id=?')
        .get(check.kind, check.id);
      if (!row || row.revision !== check.revision)
        fail('REVISION_CONFLICT', '清理对象已变化，请重新预览。');
    }
    let count = 0;
    for (const [column, ids] of [
      ['task_id', args.taskIds],
      ['stream_id', args.operationIds],
      ['segment_id', args.segmentIds],
    ] as const) {
      for (const id of ids) {
        db.prepare(
          `INSERT OR IGNORE INTO tombstones SELECT stream_id,seq,task_id,segment_id,activation_id FROM events WHERE ${column}=?`,
        ).run(id);
        count += Number(db.prepare(`DELETE FROM events WHERE ${column}=?`).run(id).changes);
      }
    }
    for (const [kind, ids] of [
      ['task', args.taskIds],
      ['operation', args.operationIds],
      ['segment', args.segmentIds],
    ] as const) {
      for (const id of ids)
        db.prepare(
          "UPDATE records SET revision=revision+1,data=json_set(json_remove(data,'$.result','$.error'),'$.purged',json('true'),'$.bytes',0,'$.revision',revision+1) WHERE kind=? AND id=?",
        ).run(kind, id);
    }
    db.exec('COMMIT');
    return { deletedEvents: count };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

parentPort?.on('message', (request: RpcRequest) => {
  const response: RpcResponse = { requestId: request.requestId };
  try {
    const args = request.args as Record<string, unknown>;
    switch (request.method) {
      case 'get':
        response.value = decode(
          db
            .prepare('SELECT data FROM records WHERE kind=? AND id=?')
            .get(args.kind as string, args.id as string),
        );
        break;
      case 'list':
        response.value = db
          .prepare('SELECT data FROM records WHERE kind=? ORDER BY id')
          .all(args.kind as string)
          .map(decode);
        break;
      case 'claim':
        response.value =
          db.prepare('SELECT holder FROM claims WHERE key=?').get(args.key as string)?.holder ??
          null;
        break;
      case 'replay': {
        const previous = db
          .prepare(
            'SELECT digest,response FROM idempotency WHERE principal=? AND method=? AND key=?',
          )
          .get(args.principal as string, args.method as string, args.key as string);
        if (previous && previous.digest !== args.digest)
          fail('IDEMPOTENCY_CONFLICT', '幂等标识已用于不同参数。');
        response.value = previous ? (JSON.parse(previous.response as string) as unknown) : null;
        break;
      }
      case 'commit':
        response.value = transaction(request.args as Transaction);
        break;
      case 'eventAppend':
        response.value = eventAppend(request.args as Parameters<typeof eventAppend>[0]);
        break;
      case 'eventRead':
        response.value = eventRead(request.args as Parameters<typeof eventRead>[0]);
        break;
      case 'purge':
        response.value = purge(request.args as Parameters<typeof purge>[0]);
        break;
      case 'usage':
        response.value = db
          .prepare('SELECT coalesce(sum(bytes),0) AS bytes,count(*) AS events FROM events')
          .get();
        break;
      case 'close':
        db.close();
        response.value = null;
        break;
      default:
        fail('STORAGE_UNAVAILABLE', '未知存储请求。');
    }
  } catch (error) {
    response.error =
      error instanceof AppError
        ? { code: error.code, message: error.message, details: error.details }
        : {
            code: String(error).includes('full') ? 'STORAGE_FULL' : 'STORAGE_UNAVAILABLE',
            message: '存储操作失败。',
            details: {},
          };
  }
  parentPort?.postMessage(response);
});
