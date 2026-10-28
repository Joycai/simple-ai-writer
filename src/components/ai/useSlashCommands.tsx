import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { parseSlash, insertSlashCommand, mcpCommand, mcpTarget, commandRequest } from "../../lib/agent/slashCommands";
import { isMcpEnabled, readMcpServers } from "../../lib/mcp/config";
import { withMcp, type McpTool } from "../../lib/mcp/client";
import { useAppStore } from "../../stores/appStore";
import { IS_TAURI } from "../../lib/platform";
import { ModalShell } from "../common/ModalShell";
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
  const [browser, setBrowser] = useState<"help" | "mcp" | null>(null);
  const [error, setError] = useState(false);
  const controllers = useRef(new Map<string, AbortController>());
  useEffect(() => {
    setCatalogues({}); setDismissed(null); setError(false); setBrowser(null);
    return () => { for (const c of controllers.current.values()) c.abort(); };
  }, [scope]);
  const parsed = parseSlash(draft);
  const servers = readMcpServers();
  const enabled = IS_TAURI && isMcpEnabled();
  const open = !browser && !!parsed && dismissed !== draft && (!parsed.request || parsed.command === "mcp" || parsed.command === "help");
  useEffect(() => {
    const panel = panelRef.current;
    const anchor = panel?.parentElement;
    if (!open || !panel || !anchor) return;
    const fit = () => {
      panel.style.maxHeight = `${Math.max(0, Math.min(320, anchor.getBoundingClientRect().top - 8))}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    // Ancestor resizing can move the composer without resizing the input.
    for (let node: Element | null = anchor; node; node = node.parentElement) observer.observe(node);
    window.addEventListener("resize", fit);
    return () => { observer.disconnect(); window.removeEventListener("resize", fit); };
  }, [open]);
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
  const query = browser ?? parsed?.command.toLowerCase() ?? "";
  const matches = entries.filter(e => e.command !== browser).filter(e => query === "help" || (query === "mcp" ? e.command === "mcp" || e.command.includes(":") : e.command.toLowerCase().includes(query)));
  const index = Math.min(selected, Math.max(0, matches.length - 1));
  useEffect(() => { setSelected(0); setError(false); }, [draft]);
  useEffect(() => { if (open) selectedRow.current?.scrollIntoView({ block: "nearest" }); }, [index, open]);
  const browse = (command: "help" | "mcp") => {
    setBrowser(command); setDraft(browser ? draft : draft.replace(/^\/[^\s]*[ \t]?/, "")); setDismissed(null);
  };
  const pick = (command: string) => {
    if (command === "help" || command === "mcp") { browse(command); return; }
    setBrowser(null); setDismissed(null); setDraft(browser ? `/${command} ${draft}` : insertSlashCommand(draft, command));
  };
  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean) => {
    if (composing) return false;
    if (e.key === "Enter" && !e.shiftKey && (parsed?.command === "help" || parsed?.command === "mcp") && (!open || matches[index]?.command === parsed.command)) {
      e.preventDefault(); browse(parsed.command); return true;
    }
    if (!open) return false;
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
      // A complete command must reach prepare(), not be reinserted forever.
      if (!entry.unavailable && parsed?.command === entry.command) return false;
      e.preventDefault();
      if (!entry.unavailable) pick(entry.command);
      return true;
    }
    return false;
  };
  // Local actions consume only their command; invalid execution keeps the draft.
  const prepare = (): string | null => {
    const p = parseSlash(draft);
    if (!p) return draft;
    if (p.command === "help" || p.command === "mcp") { browse(p.command); return null; }
    if (!p.command) { setDismissed(null); return null; }
    const target = mcpTarget(p.command);
    // Only known command syntax claims a message. A slash alone does not
    // reserve arbitrary prose or paths, even after the picker is dismissed.
    if (p.command !== "imageGen" && !target) return draft;
    const valid = p.command === "imageGen" ? imageAvailable : target && enabled && servers.some(s => s.enabled && s.name === target.server);
    if (!valid || !p.request) { setError(true); return null; }
    return commandRequest(p.command, p.request);
  };
  const content = <>
      <div className={styles.heading}>{t(browser ? `slash.${browser}` : "slash.title")}</div>
      {browser && <p>{t("slash.localHelp")}</p>}
      <div id={listId} role={browser ? undefined : "listbox"} aria-label={t("slash.title")}>
        {matches.map((entry, i) => <button key={entry.command} id={`${listId}-${i}`} ref={i === index ? selectedRow : undefined} type="button" role={browser ? undefined : "option"} aria-selected={browser ? undefined : i === index}
          disabled={entry.unavailable} className={`${styles.row} ${!browser && i === index ? styles.selected : ""}`}
          onMouseDown={e => { if (!browser) e.preventDefault(); }} onClick={() => pick(entry.command)}>
          <span className={styles.command}>/{entry.command}</span><span>{entry.description}</span>
        </button>)}
        {!matches.length && <p>{t(browser === "mcp" ? "slash.loadHint" : "slash.noMatches")}</p>}
      </div>
      {browser === "mcp" && <div className={styles.servers}>
        <p>{t("slash.count", { count: servers.filter(s => s.enabled).length })}</p>
        {!enabled && <p>{t("slash.mcpUnavailable")}</p>}
        {servers.map(server => { const cat = catalogueOf(server.id, server.revision); return <div key={server.id} className={styles.server}>
          <span>{server.name} · {t(!server.enabled ? "slash.disabled" : cat?.loading ? "slash.loading" : cat?.failed ? "slash.failed" : cat?.tools ? "slash.tools" : "slash.notLoaded", { count: cat?.tools?.length })}</span>
          <button type="button" data-slash-control disabled={!enabled || !server.enabled || cat?.loading} onClick={() => void load(server.id)}>{t(cat?.tools ? "slash.refresh" : "slash.load")}</button>
        </div>; })}
      </div>}
      <button type="button" data-slash-control className={styles.settings} onClick={() => { setBrowser(null); useAppStore.getState().openSettings(parsed?.command === "imageGen" ? "subagents" : "lab"); }}>{t("slash.settings")}</button>
      <p className={styles.hint}>{t(browser ? "slash.usage" : "slash.hint")}</p>
  </>;
  const panel = <>
    {open && <div ref={panelRef} className={styles.panel} tabIndex={-1} aria-label={t("slash.title")}
      onKeyDown={e => {
        if (e.key === "Escape" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
          e.preventDefault(); e.stopPropagation(); setDismissed(draft); setDraft(draft);
        }
      }}>{content}</div>}
    {browser && <ModalShell overlayClassName={styles.overlay} onClose={() => { setBrowser(null); setDraft(draft); }}>
      <div className={styles.browser} role="dialog" aria-modal="true" aria-label={t(`slash.${browser}`)}>
        <button autoFocus type="button" className={styles.settings} onClick={() => { setBrowser(null); setDraft(draft); }}>{t("common.close")}</button>
        {content}
      </div>
    </ModalShell>}
    {error && <p className={styles.error} role="alert">{t("slash.invalid")}</p>}
  </>;
  const inputProps = { role: "combobox" as const, "aria-autocomplete": "list" as const, "aria-expanded": open, "aria-controls": open ? listId : undefined, "aria-activedescendant": open && matches.length ? `${listId}-${index}` : undefined };
  return { panel, keyDown, prepare, inputProps };
}
