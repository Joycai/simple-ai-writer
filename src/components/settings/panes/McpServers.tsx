import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Copy, Database, Plus, RefreshCw, Search, Server, Trash2 } from "lucide-react";
import { connectionRevision, isMcpEnabled, readMcpServers, removeMcpServer, subscribeMcpConfig, toggleMcpServer, type McpServer } from "../../../lib/mcp/config";
import { browseCatalogue, cancelCatalogue, catalogueStale, catalogueState, refreshCatalogue, subscribeCatalogues } from "../../../lib/mcp/catalogue";
import { McpError, mcpErrorCode } from "../../../lib/mcp/errors";
import { IS_TAURI } from "../../../lib/platform";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { Pane, PaneHeader, Toggle } from "./bits";
import { McpEditor } from "./McpEditor";
import { McpImport } from "./McpImport";
import { McpTools } from "./McpTools";
import styles from "./McpManagement.module.css";
export function McpServers({ onLab, onEscapeInterceptChange }: { onLab: () => void; onEscapeInterceptChange: (handler: (() => void) | null) => void }) {
  const { t, i18n } = useTranslation();
  const [, render] = useState(0);
  useEffect(() => { const a = subscribeMcpConfig(() => render(n => n + 1)); const b = subscribeCatalogues(() => render(n => n + 1)); return () => { a(); b(); }; }, []);
  const servers = readMcpServers();
  const [selected, setSelected] = useState(servers[0]?.id ?? "");
  const active = servers.find(s => s.id === selected) ?? servers[0];
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState(false);
  const [tab, setTab] = useState("tools");
  const [editor, setEditor] = useState<{ server?: McpServer } | null>(null);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => { onEscapeInterceptChange(editor || importing || deleting ? () => {} : null); return () => onEscapeInterceptChange(null); }, [editor, importing, deleting, onEscapeInterceptChange]);
  const [mutation, setMutation] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const state = active ? catalogueState(active) : {};
  const snapshot = state.snapshot;
  const connection = active ? connectionRevision(active) : "";
  useEffect(() => {
    if (!active || !IS_TAURI) return;
    const controller = new AbortController();
    void browseCatalogue(active, controller.signal).catch(() => {});
    return () => controller.abort();
  }, [active?.id, connection, active?.enabled]); // stable connection identity, not transient progress
  const refresh = (s: McpServer) => { void refreshCatalogue(s).catch(() => {}); };
  const act = async (s: McpServer, run: () => Promise<void>) => {
    if (mutation) return; setMutation(true); setErrors(all => ({ ...all, [s.id]: "" }));
    try { await run(); } catch (error) { setErrors(all => ({ ...all, [s.id]: mcpErrorCode(error) })); } finally { setMutation(false); }
  };
  const date = (value?: number) => value ? new Date(value).toLocaleString(i18n.language) : t("mcp.manage.notChecked");
  const drawer = <>{editor && <McpEditor server={editor.server} onClose={() => setEditor(null)} onSaved={(s, check) => { setSelected(s.id); setDetail(true); setEditor(null); if (check) refresh(s); }} />}{importing && <McpImport onClose={() => setImporting(false)} />}{deleting && active && <ConfirmDialog title={t("mcp.remove")} message={t("mcp.manage.deleteHint", { name: active.name })} confirmLabel={t("mcp.remove")} onClose={() => setDeleting(false)} onConfirm={() => { setDeleting(false); void act(active, () => removeMcpServer(active.id)); }} />}</>;
  return <Pane width="wide" drawer={drawer}><div className={styles.root}>
    <PaneHeader title={t("mcp.title")} sub={t("mcp.manage.subtitle")} action={<div className={styles.actions}><button disabled={!IS_TAURI} onClick={() => setImporting(true)}>{t("mcp.import")}</button><button disabled={!IS_TAURI} className={styles.primary} onClick={() => setEditor({})}><Plus size={16} />{t("mcp.manage.add")}</button></div>} />
    {!isMcpEnabled() && <div className={styles.banner}>{t("mcp.manage.betaOff")}<button onClick={onLab}>{t("systemSettings.tabs.lab")}</button></div>}
    {!IS_TAURI && <p>{t("mcp.desktopOnly")}</p>}
    <div className={styles.summary}><span>{t("mcp.manage.count", { enabled: servers.filter(s => s.enabled).length, total: servers.length })}</span><span>{t("mcp.manage.approvalHint")}</span></div>
    <div className={`${styles.layout} ${detail ? styles.showDetail : ""}`}>
      <aside className={styles.list}><div className={styles.search}><Search size={15} /><input aria-label={t("mcp.manage.searchServices")} placeholder={t("mcp.manage.searchServices")} value={query} onChange={e => setQuery(e.target.value)} /></div>
        {servers.filter(s => `${s.name} ${s.url}`.toLowerCase().includes(query.toLowerCase())).map(s => { const cat = catalogueState(s); return <button key={s.id} className={`${styles.service} ${active?.id === s.id ? styles.selected : ""}`} aria-current={s.id === active?.id ? "true" : undefined} onClick={() => { setSelected(s.id); setDetail(true); setCopied(false); }}><strong><Server size={16} />{s.name}</strong><small>{new URL(s.url).host}</small><div><span>{cat.snapshot ? t("mcp.manage.toolCount", { count: cat.snapshot.tools.length }) : t("mcp.manage.notLoaded")}</span><span>{t(s.enabled ? "mcp.manage.enabled" : "mcp.manage.disabled")}</span></div><small>{cat.loading ? t("mcp.working") : cat.error ? t("mcp.manage.updateFailed") : cat.snapshot ? date(cat.snapshot.fetchedAt) : t("mcp.manage.notChecked")}</small></button>; })}
        {!servers.length && <p className={styles.empty}>{t("mcp.manage.empty")}</p>}
        {!!servers.length && !servers.some(s => `${s.name} ${s.url}`.toLowerCase().includes(query.toLowerCase())) && <p className={styles.empty}>{t("mcp.manage.noMatches")}</p>}
        <p className={styles.listFoot}><Database size={14} />{t("mcp.manage.cacheHint")}</p>
      </aside><section className={styles.detail}>
      {active ? <><button className={styles.back} onClick={() => setDetail(false)}><ArrowLeft size={14} />{t("mcp.manage.back")}</button><header className={styles.detailHead}><div className={styles.titleRow}><h2>{active.name}</h2><span>{t(active.enabled ? "mcp.manage.enabled" : "mcp.manage.disabled")}</span><Toggle on={active.enabled} onChange={next => void act(active, () => toggleMcpServer(active.id, next))} label={active.name} /></div>
        <button className={styles.url} onClick={() => { void navigator.clipboard.writeText(active.url).then(() => setCopied(true)).catch(() => setErrors(all => ({ ...all, [active.id]: "clipboard" }))); }}>{active.url}<Copy size={13} /></button>{copied && <span role="status">{t("mcp.manage.copied")}</span>}
        <div className={styles.controls}><span>{t("mcp.manage.lastSuccess")} {date(snapshot?.fetchedAt)}</span><div className={styles.actions}><button disabled={mutation || !IS_TAURI} onClick={() => setEditor({ server: active })}>{t("mcp.manage.edit")}</button><button disabled={!IS_TAURI} onClick={() => state.loading ? cancelCatalogue(active) : refresh(active)}><RefreshCw size={14} />{t(state.loading ? "mcp.stop" : "mcp.manage.checkRefresh")}</button><button disabled={mutation} aria-label={t("mcp.remove")} onClick={() => setDeleting(true)}><Trash2 size={14} /></button></div></div>
      </header>{!active.enabled && <p className={styles.banner}>{t("mcp.manage.disabledHint")}</p>}
      {(state.error || errors[active.id]) && <div className={styles.banner} role="status"><div>{t(`mcp.manage.errors.${errors[active.id] || mcpErrorCode(state.error)}`)}{state.error instanceof McpError && <small>{state.error.stage}{state.error.status ? ` · HTTP ${state.error.status}` : ""}</small>}{snapshot && <p>{t("mcp.manage.retained", { date: date(snapshot.fetchedAt) })}</p>}</div></div>}
      <div className={styles.tabs} role="tablist" aria-label={t("mcp.manage.details")}>{["tools", "connection"].map(value => <button key={value} role="tab" id={`mcp-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} aria-controls="mcp-details" onClick={() => setTab(value)} onKeyDown={e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const next = value === "tools" ? "connection" : "tools"; setTab(next); document.getElementById(`mcp-${next}`)?.focus(); } }}>{t(`mcp.manage.${value}`)}{value === "tools" && <span>{snapshot?.tools.length ?? "—"}</span>}</button>)}</div>
      <div id="mcp-details" role="tabpanel" aria-labelledby={`mcp-${tab}`} className={styles.panel}>{tab === "tools" ? <><p className={styles.hint}>{state.loading ? t("mcp.manage.refreshing") : snapshot ? t(catalogueStale(snapshot) ? "mcp.manage.stale" : "mcp.manage.cached", { date: date(snapshot.fetchedAt) }) : t("mcp.manage.noCache")}</p>{snapshot && state.persisted === false && <p role="status">{t("mcp.manage.notPersisted")}</p>}{snapshot ? <McpTools key={active.id} tools={snapshot.tools} /> : <div className={styles.empty}><Database size={28} /><p>{t("mcp.manage.noCache")}</p><button disabled={state.loading || !IS_TAURI} onClick={() => refresh(active)}>{t("mcp.manage.getTools")}</button></div>}</> : <dl className={styles.facts}>{[[t("mcp.manage.url"), active.url], [t("mcp.manage.transport"), "Streamable HTTP"], [t("mcp.manage.auth"), active.headerNames?.join(", ") || t("mcp.manage.authHidden")], [t("mcp.manage.serverVersion"), [snapshot?.info.name, snapshot?.info.version].filter(Boolean).join(" / ") || "—"], [t("mcp.manage.protocol"), snapshot?.info.protocolVersion || "—"], [t("mcp.manage.lastAttempt"), date(state.attemptedAt)], [t("mcp.manage.lastSuccess"), date(snapshot?.fetchedAt)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}</div></> : <div className={styles.empty}><Server size={30} /><h3>{t("mcp.manage.empty")}</h3><button disabled={!IS_TAURI} className={styles.primary} onClick={() => setEditor({})}>{t("mcp.manage.add")}</button></div>}
      </section></div></div></Pane>;
}
