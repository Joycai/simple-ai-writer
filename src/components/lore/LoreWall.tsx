import { useState, useMemo, useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Search, Sparkles, Plus, Camera, BookOpen, Pencil, FolderOpen, RotateCw, Trash2, FileDown, FileUp, MoreHorizontal, AlertTriangle, Layers, Pin } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile as readBinaryFile } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useLoreStore } from "../../stores/loreStore";
import { useProjectStore, useTerms } from "../../stores/projectStore";
import {
  applyLoreImport,
  cancelLoreImport,
  entityCollections,
  exportLoreBundle,
  indexCategories,
  inScope,
  loadPinnedLore,
  passesFilter,
  pinnedEntityDirs,
  relocationTargets,
  savePinnedLore,
  setEntityAvatar,
  slugifyEntityId,
  stageLoreImport,
  ungroupedCount,
  uniqueEntityId,
  UNGROUPED,
  type CategoryId,
  type CollectionFilter,
  type ConflictStrategy,
  type IndexedCategory,
  type LoreEntity,
  type StagedLoreImport,
} from "../../lib/lore";
import { CollectionRail } from "./collections/CollectionRail";
import { BindingEdge } from "./collections/BindingEdge";
import { CollectionAssignMenu, type AssignMode } from "./collections/CollectionAssignMenu";
import { CategoryMoveMenu } from "./CategoryMoveMenu";
import { CategoryDeleteModal, type CategoryDeleteChoice } from "./CategoryDeleteModal";
import { CollectionsManageModal } from "./collections/CollectionsManageModal";
import { ScopeBand, ScopeButton, ScopeMenu, type ScopeMenuAnchor } from "./collections/ScopePicker";
import cs from "./collections/collections.module.css";
import { IMAGE_EXTENSIONS } from "../../lib/fs/images";
import { appTerms, categoryLabel, defaultCategoryId, findCategory, loreCategories, loreCategoryIds, suggestCategoryId } from "../../lib/profile";
import { useAppStore } from "../../stores/appStore";
import { useImageThumbnails } from "./useImageDataUrl";
import { MOD_K_SPACED } from "../../lib/platform";
import { useImeGuard } from "../../lib/ime";
import { LoreGenerator } from "./LoreGenerator";
import { NewEntryTabs, type NewEntryMode } from "./ai/NewEntryTabs";
import { LoreDetail } from "./LoreDetail";
import { SyncPresence } from "./SyncPresence";
import { useSyncStore } from "../../stores/syncStore";
import { ContextMenu, type ContextMenuEntry } from "../common/ContextMenu";
import { ModalShell } from "../common/ModalShell";
import { fillLayer, pushBackdrop, pushForward, springScreen, useMotionPreset } from "../../lib/motion";
import styles from "./LoreWall.module.css";

import { categoryColor } from "./catColor";
import { baseName } from "../../lib/paths";

// Stable, deterministic small rotation per entity id
function rotationFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const r = ((h % 9) - 4) * 0.1; // -0.4 .. +0.4 deg
  return Number(r.toFixed(2));
}

export function LoreWall() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const { index, scanProject, createNewEntity, deleteEntity, moveToCategory, detailPath, detailEditing, openDetail } = useLoreStore();
  const scope = useLoreStore((s) => s.scope);
  const setScope = useLoreStore((s) => s.setScope);
  const { projectPath } = useProjectStore();
  const collections = useProjectStore((s) => s.collections);
  const fileIntoCollections = useProjectStore((s) => s.fileIntoCollections);
  const customCategories = useProjectStore((s) => s.customCategories);
  const setCustomCategories = useProjectStore((s) => s.setCustomCategories);
  const terms = useTerms();
  // The eyebrow is decorative English regardless of UI language (matching
  // "DOCUMENTS · 文档"), so it resolves the en term explicitly.
  const kbEyebrow = appTerms(false).kb.toUpperCase();
  const setShowCommandPalette = useAppStore((s) => s.setShowCommandPalette);

  // Entering the wall re-reads disk. There is no filesystem watcher, and this
  // component is unmounted on every view switch, so it otherwise renders
  // whatever index the store happens to hold — stale after an agent write that
  // landed while another view was up, or after a scan that failed. The store
  // coalesces queued scans, so a fast view toggle costs one walk, not several.
  useEffect(() => {
    if (projectPath) void scanProject(projectPath);
  }, [projectPath, scanProject]);

  const [filter, setFilter] = useState<string>("all");
  /**
   * 装订栏的筛选——**只影响眼睛**，和取材范围是两件事。
   *
   * 两者共用一份状态会省几行代码，代价是「我只想看看这一摊」和「让 AI 只用这一摊」
   * 变成同一个动作：作者筛着筛着忘了，下一次运行就在他不知情的情况下换了取材范围。
   */
  const [colFilter, setColFilter] = useState<CollectionFilter>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** ⇧ 连选的锚点：上一次「非连选」点中的那一张。 */
  const anchorRef = useRef<string | null>(null);
  const [scopeMenu, setScopeMenu] = useState<ScopeMenuAnchor | null>(null);
  const [assign, setAssign] = useState<
    { mode: AssignMode; anchor: { x: number; y: number; above?: boolean }; entities: LoreEntity[] } | null
  >(null);
  /** 「移到分类」的浮层。和归集清单分开两个状态：两块板子的语汇不同，合并只会长出一堆 if。 */
  const [catMove, setCatMove] = useState<{ x: number; y: number; above?: boolean } | null>(null);
  /** 分类芯片的右键菜单，和卡片那个 `menu` 分开——菜单项的来源不同，合进去要在每一项上判类型。 */
  const [catMenu, setCatMenu] = useState<{ x: number; y: number; cat: IndexedCategory } | null>(null);
  const [deleteCat, setDeleteCat] = useState<IndexedCategory | null>(null);
  const [showManage, setShowManage] = useState(false);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const gridRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [showNewCategory, setShowNewCategory] = useState(false);
  // Unified new-entry flow: null = closed, else which mode the modal opens in.
  const [newMode, setNewMode] = useState<NewEntryMode | null>(null);
  // A passage the editor's 提取为设定 handed over. Read once, and held here for
  // the life of the modal so re-renders don't re-seed a description the author
  // has since edited.
  const pendingExtract = useLoreStore((s) => s.pendingExtract);
  const takePendingExtract = useLoreStore((s) => s.takePendingExtract);
  const [extractSeed, setExtractSeed] = useState<string | null>(null);
  useEffect(() => {
    if (pendingExtract === null) return;
    setExtractSeed(takePendingExtract());
    setNewMode("ai");
  }, [pendingExtract, takePendingExtract]);
  // One menu state for both openers: right-click (entity or empty background)
  // and the header's ⋯ button, which sets `header` to get the trimmed list —
  // 新建条目 / AI 提取 are buttons right beside it, so repeating them is noise.
  const [menu, setMenu] = useState<
    { x: number; y: number; entity: LoreEntity | null; header?: boolean } | null
  >(null);
  // Lore bundle transfer: staged import awaiting the user's conflict decision.
  const [importStaged, setImportStaged] = useState<StagedLoreImport | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);

  const [avatarBusy, setAvatarBusy] = useState<string | null>(null);

  // Which entity the detail view is showing. Resolved from the index on every
  // render rather than held as an object: the open entity survives a re-scan,
  // and a path opened before the index was ready (a citation click during a
  // scan) starts rendering the moment it resolves.
  const detailEntity = useMemo<LoreEntity | null>(() => {
    if (!detailPath) return null;
    return Object.values(index).flat().find((e) => e.dirPath === detailPath) ?? null;
  }, [detailPath, index]);

  // Avatar rendering uses data URLs (see LoreDetail rationale: Webview2's
  // strict URL parsing on Windows drive-letter paths makes the
  // ai-writer-asset:// protocol unreliable) — but *thumbnails*, not the
  // full-resolution encoder: these render at avatar size in a grid, and a wall
  // of full-size pictures held hundreds of megabytes of base64 in state (and
  // WebKit silently refuses to decode oversized data: URIs). The hook keys on
  // the path list, so a rescan that changed no avatar re-encodes nothing, and
  // a changed set only fetches the paths it doesn't already hold.
  const avatarPaths = useMemo(
    () =>
      Object.values(index)
        .flat()
        .map((e) => e.avatarPath)
        .filter((p): p is string => !!p),
    [index],
  );
  const avatarThumbs = useImageThumbnails(avatarPaths);

  const handleAvatarPick = async (entity: LoreEntity) => {
    if (!projectPath || avatarBusy) return;
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: [...IMAGE_EXTENSIONS] }],
    });
    if (typeof picked !== "string") return;
    setAvatarBusy(entity.id);
    try {
      const bytes = await readBinaryFile(picked);
      const ext = (picked.split(".").pop() ?? "png").toLowerCase();
      await setEntityAvatar(entity.dirPath, bytes, ext);
      await scanProject(projectPath);
    } finally {
      setAvatarBusy(null);
    }
  };

  // Flatten + filter
  // Wall order = every category the *scan* found, so entries whose category
  // comes from a disabled pack are on the wall rather than silently absent
  // (they are in the model's context either way — see lib/lore/categories).
  const cats = useMemo(() => indexCategories(index), [index]);

  const allEntities = useMemo(() => {
    const flat: LoreEntity[] = [];
    for (const cat of cats) {
      for (const e of (index[cat.id] ?? [])) flat.push(e);
    }
    return flat;
  }, [cats, index]);

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: allEntities.length };
    for (const cat of cats) {
      out[cat.id] = (index[cat.id] ?? []).length;
    }
    return out;
  }, [allEntities, cats, index]);

  const filtered = useMemo(() => {
    let list = allEntities;
    if (filter !== "all") list = list.filter((e) => e.category === filter);
    // 集合筛选和分类筛选是两根轴，所以是**与**关系：「《漕运纪》的人物」是一个
    // 正常的问题，而它需要两个筛选同时成立。
    list = list.filter((e) => passesFilter(e, colFilter));
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.aliases.some((a) => a.toLowerCase().includes(q)) ||
          e.summary.toLowerCase().includes(q),
      );
    }
    return list;
  }, [allEntities, filter, colFilter, search]);

  const totalRelations = 0; // future

  /**
   * 置顶的条目（AI 面板里勾的那份）。围栏生效时它们**越栏**——显式指定＝作者坚持
   * ——所以墙上不能把它们翻面，否则界面在说 AI 看不见，而 AI 其实看得见。
   *
   * 依赖里带上 `index` 是有意的：置顶存在 prefs 里（不是 React 状态），扫描是这个
   * 组件能观察到的、离「作者刚在别处改过东西」最近的一个信号。
   */
  const pinnedDirs = useMemo(
    () => pinnedEntityDirs(loadPinnedLore(projectPath)),
    [projectPath, index],
  );

  const unfiled = useMemo(() => ungroupedCount(index), [index]);

  /** 这一张卡此刻在围栏外吗？ */
  const isOut = (e: LoreEntity) =>
    scope !== null && !inScope(e, scope) && !pinnedDirs.has(e.dirPath);
  const outOfScopeVisible = filtered.filter(isOut).length;

  const selectedEntities = useMemo(
    () => allEntities.filter((e) => selected.has(e.dirPath)),
    [allEntities, selected],
  );
  const selectedBreakdown = useMemo(() => {
    const byCat = new Map<string, number>();
    for (const e of selectedEntities) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);
    return [...byCat.entries()]
      .map(([id, n]) => {
        const cat = findCategory(id);
        return `${cat ? categoryLabel(cat, isZh) : id} ${n}`;
      })
      .join(" · ");
  }, [selectedEntities, isZh]);

  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
    anchorRef.current = null;
  };

  // 多选中 Esc 退出。挂在 document 上而不是墙的 div 上：墙没有焦点，作者刚刚点的是
  // 一张卡片。
  useEffect(() => {
    if (!selectMode) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") exitSelect(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectMode]);

  /**
   * 三种进入多选的方式共用这一个：勾选框、⇧ 点卡身连选、框选。
   * ⇧ 的锚点是上一次**非连选**点中的那张——连选之后再连选，作者期望的是从同一个
   * 锚点重新拉一段，而不是从上一段的末端接着拉。
   */
  const toggleSelect = (entity: LoreEntity, ev: React.MouseEvent) => {
    setSelectMode(true);
    setSelected((cur) => {
      const next = new Set(cur);
      if (ev.shiftKey && anchorRef.current) {
        const order = filtered.map((e) => e.dirPath);
        const a = order.indexOf(anchorRef.current);
        const b = order.indexOf(entity.dirPath);
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(order[i]);
          return next;
        }
      }
      if (next.has(entity.dirPath)) next.delete(entity.dirPath);
      else next.add(entity.dirPath);
      anchorRef.current = entity.dirPath;
      return next;
    });
  };

  const openAssign = (ev: React.MouseEvent, mode: AssignMode, entities?: LoreEntity[]) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    setAssign({
      mode,
      anchor: { x: r.left, y: r.top - 8, above: true },
      entities: entities ?? selectedEntities,
    });
  };

  const commitAssign = async (entities: LoreEntity[], add: string[], remove: string[]) => {
    try {
      await fileIntoCollections(entities, add, remove);
    } catch (e) {
      console.warn("[lore] filing failed:", e);
    }
  };

  /**
   * 把选中的这批搬进 `category`。
   *
   * 搬完**不退出多选**，而是把选中态跟着新 dirPath 改过去：搬错一批的时候，作者要的
   * 下一个动作是「再搬回去」，清空选中会让他重新框一遍二十张卡。
   *
   * 只有失败才弹窗。成功是墙上看得见的——卡片换了颜色、分类计数变了——而每次成功都
   * 弹一次的提示，第三次就变成了下意识点掉的东西。
   */
  const moveSelectedToCategory = async (category: string) => {
    if (!projectPath || selectedEntities.length === 0) return;
    const targets = selectedEntities;
    try {
      const { moves, failed } = await moveToCategory(projectPath, targets, category);
      if (moves.length > 0) {
        const byFrom = new Map(moves.map((m) => [m.from, m.to]));
        setSelected((cur) => new Set([...cur].map((p) => byFrom.get(p) ?? p)));
        anchorRef.current = anchorRef.current
          ? (byFrom.get(anchorRef.current) ?? anchorRef.current)
          : null;
      }
      if (failed.length > 0) {
        window.alert(t("lore.categoryMove.failed", { list: failed.join("、") }));
      }
    } catch (e) {
      console.warn("[lore] category move failed:", e);
      window.alert(t("lore.categoryMove.failed", { list: targets.map((x) => x.name).join("、") }));
    }
  };

  /** 墙底那颗「把未归集的都归进当前范围」——围栏生效时最常见的一次性收尾。 */
  const fileUnfiledIntoScope = async () => {
    if (!scope) return;
    const targets = allEntities.filter((e) => entityCollections(e).length === 0);
    if (targets.length === 0) return;
    await commitAssign(targets, [scope], []);
  };

  /** 作者自建的分类才可以删——能力包带来的那些，删除的地方在工作台的包开关。 */
  const isUserCategory = (id: string) => customCategories.some((c) => c.id === id);

  /**
   * 删掉一个分类。两条出口在 `CategoryDeleteModal` 里由作者选，这里只负责按顺序执行。
   *
   * **先搬条目、再摘声明**：反过来的话，摘声明会先让这个分类变成 orphan，而搬家失败
   * 时作者就同时失去了分类和一次干净的重试——现在失败会抛回弹窗，profile.json 一个
   * 字都没动。
   *
   * orphan 分类没有声明可摘，搬空就是全部：`scanLore` 只把**至少有一条**的目录算成
   * orphan，空掉的那个文件夹自己就从墙上消失了。
   */
  const handleCategoryDelete = async (cat: IndexedCategory, choice: CategoryDeleteChoice) => {
    if (!projectPath) return;
    if (choice.kind === "move") {
      const inCat = index[cat.id] ?? [];
      const { failed } = await moveToCategory(projectPath, inCat, choice.target);
      if (failed.length > 0) {
        throw new Error(t("lore.categoryMove.failed", { list: failed.join("、") }));
      }
    }
    if (!cat.orphan) {
      await setCustomCategories(customCategories.filter((c) => c.id !== cat.id));
    }
    // 正筛着它的时候把它删了，筛选得跟着回到「全部」，否则墙上空空如也而作者不知道
    // 自己还在一个已经不存在的筛选里。
    if (filter === cat.id) setFilter("all");
  };

  const categoryMenuItems = (cat: IndexedCategory): ContextMenuEntry[] => {
    const n = counts[cat.id] ?? 0;
    if (cat.orphan) {
      // orphan ＝ 有条目、但没有能力包声明它。删不了「声明」（本来就没有），但把条目
      // 搬走是真的出路——搬空之后这个文件夹就不再是一个分类。
      return [
        { kind: "item", icon: <FolderOpen size={13} />, label: t("lore.categoryDelete.menuEmpty", { n }),
          action: () => setDeleteCat(cat) },
      ];
    }
    if (!isUserCategory(cat.id)) {
      // 藏掉菜单项会让作者以为自己点错了地方。留着、禁用、把理由写在标签上。
      return [
        { kind: "item", label: t("lore.categoryDelete.menuFromPack"), disabled: true, action: () => {} },
      ];
    }
    return [
      { kind: "item", icon: <Trash2 size={13} />, danger: true, label: t("lore.categoryDelete.menu"),
        action: () => setDeleteCat(cat) },
    ];
  };

  /**
   * 框选：在格纸空白处按下才开始（按在卡片上是拖拽/点击），移动时按矩形相交挑卡片。
   * 相交而不是包含——半张卡进了框，作者的意思显然是要它。
   */
  const onGridPointerDown = (ev: React.PointerEvent) => {
    if (ev.button !== 0) return;
    if ((ev.target as HTMLElement).closest("[data-lore-card]")) return;
    const start = { x: ev.clientX, y: ev.clientY };
    let moved = false;
    const onMove = (m: PointerEvent) => {
      if (!moved && Math.abs(m.clientX - start.x) + Math.abs(m.clientY - start.y) < 6) return;
      moved = true;
      const rect = { x0: Math.min(start.x, m.clientX), y0: Math.min(start.y, m.clientY), x1: Math.max(start.x, m.clientX), y1: Math.max(start.y, m.clientY) };
      setMarquee(rect);
      const hit = new Set<string>();
      for (const [dir, el] of cardRefs.current) {
        const b = el.getBoundingClientRect();
        if (b.right >= rect.x0 && b.left <= rect.x1 && b.bottom >= rect.y0 && b.top <= rect.y1) hit.add(dir);
      }
      setSelectMode(true);
      setSelected(hit);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setMarquee(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const handleDeleteEntity = async (e: LoreEntity) => {
    if (!projectPath) return;
    if (!window.confirm(t("lore.panel.deleteConfirm", { name: e.name }))) return;
    await deleteEntity(projectPath, e);
  };

  const handleExport = async () => {
    if (!projectPath || transferBusy) return;
    setTransferBusy(true);
    try {
      const saved = await exportLoreBundle(projectPath);
      // Show the bundle where it landed instead of an alert.
      if (saved) revealItemInDir(saved).catch(() => { /* best-effort */ });
    } catch (err) {
      window.alert(`${t("lore.transfer.exportFailed", { kb: terms.kb })}\n${err}`);
    } finally {
      setTransferBusy(false);
    }
  };

  const handleImport = async () => {
    if (!projectPath || transferBusy) return;
    setTransferBusy(true);
    try {
      const staged = await stageLoreImport(projectPath);
      if (staged) setImportStaged(staged);
    } catch (err) {
      const empty = err instanceof Error && err.message === "empty-bundle";
      window.alert(empty
        ? t("lore.transfer.emptyBundle", { kb: terms.kb })
        : `${t("lore.transfer.importFailed", { kb: terms.kb })}\n${err}`);
    } finally {
      setTransferBusy(false);
    }
  };

  const handleApplyImport = async (strategy: ConflictStrategy) => {
    if (!projectPath || !importStaged) return;
    try {
      const summary = await applyLoreImport(projectPath, importStaged, strategy);
      setImportStaged(null);
      await scanProject(projectPath);
      let msg = t("lore.transfer.importDone", { imported: summary.imported, skipped: summary.skipped });
      if (summary.hiddenCategories.length > 0) {
        msg += `\n${t("lore.transfer.hiddenCategories", { categories: summary.hiddenCategories.join(", ") })}`;
      }
      window.alert(msg);
    } catch (err) {
      setImportStaged(null);
      window.alert(`${t("lore.transfer.importFailed", { kb: terms.kb })}\n${err}`);
    }
  };

  // Bundle export/import — the knowledge-base backup. Shared by the header ⋯
  // menu and the empty-background right-click menu so the two can't drift.
  const transferItems = (): ContextMenuEntry[] => {
    const disabled = !projectPath || transferBusy;
    return [
      { kind: "item", icon: <FileDown size={13} />, label: t("lore.transfer.export"),
        disabled, action: () => void handleExport() },
      { kind: "item", icon: <FileUp size={13} />, label: t("lore.transfer.import"),
        disabled, action: () => void handleImport() },
    ];
  };

  const refreshItem = (): ContextMenuEntry => ({
    kind: "item", icon: <RotateCw size={13} />, label: t("fileTree.refresh"),
    disabled: !projectPath,
    action: () => { if (projectPath) void scanProject(projectPath); },
  });

  const buildMenuItems = (m: { entity: LoreEntity | null; header?: boolean }): ContextMenuEntry[] => {
    const e = m.entity;
    if (m.header) {
      // AI 提取从第一行下沉到这里(设计稿 14 屏 1k):它是每周一次的动作,
      // 不是每天,腾出的位置给同步状态件。未绑定时,绑定入口也只在这里留一项
      // ——工具带上不放「去绑定」的常驻广告。
      const items: ContextMenuEntry[] = [
        { kind: "item", icon: <Sparkles size={13} />, label: t("lore.newEntry.ai", { defaultValue: "AI 提取" }),
          action: () => setNewMode("ai") },
        { kind: "divider" },
        ...transferItems(),
        { kind: "divider" },
        refreshItem(),
      ];
      if (projectPath && !useSyncStore.getState().binding) {
        items.push({ kind: "divider" }, {
          kind: "item",
          label: t("sync.wBind"),
          action: () => useAppStore.getState().openSettings("sync"),
        });
      }
      return items;
    }
    if (!e) {
      return [
        { kind: "item", icon: <Plus size={13} />, label: t("lore.panel.newEntry"),
          action: () => setNewMode("manual") },
        { kind: "item", icon: <Sparkles size={13} />, label: t("lore.newEntry.ai", { defaultValue: "AI 提取" }),
          action: () => setNewMode("ai") },
        { kind: "divider" },
        ...transferItems(),
        { kind: "divider" },
        refreshItem(),
      ];
    }
    return [
      { kind: "item", icon: <BookOpen size={13} />, label: t("fileTree.open"),
        action: () => openDetail(e.dirPath) },
      { kind: "item", icon: <Pencil size={13} />, label: t("lore.detail.edit", { defaultValue: "编辑" }),
        action: () => openDetail(e.dirPath, true) },
      { kind: "item", icon: <Camera size={13} />, label: t("lore.wall.changeAvatar", { defaultValue: "更换头像" }),
        action: () => void handleAvatarPick(e) },
      { kind: "divider" },
      // 不进多选也能改一条：右键 → 归入集合。菜单项本身弹出同一个勾选清单，
      // 所以「多选一条」和「右键一条」得到的是同一个界面。
      { kind: "item", icon: <Layers size={13} />, label: t("lore.collections.assign.menuLabel"),
        action: () => setAssign({
          mode: "single",
          anchor: { x: menu?.x ?? 0, y: (menu?.y ?? 0) + 4 },
          entities: [e],
        }) },
      // 越栏：把这一条置顶，于是围栏外它照样进上下文。写成一个动词而不是一个
      // 「例外开关」——作者要的是「这次也带上它」，不是在管理围栏的例外表。
      ...(scope !== null && !inScope(e, scope)
        ? [{
            kind: "item" as const,
            icon: <Pin size={13} />,
            label: t("lore.collections.assign.makeVisible"),
            action: () => {
              const cur = loadPinnedLore(projectPath);
              if (!cur.includes(e.dirPath)) savePinnedLore(projectPath, [...cur, e.dirPath]);
              void scanProject(projectPath!);
            },
          }]
        : []),
      { kind: "divider" },
      { kind: "item", icon: <FolderOpen size={13} />, label: t("lore.panel.showInBrowser"),
        action: () => { revealItemInDir(e.dirPath).catch(() => { /* best-effort */ }); } },
      { kind: "item", icon: <Trash2 size={13} />, label: t("lore.panel.deleteEntity"), danger: true,
        action: () => void handleDeleteEntity(e) },
    ];
  };

  const forwardVariants = useMotionPreset(pushForward);
  const backdropVariants = useMotionPreset(pushBackdrop);

  return (
    <div style={{ position: "relative", flex: 1, minWidth: 0, height: "100%", display: "flex", overflow: "hidden" }}>
      <AnimatePresence initial={false}>
        {/* Keyed by entity: LoreDetail seeds internal state from the entity it
            mounted with, so going straight from one entry to another (a
            citation click, a history step) has to remount it. */}
        {detailEntity ? (
          <motion.div
            key={`detail:${detailEntity.dirPath}`}
            variants={forwardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={springScreen}
            style={fillLayer}
          >
            <LoreDetail
              entity={detailEntity}
              initialEditing={detailEditing}
              onBack={() => openDetail(null)}
            />
          </motion.div>
        ) : (
          <motion.div
            key="grid"
            variants={backdropVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={springScreen}
            style={fillLayer}
          >
            <div className={styles.wall}>
      {newMode === "ai" && (
        <LoreGenerator
          initialDescription={extractSeed ?? undefined}
          onClose={() => { setNewMode(null); setExtractSeed(null); }}
          onModeChange={setNewMode}
        />
      )}
      {showNewCategory && (
        <NewCategoryModal
          onClose={() => setShowNewCategory(false)}
          onCreate={async (label) => {
            const id = suggestCategoryId(label, loreCategoryIds());
            const store = useProjectStore.getState();
            await store.setCustomCategories([
              ...store.customCategories,
              { id, labelZh: label, labelEn: label },
            ]);
            setShowNewCategory(false);
            setFilter(id);
          }}
        />
      )}
      {newMode === "manual" && (
        <NewEntryModal
          initialCategory={filter !== "all" ? (filter as CategoryId) : defaultCategoryId()}
          onClose={() => setNewMode(null)}
          onModeChange={setNewMode}
          onCreate={async (category, name) => {
            if (!projectPath) return;
            const baseId = slugifyEntityId(name);
            const id = await uniqueEntityId(projectPath, category, baseId);
            await createNewEntity(projectPath, category, id, name.trim());
            setNewMode(null);
            const created = useLoreStore.getState().index[category]?.find((e) => e.id === id);
            if (created) openDetail(created.dirPath);
          }}
        />
      )}

      {/* 骑缝带常驻，不是一个可关掉的提示：范围指向一个空集合、或者作者忘了自己
          上次切过，这两种情况下 AI 一条设定也找不到，而唯一的止损就是界面上始终
          写着当前生效的是哪一个。 */}
      {scope !== null && !selectMode && (
        <ScopeBand
          index={index}
          scope={scope}
          onSwitch={setScopeMenu}
          onReset={() => setScope(projectPath, null)}
        />
      )}

      {selectMode && (
        <div className={cs.selectHead}>
          <span className={cs.bandEyebrow}>{t("lore.collections.select.mode")}</span>
          <span className={cs.bandRule} />
          <span className={cs.bandExplainZh}>{t("lore.collections.select.how")}</span>
          <span style={{ flex: 1 }} />
          <span className={cs.wallFootMono}>{t("lore.collections.select.esc")}</span>
        </div>
      )}

      <div className={styles.header}>
        <div className={styles.headerRow}>
          <div className={styles.eyebrow}>{kbEyebrow}</div>
          <div className={styles.title}>{terms.kb}</div>
          <div className={styles.subtitle}>
            {projectPath ? `${baseName(projectPath)} · ` : ""}
            {scope !== null
              ? t("lore.collections.wallStatsScoped", {
                  entries: counts.all,
                  inScope: counts.all - allEntities.filter(isOut).length,
                })
              : collections.length > 0
                ? t("lore.collections.wallStats", {
                    entries: counts.all,
                    collections: collections.length,
                  })
                : t("lore.wallStats", {
                    defaultValue: "{{n}} 条 · {{r}} 关系",
                    n: counts.all,
                    r: totalRelations,
                    entries: terms.entries,
                  })}
          </div>
          <span className={styles.spacer} />

          <div className={styles.search}>
            <Search size={12} color="var(--color-text-muted)" strokeWidth={1.6} />
            <input
              className={styles.searchInput}
              placeholder={t("sidebar.projectSearch", { entries: terms.entries })}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className={styles.searchKey} onClick={() => setShowCommandPalette(true)} style={{ cursor: "pointer" }}>{MOD_K_SPACED}</span>
          </div>

          <ScopeButton scope={scope} onOpen={setScopeMenu} />

          <button className={styles.btnPrimary} onClick={() => setNewMode("manual")}>
            <Plus size={12} strokeWidth={2.5} />
            {t("lore.panel.newEntry")}
          </button>
          {/* 一根 1px 竖线把「操作这面墙的内容」与「这面墙和服务器的关系」切开;
              状态件只在项目绑定后存在(设计稿 14 屏 1i/1k)。 */}
          <span className={styles.headDivider} />
          <SyncPresence />
          <button
            className={styles.btnGhost}
            onClick={(ev) => {
              const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom + 4, entity: null, header: true });
            }}
            title={t("lore.detail.moreActions", { defaultValue: "更多操作" })}
          >
            {/* Icon, not a ⋯ glyph: an icon centers identically everywhere,
                while the ellipsis character's vertical position depends on
                whichever fallback font supplies it. */}
            <MoreHorizontal size={12} strokeWidth={2} />
          </button>
        </div>

      </div>

      {/* 两根轴的分工写在布局里：**装订栏在左**（集合＝这条属于哪一摊活），
          **分类 chips 在右上**（分类＝这条是什么）。墙本身从不按集合分区——
          一个条目属于几个集合，墙上都只出现一次（设计稿 03 屏 24 的 Q1）。 */}
      <div className={styles.body}>
        <CollectionRail
          index={index}
          declared={collections}
          filter={colFilter}
          scope={scope}
          onFilter={setColFilter}
          onScope={(next) => setScope(projectPath, next)}
          onManage={() => setShowManage(true)}
          onCreate={() => setShowManage(true)}
        />

        <div className={styles.main}>
            <div className={styles.filters}>
              <span
                className={`${styles.chip} ${filter === "all" ? styles.chipActive : ""}`}
                onClick={() => setFilter("all")}
              >
                {isZh ? "全部" : "All"}
                <span className={styles.chipCount}>{counts.all}</span>
              </span>
              {cats.map((cat) => (
                <span
                  key={cat.id}
                  className={`${styles.chip} ${filter === cat.id ? styles.chipActive : ""}`}
                  style={filter === cat.id ? undefined : { borderLeft: `3px solid ${categoryColor(cat.id)}` }}
                  onClick={() => setFilter(cat.id)}
                  // 右键是删除分类的入口，和「+ 新建分类」同一处——建和删本来就该在一起。
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    setCatMenu({ x: ev.clientX, y: ev.clientY, cat });
                  }}
                  // Orphans look like any other chip on purpose: their entries are
                  // intact, so an alarming treatment would misreport the state. The
                  // dedicated presentation is 设计稿 03 屏 23 (plan phase 4).
                  title={cat.orphan
                    ? (isZh
                        ? "这个分类来自未启用的能力包 · 条目完好，只是不能在这里新建 · 右键可把条目搬走"
                        : "From a pack that isn't enabled — entries are intact, but nothing new can be created here. Right-click to move them out")
                    : t("lore.categoryDelete.chipHint")}
                >
                  {categoryLabel(cat, isZh)}
                  <span className={styles.chipCount}>{counts[cat.id] ?? 0}</span>
                </span>
              ))}
              <span
                className={styles.chip}
                onClick={() => setShowNewCategory(true)}
                title={t("lore.newCategory.hint", { defaultValue: isZh ? "新建一个知识库分类" : "Create a knowledge-base category" })}
              >
                <Plus size={11} strokeWidth={2.2} />
                {t("lore.newCategory.cta", { defaultValue: isZh ? "新建分类" : "New category" })}
              </span>
              <span style={{ flex: 1 }} />
              {selectMode ? (
                <span
                  className={cs.railFootLink}
                  onClick={() => {
                    setSelected(new Set(filtered.map((e) => e.dirPath)));
                    anchorRef.current = null;
                  }}
                >
                  {t("lore.collections.select.selectAll", { n: filtered.length })}
                </span>
              ) : (
                <span className={cs.chipsNote}>
                  {scope !== null
                    ? t("lore.collections.scope.chipsNote")
                    : t("lore.collections.axisNote")}
                </span>
              )}
            </div>
          <div className={styles.gridArea}>
        <div
          ref={gridRef}
          className={styles.gridWrap}
          onPointerDown={onGridPointerDown}
          onContextMenu={(ev) => {
            ev.preventDefault();
            setMenu({ x: ev.clientX, y: ev.clientY, entity: null });
          }}
        >
          {colFilter === UNGROUPED && filtered.length > 0 && (
          <div className={cs.ungroupedHint}>
            {t("lore.collections.ungroupedFilteredN", { n: filtered.length })}
          </div>
        )}
        {filtered.length === 0 ? (
            <div className={styles.empty}>
              {search.trim()
                ? t("lore.wallNoMatch", { defaultValue: "未找到匹配的{{entry}}", entry: terms.entry })
                : t("lore.wallEmpty", {
                    defaultValue: "{{kb}}为空 — 用 AI 提取或新建条目开始积累",
                    kb: terms.kb,
                  })}
            </div>
          ) : (
            // key 只跟取材范围走：换围栏是一次换幕（它同时改的是 AI 的视野），
            // 值得一次淡入；而搜索/分类筛选每次按键都会改 filtered，跟着重挂载
            // 就会变成在打字时闪烁。
            <div key={scope ?? "all"} className={styles.grid}>
              {filtered.map((e, idx) => {
                const featured = idx === 0 && filter === "all";
                const rot = rotationFor(e.id);
                const cat = findCategory(e.category);
                const cols = entityCollections(e);
                const out = isOut(e);
                const pinnedOverFence =
                  scope !== null && !inScope(e, scope) && pinnedDirs.has(e.dirPath);

                // 围栏外的条目**翻面**而不是消失：作者仍然看得见、点得开、搜得到，
                // 只是这次运行 AI 不会自己找到它。筛选让卡片消失，围栏让卡片翻面
                // ——两者永远不长成一个样子（设计稿 03 屏 25 的 Q2）。
                if (out) {
                  return (
                    <div
                      key={e.id}
                      data-lore-card
                      ref={(el) => { if (el) cardRefs.current.set(e.dirPath, el); else cardRefs.current.delete(e.dirPath); }}
                      className={cs.flip}
                      style={{ transform: `rotate(${rot}deg)` }}
                      onClick={() => openDetail(e.dirPath)}
                      onContextMenu={(ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        setMenu({ x: ev.clientX, y: ev.clientY, entity: e });
                      }}
                    >
                      <div className={cs.flipName}>{e.name}</div>
                      <div className={cs.flipMeta}>
                        {t("lore.collections.scope.cardOut", {
                          name: cols.length > 0 ? cols.join(" · ") : t("lore.collections.ungrouped"),
                        })}
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={e.id}
                    data-lore-card
                    ref={(el) => { if (el) cardRefs.current.set(e.dirPath, el); else cardRefs.current.delete(e.dirPath); }}
                    className={`${styles.card} ${cs.edgeHost} ${featured ? styles.cardFeatured : ""} ${pinnedOverFence ? styles.cardPinned : ""} ${selected.has(e.dirPath) ? styles.cardSelected : ""}`}
                    style={{ transform: `rotate(${rot}deg)` }}
                    onClick={(ev) => {
                      // 多选中（或按住 ⇧）时，卡身是「选中」而不是「打开」。
                      if (selectMode || ev.shiftKey) { toggleSelect(e, ev); return; }
                      openDetail(e.dirPath);
                    }}
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      setMenu({ x: ev.clientX, y: ev.clientY, entity: e });
                    }}
                  >
                    <BindingEdge
                      collections={cols}
                      scope={scope}
                      selectMode={selectMode}
                      selected={selected.has(e.dirPath)}
                      onToggleSelect={(ev) => toggleSelect(e, ev)}
                    />
                    <div className={styles.cardBody}>
                      {pinnedOverFence && (
                        <div className={cs.pinnedBadgeRow}>
                          <span className={cs.pinnedBadge}>{t("lore.collections.scope.pinned")}</span>
                          <span className={cs.pinnedNote}>{t("lore.collections.scope.pinnedNote")}</span>
                        </div>
                      )}

                      <div className={styles.cardTop}>
                        <span className={styles.cardLabel}>
                          {cat ? categoryLabel(cat, isZh) : e.category}
                        </span>
                      </div>
                      <div className={styles.cardHeader}>
                        <div
                          className={styles.cardAvatarWrap}
                          onClick={(ev) => { ev.stopPropagation(); handleAvatarPick(e); }}
                          title={t("lore.wall.changeAvatar", { defaultValue: "更换头像" })}
                        >
                          {e.avatarPath && avatarThumbs[e.avatarPath] ? (
                            <img
                              src={avatarThumbs[e.avatarPath]}
                              alt={e.name}
                              className={styles.cardAvatarImg}
                            />
                          ) : (
                            <div
                              className={styles.cardAvatar}
                              style={{ background: categoryColor(e.category) }}
                            >
                              {e.name.charAt(0)}
                            </div>
                          )}
                          <div className={styles.cardAvatarOverlay}>
                            <Camera size={14} strokeWidth={1.8} />
                          </div>
                        </div>
                        <div>
                          <div className={styles.cardName}>{e.name}</div>
                          {e.aliases.length > 0 && (
                          <div className={styles.cardMeta}>
                            {t("lore.detail.fieldAliases", { defaultValue: "别名" })}：{e.aliases.slice(0, 3).join(" · ")}
                          </div>
                        )}
                        </div>
                      </div>
                      <div className={styles.cardSummary}>
                        {e.summary || "—"}
                      </div>
                      {/* 屏 14: the chips are the entry's 特征 — the aliases already
                          sit under the name, and repeating them said nothing. */}
                      {e.facets.length > 0 && (
                        <div className={styles.cardTags}>
                          {e.facets.slice(0, featured ? 5 : 3).map((f) => (
                            <span key={f.file} className={styles.cardTag}>◈ {f.title}</span>
                          ))}
                          {e.facets.length > (featured ? 5 : 3) && (
                            <span className={styles.cardTagMore}>+{e.facets.length - (featured ? 5 : 3)}</span>
                          )}
                        </div>
                      )}
                      <div className={styles.cardFoot}>
                        {t("lore.wall.cardCounts", {
                          facets: e.facets.length,
                          images: e.images.length,
                          defaultValue: `${e.facets.length} 特征 · ${e.images.length} 配图`,
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* + new card */}
              <div className={styles.newCard} onClick={() => setNewMode("manual")}>
                <Plus size={22} color="var(--color-sienna)" strokeWidth={1.6} />
                <div className={styles.newCardLabel}>{t("lore.panel.newEntry")}</div>
                <div className={styles.newCardHint}>{isZh ? "手填或从手稿提取" : "Fill in, or extract from the manuscript"}</div>
              </div>
            </div>
          )}

          {marquee && (
            <div
              className={cs.marquee}
              style={{
                left: marquee.x0,
                top: marquee.y0,
                width: marquee.x1 - marquee.x0,
                height: marquee.y1 - marquee.y0,
              }}
            >
              <span className={cs.marqueeNote}>{t("lore.collections.select.marquee")}</span>
            </div>
          )}
        </div>

            {/* 页边的围栏标注：围栏生效时右侧多出的那一条骑缝。它和顶部的带子
                是同一件事说两遍——一次在你进来时，一次在你视线离开卡片时。 */}
            {scope !== null && (
              <div className={cs.pageEdge}>
                <span className={cs.pageEdgeText}>
                  {t("lore.collections.scope.fence", { name: scope })}
                </span>
              </div>
            )}
          </div>

          {selectMode ? (
            <div className={cs.selectBar}>
              <span className={cs.selectCount}>
                {t("lore.collections.select.selected", { n: selected.size })}
              </span>
              <span className={cs.selectBreakdown}>{selectedBreakdown}</span>
              <span style={{ flex: 1 }} />
              {/* 分类在集合之前：第一根轴排在第二根轴左边，两颗集合按钮仍然连着。 */}
              <button
                type="button"
                className={`${cs.selectBtn} ${cs.selectBtnSecondary}`}
                disabled={selected.size === 0}
                onClick={(ev) => {
                  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                  setCatMove({ x: r.left, y: r.top - 8, above: true });
                }}
              >
                {t("lore.categoryMove.cta")}
              </button>
              <button
                type="button"
                className={cs.selectBtn}
                disabled={selected.size === 0}
                onClick={(ev) => openAssign(ev, "add")}
              >
                {t("lore.collections.select.fileInto")}
              </button>
              <button
                type="button"
                className={`${cs.selectBtn} ${cs.selectBtnSecondary}`}
                disabled={selected.size === 0}
                onClick={(ev) => openAssign(ev, "remove")}
              >
                {t("lore.collections.select.removeFrom")}
              </button>
              <button type="button" className={`${cs.selectBtn} ${cs.selectBtnGhost}`} onClick={exitSelect}>
                {t("lore.collections.select.cancel")}
              </button>
            </div>
          ) : scope !== null ? (
            <div className={cs.wallFoot}>
              <span className={cs.wallFootSwatch} />
              <span className={cs.wallFootZh}>
                {t("lore.collections.scope.outNote", { n: outOfScopeVisible })}
              </span>
              <span style={{ flex: 1 }} />
              {unfiled > 0 && (
                <>
                  <span className={cs.wallFootMono}>
                    {t("lore.collections.scope.ungroupedOut", { n: unfiled })}
                  </span>
                  <button type="button" className={cs.wallFootBtn} onClick={fileUnfiledIntoScope}>
                    {t("lore.collections.scope.fileInto", { name: scope })}
                  </button>
                </>
              )}
            </div>
          ) : collections.length === 0 && counts.all > 0 ? (
            // 一个集合都还没建：墙底说的是「装订边现在都空着」，并给出唯一的下一步。
            <div className={cs.wallFoot}>
              <span className={cs.wallFootZh}>
                {t("lore.collections.emptyBindingNote", { n: counts.all })}
              </span>
              <span className={cs.wallFootEn}>{t("lore.collections.emptyBindingNoteEn")}</span>
              <span style={{ flex: 1 }} />
              <button type="button" className={cs.wallFootBtn} onClick={() => setSelectMode(true)}>
                {t("lore.collections.startBatch")}
              </button>
            </div>
          ) : (
            <div className={cs.wallFoot}>
              <span className={cs.wallFootMono}>{t("lore.collections.wallFootLegend")}</span>
              <span className={cs.wallFootRule} />
              <span className={cs.wallFootZh}>{t("lore.collections.wallFootNote")}</span>
              <span className={cs.wallFootEn}>{t("lore.collections.wallFootNoteEn")}</span>
            </div>
          )}
        </div>
      </div>

      {scopeMenu && (
        <ScopeMenu
          index={index}
          declared={collections}
          scope={scope}
          anchor={scopeMenu}
          onPick={(next) => setScope(projectPath, next)}
          onManage={() => setShowManage(true)}
          onClose={() => setScopeMenu(null)}
        />
      )}

      {assign && (
        <CollectionAssignMenu
          index={index}
          declared={collections}
          entities={assign.entities}
          mode={assign.mode}
          anchor={assign.anchor}
          onCommit={(add, remove) => void commitAssign(assign.entities, add, remove)}
          onClose={() => setAssign(null)}
        />
      )}

      {catMove && (
        <CategoryMoveMenu
          entities={selectedEntities}
          anchor={catMove}
          onPick={(category) => void moveSelectedToCategory(category)}
          onClose={() => setCatMove(null)}
        />
      )}

      {catMenu && (
        <ContextMenu
          x={catMenu.x}
          y={catMenu.y}
          items={categoryMenuItems(catMenu.cat)}
          onClose={() => setCatMenu(null)}
        />
      )}

      {deleteCat && (
        <CategoryDeleteModal
          categoryId={deleteCat.id}
          label={categoryLabel(deleteCat, isZh)}
          entities={index[deleteCat.id] ?? []}
          targets={relocationTargets(deleteCat.id)}
          orphan={deleteCat.orphan}
          onConfirm={(choice) => handleCategoryDelete(deleteCat, choice)}
          onClose={() => setDeleteCat(null)}
        />
      )}

      {showManage && (
        <CollectionsManageModal
          index={index}
          declared={collections}
          scope={scope}
          onClose={() => setShowManage(false)}
          onReorder={(next) => useProjectStore.getState().setCollections(next)}
          onCreate={(name) => useProjectStore.getState().setCollections([...collections, name])}
          onRename={(from, to) => useProjectStore.getState().renameCollection(from, to)}
          onDelete={(name) => useProjectStore.getState().deleteCollection(name)}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu)}
          onClose={() => setMenu(null)}
        />
      )}

      {importStaged && (
        <LoreImportModal
          staged={importStaged}
          onCancel={() => {
            void cancelLoreImport(importStaged.tempDir);
            setImportStaged(null);
          }}
          onApply={handleApplyImport}
        />
      )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Create one user-defined knowledge-base category. The author names it; the
 * folder id is derived (`suggestCategoryId`) so the dialog never has to
 * explain folder-name rules. One label serves both languages — a per-language
 * pair here would be ceremony for a personal organisational bucket.
 */
function NewCategoryModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (label: string) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ime = useImeGuard();
  const shellCloseRef = useRef<(() => void) | null>(null);
  const requestClose = () => (shellCloseRef.current ?? onClose)();

  const handleSubmit = async () => {
    if (!label.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onCreate(label.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell overlayClassName={styles.modalBackdrop} onClose={onClose} isDirty={label.trim().length > 0} closeOnBackdrop={false} closeRef={shellCloseRef}>
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <div className={styles.modalEyebrow}>{isZh ? "新建分类" : "NEW CATEGORY"}</div>
          <div className={styles.modalTitle}>
            {t("lore.newCategory.title", { defaultValue: isZh ? "新建知识库分类" : "New knowledge-base category" })}
          </div>
        </div>

        <div className={styles.modalBody}>
          <label className={styles.modalLabel}>{isZh ? "名称" : "Name"}</label>
          <input
            className={styles.modalInput}
            placeholder={t("lore.newCategory.placeholder", { defaultValue: isZh ? "如：会议纪要、竞品调研…" : "e.g. Meeting notes, Research…" })}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={40}
            {...ime.imeProps}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !ime.isComposing(e)) void handleSubmit();
            }}
            autoFocus
          />
          {error && (
            <div style={{ marginTop: 6, font: "400 12px/1.5 var(--font-sans)", color: "var(--color-red, #b91c1c)" }}>
              {error}
            </div>
          )}
        </div>

        <div className={styles.modalActions}>
          <button className={styles.btnSecondary} onClick={requestClose}>
            {t("lore.form.cancel", { defaultValue: isZh ? "取消" : "Cancel" })}
          </button>
          <button className={styles.btnPrimary} onClick={handleSubmit} disabled={!label.trim() || saving}>
            {saving
              ? t("lore.form.creating", { defaultValue: isZh ? "创建中…" : "Creating…" })
              : t("lore.form.create", { defaultValue: isZh ? "创建" : "Create" })}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function NewEntryModal({
  initialCategory,
  onClose,
  onModeChange,
  onCreate,
}: {
  initialCategory: CategoryId;
  onClose: () => void;
  onModeChange: (mode: NewEntryMode) => void;
  onCreate: (category: CategoryId, name: string) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const [category, setCategory] = useState<CategoryId>(initialCategory);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const ime = useImeGuard();
  const shellCloseRef = useRef<(() => void) | null>(null);
  const requestClose = () => (shellCloseRef.current ?? onClose)();

  const handleSubmit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await onCreate(category, name);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell overlayClassName={styles.modalBackdrop} onClose={onClose} isDirty={name.trim().length > 0} closeOnBackdrop={false} closeRef={shellCloseRef}>
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <div className={styles.modalEyebrow}>{isZh ? "新建条目" : "NEW ENTRY"}</div>
          <div className={styles.modalTitle}>{t("lore.panel.newEntry")}</div>
        </div>

        <div className={styles.modalBody}>
          <NewEntryTabs value="manual" onChange={onModeChange} />
          <label className={styles.modalLabel}>{isZh ? "分类" : "Category"}</label>
          {/* Creation target — the workspace list, never `indexCategories`: an
              orphan category is not a folder this app may create an entry in. */}
          <div className={styles.modalCats}>
            {loreCategories().map((cat) => (
              <span
                key={cat.id}
                className={`${styles.chip} ${category === cat.id ? styles.chipActive : ""}`}
                onClick={() => setCategory(cat.id)}
              >
                <span className={styles.chipDot} style={{ background: categoryColor(cat.id) }} />
                {categoryLabel(cat, isZh)}
              </span>
            ))}
          </div>

          <label className={styles.modalLabel}>{isZh ? "名称" : "Name"}</label>
          <input
            className={styles.modalInput}
            placeholder={t("lore.form.namePlaceholder", { defaultValue: isZh ? "条目名称" : "Entry name" })}
            value={name}
            onChange={(e) => setName(e.target.value)}
            {...ime.imeProps}
            onKeyDown={(e) => {
              // Escape is handled by ModalShell (with an unsaved-changes guard).
              // An Enter that ends a pinyin word belongs to the IME, not to us.
              if (e.key === "Enter" && !ime.isComposing(e)) void handleSubmit();
            }}
            autoFocus
          />
        </div>

        <div className={styles.modalActions}>
          <button className={styles.btnSecondary} onClick={requestClose}>
            {t("lore.form.cancel", { defaultValue: isZh ? "取消" : "Cancel" })}
          </button>
          <button
            className={styles.btnPrimary}
            onClick={handleSubmit}
            disabled={!name.trim() || saving}
          >
            {saving
              ? t("lore.form.creating", { defaultValue: isZh ? "创建中…" : "Creating…" })
              : t("lore.form.create", { defaultValue: isZh ? "创建" : "Create" })}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/**
 * Confirmation step of a lore bundle import: shows what the bundle contains,
 * and — when some entities already exist — lets the user pick the conflict
 * strategy before anything is written into the real lore tree.
 */
function LoreImportModal({
  staged,
  onCancel,
  onApply,
}: {
  staged: StagedLoreImport;
  onCancel: () => void;
  onApply: (strategy: ConflictStrategy) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const terms = useTerms();
  const [strategy, setStrategy] = useState<ConflictStrategy>("skip");
  const [applying, setApplying] = useState(false);
  const shellCloseRef = useRef<(() => void) | null>(null);
  const requestClose = () => (shellCloseRef.current ?? onCancel)();

  const conflicts = staged.entities.filter((e) => e.conflicts);
  const strategies: { value: ConflictStrategy; label: string }[] = [
    { value: "skip", label: t("lore.transfer.strategySkip") },
    { value: "overwrite", label: t("lore.transfer.strategyOverwrite") },
    { value: "keepBoth", label: t("lore.transfer.strategyKeepBoth") },
  ];

  const handleApply = async () => {
    if (applying) return;
    setApplying(true);
    try {
      await onApply(strategy);
    } finally {
      setApplying(false);
    }
  };

  return (
    <ModalShell overlayClassName={styles.modalBackdrop} onClose={onCancel} closeOnBackdrop={false} closeRef={shellCloseRef}>
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <div className={styles.modalEyebrow}>{isZh ? `导入${terms.kb}` : "IMPORT"}</div>
          <div className={styles.modalTitle}>{t("lore.transfer.import")}</div>
        </div>

        <div className={styles.modalBody}>
          <div style={{ font: "400 12.5px/1.7 var(--font-sans)", color: "var(--color-text-secondary)" }}>
            {t("lore.transfer.stagedSummary", { count: staged.entities.length })}
            {staged.manifest?.profileId && (
              <> · {t("lore.transfer.sourceProfile", { profile: staged.manifest.profileId })}</>
            )}
          </div>

          {conflicts.length > 0 && (
            <>
              <div style={{
                display: "flex", alignItems: "center", gap: 6, marginTop: 10,
                font: "500 12px/1.5 var(--font-sans)", color: "var(--color-amber, #b45309)",
              }}>
                <AlertTriangle size={13} />
                {t("lore.transfer.conflictCount", { count: conflicts.length })}
              </div>
              <div style={{ font: "400 12px/1.6 var(--font-sans)", color: "var(--color-text-muted)", marginTop: 4 }}>
                {conflicts.slice(0, 8).map((e) => e.name).join("、")}
                {conflicts.length > 8 && ` …(+${conflicts.length - 8})`}
              </div>

              <label className={styles.modalLabel}>{t("lore.transfer.strategyLabel")}</label>
              <div className={styles.modalCats}>
                {strategies.map((s) => (
                  <span
                    key={s.value}
                    className={`${styles.chip} ${strategy === s.value ? styles.chipActive : ""}`}
                    onClick={() => setStrategy(s.value)}
                  >
                    {s.label}
                  </span>
                ))}
              </div>
              {strategy === "overwrite" && (
                <div style={{ font: "400 12px/1.6 var(--font-sans)", color: "var(--color-text-muted)", marginTop: 6 }}>
                  {t("lore.transfer.strategyOverwriteHint")}
                </div>
              )}
            </>
          )}
        </div>

        <div className={styles.modalActions}>
          <button className={styles.btnSecondary} onClick={requestClose} disabled={applying}>
            {t("lore.form.cancel", { defaultValue: isZh ? "取消" : "Cancel" })}
          </button>
          <button className={styles.btnPrimary} onClick={handleApply} disabled={applying}>
            {applying ? t("lore.transfer.importing") : t("lore.transfer.importConfirm")}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
