import { getGlobalDb, getGlobalDbPath } from "../project";
import { sqlTransaction } from "../sqlTx";
const MAX_BYTES = 8 * 1024 * 1024;
const TOTAL_BYTES = 64 * 1024 * 1024;
async function database() {
  const db = await getGlobalDb();
  await db.execute(`CREATE TABLE IF NOT EXISTS mcp_catalogues (
    id TEXT PRIMARY KEY, connection TEXT NOT NULL, payload TEXT NOT NULL, bytes INTEGER NOT NULL, updated INTEGER NOT NULL)`);
  return db;
}
export async function readCatalogueRow(id: string, connection: string): Promise<string | undefined> {
  const db = await database();
  const rows = await db.select<{ payload: string }[]>("SELECT payload FROM mcp_catalogues WHERE id = ? AND connection = ? AND bytes <= ?", [id, connection, MAX_BYTES]);
  return rows[0]?.payload;
}
export async function writeCatalogueRow(id: string, connection: string, payload: string): Promise<boolean> {
  const bytes = new TextEncoder().encode(payload).length;
  if (bytes > MAX_BYTES) return false;
  await database();
  await sqlTransaction(await getGlobalDbPath(), [
    { sql: "INSERT OR REPLACE INTO mcp_catalogues (id, connection, payload, bytes, updated) VALUES (?,?,?,?,?)", values: [id, connection, payload, bytes, Date.now()] },
    { sql: `DELETE FROM mcp_catalogues WHERE id IN (SELECT id FROM
      (SELECT id, SUM(bytes) OVER (ORDER BY updated DESC, id) AS total FROM mcp_catalogues) WHERE total > ?)`, values: [TOTAL_BYTES] },
  ]);
  return true;
}
export async function deleteCatalogueRow(id: string): Promise<void> {
  await (await database()).execute("DELETE FROM mcp_catalogues WHERE id = ?", [id]);
}
export async function clearCatalogueRows(): Promise<void> {
  await (await database()).execute("DELETE FROM mcp_catalogues");
}
