import { useState } from "react";
import { useTranslation } from "react-i18next";
import { McpDialog } from "./McpDialog";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { parseMcpImport, readMcpServers, saveMcpServer, type McpImport as Entry } from "../../../lib/mcp/config";
import styles from "./McpManagement.module.css";
export function McpImport({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [replace, setReplace] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, "saved" | "failed">>({});
  const [error, setError] = useState(false);
  const [discard, setDiscard] = useState(false);
  const close = () => { if (busy) return; if (raw) setDiscard(true); else onClose(); };
  const [busy, setBusy] = useState(false);
  const importAll = async () => {
    setBusy(true);
    for (const entry of entries) {
      if (results[entry.name] === "saved") continue;
      const old = readMcpServers().find(s => s.name.toLowerCase() === entry.name.toLowerCase());
      if (old && !replace[entry.name]) continue;
      try { await saveMcpServer({ ...entry, id: old?.id, revision: old?.revision, enabled: true, replaceHeaders: true }); setResults(all => ({ ...all, [entry.name]: "saved" })); setEntries(all => all.map(e => e.name === entry.name ? { ...e, headers: {} } : e)); }
      catch { setResults(all => ({ ...all, [entry.name]: "failed" })); }
    }
    setRaw(""); setBusy(false);
  };
  return <><McpDialog busy={busy} onClose={close} title={t("mcp.import")}><header className={styles.drawerHead}><h2>{t("mcp.import")}</h2></header><div className={styles.drawerBody}>
      {!entries.length ? <><label className={styles.field}>{t("mcp.importLabel")}<textarea autoFocus rows={12} spellCheck={false} autoComplete="off" value={raw} onChange={e => setRaw(e.target.value)} placeholder={'{"mcpServers":{"search":{"url":"https://example.com/mcp"}}}'} /></label>{error && <p role="alert" className={styles.error}>{t("mcp.manage.errors.json")}</p>}</> : entries.map(entry => { const existing = readMcpServers().some(s => s.name.toLowerCase() === entry.name.toLowerCase()); return <div className={styles.importEntry} key={entry.name}><strong>{entry.name}</strong><p>{entry.url}</p><small>{t(Object.keys(entry.headers).length ? "mcp.manage.hasCredentials" : "mcp.manage.noAuth")}</small>{existing && results[entry.name] !== "saved" && <label><input type="checkbox" disabled={busy} checked={!!replace[entry.name]} onChange={e => setReplace(all => ({ ...all, [entry.name]: e.target.checked }))} />{t("mcp.manage.replaceExisting")}</label>}{results[entry.name] && <p role="status">{t(results[entry.name] === "saved" ? "mcp.saved" : "mcp.manage.errors.failed")}</p>}</div>; })}
    </div><footer className={styles.drawerFoot}>{entries.length > 0 && !Object.keys(results).length && <button disabled={busy} onClick={() => setEntries([])}>{t("mcp.manage.backToJson")}</button>}<button disabled={busy} onClick={close}>{t("common.close")}</button>{entries.length ? <button disabled={busy || entries.every(e => results[e.name] === "saved" || (readMcpServers().some(s => s.name.toLowerCase() === e.name.toLowerCase()) && !replace[e.name]))} className={styles.primary} onClick={() => void importAll()}>{t("mcp.manage.confirmImport")}</button> : <button className={styles.primary} disabled={!raw.trim()} onClick={() => { try { const parsed = parseMcpImport(raw); if (new Set(parsed.map(e => e.name.toLowerCase())).size !== parsed.length) throw new Error(); setEntries(parsed); setError(false); } catch { setError(true); } }}>{t("mcp.manage.preview")}</button>}</footer>
  </McpDialog>{discard && <ConfirmDialog title={t("mcp.manage.discard")} message={t("mcp.manage.discardHint")} confirmLabel={t("mcp.manage.discard")} onClose={() => setDiscard(false)} onConfirm={onClose} />}</>;
}
