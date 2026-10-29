import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { McpDialog } from "./McpDialog";
import { Select } from "../../common/Select";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { mcpHeaderNames, saveMcpServer, type McpServer } from "../../../lib/mcp/config";
import { mcpErrorCode } from "../../../lib/mcp/errors";
import { Toggle } from "./bits";
import styles from "./McpManagement.module.css";
type Header = { name: string; value: string; saved: boolean; mode: "keep" | "replace" | "remove" };
export function McpEditor({ server, onClose, onSaved }: { server?: McpServer; onClose: () => void; onSaved: (s: McpServer, check: boolean) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [headers, setHeaders] = useState<Header[]>([]);
  const [auth, setAuth] = useState(server ? "custom" : "bearer");
  const [token, setToken] = useState("");
  const [dirty, setDirty] = useState(false);
  const [credentialsChanged, setCredentialsChanged] = useState(false);
  const [loading, setLoading] = useState(!!server);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [discard, setDiscard] = useState(false);
  useEffect(() => {
    if (!server) return;
    let live = true;
    void mcpHeaderNames(server).then(names => { if (live) { setHeaders(names.map(name => ({ name, value: "", saved: true, mode: "keep" }))); setAuth(names.length ? "custom" : "none"); } })
      .catch(() => { if (live) setError("credentials"); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [server]);
  const close = () => { if (busy) return; if (dirty) setDiscard(true); else onClose(); };
  const changeHeader = (index: number, patch: Partial<Header>) => { setDirty(true); setCredentialsChanged(true); setHeaders(all => all.map((row, i) => i === index ? { ...row, ...patch } : row)); };
  const save = async (check: boolean) => {
    if (busy || loading) return;
    setError("");
    let patch: Record<string, string | null> | undefined;
    if (!server || credentialsChanged) {
      patch = {};
      if (auth === "bearer") {
        if (!token.trim() || /\s/.test(token.trim())) { setError("token"); return; }
        patch.Authorization = `Bearer ${token.trim()}`;
      } else if (auth === "custom") {
        const names = new Set<string>();
        for (const h of headers) {
          if (!h.name.trim() || names.has(h.name.toLowerCase())) { setError("headers"); return; }
          names.add(h.name.toLowerCase());
          if (h.mode === "keep" && h.saved) continue;
          if (h.mode !== "remove" && !h.value.trim()) { setError("headers"); return; }
          patch[h.name] = h.mode === "remove" ? null : h.value;
        }
      }
    }
    setBusy(true);
    try {
      const saved = await saveMcpServer({ id: server?.id, revision: server?.revision, name, url, enabled, headers: patch, replaceHeaders: auth !== "custom" });
      setToken(""); setHeaders([]); onSaved(saved, check);
    } catch (e) { setError(mcpErrorCode(e)); } finally { setBusy(false); }
  };
  return <><McpDialog busy={busy} onClose={close} title={t(server ? "mcp.manage.edit" : "mcp.manage.add")}>
      <header className={styles.drawerHead}><h2>{t(server ? "mcp.manage.edit" : "mcp.manage.add")}</h2><button onClick={close} disabled={busy} aria-label={t("common.close")}><X size={18} /></button></header>
      <form className={styles.drawerBody} id="mcp-editor" onSubmit={e => { e.preventDefault(); void save(false); }}>
        <fieldset disabled={busy || loading}><label className={styles.field}>{t("mcp.manage.name")}<input autoFocus maxLength={100} value={name} onChange={e => { setName(e.target.value); setDirty(true); }} required /></label>
        <label className={styles.field}>{t("mcp.manage.url")}<input type="url" value={url} placeholder="https://example.com/mcp" onChange={e => { setUrl(e.target.value); setDirty(true); }} required /><small>{t("mcp.manage.urlHint")}</small></label>
        <div className={styles.field}><span>{t("mcp.manage.auth")}</span><Select className={styles.authSelect} ariaLabel={t("mcp.manage.auth")} disabled={busy || loading} value={auth} options={[{ value: "none", label: t("mcp.manage.noAuth") }, { value: "bearer", label: "Bearer Token" }, { value: "custom", label: t("mcp.manage.customHeaders") }]} onChange={value => { setAuth(value); setDirty(true); setCredentialsChanged(true); setHeaders(all => all.map(h => ({ ...h, mode: "remove" }))); }} /></div>
        {auth === "bearer" && <label className={styles.field}>Token<input type="password" autoComplete="off" value={token} onChange={e => { setToken(e.target.value); setDirty(true); setCredentialsChanged(true); }} /><small>{t("mcp.manage.tokenHint")}</small></label>}
        {auth === "custom" && <div className={styles.field}><p>{t("mcp.manage.keepSecret")}</p>{headers.map((h, i) => <div className={styles.headerRow} key={i}><input aria-label={t("mcp.manage.headerName")} disabled={h.saved} value={h.name} onChange={e => changeHeader(i, { name: e.target.value })} />{h.saved && h.mode === "keep" ? <span>{t("mcp.manage.secretSaved")}</span> : h.mode === "remove" ? <span>{t("mcp.manage.willRemove")}</span> : <input type="password" autoComplete="off" aria-label={t("mcp.manage.headerValue")} value={h.value} onChange={e => changeHeader(i, { value: e.target.value })} />}
          {h.saved && <button type="button" onClick={() => changeHeader(i, { mode: h.mode === "keep" ? "replace" : "keep", value: "" })}>{t(h.mode === "keep" ? "mcp.manage.replace" : "mcp.manage.keep")}</button>}<button type="button" aria-label={t("mcp.manage.removeHeader")} onClick={() => { if (h.saved) changeHeader(i, { mode: "remove" }); else { setHeaders(all => all.filter((_, index) => index !== i)); setDirty(true); setCredentialsChanged(true); } }}><X size={14} /></button></div>)}<button type="button" onClick={() => { setHeaders(all => [...all, { name: "", value: "", saved: false, mode: "replace" }]); setDirty(true); setCredentialsChanged(true); }}><Plus size={14} />{t("mcp.manage.addHeader")}</button></div>}
        <div className={styles.enable}><span>{t("mcp.manage.enabled")}</span><Toggle on={enabled} onChange={v => { setEnabled(v); setDirty(true); }} label={t("mcp.manage.enabled")} /></div><p className={styles.hint}>{t("mcp.manage.saveHint")}</p></fieldset>
        {error && <p className={styles.error} role="alert">{t(`mcp.manage.errors.${error}`)}</p>}
      </form><footer className={styles.drawerFoot}><button disabled={busy} onClick={close}>{t("common.cancel")}</button><button disabled={busy || loading} type="submit" form="mcp-editor">{t("common.save")}</button><button className={styles.primary} disabled={busy || loading} onClick={() => void save(true)}>{t("mcp.manage.saveCheck")}</button></footer>
    </McpDialog>{discard && <ConfirmDialog title={t("mcp.manage.discard")} message={t("mcp.manage.discardHint")} confirmLabel={t("mcp.manage.discard")} onClose={() => setDiscard(false)} onConfirm={onClose} />}</>;
}
