import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { StreamRecord } from './stream/types';

export interface CreateStreamInput {
  name: string;
  rtsp_url: string;
  rtmp_url: string;
  enabled?: boolean;
}

export interface UpdateStreamInput {
  name?: string;
  rtsp_url?: string;
  rtmp_url?: string;
  enabled?: boolean;
}

export class StreamDatabase {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS streams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        rtsp_url TEXT NOT NULL,
        rtmp_url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  listStreams(): StreamRecord[] {
    return this.db
      .prepare(
        'SELECT id, name, rtsp_url, rtmp_url, enabled, created_at, updated_at FROM streams ORDER BY created_at DESC',
      )
      .all() as unknown as StreamRecord[];
  }

  getStream(id: string): StreamRecord | null {
    const row = this.db
      .prepare('SELECT id, name, rtsp_url, rtmp_url, enabled, created_at, updated_at FROM streams WHERE id = ?')
      .get(id) as unknown as StreamRecord | undefined;
    return row ?? null;
  }

  createStream(input: CreateStreamInput): StreamRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    const enabled = input.enabled === false ? 0 : 1;

    this.db
      .prepare(
        `INSERT INTO streams (id, name, rtsp_url, rtmp_url, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name.trim(), input.rtsp_url.trim(), input.rtmp_url.trim(), enabled, now, now);

    const created = this.getStream(id);
    if (!created) {
      throw new Error('Failed to load created stream');
    }
    return created;
  }

  updateStream(id: string, input: UpdateStreamInput): StreamRecord | null {
    const existing = this.getStream(id);
    if (!existing) {
      return null;
    }

    const nextName = input.name !== undefined ? input.name.trim() : existing.name;
    const nextRtsp = input.rtsp_url !== undefined ? input.rtsp_url.trim() : existing.rtsp_url;
    const nextRtmp = input.rtmp_url !== undefined ? input.rtmp_url.trim() : existing.rtmp_url;
    const nextEnabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE streams
         SET name = ?, rtsp_url = ?, rtmp_url = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(nextName, nextRtsp, nextRtmp, nextEnabled, now, id);

    return this.getStream(id);
  }

  deleteStream(id: string): boolean {
    const result = this.db.prepare('DELETE FROM streams WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}
