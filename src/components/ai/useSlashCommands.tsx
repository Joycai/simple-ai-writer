import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { parseSlash, insertSlashCommand, mcpCommand, mcpTarget, commandRequest } from "../../lib/agent/slashCommands";
import { isMcpEnabled, readMcpServers } from "../../lib/mcp/config";
import { withMcp, type McpTool } from "../../lib/mcp/client";
import { useAppStore } from "../../stores/appStore";
import { IS_TAURI } from "../../lib/platform";
import styles from "./SlashCommands.module.css";

type Catalogue = { revision: string; tools?: McpTool[]; loading?: boolean; failed?: boolean };
export function useSlashCommands(scope: string, draft: string, setDraft: (text: string) => void, imageAvailable: boolean) {
  const { t } = useTranslation();
  const listId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const selectedRow = useRef<HTMLButtonElement>(null);
  const [catalogues, setCatalogues] = useState<Record<string, Catalogue>>({});
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState(false);
  const controllers = useRef(new Map<string, AbortController>());
  useEffect(() => {
    setCatalogues({}); setDismissed(null); setError(false);
    return () => { for (const c of controllers.current.values()) c.abort(); };
  }, [scope]);
  const parsed = parseSlash(draft);
  const servers = readMcpServers();
  const enabled = IS_TAURI && isMcpEnabled();
  const open = !!parsed && dismissed !== draft && (!parsed.request || parsed.command === "mcp" || parsed.command === "help");
  const catalogueOf = (id: string, revision: string) => catalogues[id]?.revision === revision ? catalogues[id] : undefined;
  const load = async (id: string) => {
    const server = readMcpServers().find(s => s.id === id);
    if (!server?.enabled || !IS_TAURI || !isMcpEnabled()) return;
    controllers.current.get(id)?.abort();
    const controller = new AbortController();
    controllers.current.set(id, controller);
    setCatalogues(prev => ({ ...prev, [id]: { revision: server.revision, loading: true } }));
    try {
      const tools = await withMcp(server, controller.signal, client => client.listTools(), 30_000);
      if (!controller.signal.aborted) setCatalogues(prev => ({ ...prev, [id]: { revision: server.revision, tools } }));
    } catch {
      if (!controller.signal.aborted) setCatalogues(prev => ({ ...prev, [id]: { revision: server.revision, failed: true } }));
    }
  };
  const entries = [
    { command: "help", description: t("slash.help"), unavailable: false },
    { command: "mcp", description: t("slash.mcp"), unavailable: false },
    { command: "imageGen", description: t(imageAvailable ? "slash.image" : "slash.imageUnavailable"), unavailable: !imageAvailable },
    ...servers.filter(s => enabled && s.enabled).flatMap(s => (catalogueOf(s.id, s.revision)?.tools ?? []).map(tool => ({
      command: mcpCommand(s.name, tool.name), description: tool.description?.slice(0, 240) || tool.name, unavailable: false,
    }))),
  ];
  const query = parsed?.command.toLowerCase() ?? "";
  const matches = entries.filter(e => query === "help" || (query === "mcp" ? e.command === "mcp" || e.command.includes(":") : e.command.toLowerCase().includes(query)));
  const index = Math.min(selected, Math.max(0, matches.length - 1));
  useEffect(() => { setSelected(0); setError(false); }, [draft]);
  useEffect(() => { if (open) selectedRow.current?.scrollIntoView({ block: "nearest" }); }, [index, open]);
  const pick = (command: string) => { setDismissed(null); setDraft(insertSlashCommand(draft, command)); };
  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean) => {
    if (!open || composing) return false;
    if (e.key === "Escape") { e.preventDefault(); setDismissed(draft); return true; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); setSelected((index + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % Math.max(1, matches.length)); return true;
    }
    if (e.key === "Tab" && !e.shiftKey) {
      // Skip virtual-focus options and enter the catalogue controls. The panel
      // follows the textarea in DOM order, so subsequent Tabs reach the footer.
      const control = panelRef.current?.querySelector<HTMLButtonElement>("[data-slash-control]:not(:disabled)");
      if (control) { e.preventDefault(); control.focus(); return true; }
      return false;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      const entry = matches[index];
      if (!entry) return false;
      e.preventDefault();
      if (entry && !entry.unavailable) pick(entry.command);
      return true;
    }
    return false;
  };
  // null means a local action or invalid command: preserve the author's draft.
  const prepare = (): string | null => {
    const p = parseSlash(draft);
    if (!p) return draft;
    if (p.command === "help" || p.command === "mcp" || !p.command) { setDismissed(null); return null; }
    const target = mcpTarget(p.command);
    // Only known command syntax claims a message. A slash alone does not
    // reserve arbitrary prose or paths, even after the picker is dismissed.
    if (p.command !== "imageGen" && !target) return draft;
    const valid = p.command === "imageGen" ? imageAvailable : target && enabled && servers.some(s => s.enabled && s.name === target.server);
    if (!valid || !p.request) { setError(true); return null; }
    return commandRequest(p.command, p.request);
  };
  const panel = <>
    {open && <div ref={panelRef} className={styles.panel} aria-label={t("slash.title")}
      onKeyDown={e => {
        if (e.key === "Escape" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
          e.preventDefault(); e.stopPropagation(); setDismissed(draft); setDraft(draft);
        }
      }}>
      <div className={styles.heading}>{t("slash.title")}</div>
      <div id={listId} role="listbox" aria-label={t("slash.title")}>
        {matches.map((entry, i) => <button key={entry.command} id={`${listId}-${i}`} ref={i === index ? selectedRow : undefined} type="button" role="option" aria-selected={i === index}
          disabled={entry.unavailable} className={`${styles.row} ${i === index ? styles.selected : ""}`}
          onMouseDown={e => e.preventDefault()} onClick={() => pick(entry.command)}>
          <span className={styles.command}>/{entry.command}</span><span>{entry.description}</span>
        </button>)}
        {!matches.length && <p>{t("slash.noMatches")}</p>}
      </div>
      {parsed?.command === "mcp" && <div className={styles.servers}>
        <p>{t("slash.count", { count: servers.filter(s => s.enabled).length })}</p>
        {!enabled && <p>{t("slash.mcpUnavailable")}</p>}
        {servers.map(server => { const cat = catalogueOf(server.id, server.revision); return <div key={server.id} className={styles.server}>
          <span>{server.name} · {t(!server.enabled ? "slash.disabled" : cat?.loading ? "slash.loading" : cat?.failed ? "slash.failed" : cat?.tools ? "slash.tools" : "slash.notLoaded", { count: cat?.tools?.length })}</span>
          <button type="button" data-slash-control disabled={!enabled || !server.enabled || cat?.loading} onClick={() => void load(server.id)}>{t(cat?.tools ? "slash.refresh" : "slash.load")}</button>
        </div>; })}
      </div>}
      <button type="button" data-slash-control className={styles.settings} onClick={() => useAppStore.getState().openSettings(parsed?.command === "imageGen" ? "subagents" : "lab")}>{t("slash.settings")}</button>
      <p className={styles.hint}>{t("slash.hint")}</p>
    </div>}
    {error && <p className={styles.error} role="alert">{t("slash.invalid")}</p>}
  </>;
  const inputProps = { role: "combobox" as const, "aria-autocomplete": "list" as const, "aria-expanded": open, "aria-controls": open ? listId : undefined, "aria-activedescendant": open && matches.length ? `${listId}-${index}` : undefined };
  return { panel, keyDown, prepare, inputProps };
}
