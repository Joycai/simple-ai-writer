//! One SQL transaction, on one connection.
//!
//! `tauri-plugin-sql` hands the frontend a *pool*, not a connection: every
//! `db.execute()` borrows whichever connection happens to be free, and sqlx
//! returns it to the pool from a spawned task *after* the call resolves — so
//! the next statement frequently opens a second connection rather than reusing
//! the first. `BEGIN` / … / `COMMIT` issued as separate `execute` calls
//! therefore does not describe one transaction. The `BEGIN` lands on connection
//! A; the writes land on A or B by luck; and the moment a write does land inside
//! A's still-open transaction, A holds SQLite's write lock while every later
//! statement that got B waits out the busy timeout and fails with
//! `error returned from database: (code: 5) database is locked`.
//!
//! The damage outlives the failure, too: sqlx's on-release check is a ping, not
//! a rollback, so A goes back into the pool mid-transaction and keeps the write
//! lock until the app restarts — every later config write can fail the same way.
//!
//! This command is the missing piece. It opens a private connection for the
//! duration of one transaction and closes it after, so BEGIN/COMMIT/ROLLBACK
//! mean what they say and nothing half-finished can be left in the shared pool.
//! It grants the webview no new reach — the webview already runs arbitrary SQL
//! through the plugin — but the database file still has to pass `FsScope`, which
//! keeps it to this app's own databases (app data dir + registered project
//! roots).

use crate::scope::FsScope;
use serde::Deserialize;
use serde_json::Value as JsonValue;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, SqliteConnection};
use std::path::Path;
use std::time::Duration;
use tauri::{command, State};

/// One parameterized statement. `values` are bound positionally, with the same
/// JSON→SQLite mapping `tauri-plugin-sql` uses, so a statement behaves
/// identically whether it runs here or through the plugin.
#[derive(Deserialize)]
pub struct SqlStatement {
    pub sql: String,
    #[serde(default)]
    pub values: Vec<JsonValue>,
}

/// How long to wait for another connection's write lock before giving up.
/// Longer than sqlx's 5s default because the pool this contends with does
/// background writes of its own (preferences), and the caller here is a
/// user-initiated restore that is worth waiting for.
const BUSY_TIMEOUT: Duration = Duration::from_secs(10);

/// Run `statements` in order inside a single transaction against `db_path`.
///
/// All-or-nothing: the first failure aborts and rolls back, and the error is
/// returned verbatim. `BEGIN IMMEDIATE` takes the write lock up front rather
/// than on the first write, so a busy database fails before any of the batch
/// has been applied instead of half way through it.
#[command]
pub async fn sqlite_transaction(
    scope: State<'_, FsScope>,
    db_path: String,
    statements: Vec<SqlStatement>,
) -> Result<(), String> {
    scope.check(&db_path)?;
    if !Path::new(&db_path).is_file() {
        return Err(format!("No such database: {db_path}"));
    }
    if statements.is_empty() {
        return Ok(());
    }

    // `create_if_missing` stays off deliberately: the databases this runs
    // against are created by whoever owns their schema, and silently
    // conjuring an empty one would turn a wrong path into a mystery rather
    // than an error.
    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(false)
        .busy_timeout(BUSY_TIMEOUT);

    let mut conn = SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| e.to_string())?;

    let result = run(&mut conn, &statements).await;
    // Closing is best-effort — the transaction has already committed or rolled
    // back, and a connection that won't close cleanly is dropped either way.
    let _ = conn.close().await;
    result
}

async fn run(conn: &mut SqliteConnection, statements: &[SqlStatement]) -> Result<(), String> {
    let mut tx = conn
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| e.to_string())?;

    for statement in statements {
        bind(sqlx::query(&statement.sql), &statement.values)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        // On the error path `tx` is dropped here, which rolls back — and the
        // connection it rolls back on is ours alone, so nothing is left holding
        // a lock for the rest of the session.
    }

    tx.commit().await.map_err(|e| e.to_string())
}

type Query<'q> = sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>;

/// Bind JSON values positionally, mirroring `tauri-plugin-sql`'s mapping:
/// numbers go over as f64 (SQLite's column affinity converts them back to
/// INTEGER where the column asks for one), strings as text, anything
/// structured as JSON text.
fn bind<'q>(mut query: Query<'q>, values: &'q [JsonValue]) -> Query<'q> {
    for value in values {
        query = if value.is_null() {
            query.bind(None::<JsonValue>)
        } else if let Some(s) = value.as_str() {
            query.bind(s.to_owned())
        } else if let Some(n) = value.as_number() {
            query.bind(n.as_f64().unwrap_or_default())
        } else {
            query.bind(value.clone())
        };
    }
    query
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::Row;
    use std::path::PathBuf;

    /// Unique scratch database under the OS temp dir. Mirrors
    /// `transfer::tests::scratch`.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("saw-sqltx-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("test.db")
    }

    fn stmt(sql: &str, values: Vec<JsonValue>) -> SqlStatement {
        SqlStatement {
            sql: sql.into(),
            values,
        }
    }

    async fn open(path: &Path, create: bool) -> SqliteConnection {
        SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(create),
        )
        .await
        .unwrap()
    }

    /// A database with one `things (id TEXT PRIMARY KEY, n INTEGER)` table.
    async fn seed(path: &Path) {
        let mut conn = open(path, true).await;
        sqlx::query("CREATE TABLE things (id TEXT PRIMARY KEY, n INTEGER)")
            .execute(&mut conn)
            .await
            .unwrap();
        conn.close().await.unwrap();
    }

    async fn rows(path: &Path) -> Vec<(String, i64)> {
        let mut conn = open(path, false).await;
        let rows = sqlx::query("SELECT id, n FROM things ORDER BY id")
            .fetch_all(&mut conn)
            .await
            .unwrap();
        let out = rows
            .iter()
            .map(|r| (r.get::<String, _>("id"), r.get::<i64, _>("n")))
            .collect();
        conn.close().await.unwrap();
        out
    }

    const INSERT: &str = "INSERT INTO things (id, n) VALUES (?, ?)";

    #[tokio::test(flavor = "multi_thread")]
    async fn a_whole_batch_lands_together() {
        let db = scratch("commit");
        seed(&db).await;

        let mut conn = open(&db, false).await;
        run(
            &mut conn,
            &[
                stmt(INSERT, vec![json!("a"), json!(1)]),
                stmt(INSERT, vec![json!("b"), json!(2)]),
            ],
        )
        .await
        .unwrap();
        conn.close().await.unwrap();

        assert_eq!(rows(&db).await, vec![("a".into(), 1), ("b".into(), 2)]);
        let _ = std::fs::remove_dir_all(db.parent().unwrap());
    }

    /// The property the config restore depends on: a rejected row part-way
    /// through must not leave the earlier ones behind. This is exactly what the
    /// pooled `db.execute("BEGIN")` could not deliver.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_failing_statement_rolls_the_whole_batch_back() {
        let db = scratch("rollback");
        seed(&db).await;

        let mut conn = open(&db, false).await;
        let err = run(
            &mut conn,
            &[
                stmt(INSERT, vec![json!("a"), json!(1)]),
                stmt("INSERT INTO nope (id) VALUES (?)", vec![json!("x")]),
                stmt(INSERT, vec![json!("b"), json!(2)]),
            ],
        )
        .await
        .unwrap_err();
        assert!(err.contains("nope"), "{err}");

        // The connection is still usable afterwards — the rollback happened
        // here rather than being left for whoever borrows it next.
        run(&mut conn, &[stmt(INSERT, vec![json!("c"), json!(3)])])
            .await
            .unwrap();
        conn.close().await.unwrap();

        assert_eq!(rows(&db).await, vec![("c".into(), 3)]);
        let _ = std::fs::remove_dir_all(db.parent().unwrap());
    }

    /// Numbers cross the IPC boundary as JSON and are bound as f64, the same as
    /// through the plugin — an INTEGER column must still read back as an
    /// integer rather than as `1.7e12`.
    #[tokio::test(flavor = "multi_thread")]
    async fn integers_survive_the_json_round_trip() {
        let db = scratch("affinity");
        seed(&db).await;

        let mut conn = open(&db, false).await;
        run(
            &mut conn,
            &[stmt(INSERT, vec![json!("a"), json!(1_755_388_800_000i64)])],
        )
        .await
        .unwrap();
        conn.close().await.unwrap();

        assert_eq!(rows(&db).await, vec![("a".into(), 1_755_388_800_000)]);
        let _ = std::fs::remove_dir_all(db.parent().unwrap());
    }
}
