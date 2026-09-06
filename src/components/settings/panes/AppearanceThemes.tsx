/**
 * 设置 → 通用 → 外观 → 外观主题 / Markdown 排版主题 (设计稿 05i 屏 1a–1f).
 *
 * Three pieces, all reading `themeStore`: the appearance grid — one band
 * per polarity the mode needs (1z A1: 跟随系统 is a pair, so two bands; a
 * fixed mode shows one, its band head still standing as the section's
 * colophon) — the typography grid, whose samples are sandboxed frames each
 * carrying the export's own stylesheet (`lib/theme/sample`), and the action
 * row the whole 外观 section ends on (打开主题文件夹 · 重新载入 ·
 * 把当前主题导出为文件).
 *
 * Every card is a real `ThemeEntry`; the three ways a file can be bad each
 * have their own card and none of them is a dialog (1z A4, B1, B2): a theme
 * with dropped rules is a normal, selectable card with one ochre note and an
 * in-place 详情 table; an unreadable file is a solid-edged card that cannot
 * be selected; an absent file is a dashed card with no 「移除」 — putting the
 * file back is what revives it, and clicking another card is how one moves on.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../../../stores/appStore";
import { useThemeStore } from "../../../stores/themeStore";
import {
  displayThemeName, resolveMarkdownTheme, resolveUiTheme, usableCount, type ThemeEntry,
} from "../../../lib/theme/registry";
import { SCHEME_ATTR, THEME_ATTR, useScheme, type ColorScheme } from "../../../lib/theme/scheme";
import { exportThemeToFolder } from "../../../lib/theme/exportFile";
import { TOKEN_CONTRACT } from "../../../lib/theme/contractData";
import { inlinedMarkdownCss } from "../../../lib/theme/install";
import { sampleDocument } from "../../../lib/theme/sample";
import { PROJECT_THEMES_DIR } from "../../../lib/theme/scan";
import { openWithDefaultApp } from "../../../lib/fs/fileio";
import ui from "../settingsUi.module.css";
import s from "./ThemeCards.module.css";

const SAMPLE = { zh: "第三章 · 渡口", en: "Chapter Three" };

/** `…/themes/宣纸.css` / `.ai-writer/themes/brand.css` — the folder and the file (1z A2). */
function shortPath(entry: ThemeEntry): string {
  const file = entry.fileName ?? `${entry.id}.css`;
  return entry.source === "project" ? `${PROJECT_THEMES_DIR}/${file}` : `…/themes/${file}`;
}

// ─── The appearance grid ─────────────────────────────────────────────────────

export function AppearanceThemeGrid() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const mode = useAppStore((st) => st.theme);
  const themeLight = useAppStore((st) => st.themeLight);
  const themeDark = useAppStore((st) => st.themeDark);
  const setThemeFor = useAppStore((st) => st.setThemeFor);
  const entries = useThemeStore((st) => st.ui);
  const load = useThemeStore((st) => st.load);
  const current = useScheme();

  useEffect(() => { void load(); }, [load]);

  // Band order is fixed 浅 → 深 and never swaps with the OS (1z A1).
  const bands: ColorScheme[] = mode === "system" ? ["light", "dark"] : [current];
  const selected = { light: themeLight, dark: themeDark };

  return (
    <div className={ui.rowStacked}>
      <div className={ui.rowTitleLine}>
        <span className={ui.rowTitle}>{t("systemSettings.general.uiThemeLabel")}</span>
        <span className={s.tag}>{t("systemSettings.general.uiThemeCount", { count: usableCount(entries) })}</span>
      </div>
      <div className={ui.rowDesc}>{t("systemSettings.general.uiThemeHint")}</div>
      {bands.map((scheme) => {
        const resolved = resolveUiTheme(entries, scheme, selected[scheme]);
        const cards = entries.filter((e) => e.scheme === scheme);
        return (
          <div key={scheme} className={s.band}>
            <div className={s.bandHead}>
              <span>{t(scheme === "light" ? "systemSettings.general.bandLight" : "systemSettings.general.bandDark")}</span>
              <span className={s.bandRule} />
              <span className={s.bandCurrent}>{displayThemeName(resolved, isZh)}</span>
            </div>
            <div className={s.grid}>
              {cards.map((entry) => (
                <ThemeCard
                  key={entry.id}
                  entry={entry}
                  active={resolved.id === entry.id}
                  isZh={isZh}
                  onPick={() => setThemeFor(scheme, entry.id)}
                  sample={<Swatch entry={entry} isZh={isZh} />}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── The typography grid ─────────────────────────────────────────────────────

export function MarkdownThemeGrid() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const markdownTheme = useAppStore((st) => st.markdownTheme);
  const setMarkdownTheme = useAppStore((st) => st.setMarkdownTheme);
  const themeLight = useAppStore((st) => st.themeLight);
  const themeDark = useAppStore((st) => st.themeDark);
  const entries = useThemeStore((st) => st.markdown);
  const uiEntries = useThemeStore((st) => st.ui);
  const load = useThemeStore((st) => st.load);
  const scheme = useScheme();

  useEffect(() => { void load(); }, [load]);

  const resolved = resolveMarkdownTheme(entries, markdownTheme);
  // The samples follow the appearance in force (1e): night paints them dark.
  const appearance = resolveUiTheme(uiEntries, scheme, scheme === "light" ? themeLight : themeDark);

  return (
    <div className={`${ui.rowStacked} ${ui.rowLast}`}>
      <div className={ui.rowTitleLine}>
        <span className={ui.rowTitle}>{t("systemSettings.general.mdThemeLabel")}</span>
        <span className={s.tag}>{t("systemSettings.general.mdThemeCount", { count: usableCount(entries) })}</span>
      </div>
      <div className={ui.rowDesc}>{t("systemSettings.general.mdThemeHint")}</div>
      <div className={`${s.grid} ${s.gridMd}`}>
        {entries.map((entry) => (
          <ThemeCard
            key={`${entry.source}:${entry.id}`}
            entry={entry}
            active={resolved.id === entry.id}
            isZh={isZh}
            onPick={() => setMarkdownTheme(entry.id)}
            sample={<MdSample entry={entry} appearance={appearance} scheme={scheme} isZh={isZh} />}
          />
        ))}
      </div>
      <ThemeActions />
    </div>
  );
}

// ─── One card ────────────────────────────────────────────────────────────────

function ThemeCard({
  entry, active, isZh, onPick, sample,
}: {
  entry: ThemeEntry;
  active: boolean;
  isZh: boolean;
  onPick: () => void;
  sample: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const name = displayThemeName(entry, isZh);
  const md = entry.kind === "markdown";
  const schemeTag = md
    ? ""
    : t(entry.scheme === "light" ? "systemSettings.general.schemeLight" : "systemSettings.general.schemeDark");
  const base = md
    ? displayThemeName(entry.missing ? { name: { zh: "手稿", en: "Manuscript" } } : baseOf(entry), isZh)
    : t(entry.extends === "paper" ? "systemSettings.general.builtinPaper" : "systemSettings.general.builtinNight");

  const absent = !!entry.missing;
  const unreadable = !entry.usable && !absent;
  const selectable = entry.usable && !absent;
  const cls = [
    s.card,
    md ? s.cardMd : "",
    active ? s.cardActive : "",
    absent ? s.cardAbsent : "",
    unreadable ? s.cardUnreadable : "",
    open ? s.cardWide : "",
  ].filter(Boolean).join(" ");

  const foot = entry.source === "builtin"
    ? t("systemSettings.general.sourceBuiltin")
    : absent || unreadable
      ? shortPath(entry)
      : entry.source === "project"
        ? `${shortPath(entry)} · ${t("systemSettings.general.sourceProject")}`
        : md
          ? shortPath(entry)
          : `${shortPath(entry)} · ${t("systemSettings.general.sourceOn", { base })}`;

  const problems = entry.problems;
  const noteHead = unreadable
    ? (problems[0]?.reason ?? "")
    : problems.length
      ? `${t("systemSettings.general.ignoredNote", { count: problems.length })} · ${problemHint(problems[0])}`
      : "";

  const body: ReactNode = absent ? (
    <div className={`${s.slot} ${md ? s.slotMd : ""} ${s.slotAbsent}`}>
      {t("systemSettings.general.absentText", { file: entry.fileName, base })}
    </div>
  ) : unreadable ? (
    <div className={`${s.slot} ${md ? s.slotMd : ""} ${s.slotUnreadable}`}>{t("systemSettings.general.unreadableText")}</div>
  ) : (
    sample
  );

  const content = (
    <div className={s.cardBody}>
      <div className={s.cardMain}>
        {body}
        <div className={s.nameRow}>
          <span className={s.name}>{name}</span>
          {!md && (
            <span className={`${s.tag} ${absent ? s.tagAbsent : ""}`}>
              {unreadable ? "—" : absent ? `${schemeTag} · ${t("systemSettings.general.absentTag")}` : schemeTag}
            </span>
          )}
          {md && absent && <span className={`${s.tag} ${s.tagAbsent}`}>{t("systemSettings.general.absentTag")}</span>}
        </div>
        {md && entry.desc && <div className={s.desc}>{isZh ? entry.desc.zh : entry.desc.en}</div>}
        {md && (entry.ownFonts || entry.ownColors) && (
          <div className={s.badges}>
            {entry.ownFonts && (
              <span><b className={s.badge}>{t("systemSettings.general.ownFonts")}</b> {t("systemSettings.general.ownFontsNote")}</span>
            )}
            {entry.ownColors && (
              <span><b className={s.badge}>{t("systemSettings.general.ownColors")}</b> {t("systemSettings.general.ownColorsNote")}</span>
            )}
          </div>
        )}
        <div className={s.foot} title={entry.path}>{foot}</div>
        {absent && (
          <div className={`${s.note} ${s.absentActions}`}>
            {t("systemSettings.general.absentAction")} · <ReloadLink />
          </div>
        )}
        {!absent && noteHead && (
          <div className={s.note}>
            {noteHead} ·{" "}
            <button type="button" className={s.noteLink} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
              {t(open ? "systemSettings.general.collapse" : "systemSettings.general.details")}
            </button>
          </div>
        )}
      </div>
      {open && !absent && <ProblemTable entry={entry} />}
    </div>
  );

  // A div with a button role rather than a <button>: the card carries real
  // buttons of its own (详情 / 在编辑器里打开 / 重新载入), and a button cannot
  // nest one. Absent and unreadable cards get no role — nothing to pick.
  if (!selectable) return <div className={cls}>{content}</div>;
  return (
    <div
      className={cls}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(); }
      }}
    >
      {content}
    </div>
  );
}

/** The built-in a typography file extends, as a nameable thing. */
function baseOf(entry: ThemeEntry): { name: ThemeEntry["name"] } {
  const hit = useThemeStore.getState().markdown.find((e) => e.source === "builtin" && e.id === entry.extends);
  return { name: hit?.name ?? entry.extends };
}

/** 「body 越界」 — the first problem's selector and the head of its reason. */
function problemHint(p: { selector?: string; reason: string }): string {
  const head = p.reason.split(" · ")[0];
  const sel = (p.selector ?? "").split(" ").pop() ?? "";
  return sel ? `${sel} ${head}` : head;
}

/**
 * The appearance swatch is drawn from the theme's own tokens, not from the
 * page's: the element carries `data-theme` / `data-scheme` itself, so
 * `tokens.scheme` and `tokens.user` declare the six core tokens *on it*,
 * beating what the settings page's remap would otherwise pass down.
 * Built-ins and user themes are drawn by the same rule (1z B4).
 */
function Swatch({ entry, isZh }: { entry: ThemeEntry; isZh: boolean }) {
  return (
    <div className={s.swatch} {...{ [THEME_ATTR]: entry.id, [SCHEME_ATTR]: entry.scheme }} aria-hidden>
      <div className={s.swatchSide}>
        <div className={s.swatchAccent} />
        <div className={s.swatchBar} />
        <div className={s.swatchBar} />
      </div>
      <div className={s.swatchMain}>
        <div className={s.swatchText}>{isZh ? SAMPLE.zh : SAMPLE.en}</div>
        <div className={s.swatchLine} />
        <div className={s.swatchLine} />
        <div className={s.swatchLine} />
      </div>
      <div className={s.swatchRail}>
        <div className={s.swatchBar} />
        <div className={s.swatchBar} />
      </div>
    </div>
  );
}

/**
 * A typography sample: a sandboxed frame with the export's stylesheet and a
 * page of real text. `sandbox=""` — no scripts, no same-origin, ever. The
 * frame is a picture: `pointer-events: none`, out of the tab order.
 */
function MdSample({
  entry, appearance, scheme, isZh,
}: {
  entry: ThemeEntry;
  appearance: ThemeEntry;
  scheme: ColorScheme;
  isZh: boolean;
}) {
  const [userCss, setUserCss] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    if (entry.source === "builtin" || !entry.css) { setUserCss(""); return; }
    void inlinedMarkdownCss(entry).then((css) => { if (!cancelled) setUserCss(css); });
    return () => { cancelled = true; };
  }, [entry]);
  const doc = useMemo(
    () => sampleDocument(entry, userCss, appearance, scheme, isZh),
    [entry, userCss, appearance, scheme, isZh],
  );
  return (
    <iframe
      className={s.mdSample}
      title={displayThemeName(entry, isZh)}
      sandbox=""
      srcDoc={doc}
      tabIndex={-1}
      aria-hidden
      loading="lazy"
    />
  );
}

function ProblemTable({ entry }: { entry: ThemeEntry }) {
  const { t } = useTranslation();
  return (
    <div className={s.details}>
      <table className={s.detailsTable}>
        <thead>
          <tr>
            <th>{t("systemSettings.general.colRule")}</th>
            <th>{t("systemSettings.general.colSelector")}</th>
            <th>{t("systemSettings.general.colReason")}</th>
          </tr>
        </thead>
        <tbody>
          {entry.problems.map((p, i) => (
            <tr key={i}>
              <td>{p.rule || ""}</td>
              <td>{p.selector ?? ""}</td>
              <td>{p.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={s.detailsFoot}>
        {entry.usable && `${t("systemSettings.general.detailsFoot", { count: entry.kept })} · `}
        {entry.path && (
          <button
            type="button"
            className={s.noteLink}
            onClick={(e) => { e.stopPropagation(); void openWithDefaultApp(entry.path as string).catch(() => {}); }}
          >
            {t("systemSettings.general.openInEditor")}
          </button>
        )}
      </div>
    </div>
  );
}

function ReloadLink() {
  const { t, i18n } = useTranslation();
  const reload = useThemeStore((st) => st.reload);
  return (
    <button type="button" className={s.noteLink} onClick={() => void reload(i18n.language.startsWith("zh"))}>
      {t("systemSettings.general.reloadThemes")}
    </button>
  );
}

// ─── The action row ──────────────────────────────────────────────────────────

type Trace =
  | { kind: "reloaded"; text: string }
  | { kind: "exported"; fileName: string; dir: string; path: string }
  | { kind: "error"; text: string };

export function ThemeActions() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const reload = useThemeStore((st) => st.reload);
  const loading = useThemeStore((st) => st.loading);
  const ensureDir = useThemeStore((st) => st.ensureDir);
  const entries = useThemeStore((st) => st.ui);
  const themeLight = useAppStore((st) => st.themeLight);
  const themeDark = useAppStore((st) => st.themeDark);
  const scheme = useScheme();
  const [trace, setTrace] = useState<Trace | null>(null);
  const [leaving, setLeaving] = useState(false);
  const timers = useRef<number[]>([]);

  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  useEffect(() => clearTimers, []);

  /** The reload trace is the one that fades: success usually changes nothing (1z C2). */
  const showFading = (next: Trace) => {
    clearTimers();
    setLeaving(false);
    setTrace(next);
    timers.current.push(
      window.setTimeout(() => setLeaving(true), 1600),
      window.setTimeout(() => { setTrace(null); setLeaving(false); }, 1760),
    );
  };
  const showSticky = (next: Trace) => {
    clearTimers();
    setLeaving(false);
    setTrace(next);
  };

  const openFolder = async () => {
    try {
      await revealItemInDir(await ensureDir());
    } catch (e) {
      showSticky({ kind: "error", text: String(e) });
    }
  };

  const doReload = async () => {
    try {
      const diff = await reload(isZh);
      const unit = (kind: ThemeEntry["kind"]) =>
        t(kind === "ui" ? "systemSettings.general.uiThemeUnit" : "systemSettings.general.mdThemeUnit");
      const parts = [
        ...diff.added.map((d) => `+1 ${unit(d.kind)} · ${d.name}`),
        ...diff.removed.map((d) => `−1 ${unit(d.kind)} · ${d.name}`),
      ];
      showFading({
        kind: "reloaded",
        text: parts.length
          ? t("systemSettings.general.reloadedChanged", { ui: diff.uiCount, md: diff.mdCount, diff: parts.join(" · ") })
          : t("systemSettings.general.reloadedNoChange", { ui: diff.uiCount, md: diff.mdCount }),
      });
    } catch (e) {
      showSticky({ kind: "error", text: String(e) });
    }
  };

  const doExport = async () => {
    const entry = resolveUiTheme(entries, scheme, scheme === "light" ? themeLight : themeDark);
    try {
      const dir = await ensureDir();
      const { fileName, path } = await exportThemeToFolder(entry, dir, TOKEN_CONTRACT, isZh);
      showSticky({ kind: "exported", fileName, dir, path });
    } catch (e) {
      showSticky({ kind: "error", text: t("systemSettings.general.exportFailed", { error: String(e) }) });
    }
  };

  return (
    <>
      <div className={s.actions}>
        <button type="button" className={ui.rowBtn} onClick={() => void openFolder()}>
          {t("systemSettings.general.openThemesFolder")}
        </button>
        <button type="button" className={ui.rowBtn} onClick={() => void doReload()} disabled={loading}>
          {t("systemSettings.general.reloadThemes")}
        </button>
        <span className={s.actionsSpacer} />
        <div className={s.exportWrap}>
          <button type="button" className={s.btnAccent} onClick={() => void doExport()}>
            {t("systemSettings.general.exportTheme")}
          </button>
          <div className={s.exportHint}>{t("systemSettings.general.exportHint")}</div>
        </div>
      </div>
      {trace && (
        <div className={`${s.trace} ${leaving ? s.traceLeaving : ""} ${trace.kind === "error" ? s.traceError : ""}`}>
          {trace.kind === "reloaded" && <span>{trace.text}</span>}
          {trace.kind === "error" && <span>{trace.text}</span>}
          {trace.kind === "exported" && (
            <>
              <span>{t("systemSettings.general.exported", { file: trace.fileName })}</span>
              <span className={s.traceDim}>{trace.dir}</span>
              <button
                type="button"
                className={s.traceLink}
                onClick={() => void revealItemInDir(trace.path).catch(() => {})}
              >
                {t("systemSettings.general.openFolder")}
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
