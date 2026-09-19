import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { settingsSchema } from '../domain/schemas.js';
import type { Settings } from '../domain/schemas.js';
import type { SqliteStore } from '../infrastructure/storage/sqlite-store.js';
import { row } from '../infrastructure/storage/sqlite-store.js';
import { fail } from '../domain/errors.js';
import { id } from '../domain/ids.js';

interface ConnectorMeta {
  id: string;
  revision: number;
  createdAt: string;
  serviceId: string;
  cursorKey: string;
  settings: Settings;
}
export const connectorDocument = z.strictObject({
  schemaVersion: z.literal(1),
  documentId: z.literal('connector'),
  kind: z.literal('connector'),
  revision: z.number().int().positive(),
  value: settingsSchema,
});

export class SettingsService {
  constructor(
    readonly store: SqliteStore,
    readonly dataDir: string,
  ) {}
  async document() {
    const meta = (await this.store.get<ConnectorMeta>('meta', 'connector'))!;
    return {
      schemaVersion: 1 as const,
      documentId: 'connector' as const,
      kind: 'connector' as const,
      revision: meta.revision,
      value: meta.settings,
    };
  }
  async export(overwrite = false) {
    const path = join(this.dataDir, 'config/connector.json');
    await mkdir(join(this.dataDir, 'config'), { recursive: true, mode: 0o700 });
    const content = JSON.stringify(await this.document(), null, 2) + '\n';
    if (!overwrite) {
      try {
        await writeFile(path, content, { mode: 0o600, flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } else {
      const temp = `${path}.${id('tmp')}`;
      await writeFile(temp, content, { mode: 0o600 });
      await rename(temp, path);
    }
    return { path };
  }
  async apply(input: unknown) {
    const doc = connectorDocument.parse(input);
    const meta = (await this.store.get<ConnectorMeta>('meta', 'connector'))!;
    if (
      doc.value.httpAuth === 'none' &&
      (!['127.0.0.1', '::1', 'localhost'].includes(doc.value.httpHost) || doc.value.externalProxy)
    )
      fail('CONFIG_INVALID', '匿名 HTTP 仅允许直接回环访问。');
    await this.store.commit({
      checks: [{ kind: 'meta', id: 'connector', revision: doc.revision }],
      puts: [row('meta', { ...meta, revision: meta.revision + 1, settings: doc.value })],
    });
    return {
      documentId: 'connector',
      revision: meta.revision + 1,
      applied: true,
      restartRequired: true,
    };
  }
}
