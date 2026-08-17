/**
 * Run several statements as one transaction (see src-tauri/src/sqltx.rs).
 *
 * `@tauri-apps/plugin-sql` gives you a connection *pool* dressed as a handle:
 * each `db.execute()` borrows whichever connection is free at the time. So
 * `execute("BEGIN")` … `execute("COMMIT")` is not a transaction — the writes in
 * between land on whatever connection they get, and once one of them lands
 * inside the still-open transaction, that connection holds SQLite's write lock
 * while the next statement on a different connection waits out the busy timeout
 * and fails with `(code: 5) database is locked`. The half-open transaction then
 * goes back into the pool and keeps the lock for the rest of the session.
 *
 * The Rust side opens a private connection instead. Use this — never a hand-
 * written BEGIN — whenever a group of writes has to land together.
 */

import { invoke } from "@tauri-apps/api/core";

/** A parameterized statement: `?` placeholders bound positionally. */
export interface SqlStatement {
  sql: string;
  values: unknown[];
}

/**
 * Apply `statements` in order, all or nothing, to the database at `dbPath`.
 *
 * `dbPath` is checked against the same path scope the `fs_*` commands use, so
 * it has to be one of this app's own databases. An empty batch is a no-op
 * rather than an empty transaction.
 */
export async function sqlTransaction(dbPath: string, statements: SqlStatement[]): Promise<void> {
  if (statements.length === 0) return;
  await invoke("sqlite_transaction", { dbPath, statements });
}
