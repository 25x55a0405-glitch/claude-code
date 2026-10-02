import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Storage is one SQLite file. Most records are JSON documents keyed by id,
 * because a single person's agent holds thousands of rows, not millions,
 * and the shapes are owned by web/src/api/types.ts. Activity and steps get
 * real columns because they are append-only and paged.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS docs (
  kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, private TEXT,
  PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS steps (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS steps_task ON steps (task_id, seq);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages (conversation_id, seq);
CREATE TABLE IF NOT EXISTS team_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, to_star TEXT NOT NULL, from_star TEXT NOT NULL, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL
);
`;

export type Kind = 'task' | 'approval' | 'conversation' | 'memory' | 'connection' | 'rule' | 'briefing' | 'run' | 'idea' | 'star' | 'provider' | 'skill' | 'lesson' | 'secret' | 'push';

export class Db {
  sql: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.sql.exec(SCHEMA);
  }

  // ---- key/value --------------------------------------------------------

  getKv<T>(key: string): T | undefined {
    const row = this.sql.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setKv(key: string, value: unknown) {
    this.sql.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  // ---- documents --------------------------------------------------------

  get<T>(kind: Kind, id: string): T | undefined {
    const row = this.sql.prepare('SELECT data FROM docs WHERE kind = ? AND id = ?').get(kind, id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  all<T>(kind: Kind): T[] {
    const rows = this.sql.prepare('SELECT data FROM docs WHERE kind = ? ORDER BY rowid').all(kind) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  put<T extends { id: string }>(kind: Kind, doc: T): T {
    this.sql.prepare(
      'INSERT INTO docs (kind, id, data) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data',
    ).run(kind, doc.id, JSON.stringify(doc));
    return doc;
  }

  delete(kind: Kind, id: string): boolean {
    return this.sql.prepare('DELETE FROM docs WHERE kind = ? AND id = ?').run(kind, id).changes > 0;
  }

  /** Server-only data attached to a document (tokens, pending tool calls). Never sent to the UI. */
  getPrivate<T>(kind: Kind, id: string): T | undefined {
    const row = this.sql.prepare('SELECT private FROM docs WHERE kind = ? AND id = ?').get(kind, id) as { private: string | null } | undefined;
    return row?.private ? (JSON.parse(row.private) as T) : undefined;
  }

  setPrivate(kind: Kind, id: string, value: unknown) {
    this.sql.prepare('UPDATE docs SET private = ? WHERE kind = ? AND id = ?')
      .run(value === undefined ? null : JSON.stringify(value), kind, id);
  }

  transaction<T>(fn: () => T): T {
    this.sql.exec('BEGIN');
    try {
      const out = fn();
      this.sql.exec('COMMIT');
      return out;
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
  }

  close() {
    this.sql.close();
  }
}
