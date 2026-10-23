/** Bounds only disposable document vectors, independently of the KB index. */
import type { SqlStatement } from "../sqlTx";

export const DOCUMENT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const DOCUMENT_CACHE_MAX_NAMESPACES = 8;

export const DOCUMENT_CACHE_ACCESS_TABLE = `CREATE TABLE IF NOT EXISTS document_embedding_access (
  namespace TEXT PRIMARY KEY, accessed INTEGER NOT NULL)`;

/** Run inside the same transaction as a batch write (or before a cache read).
 * A database sequence, not wall-clock time, keeps recency ordered across windows.
 * Legacy rows without metadata are oldest. Whole namespaces are evicted, so we
 * never retain a misleading mixture of models. An oversized namespace is itself
 * disposable; the retrieval pass still owns its complete in-memory vector map.
 */
export function documentCacheMaintenance(namespace: string): SqlStatement[] {
  return [
    {
      sql: `INSERT OR REPLACE INTO document_embedding_access (namespace, accessed)
        VALUES (?, (SELECT COALESCE(MAX(accessed), 0) + 1 FROM document_embedding_access))`,
      values: [namespace],
    },
    {
      sql: `WITH sizes AS (
        SELECT namespace, SUM(length(CAST(namespace AS BLOB)) + length(CAST(entry AS BLOB))
          + length(CAST(hash AS BLOB)) + length(CAST(vector AS BLOB))) AS bytes
        FROM document_embeddings GROUP BY namespace
      ), ranked AS (
        SELECT sizes.namespace,
          ROW_NUMBER() OVER (ORDER BY COALESCE(accessed, 0) DESC, sizes.namespace) AS position,
          SUM(bytes) OVER (ORDER BY COALESCE(accessed, 0) DESC, sizes.namespace
            ROWS UNBOUNDED PRECEDING) AS retained_bytes
        FROM sizes LEFT JOIN document_embedding_access USING (namespace)
        WHERE bytes <= ?
      ) DELETE FROM document_embeddings WHERE namespace IN (
        SELECT namespace FROM sizes WHERE bytes > ?
        UNION ALL
        SELECT namespace FROM ranked WHERE position > ? OR retained_bytes > ?
      )`,
      values: [DOCUMENT_CACHE_MAX_BYTES, DOCUMENT_CACHE_MAX_BYTES,
        DOCUMENT_CACHE_MAX_NAMESPACES, DOCUMENT_CACHE_MAX_BYTES],
    },
    {
      sql: `DELETE FROM document_embedding_access
        WHERE namespace NOT IN (SELECT DISTINCT namespace FROM document_embeddings)`,
      values: [],
    },
  ];
}
