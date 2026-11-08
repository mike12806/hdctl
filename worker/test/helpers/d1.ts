import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

/**
 * D1 for tests: an in-memory SQLite database (which is what D1 is) with the
 * real migrations applied, behind the parts of the D1 API the Worker uses.
 * So the SQL itself is exercised, not a mock of it.
 */

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new Statement(this.db, this.sql, params);
  }

  rows<T>(): T[] {
    return this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r }) as T);
  }

  async all<T>() {
    return { results: this.rows<T>(), success: true, meta: {} };
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params);
    if (!row) return null;
    return (column ? row[column] : { ...row }) as T;
  }

  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export interface TestD1 {
  db: D1Database;
  /** Read the database directly, for assertions. */
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
}

export function testD1(): TestD1 {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
  const db = {
    prepare: (sql: string) => new Statement(sqlite, sql),
    // D1 runs a batch as one transaction.
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN");
      try {
        const out = statements.map((s) => ({ results: s.rows(), success: true, meta: {} }));
        sqlite.exec("COMMIT");
        return out;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
  };
  return {
    db: db as unknown as D1Database,
    query: (sql, ...params) => new Statement(sqlite, sql, params).rows(),
  };
}
