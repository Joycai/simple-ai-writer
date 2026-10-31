import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Check, ChevronDown, ChevronRight, Palette } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore, type ThemeMode } from "../../stores/appStore";
import { useThemeStore } from "../../stores/themeStore";
import { displayThemeName, type ThemeEntry } from "../../lib/theme/registry";
import { useScheme } from "../../lib/theme/scheme";
import { themeMenuPosition } from "./themeMenuPosition";
import styles from "./ThemeMenu.module.css";

type Page = "ui" | "markdown";
const modes: ThemeMode[] = ["light", "dark", "system"];
const focusable = (el: HTMLElement | null) => Array.from(el?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);

/** Both panels are portaled to the root palette. Only swatches scope their own theme. */
export function ThemeMenu() {
  const { t, i18n } = useTranslation();
  const mode = useAppStore((s) => s.theme);
  const light = useAppStore((s) => s.themeLight);
  const dark = useAppStore((s) => s.themeDark);
  const markdown = useAppStore((s) => s.markdownTheme);
  const scheme = useScheme();
  const ui = useThemeStore((s) => s.ui);
  const md = useThemeStore((s) => s.markdown);
  const loading = useThemeStore((s) => s.loading);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<Page | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 8, childLeft: 8, childTop: 8, stacked: false });
  const trigger = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const child = useRef<HTMLDivElement>(null);
  const branches = useRef<Partial<Record<Page, HTMLButtonElement | null>>>({});
  const keyboardChild = useRef(false);
  const returnBranch = useRef<Page | null>(null);
  const openAtEnd = useRef(false);
  const isZh = i18n.language.startsWith("zh");
  const name = (entry: ThemeEntry) => displayThemeName(entry, isZh);
  const selectedName = (entries: ThemeEntry[], id: string) => {
    const entry = entries.find((e) => e.id === id);
    return entry ? name(entry) : id;
  };
  const close = () => { setOpen(false); setPage(null); trigger.current?.focus(); };
  const back = () => { returnBranch.current = page; setPage(null); };
  const select = (action: () => void) => { close(); action(); };
  const enter = (next: Page, keyboard = false) => {
    // Removing the focused child would otherwise leave focus on document.body.
    keyboardChild.current = keyboard || !!child.current?.contains(document.activeElement);
    setPage(next);
    if (page === next && keyboard) focusable(child.current)[0]?.focus();
  };

  const leaveChild = (target: HTMLButtonElement) => {
    if (child.current?.contains(document.activeElement)) target.focus();
    setPage(null);
  };

  useEffect(() => {
    if (!open) return;
    setError(false);
    void useThemeStore.getState().load().catch(() => setError(true));
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor || !root.current) return;
      const row = page ? branches.current[page]?.getBoundingClientRect() : null;
      setPosition(themeMenuPosition({
        viewport: { width: window.innerWidth, height: window.innerHeight },
        anchor,
        root: { width: root.current.offsetWidth, height: root.current.offsetHeight },
        child: { width: child.current?.offsetWidth ?? root.current.offsetWidth, height: child.current?.offsetHeight ?? 0 },
        rowOffset: row ? row.top - root.current.getBoundingClientRect().top : 0,
      }));
    };
    place();
    const observer = new ResizeObserver(place);
    if (root.current) observer.observe(root.current);
    if (child.current) observer.observe(child.current);
    const panel = root.current;
    panel?.addEventListener("scroll", place);
    window.addEventListener("resize", place);
    return () => { observer.disconnect(); panel?.removeEventListener("scroll", place); window.removeEventListener("resize", place); };
  }, [open, page]);

  useLayoutEffect(() => {
    if (open) {
      const items = focusable(root.current);
      items[openAtEnd.current ? items.length - 1 : 0]?.focus();
      openAtEnd.current = false;
    }
  }, [open]);
  useLayoutEffect(() => {
    if (page && (keyboardChild.current || position.stacked)) focusable(child.current)[0]?.focus();
    if (!page && returnBranch.current) {
      branches.current[returnBranch.current]?.focus();
      returnBranch.current = null;
    }
  }, [page, position.stacked]);

  const keys = (event: KeyboardEvent<HTMLDivElement>, submenu: boolean) => {
    const items = focusable(submenu ? child.current : root.current);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (next !== undefined) { event.preventDefault(); items[next]?.focus(); }
    if (event.key === "Escape" || (submenu && event.key === "ArrowLeft")) {
      event.preventDefault(); event.stopPropagation();
      if (page) back(); else close();
    }
    // Restore the trigger before the native Tab action, which then leaves the menu.
    if (event.key === "Tab") close();
  };
  const renderEntry = (entry: ThemeEntry) => {
    const checked = entry.kind === "markdown" ? markdown === entry.id : (entry.scheme === "dark" ? dark : light) === entry.id;
    return <button key={`${entry.source}:${entry.id}:${entry.path ?? ""}`} role="menuitemradio" aria-checked={checked}
      disabled={!entry.usable} className={styles.item}
      title={!entry.usable ? t("themeMenu.unavailable") : name(entry)}
      onClick={() => select(() => {
        const app = useAppStore.getState();
        if (entry.kind === "markdown") app.setMarkdownTheme(entry.id);
        else if (entry.scheme) app.setThemeFor(entry.scheme, entry.id);
      })}>
      {entry.kind === "ui" && <span className={styles.swatch} data-theme={entry.id} data-scheme={entry.scheme} aria-hidden="true" />}
      <span className={styles.label}>{name(entry)}{!entry.usable && <small>{t("themeMenu.unavailable")}</small>}</span>
      {checked && <Check size={14} aria-hidden="true" />}
    </button>;
  };

  return <>
    <button ref={trigger} className={styles.trigger} aria-label={t("settings.theme")} title={t("settings.theme")}
      aria-haspopup="menu" aria-expanded={open} onClick={() => open ? close() : setOpen(true)}
      onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openAtEnd.current = e.key === "ArrowUp"; setOpen(true); } }}>
      <Palette size={14} /><span className={styles.triggerLabel}>{t("settings.theme")}</span><ChevronDown size={12} />
    </button>
    {open && createPortal(<div className={styles.overlay} data-context-menu onMouseDown={close}>
      <div ref={root} role="menu" aria-label={t("settings.theme")} className={styles.menu}
        style={{ left: position.left, top: position.top, visibility: page && position.stacked ? "hidden" : undefined }}
        onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => keys(e, false)}>
        <div className={styles.modes} role="group" aria-label={t("systemSettings.appearance.modeLabel")}>
          {modes.map((value) => <button key={value} role="menuitemradio" aria-checked={mode === value}
            className={styles.mode} onFocus={() => setPage(null)} onMouseEnter={(e) => leaveChild(e.currentTarget)}
            onClick={() => select(() => useAppStore.getState().setTheme(value))}>{t(`settings.${value}`)}</button>)}
        </div>
        {(["ui", "markdown"] as Page[]).map((value) => <button key={value} ref={(el) => { branches.current[value] = el; }}
          role="menuitem" aria-haspopup="menu" aria-expanded={page === value} className={styles.item}
          onMouseEnter={() => { if (!position.stacked) enter(value); }} onClick={() => enter(value, true)}
          onFocus={() => { if (page && page !== value) setPage(null); }}
          onKeyDown={(e) => { if (e.key === "ArrowRight") { e.preventDefault(); enter(value, true); } }}>
          <span className={styles.label}>{t(value === "ui" ? "themeMenu.appearance" : "themeMenu.markdown")}
            <small>{value === "ui" ? selectedName(ui, scheme === "dark" ? dark : light) : selectedName(md, markdown)}</small></span>
          <ChevronRight size={14} />
        </button>)}
        {(loading || error) && <p className={styles.note} role="status">{t(error ? "themeMenu.loadFailed" : "themeMenu.loading")}</p>}
        <div className={styles.divider} />
        <button role="menuitem" className={styles.item} onFocus={() => setPage(null)} onMouseEnter={(e) => leaveChild(e.currentTarget)}
          onClick={() => select(() => useAppStore.getState().openSettings("appearance"))}>{t("themeMenu.settings")}</button>
      </div>
      {page && <div ref={child} role="menu" aria-label={t(page === "ui" ? "themeMenu.appearance" : "themeMenu.markdown")}
        className={styles.menu} style={{ left: position.childLeft, top: position.childTop }}
        onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => keys(e, true)}>
        {position.stacked && <button role="menuitem" className={styles.item} onClick={back}><ArrowLeft size={14} />{t("themeMenu.back")}</button>}
        {page === "ui" ? (mode === "system" ? ["light", "dark"] as const : [mode]).map((polarity) =>
          <div key={polarity} role="group" aria-label={t(`settings.${polarity}`)}>
            <p className={styles.note}>{t(`settings.${polarity}`)}</p>
            {ui.filter((entry) => entry.scheme === polarity).map(renderEntry)}
          </div>) : <>{md.map(renderEntry)}<p className={styles.note}>{t("themeMenu.markdownHint")}</p></>}
      </div>}
    </div>, document.body)}
  </>;
}
