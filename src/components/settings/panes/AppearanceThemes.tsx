/**
 * 设置 → 外观 的主题件：外观主题 / Markdown 排版主题 / 主题文件 (设计稿 05i
 * 屏 1a–1f 的卡与坏主题，05m 把它们各自立成一节).
 *
 * Four pieces, all reading `themeStore`: the appearance bands — one band
 * per polarity the mode needs (1z A1: 跟随系统 is a pair, so two bands; a
 * fixed mode shows one, its band head still standing as the section's
 * colophon) — the typography grid, whose samples are sandboxed frames each
 * carrying the export's own stylesheet (`lib/theme/sample`), the 主题文件
 * section (打开文件夹 · 重新载入 · 导出当前外观主题), and `NowSpecimen`, the
 * page's 「此刻」 window that stacks all three axes into one picture.
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
import type { TFunction } from "i18next";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../../../stores/appStore";
import { useThemeStore } from "../../../stores/themeStore";
import {
  displayThemeName, resolveMarkdownTheme, resolveUiTheme, usableCount, type ThemeEntry,
} from "../../../lib/theme/registry";
import { SCHEME_ATTR, THEME_ATTR, useScheme, type ColorScheme } from "../../../lib/theme/scheme";
import { exportThemeToFolder } from "../../../lib/theme/exportFile";
import { TOKEN_CONTRACT } from "../../../lib/theme/contractData";
import { inlinedMarkdownCss } from "../../../lib/theme/install";
import { isFontPackId } from "../../../lib/theme/fontPacks";
import { sampleDocument, type SampleSize } from "../../../lib/theme/sample";
import { PROJECT_THEMES_DIR } from "../../../lib/theme/scan";
import type { ThemeProblem } from "../../../lib/theme/manifest";
import { openWithDefaultApp } from "../../../lib/fs/fileio";
import { baseName } from "../../../lib/paths";
import { Row } from "./bits";
import ui from "../settingsUi.module.css";
import s from "./ThemeCards.module.css";

const SAMPLE = { zh: "第三章 · 渡口", en: "Chapter Three" };

/** A problem's reason in the interface's language — the code is what the file carries. */
function reasonText(p: ThemeProblem, t: TFunction): string {
  const key = p.reason === "unreadableFile" && p.params?.error ? "unreadableFileError" : p.reason;
  return t(`systemSettings.appearance.reason.${key}`, { ...p.params, defaultValue: p.reason });
}

/** `…/themes/宣纸.css` / `.ai-writer/themes/brand.css` — the folder and the file (1z A2). */
function shortPath(entry: ThemeEntry): string {
  const file = entry.fileName ?? `${entry.id}.css`;
  return entry.source === "project" ? `${PROJECT_THEMES_DIR}/${file}` : `…/themes/${file}`;
}

// ─── The appearance grid ─────────────────────────────────────────────────────

/** 「3 个可用」 — the count the 外观主题 section head carries on its right. */
export function UiThemeCount() {
  const { t } = useTranslation();
  const entries = useThemeStore((st) => st.ui);
  return <span className={s.tag}>{t("systemSettings.appearance.uiThemeCount", { count: usableCount(entries) })}</span>;
}

/** 「7 个」 — the typography section's count. */
export function MdThemeCount() {
  const { t } = useTranslation();
  const entries = useThemeStore((st) => st.markdown);
  return <span className={s.tag}>{t("systemSettings.appearance.mdThemeCount", { count: usableCount(entries) })}</span>;
}

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
    <div className={`${ui.rowStacked} ${ui.rowLast}`}>
      {bands.map((scheme) => {
        const resolved = resolveUiTheme(entries, scheme, selected[scheme]);
        const cards = entries.filter((e) => e.scheme === scheme);
        return (
          <div key={scheme} className={s.band}>
            <div className={s.bandHead}>
              <span>{t(scheme === "light" ? "systemSettings.appearance.bandLight" : "systemSettings.appearance.bandDark")}</span>
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
      <div className={`${ui.rowDesc} ${s.afterGrid}`}>{t("systemSettings.appearance.uiThemeHint")}</div>
    </div>
  );
}

// ─── The typography grid ─────────────────────────────────────────────────────

/** The downloadable examples + the author's guide (`themes/README.md` in the repo). */
const THEMES_EXAMPLES_URL = "https://github.com/Joycai/simple-ai-writer/tree/main/themes";

export function MarkdownThemeGrid() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const markdownTheme = useAppStore((st) => st.markdownTheme);
  const setMarkdownTheme = useAppStore((st) => st.setMarkdownTheme);
  const themeLight = useAppStore((st) => st.themeLight);
  const themeDark = useAppStore((st) => st.themeDark);
  const fontScheme = useAppStore((st) => st.fontScheme);
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
      <div className={ui.rowDesc}>
        {t("systemSettings.appearance.mdThemeHint")}{" "}
        {/* Opened through the shell, not the webview — a Tauri window has no tabs to come back from. */}
        <a
          className={s.noteLink}
          href={THEMES_EXAMPLES_URL}
          onClick={(e) => { e.preventDefault(); openUrl(THEMES_EXAMPLES_URL).catch(() => { /* best-effort */ }); }}
        >
          {t("systemSettings.appearance.mdThemeExamples")} ↗
        </a>
      </div>
      <div className={`${s.grid} ${s.gridMd}`}>
        {entries.map((entry) => (
          <ThemeCard
            key={`${entry.source}:${entry.id}`}
            entry={entry}
            active={resolved.id === entry.id}
            isZh={isZh}
            onPick={() => setMarkdownTheme(entry.id)}
            sample={<MdSample entry={entry} appearance={appearance} scheme={scheme} fontScheme={fontScheme} isZh={isZh} />}
          />
        ))}
      </div>
    </div>
  );
}

// ─── 此刻：三根轴叠在一扇窗里 ────────────────────────────────────────────────

/** Which section a 「此刻」 caption jumps to. */
export type AppearanceAxis = "ui" | "font" | "md";

/** A 「此刻」 page is read, not thumbnailed: reading size, two paragraphs. */
const NOW_SAMPLE = { size: 13, padding: "20px 34px", long: true };

/**
 * 「此刻」 (设计稿 05m 1a): the appearance theme in force, drawn as a small
 * window — side panel and AI rail from its own tokens, as the swatch does —
 * with a real page of the typography theme in the middle, set in the current
 * font scheme. The three grids below each show one axis; this is the only
 * place they are seen stacked, which is how they meet while writing
 * (typography borrows the appearance's colours; the font scheme sets its body
 * face unless the theme brings its own).
 *
 * It is a picture like the cards' samples: no hover, not in the tab order.
 * The three names under it are the only controls — each jumps to its section,
 * since after reading the combination the author changes one axis.
 */
export function NowSpecimen({ fontName, onJump }: { fontName: string; onJump: (axis: AppearanceAxis) => void }) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const mode = useAppStore((st) => st.theme);
  const themeLight = useAppStore((st) => st.themeLight);
  const themeDark = useAppStore((st) => st.themeDark);
  const markdownTheme = useAppStore((st) => st.markdownTheme);
  const fontScheme = useAppStore((st) => st.fontScheme);
  const uiEntries = useThemeStore((st) => st.ui);
  const mdEntries = useThemeStore((st) => st.markdown);
  const scheme = useScheme();

  const appearance = resolveUiTheme(uiEntries, scheme, scheme === "light" ? themeLight : themeDark);
  const md = resolveMarkdownTheme(mdEntries, markdownTheme);
  const schemeWord = t(scheme === "light" ? "settings.light" : "settings.dark");
  const modeNote = mode === "system" ? t("systemSettings.appearance.nowFollow", { scheme: schemeWord }) : schemeWord;

  const parts: { axis: AppearanceAxis; label: string; name: string }[] = [
    { axis: "ui", label: t("systemSettings.appearance.nowUi"), name: displayThemeName(appearance, isZh) },
    { axis: "font", label: t("systemSettings.appearance.nowFont"), name: fontName },
    { axis: "md", label: t("systemSettings.appearance.nowMd"), name: displayThemeName(md, isZh) },
  ];

  return (
    <figure className={s.now} aria-label={t("systemSettings.appearance.nowTitle")}>
      <div className={s.nowWin} {...{ [THEME_ATTR]: appearance.id, [SCHEME_ATTR]: appearance.scheme }} aria-hidden>
        <div className={s.nowSide}>
          <div className={s.nowSideHead}>
            <span className={s.swatchAccent} />
            <span className={s.nowSideTitle} />
          </div>
          <div className={s.swatchBar} />
          <div className={s.swatchBar} />
          <div className={s.swatchBar} />
          <div className={s.swatchBar} />
        </div>
        <MdSample
          entry={md}
          appearance={appearance}
          scheme={scheme}
          fontScheme={fontScheme}
          isZh={isZh}
          sizing={NOW_SAMPLE}
          className={s.nowPage}
        />
        <div className={s.nowRail}>
          <span className={s.nowSideTitle} />
          <div className={s.nowBubble}><div className={s.swatchBar} /><div className={s.swatchBar} /></div>
          <div className={s.nowBubble}><div className={s.swatchBar} /><div className={s.swatchBar} /></div>
        </div>
      </div>
      <figcaption className={s.nowCaption}>
        {parts.map((p) => (
          <button
            key={p.axis}
            type="button"
            className={s.nowPart}
            title={t("systemSettings.appearance.nowJump")}
            onClick={() => onJump(p.axis)}
          >
            <span className={s.nowPartLabel}>{p.label}</span>
            <span className={s.nowPartName}>{p.name}</span>
          </button>
        ))}
        <span className={s.nowMode}>{modeNote}</span>
      </figcaption>
    </figure>
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
    : t(entry.scheme === "light" ? "systemSettings.appearance.schemeLight" : "systemSettings.appearance.schemeDark");
  const base = md
    ? displayThemeName(entry.missing ? { name: { zh: "手稿", en: "Manuscript" } } : baseOf(entry), isZh)
    : t(entry.extends === "paper" ? "systemSettings.appearance.builtinPaper" : "systemSettings.appearance.builtinNight");

  const absent = !!entry.missing;
  const unreadable = !entry.usable && !absent;
  const selectable = entry.usable && !absent;
  const cls = [
    s.card,
    active ? s.cardActive : "",
    absent ? s.cardAbsent : "",
    unreadable ? s.cardUnreadable : "",
    open ? s.cardWide : "",
  ].filter(Boolean).join(" ");

  const foot = entry.source === "builtin"
    ? t("systemSettings.appearance.sourceBuiltin")
    : absent || unreadable
      ? shortPath(entry)
      : entry.source === "project"
        ? `${shortPath(entry)} · ${t("systemSettings.appearance.sourceProject")}`
        : md
          ? shortPath(entry)
          : `${shortPath(entry)} · ${t("systemSettings.appearance.sourceOn", { base })}`;

  const problems = entry.problems;
  const noteHead = unreadable
    ? (problems[0] ? reasonText(problems[0], t) : "")
    : problems.length
      ? `${t("systemSettings.appearance.ignoredNote", { count: problems.length })} · ${problemHint(problems[0], t)}`
      : "";

  const body: ReactNode = absent ? (
    <div className={`${s.slot} ${md ? s.slotMd : ""} ${s.slotAbsent}`}>
      {t("systemSettings.appearance.absentText", { file: entry.fileName, base })}
    </div>
  ) : unreadable ? (
    <div className={`${s.slot} ${md ? s.slotMd : ""} ${s.slotUnreadable}`}>{t("systemSettings.appearance.unreadableText")}</div>
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
              {unreadable ? "—" : absent ? `${schemeTag} · ${t("systemSettings.appearance.absentTag")}` : schemeTag}
            </span>
          )}
          {md && absent && <span className={`${s.tag} ${s.tagAbsent}`}>{t("systemSettings.appearance.absentTag")}</span>}
        </div>
        {md && entry.desc && <div className={s.desc}>{isZh ? entry.desc.zh : entry.desc.en}</div>}
        {md && (entry.ownFonts || entry.ownColors) && (
          <div className={s.badges}>
            {entry.ownFonts && (
              <span><b className={s.badge}>{t("systemSettings.appearance.ownFonts")}</b> {t("systemSettings.appearance.ownFontsNote")}</span>
            )}
            {entry.ownColors && (
              <span><b className={s.badge}>{t("systemSettings.appearance.ownColors")}</b> {t("systemSettings.appearance.ownColorsNote")}</span>
            )}
          </div>
        )}
        <div className={s.foot} title={entry.path}>{foot}</div>
        {absent && (
          <div className={`${s.note} ${s.absentActions}`}>
            {t("systemSettings.appearance.absentAction")} · <ReloadLink />
          </div>
        )}
        {!absent && noteHead && (
          <div className={s.note}>
            {noteHead} ·{" "}
            <button type="button" className={s.noteLink} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
              {t(open ? "systemSettings.appearance.collapse" : "systemSettings.appearance.details")}
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
function problemHint(p: ThemeProblem, t: TFunction): string {
  const head = reasonText(p, t).split(" · ")[0];
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
  entry, appearance, scheme, fontScheme, isZh, sizing, className,
}: {
  entry: ThemeEntry;
  appearance: ThemeEntry;
  scheme: ColorScheme;
  fontScheme: string;
  isZh: boolean;
  /** Defaults to the card thumbnail. */
  sizing?: SampleSize;
  className?: string;
}) {
  const [userCss, setUserCss] = useState<string>("");
  // The frame can't see the page's `@font-face` rules — hand the packs' in.
  const faces = useAppStore((st) => (isFontPackId(fontScheme) ? st.fontFaces[fontScheme] ?? "" : ""));
  useEffect(() => {
    let cancelled = false;
    if (entry.source === "builtin" || !entry.css) { setUserCss(""); return; }
    void inlinedMarkdownCss(entry).then((css) => { if (!cancelled) setUserCss(css); });
    return () => { cancelled = true; };
  }, [entry]);
  const doc = useMemo(
    () => sampleDocument(entry, userCss, appearance, scheme, isZh, fontScheme, sizing, faces),
    [entry, userCss, appearance, scheme, isZh, fontScheme, sizing, faces],
  );
  return (
    <iframe
      className={className ?? s.mdSample}
      title={displayThemeName(entry, isZh)}
      sandbox=""
      srcDoc={doc}
      tabIndex={-1}
      aria-hidden
      // The cards run below the fold; the 「此刻」 page is the first thing on screen.
      loading={className ? "eager" : "lazy"}
    />
  );
}

function ProblemTable({ entry }: { entry: ThemeEntry }) {
  const { t } = useTranslation();
  // 「在编辑器里打开」交给系统默认程序，会失败（没关联程序、文件刚被删、在围栏外）。
  // 失败留在原地、不自己消失——和这一页 `ThemeFiles` 的错误痕迹同一口径（showSticky）；
  // 那条痕迹在页面底部，离这张卡太远，所以写在表脚里。收起卡片即清掉。
  const [openError, setOpenError] = useState<string | null>(null);
  const openInEditor = async (path: string) => {
    setOpenError(null);
    try {
      await openWithDefaultApp(path);
    } catch (e) {
      console.error("[AppearanceThemes] open with default app failed:", e);
      setOpenError(`${t("fileTree.openExternalFailed", { name: baseName(path) })} ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <div className={s.details}>
      <table className={s.detailsTable}>
        <thead>
          <tr>
            <th>{t("systemSettings.appearance.colRule")}</th>
            <th>{t("systemSettings.appearance.colSelector")}</th>
            <th>{t("systemSettings.appearance.colReason")}</th>
          </tr>
        </thead>
        <tbody>
          {entry.problems.map((p, i) => (
            <tr key={i}>
              <td>{p.rule || ""}</td>
              <td>{p.selector ?? ""}</td>
              <td>{reasonText(p, t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={s.detailsFoot}>
        {entry.usable && `${t("systemSettings.appearance.detailsFoot", { count: entry.kept })} · `}
        {entry.path && (
          <button
            type="button"
            className={s.noteLink}
            onClick={(e) => { e.stopPropagation(); void openInEditor(entry.path as string); }}
          >
            {t("systemSettings.appearance.openInEditor")}
          </button>
        )}
        {openError && <div className={s.detailsError} role="alert">{openError}</div>}
      </div>
    </div>
  );
}

function ReloadLink() {
  const { t, i18n } = useTranslation();
  const reload = useThemeStore((st) => st.reload);
  return (
    <button type="button" className={s.noteLink} onClick={() => void reload(i18n.language.startsWith("zh"))}>
      {t("systemSettings.appearance.reloadThemes")}
    </button>
  );
}

// ─── 主题文件 ────────────────────────────────────────────────────────────────

type Trace =
  | { kind: "reloaded"; text: string }
  | { kind: "exported"; fileName: string; dir: string; path: string }
  | { kind: "error"; text: string };

export function ThemeFiles() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const reload = useThemeStore((st) => st.reload);
  const loading = useThemeStore((st) => st.loading);
  const ensureDir = useThemeStore((st) => st.ensureDir);
  const autoReload = useThemeStore((st) => st.autoReload);
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

  /** What one reload found, as the trace line says it. */
  const diffLine = (diff: { uiCount: number; mdCount: number; added: { kind: ThemeEntry["kind"]; name: string }[]; removed: { kind: ThemeEntry["kind"]; name: string }[] }, auto: boolean) => {
    const unit = (kind: ThemeEntry["kind"]) =>
      t(kind === "ui" ? "systemSettings.appearance.uiThemeUnit" : "systemSettings.appearance.mdThemeUnit");
    const parts = [
      ...diff.added.map((d) => `+1 ${unit(d.kind)} · ${d.name}`),
      ...diff.removed.map((d) => `−1 ${unit(d.kind)} · ${d.name}`),
    ];
    const vars = { ui: diff.uiCount, md: diff.mdCount, diff: parts.join(" · ") };
    if (auto) return t("systemSettings.appearance.autoReloaded", { ...vars, diff: parts.length ? vars.diff : t("systemSettings.appearance.noChange") });
    return parts.length
      ? t("systemSettings.appearance.reloadedChanged", vars)
      : t("systemSettings.appearance.reloadedNoChange", vars);
  };

  // The watcher's reloads leave the same trace the button does — unless the
  // export's sticky trace is up: its 「打开文件夹」 must not vanish under the
  // very reload that export just caused.
  const lastAuto = useRef(0);
  useEffect(() => {
    if (!autoReload || autoReload.seq === lastAuto.current) return;
    lastAuto.current = autoReload.seq;
    setTrace((cur) => {
      if (cur?.kind === "exported") return cur;
      clearTimers();
      setLeaving(false);
      timers.current.push(
        window.setTimeout(() => setLeaving(true), 1600),
        window.setTimeout(() => { setTrace(null); setLeaving(false); }, 1760),
      );
      return { kind: "reloaded", text: diffLine(autoReload.diff, true) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoReload]);

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
      showFading({ kind: "reloaded", text: diffLine(diff, false) });
    } catch (e) {
      showSticky({ kind: "error", text: String(e) });
    }
  };

  const current = resolveUiTheme(entries, scheme, scheme === "light" ? themeLight : themeDark);

  const doExport = async () => {
    try {
      const dir = await ensureDir();
      const { fileName, path } = await exportThemeToFolder(current, dir, TOKEN_CONTRACT, isZh);
      showSticky({ kind: "exported", fileName, dir, path });
    } catch (e) {
      showSticky({ kind: "error", text: t("systemSettings.appearance.exportFailed", { error: String(e) }) });
    }
  };

  // Two rows, not one action strip (05m 1n): the strip used to hang under the
  // typography grid and read as belonging to it, while the folder holds both
  // kinds of file and the export writes the *appearance* theme. The folder
  // row names the folder; the export row names what it exports. 05i C1's
  // weights still hold — two neutral buttons, the export ochre-outlined.
  return (
    <>
      <Row
        title={t("systemSettings.appearance.folderLabel")}
        desc={t("systemSettings.appearance.folderHint")}
      >
        <button type="button" className={ui.rowBtn} onClick={() => void openFolder()}>
          {t("systemSettings.appearance.openThemesFolder")}
        </button>
        <button type="button" className={ui.rowBtn} onClick={() => void doReload()} disabled={loading}>
          {t("systemSettings.appearance.reloadThemes")}
        </button>
      </Row>
      <Row
        title={t("systemSettings.appearance.exportLabel")}
        desc={`${t("systemSettings.appearance.exportFrom", { name: displayThemeName(current, isZh) })}${t("systemSettings.appearance.exportHint")}`}
        last
      >
        <button type="button" className={s.btnAccent} onClick={() => void doExport()}>
          {t("systemSettings.appearance.exportButton")}
        </button>
      </Row>
      {trace && (
        <div className={`${s.trace} ${leaving ? s.traceLeaving : ""} ${trace.kind === "error" ? s.traceError : ""}`}>
          {trace.kind === "reloaded" && <span>{trace.text}</span>}
          {trace.kind === "error" && <span>{trace.text}</span>}
          {trace.kind === "exported" && (
            <>
              <span>{t("systemSettings.appearance.exported", { file: trace.fileName })}</span>
              <span className={s.traceDim}>{trace.dir}</span>
              <button
                type="button"
                className={s.traceLink}
                onClick={() => void revealItemInDir(trace.path).catch(() => {})}
              >
                {t("systemSettings.appearance.openFolder")}
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
