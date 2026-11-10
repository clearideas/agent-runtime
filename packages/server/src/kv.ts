/**
 * Key-value stores for server state: the conversation ledger, the media
 * index, and the retention queue. Values are strings (JSON) and every entry
 * has a time to live.
 */
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { KeyValueStoreConfig } from "./config.js";

export interface KeyValueStore {
  get(namespace: string, key: string): Promise<string | undefined>;
  set(
    namespace: string,
    key: string,
    value: string,
    ttlMs: number,
  ): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
  /**
   * Remove and return up to `limit` expired entries of a namespace. Used for
   * queues whose expiry triggers work, such as run retention.
   */
  takeExpired(
    namespace: string,
    limit: number,
  ): Promise<Array<{ key: string; value: string }>>;
  close?(): void | Promise<void>;
}

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

/**
 * A bounded in-process store. Expired entries are removed when read or
 * taken; the least recently used entries are evicted above `maxEntries`.
 */
export class MemoryKeyValueStore implements KeyValueStore {
  readonly #entries = new Map<string, MemoryEntry>();
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: { maxEntries?: number; now?: () => number } = {}) {
    this.#maxEntries = options.maxEntries ?? 100_000;
    this.#now = options.now ?? Date.now;
  }

  async get(namespace: string, key: string): Promise<string | undefined> {
    const id = `${namespace}\u0000${key}`;
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(id);
      return undefined;
    }
    // Refresh recency.
    this.#entries.delete(id);
    this.#entries.set(id, entry);
    return entry.value;
  }

  async set(
    namespace: string,
    key: string,
    value: string,
    ttlMs: number,
  ): Promise<void> {
    const id = `${namespace}\u0000${key}`;
    this.#entries.delete(id);
    this.#entries.set(id, { value, expiresAt: this.#now() + ttlMs });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  async delete(namespace: string, key: string): Promise<void> {
    this.#entries.delete(`${namespace}\u0000${key}`);
  }

  async takeExpired(
    namespace: string,
    limit: number,
  ): Promise<Array<{ key: string; value: string }>> {
    const now = this.#now();
    const prefix = `${namespace}\u0000`;
    const taken: Array<{ key: string; value: string }> = [];
    for (const [id, entry] of this.#entries) {
      if (taken.length >= limit) break;
      if (!id.startsWith(prefix) || entry.expiresAt > now) continue;
      this.#entries.delete(id);
      taken.push({ key: id.slice(prefix.length), value: entry.value });
    }
    return taken;
  }
}

interface SqliteStatement {
  run(...values: unknown[]): unknown;
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/** A durable single-node store in one SQLite file (owner-only permissions). */
export class SqliteKeyValueStore implements KeyValueStore {
  readonly #database: SqliteDatabase;
  readonly #now: () => number;

  private constructor(database: SqliteDatabase, now: () => number) {
    this.#database = database;
    this.#now = now;
    this.#database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS agent_runtime_server_kv (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, key)
      );
      CREATE INDEX IF NOT EXISTS agent_runtime_server_kv_expiry
        ON agent_runtime_server_kv(namespace, expires_at);
    `);
  }

  static async open(
    filename: string,
    options: { now?: () => number } = {},
  ): Promise<SqliteKeyValueStore> {
    // node:sqlite is loaded only when a SQLite store is configured.
    const { DatabaseSync } = await import("node:sqlite");
    let database: SqliteDatabase;
    if (filename === ":memory:") {
      database = new DatabaseSync(filename) as unknown as SqliteDatabase;
    } else {
      const resolved = path.resolve(filename);
      mkdirSync(path.dirname(resolved), { recursive: true });
      database = new DatabaseSync(resolved) as unknown as SqliteDatabase;
      chmodSync(resolved, 0o600);
      database.exec("PRAGMA journal_mode = WAL;");
    }
    return new SqliteKeyValueStore(database, options.now ?? Date.now);
  }

  async get(namespace: string, key: string): Promise<string | undefined> {
    const row = this.#database
      .prepare(
        "SELECT value FROM agent_runtime_server_kv WHERE namespace = ? AND key = ? AND expires_at > ?",
      )
      .get(namespace, key, this.#now()) as { value: string } | undefined;
    return row?.value;
  }

  async set(
    namespace: string,
    key: string,
    value: string,
    ttlMs: number,
  ): Promise<void> {
    this.#database
      .prepare(
        `INSERT INTO agent_runtime_server_kv (namespace, key, value, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (namespace, key) DO UPDATE
         SET value = excluded.value, expires_at = excluded.expires_at`,
      )
      .run(namespace, key, value, this.#now() + ttlMs);
  }

  async delete(namespace: string, key: string): Promise<void> {
    this.#database
      .prepare(
        "DELETE FROM agent_runtime_server_kv WHERE namespace = ? AND key = ?",
      )
      .run(namespace, key);
  }

  async takeExpired(
    namespace: string,
    limit: number,
  ): Promise<Array<{ key: string; value: string }>> {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#database
        .prepare(
          `SELECT key, value FROM agent_runtime_server_kv
           WHERE namespace = ? AND expires_at <= ?
           ORDER BY expires_at LIMIT ?`,
        )
        .all(namespace, this.#now(), limit) as Array<{
        key: string;
        value: string;
      }>;
      const remove = this.#database.prepare(
        "DELETE FROM agent_runtime_server_kv WHERE namespace = ? AND key = ?",
      );
      for (const row of rows) remove.run(namespace, row.key);
      this.#database.exec("COMMIT");
      return rows.map((row) => ({ key: row.key, value: row.value }));
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }
}

/** Open a configured store. */
export const openKeyValueStore = async (
  config: KeyValueStoreConfig,
): Promise<KeyValueStore> =>
  config.driver === "sqlite"
    ? SqliteKeyValueStore.open(config.path)
    : new MemoryKeyValueStore({ maxEntries: config.maxEntries });
