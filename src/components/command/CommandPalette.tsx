/**
 * ⌘K —— 全局搜索（设计稿 21）。
 *
 * 一个输入框，三个去处：**文档**（项目里所有文件，按名字 + 分组路径）→ 编辑器打开并让
 * 文件树定位到它；**条目**（知识库全部分类）→ 切到知识库墙打开那张条目；**正文**（只搜
 * 当前打开的那一篇）→ 光标跳到那一行。同一个词命中文档和条目时，作者靠三条叠加的既有
 * 通道分辨 ↵ 会去哪：组头右端的目的地、行的左端形状（16px 描边图标 + mono 路径 vs
 * 24px 分类色块 + 斜体副行）、当前项的动词（打开 / 前往条目 / 跳到第 N 行）。
 *
 * 作用域是输入行右端的四枚 chip，Tab 轮换；前缀被删掉了——作用域藏在第一个字符里，
 * 输入长一点就滚出视野。空查询列本会话「最近去过」（混排，一条时间线不该按类拆开）；
 * 没打开项目时面板变成「最近项目」选择器。
 *
 * 匹配、排序、高亮区间全在 `lib/search/globalSearch`；这里只做接线和画行。
 * 设计与取舍：docs/feature/global-search-ui-brief.md
 */
import { useState, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Search, Sparkles, Check, File, FileText, FileCode, FileImage, Folder, FolderPlus,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useLoreStore } from "../../stores/loreStore";
import { useProjectStore, useTerms } from "../../stores/projectStore";
import { useEditorStore } from "../../stores/editorStore";
import { useAiTaskStore } from "../../stores/aiTaskStore";
import { useNavStore } from "../../stores/navStore";
import { indexCategories, type LoreEntity } from "../../lib/lore";
import { categoryLabel } from "../../lib/profile";
import { extLabel, isSecondary, rowKind, type RowKind } from "../../lib/fs/rowMeta";
import { splitProjects } from "../../lib/recentProjects";
import { comboLabel } from "../../lib/shortcuts";
import { useImeGuard } from "../../lib/ime";
import { baseName, dirName, isSamePath, pathKey, projectRelative } from "../../lib/paths";
import {
  matchText,
  recentLocations,
  searchFiles,
  searchLines,
  searchLore,
  windowAround,
  type FileHit,
  type LineHit,
  type LoreHit,
  type MatchRange,
  type RecentLocation,
  type SearchScope,
} from "../../lib/search/globalSearch";
import { categoryColor } from "../lore/catColor";
import { useImageThumbnails } from "../lore/useImageDataUrl";
import styles from "./CommandPalette.module.css";

// ─── 行 ──────────────────────────────────────────────────────────────────────

interface FileRow { kind: "file"; hit: FileHit; current: boolean }
interface LoreRow { kind: "lore"; hit: LoreHit<LoreEntity>; current: boolean }
interface TextRow { kind: "text"; hit: LineHit }
interface ActionRow { kind: "action"; id: "ask" | "check" | "chat" }
interface ProjectRow { kind: "project"; path: string; ranges: MatchRange[] }
interface OpenFolderRow { kind: "openFolder" }
type Row = FileRow | LoreRow | TextRow | ActionRow | ProjectRow | OpenFolderRow;

/** 一组：组头（可无）、行、以及一条不可选的尾行（「还有 N 篇 · Tab 切到…」）。 */
interface Group {
  key: string;
  label?: string;
  dest?: string;
  rows: Row[];
  trailer?: { text: string; scope: SearchScope };
}

const SCOPES: readonly SearchScope[] = ["all", "files", "lore", "text"];
/** 「全部」档每组的上限——总高约 17 行，14vh 顶边下 1080 屏刚好不用滚。 */
const ALL_LIMITS = { files: 6, lore: 5, text: 4 } as const;
/** 单档上限，超出滚动。 */
const SINGLE_LIMIT = 50;
const RECENT_LIMIT = 8;
/** 片段：命中词前后各留约 14 字。 */
const SNIPPET_PAD = 14;

/** 面板记住上次的档（只在本会话）：连按三次 ⌘K 都是找条目，第四次不该退回「全部」。 */
let lastScope: SearchScope = "all";

function Highlighted({ text, ranges }: { text: string; ranges: MatchRange[] }) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((r, i) => {
    if (r.start > cursor) parts.push(text.slice(cursor, r.start));
    parts.push(<span key={i} className={styles.hl}>{text.slice(r.start, r.end)}</span>);
    cursor = r.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/** 「… · Tab 切到…」里的 Tab 用赭石标出来：它告诉作者用哪个键，而不是让他离开键盘去点。 */
function WithTabKey({ text }: { text: string }) {
  const i = text.indexOf("Tab");
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<span className={styles.tabKey}>Tab</span>{text.slice(i + 3)}</>;
}

/**
 * 文档在结果里的名字：后缀一律不进名字——`.md` 在文件树里本来就被吃掉了，其余的
 * 由右列的大写后缀标签说（`extLabel`），名字里再带一遍是同一件事说两次。
 */
function docTitle(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function KindIcon({ kind }: { kind: RowKind }) {
  switch (kind) {
    case "deliverable": return <FileCode size={16} strokeWidth={1.6} />;
    case "image": return <FileImage size={16} strokeWidth={1.5} />;
    case "doc": return <FileText size={16} strokeWidth={1.6} />;
    default: return <File size={16} strokeWidth={1.6} />;
  }
}

const NO_PAST: never[] = [];

export function CommandPalette() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const showCommandPalette = useAppStore((s) => s.showCommandPalette);
  const scopeRequest = useAppStore((s) => s.paletteScopeRequest);
  const setShowCommandPalette = useAppStore((s) => s.setShowCommandPalette);
  const setShowAiDrawer = useAppStore((s) => s.setShowAiDrawer);
  const setMainView = useAppStore((s) => s.setMainView);
  const recentProjects = useAppStore((s) => s.recentProjects);
  const pinnedProjects = useAppStore((s) => s.pinnedProjects);
  const loreIndex = useLoreStore((s) => s.index);
  const fileTree = useProjectStore((s) => s.fileTree);
  const projectPath = useProjectStore((s) => s.projectPath);
  const activeFilePath = useProjectStore((s) => s.activeFilePath);
  const setActiveFilePath = useProjectStore((s) => s.setActiveFilePath);
  const revealPath = useProjectStore((s) => s.revealPath);
  const openProject = useProjectStore((s) => s.openProject);
  // This component is always mounted (App renders it unconditionally). Subscribing
  // to the document — and to the navigation history — only while open keeps every
  // editor keystroke from re-rendering, and re-searching, a palette nobody can see.
  const content = useEditorStore((s) => (showCommandPalette ? s.content : ""));
  const navPast = useNavStore((s) => (showCommandPalette ? s.past : NO_PAST));
  const navCurrent = useNavStore((s) => s.current);
  const setSelection = useAiTaskStore((s) => s.setSelection);
  const terms = useTerms();

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>(lastScope);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!showCommandPalette) return;
    setQuery("");
    setActive(0);
    setScope(scopeRequest?.scope ?? lastScope);
    setTimeout(() => inputRef.current?.focus(), 30);
    // 只在打开的那一刻读请求；开着时再来的请求由下一个 effect 接。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCommandPalette]);

  // ⌘P 在面板已开着时 ＝ 直接切到「文档」档。
  useEffect(() => {
    if (showCommandPalette && scopeRequest) setScope(scopeRequest.scope);
  }, [scopeRequest, showCommandPalette]);

  useEffect(() => { lastScope = scope; setActive(0); }, [scope]);
  useEffect(() => { setActive(0); }, [query]);

  const term = query.trim();
  const projectMode = !projectPath;

  // ── 数据 ──────────────────────────────────────────────────────────────────

  const allLore = useMemo(() => {
    const out: LoreEntity[] = [];
    // Every category the scan found, orphans included — the palette is a "find
    // what exists" surface, not a "pick a destination" one (lib/lore/categories).
    for (const cat of indexCategories(loreIndex)) {
      for (const e of (loreIndex[cat.id] ?? [])) out.push(e);
    }
    return out;
  }, [loreIndex]);

  const catLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const cat of indexCategories(loreIndex)) m.set(cat.id, categoryLabel(cat, isZh));
    return m;
  }, [loreIndex, isZh]);

  const loreByDir = useMemo(() => {
    const m = new Map<string, LoreEntity>();
    for (const e of allLore) m.set(pathKey(e.dirPath), e);
    return m;
  }, [allLore]);

  // 「最近去过」要剔掉已经不存在的：文档看文件树，条目看索引——都是内存里的，不碰盘。
  const treeFiles = useMemo(() => {
    const m = new Map<string, { name: string }>();
    const walk = (list: typeof fileTree) => {
      for (const n of list) {
        if (n.is_dir) walk(n.children ?? []);
        else m.set(pathKey(n.path), { name: n.name });
      }
    };
    walk(fileTree);
    return m;
  }, [fileTree]);

  const currentDocTitle = activeFilePath ? docTitle(baseName(activeFilePath)) : t("editor.untitled");

  const fileHitFor = (path: string): FileHit => {
    const rel = (projectPath ? projectRelative(projectPath, path) : null) ?? baseName(path);
    return { path, name: baseName(path), dir: dirName(rel), score: 0, nameRanges: [], dirRanges: [] };
  };

  /** 每档的命中总数——单档无命中时「别的档里有 N」那一行要用。 */
  const totals = useMemo(() => {
    if (projectMode || !term) return { files: 0, lore: 0, text: 0 };
    return {
      files: searchFiles(fileTree, projectPath, term, 0).total,
      lore: searchLore(allLore, term, 0).total,
      text: searchLines(content, term, 0).total,
    };
  }, [projectMode, term, fileTree, projectPath, allLore, content]);

  const groups = useMemo<Group[]>(() => {
    const out: Group[] = [];

    // ── 没打开项目：最近项目选择器 ──
    if (projectMode) {
      const { pinned, recent } = splitProjects(recentProjects, pinnedProjects);
      const rows: Row[] = [];
      for (const path of [...pinned, ...recent]) {
        const m = term ? matchText(baseName(path) || path, term) : { ranges: [] };
        if (!m) continue;
        rows.push({ kind: "project", path, ranges: m.ranges });
      }
      if (rows.length > 0) out.push({ key: "projects", label: t("command.projectsGroup"), dest: t("command.projectsDest"), rows });
      out.push({ key: "openFolder", rows: [{ kind: "openFolder" }] });
      return out;
    }

    // ── 空查询：最近去过 + 不需要词的 AI 动作 ──
    if (!term) {
      if (scope !== "text") {
        // `current` 排在最新：正在打开的那一篇不藏，右列写「已打开」。
        const recents = recentLocations([...navPast, navCurrent], null, {
          limit: RECENT_LIMIT,
          exists: (loc) => {
            if (loc.kind === "editor") return scope !== "lore" && treeFiles.has(pathKey(loc.filePath));
            return scope !== "files" && loreByDir.has(pathKey(loc.entityDir));
          },
        });
        const rows: Row[] = recents.map((loc: RecentLocation): Row => {
          if (loc.kind === "editor") {
            return { kind: "file", hit: fileHitFor(loc.filePath), current: isSamePath(loc.filePath, activeFilePath) };
          }
          const entity = loreByDir.get(pathKey(loc.entityDir))!;
          const current = navCurrent.kind === "lore" && isSamePath(navCurrent.entityDir, loc.entityDir);
          return { kind: "lore", hit: { entity, score: 0, via: "name", alias: null, ranges: [] }, current };
        });
        out.push({ key: "recent", label: t("command.recentGroup"), dest: t("command.recentSession"), rows });
      }
      out.push({ key: "ai", label: t("command.aiGroup"), rows: [{ kind: "action", id: "chat" }] });
      return out;
    }

    // ── 有词：文档 → 条目 → 正文 → AI ──
    const single = scope !== "all";
    const limit = (k: keyof typeof ALL_LIMITS) => (single ? SINGLE_LIMIT : ALL_LIMITS[k]);
    if (scope === "all" || scope === "files") {
      const { hits, total } = searchFiles(fileTree, projectPath, term, limit("files"));
      if (hits.length > 0) {
        out.push({
          key: "files",
          // 单档时组头消失——只有一组时它是噪音。
          ...(single ? {} : { label: t("command.fileGroup", { n: total }), dest: t("command.destEditor") }),
          rows: hits.map((hit) => ({ kind: "file", hit, current: isSamePath(hit.path, activeFilePath) })),
          ...(total > hits.length ? { trailer: { text: t("command.moreFiles", { n: total - hits.length }), scope: "files" as const } } : {}),
        });
      }
    }
    if (scope === "all" || scope === "lore") {
      const { hits, total } = searchLore(allLore, term, limit("lore"));
      if (hits.length > 0) {
        out.push({
          key: "lore",
          ...(single ? {} : { label: t("command.loreGroup", { entries: terms.entries, n: total }), dest: t("command.destLore") }),
          rows: hits.map((hit) => ({ kind: "lore", hit, current: false })),
          ...(total > hits.length ? { trailer: { text: t("command.moreLore", { n: total - hits.length }), scope: "lore" as const } } : {}),
        });
      }
    }
    if (scope === "all" || scope === "text") {
      const { hits, total } = searchLines(content, term, limit("text"));
      if (hits.length > 0) {
        out.push({
          // 正文档例外，组头留着：它要写篇名——正文只搜当前这一篇。
          key: "text",
          label: t("command.textGroup", { title: currentDocTitle, n: total }),
          dest: t("command.destLine"),
          rows: hits.map((hit) => ({ kind: "text", hit })),
          ...(total > hits.length ? { trailer: { text: t("command.moreText", { n: total - hits.length }), scope: "text" as const } } : {}),
        });
      }
    }
    out.push({ key: "ai", rows: [{ kind: "action", id: "ask" }, { kind: "action", id: "check" }] });
    return out;
  }, [projectMode, term, scope, recentProjects, pinnedProjects, navPast, navCurrent, treeFiles, loreByDir,
    fileTree, projectPath, allLore, content, activeFilePath, currentDocTitle, terms, t]);  // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const hasResults = groups.some((g) => g.key !== "ai" && g.key !== "openFolder" && g.rows.length > 0);

  const avatarPaths = useMemo(
    () => rows.flatMap((r) => (r.kind === "lore" && r.hit.entity.avatarPath ? [r.hit.entity.avatarPath] : [])),
    [rows],
  );
  const thumbs = useImageThumbnails(avatarPaths, 48);

  // ── 动作 ──────────────────────────────────────────────────────────────────

  const openDocument = (path: string) => {
    // The editor only loads files while it is the visible view, so opening one
    // without switching back leaves the writing focus pointing at the previous
    // document (see editorStore.WritingFocus).
    setActiveFilePath(path);
    setMainView("editor");
    // 树外打开即定位：树挂着时它自己的 effect 也会做，重复一次只是同一行再居中一次；
    // 树不挂着（侧栏在别的标签）时这里是唯一一次，展开先落进 store，滚动等树挂回来。
    revealPath(path);
  };

  const openEntry = (dirPath: string) => {
    // The same road navStore's back/forward takes to a lore location.
    setMainView("lore-wall");
    useLoreStore.getState().openDetail(dirPath);
  };

  const runAction = (id: ActionRow["id"]) => {
    if (id === "check") setShowAiDrawer(true, "consistency");
    else if (id === "chat") setShowAiDrawer(true, "chat");
    else { setSelection(term); setShowAiDrawer(true, "generate"); }
  };

  const runRow = (row: Row) => {
    switch (row.kind) {
      case "file": openDocument(row.hit.path); break;
      case "lore": openEntry(row.hit.entity.dirPath); break;
      case "text": setMainView("editor"); useEditorStore.getState().jumpToLine(row.hit.line); break;
      case "action": runAction(row.id); break;
      case "project": void openProject(row.path); break;
      case "openFolder": void openProject(); break;
    }
    setShowCommandPalette(false);
  };

  const cycleScope = (dir: 1 | -1) => {
    const i = SCOPES.indexOf(scope);
    setScope(SCOPES[(i + dir + SCOPES.length) % SCOPES.length]);
  };

  // A pinyin Enter commits the word being typed; it must not also open a hit.
  const ime = useImeGuard();
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (ime.isComposing(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // ⌘↵ 永远 = 问 AI（有词）或打开对话助手（无词），不管当前项在哪。
      if (mod && !projectMode) { runAction(term ? "ask" : "chat"); setShowCommandPalette(false); return; }
      if (rows[active]) runRow(rows[active]);
    } else if (e.key === "Tab" && !projectMode) {
      e.preventDefault();
      cycleScope(e.shiftKey ? -1 : 1);
    } else if (e.key === "Backspace" && mod) {
      // Esc 关闭而不是清空；清空是 ⌘⌫。
      e.preventDefault();
      setQuery("");
    }
  };

  // ── 画行 ──────────────────────────────────────────────────────────────────

  const verbFor = (row: Row | undefined): string => {
    if (!row) return t("command.verbOpen");
    switch (row.kind) {
      case "lore": return t("command.verbGoEntry");
      case "text": return t("command.verbJump", { n: row.hit.line });
      case "action": return row.id === "chat" ? t("command.verbOpenChat") : row.id === "ask" ? t("command.verbAsk") : t("command.verbOpen");
      default: return t("command.verbOpen");
    }
  };

  const renderRow = (row: Row, idx: number) => {
    const isActive = idx === active;
    const common = { onClick: () => runRow(row), onMouseEnter: () => setActive(idx) };
    const cls = (extra?: string) => [styles.row, extra, isActive ? styles.rowActive : ""].filter(Boolean).join(" ");
    const action = (verb: string) => <span className={styles.action}>{verb} ↵</span>;

    switch (row.kind) {
      case "file": {
        const { hit } = row;
        const kind = rowKind(hit.name, false, null);
        const secondary = isSecondary(kind);
        const ext = extLabel(hit.name, kind);
        // 根目录文档没有路径行——搜索结果里省略（行高退回 30），「最近去过」里写「·」占位保持行高。
        const path = hit.dir ? hit.dir.split("/").join(" / ") : (term ? null : "·");
        return (
          <div key={`file:${hit.path}`} className={cls(path ? undefined : styles.rowSingle)} {...common}>
            <span className={`${styles.icon16} ${secondary ? styles.secondary : ""}`}><KindIcon kind={kind} /></span>
            <div className={styles.rowMain}>
              <span className={`${styles.rowTitle} ${secondary ? styles.rowTitleMuted : ""}`}>
                <span><Highlighted text={docTitle(hit.name)} ranges={hit.nameRanges} /></span>
              </span>
              {path && <span className={styles.rowPath}><Highlighted text={path} ranges={hit.dir ? spreadRanges(hit.dirRanges, hit.dir) : []} /></span>}
            </div>
            {isActive
              ? action(t("command.verbOpen"))
              : row.current
                ? <span className={styles.rightCol}>{t("command.openNow")}</span>
                : ext && <span className={styles.rightCol}>{ext}</span>}
          </div>
        );
      }
      case "lore": {
        const { entity, via, alias, ranges } = row.hit;
        const color = categoryColor(entity.category);
        const thumb = entity.avatarPath ? thumbs[entity.avatarPath] : undefined;
        const aliasText = entity.aliases.length ? t("command.alias", { names: entity.aliases.join("、") }) : "";
        const sub: React.ReactNode = via === "alias" && alias
          ? <>{t("command.aliasWord")} <Highlighted text={alias} ranges={ranges} /></>
          : [entity.summary, aliasText].filter(Boolean).join(" · ");
        return (
          <div key={`lore:${entity.dirPath}`} className={cls(sub ? styles.rowLore : styles.rowSingle)} {...common}>
            <span className={styles.catBlock} style={{ "--cat": color } as React.CSSProperties}>
              {thumb ? <img src={thumb} alt="" /> : entity.name.charAt(0)}
            </span>
            <div className={styles.rowMain}>
              <span className={styles.rowTitle}>
                <span>{via === "name" ? <Highlighted text={entity.name} ranges={ranges} /> : entity.name}</span>
                <span className={styles.catLabel} style={{ "--cat": color } as React.CSSProperties}>
                  {catLabels.get(entity.category) ?? entity.category}
                </span>
              </span>
              {sub && <span className={styles.rowSub}>{sub}</span>}
            </div>
            {isActive
              ? action(t("command.verbGoEntry"))
              : row.current && <span className={styles.rightCol}>{t("command.openNow")}</span>}
          </div>
        );
      }
      case "text": {
        const { hit } = row;
        const w = windowAround(hit.text, hit.ranges, term.length + SNIPPET_PAD * 2);
        return (
          <div key={`text:${hit.line}`} className={cls(styles.rowText)} {...common}>
            <span className={styles.lineNo}>{String(hit.line).padStart(2, "0")}</span>
            <span className={styles.snippet}><Highlighted text={w.text} ranges={w.ranges} /></span>
            {isActive && action(t("command.verbJump", { n: hit.line }))}
          </div>
        );
      }
      case "action": {
        const muted = row.id === "check";
        const label = row.id === "ask"
          ? <>{t("command.askAi", { q: "" }).replace(/[“"].*$/, "")}<span className={styles.q}>“{term}”</span></>
          : row.id === "check"
            ? <>{t("command.checkConsistency", { q: "" }).replace(/[“"].*$/, "")}<span className={styles.q}>“{term}”</span></>
            : t("command.openChat");
        return (
          <div key={`action:${row.id}`} className={cls(styles.rowAi)} {...common}>
            <span className={`${styles.aiIcon} ${muted ? styles.muted : ""}`}>
              {muted ? <Check size={14} strokeWidth={1.8} /> : <Sparkles size={14} strokeWidth={1.7} />}
            </span>
            <span className={`${styles.aiLabel} ${muted ? styles.muted : ""}`}>{label}</span>
            {!muted && <span className={styles.rightCol}>{comboLabel({ mod: true, key: "↵" })}</span>}
          </div>
        );
      }
      case "project": {
        return (
          <div key={`project:${row.path}`} className={cls()} {...common}>
            <span className={`${styles.icon16} ${styles.filled}`}><Folder size={16} strokeWidth={1.6} /></span>
            <div className={styles.rowMain}>
              <span className={styles.rowTitle}><span><Highlighted text={baseName(row.path) || row.path} ranges={row.ranges} /></span></span>
              <span className={styles.rowPath}>{row.path}</span>
            </div>
            {isActive && action(t("command.verbOpen"))}
          </div>
        );
      }
      case "openFolder":
        return (
          <div key="openFolder" className={cls(styles.rowAi)} {...common}>
            <span className={`${styles.aiIcon} ${styles.muted}`}><FolderPlus size={14} strokeWidth={1.7} /></span>
            <span className={`${styles.aiLabel} ${styles.muted}`}>{t("command.openFolder")}</span>
            {isActive && action(t("command.verbOpen"))}
          </div>
        );
    }
  };

  /** 单档无命中时的第二行：别的档里有多少——多档并列，三档以上只写总数。 */
  const elsewhere = (): { text: string; scope: SearchScope } | null => {
    if (scope === "all") return null;
    const others = (["files", "lore", "text"] as const).filter((k) => k !== scope && totals[k] > 0);
    if (others.length === 0) return null;
    const best = others.reduce((a, b) => (totals[b] > totals[a] ? b : a));
    const word = (k: typeof others[number]) =>
      t(k === "files" ? "command.elsewhereFiles" : k === "lore" ? "command.elsewhereLore" : "command.elsewhereText", { n: totals[k] });
    const text = others.length >= 3
      ? t("command.elsewhereOther", { n: others.reduce((s, k) => s + totals[k], 0) })
      : others.map(word).join(" · ");
    return { text: `${text} · ${t("command.elsewhereTab")}`, scope: best };
  };

  const noHitsText = () => {
    const key = scope === "files" ? "command.noHitsFiles" : scope === "lore" ? "command.noHitsLore" : scope === "text" ? "command.noHitsText" : "command.noHitsAll";
    return t(key, { q: term });
  };

  const footerRight = (): string => {
    if (projectMode || !term) return scope === "all" && !projectMode ? t("command.footerDocs", { key: comboLabel({ mod: true, key: "p" }) }) : "";
    if (scope === "all") return t("command.footerDocs", { key: comboLabel({ mod: true, key: "p" }) });
    if (scope === "files") return t("command.countFiles", { n: totals.files });
    if (scope === "lore") return t("command.countLore", { n: totals.lore });
    return t("command.countText", { n: totals.text });
  };

  // `rows` is built in group order, so a group's global index is its offset plus
  // the local one — no O(n²) indexOf per row.
  let offset = 0;
  const away = elsewhere();

  return (
    showCommandPalette && (
      <div className={styles.backdrop} onClick={() => setShowCommandPalette(false)}>
        <div className={styles.palette} onClick={(e) => e.stopPropagation()}>
          <div className={styles.inputRow}>
            <Search size={16} strokeWidth={1.7} />
            <input
              ref={inputRef}
              className={styles.input}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              {...ime.imeProps}
              placeholder={projectMode ? t("command.placeholderNoProject") : t("command.placeholder")}
            />
            {!projectMode && (
              <div className={styles.chips}>
                {SCOPES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`${styles.chip} ${s === scope ? styles.chipOn : ""}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setScope(s)}
                  >
                    {t(s === "all" ? "command.scopeAll" : s === "files" ? "command.scopeFiles" : s === "lore" ? "command.scopeLore" : "command.scopeText")}
                  </button>
                ))}
              </div>
            )}
            <span className={styles.escKey}>esc</span>
          </div>

          <div className={styles.results}>
            {projectMode && recentProjects.length + pinnedProjects.length === 0 && (
              <div className={styles.empty}>{t("command.projectsEmpty")}</div>
            )}
            {!projectMode && term && !hasResults && (
              <>
                <div className={`${styles.empty} ${away ? styles.withElsewhere : ""}`}>{noHitsText()}</div>
                {away && (
                  <div className={styles.elsewhere} onClick={() => setScope(away.scope)}>
                    <WithTabKey text={away.text} />
                  </div>
                )}
              </>
            )}
            {groups.map((g) => {
              const base = offset;
              offset += g.rows.length;
              const recentEmpty = g.key === "recent" && g.rows.length === 0;
              return (
                <div key={g.key} className={styles.group}>
                  {g.label && (
                    <div className={styles.groupHead}>
                      <span className={styles.groupLabel}>{g.label}</span>
                      {g.dest && <span className={styles.groupDest}>{g.dest}</span>}
                    </div>
                  )}
                  {recentEmpty && <div className={styles.recentEmpty}>{t("command.recentEmpty")}</div>}
                  {g.rows.map((row, i) => renderRow(row, base + i))}
                  {g.trailer && (
                    <div className={styles.trailer} onClick={() => setScope(g.trailer!.scope)}>
                      <WithTabKey text={g.trailer.text} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className={styles.footer}>
            <span><span className={styles.footerKey}>↑↓</span>{t("command.navigate")}</span>
            <span><span className={styles.footerKey}>↵</span>{verbFor(rows[active])}</span>
            {projectMode ? (
              <span><span className={styles.footerKey}>esc</span>{t("command.close")}</span>
            ) : (
              <>
                <span><span className={styles.footerKey}>Tab</span>{t("command.scopeKey")}</span>
                <span><span className={styles.footerKey}>{comboLabel({ mod: true, key: "↵" })}</span>{term ? t("command.askAiShort") : t("command.openChat")}</span>
              </>
            )}
            <span className={styles.footerRight}>{footerRight()}</span>
          </div>
        </div>
      </div>
    )
  );
}

/** 路径里的 `/` 画成「 / 」（三个字符）后，命中区间要跟着位移。 */
function spreadRanges(ranges: MatchRange[], dir: string): MatchRange[] {
  const map = (i: number) => i + 2 * (dir.slice(0, i).split("/").length - 1);
  return ranges.map((r) => ({ start: map(r.start), end: map(r.end) }));
}
