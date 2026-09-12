/**
 * Single source of truth for the app's keyboard shortcuts: a shared
 * modifier-matching helper, a display-label formatter, and a registry
 * listing every shortcut in the app (whether it's centrally dispatched or
 * just documented here for the shortcuts list in Settings).
 */
import { IS_MAC } from "./platform";
import type { AppScreen } from "../stores/appStore";

export interface Combo {
  /** metaKey (Mac) or ctrlKey (other platforms) — the app's one "mod" key. */
  mod?: boolean;
  /**
   * The Control key *as a modifier of its own* — meaningful on Mac only, where
   * `mod` is ⌘ and Control is still free. Elsewhere Control **is** `mod`, so a
   * combo asking for both names a chord that platform cannot produce.
   *
   * No binding currently sets it. It stays because `matchesCombo` needs the
   * field to *reject* a ⌃⌘ chord on a plain-⌘ binding — which is what makes
   * "exact modifier match" below true rather than approximately true.
   */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** KeyboardEvent.key, compared case-insensitively (e.g. "k", "Escape"). */
  key: string;
}

/** Exact modifier match — a combo only fires when every modifier matches,
 *  so e.g. Cmd+Shift+K does not also trigger a Cmd+K binding. */
export function matchesCombo(e: KeyboardEvent, combo: Combo): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (!!combo.mod !== mod) return false;
  if (!!combo.shift !== e.shiftKey) return false;
  if (!!combo.alt !== e.altKey) return false;
  // Mac only: ⌃⌘K and ⌘K are two different chords, and `mod` above says true
  // for both (it ORs the two keys), so without this line every plain-⌘ binding
  // also answers to its ⌃⌘ variant. Off-Mac the two keys are the same key, so
  // the check is skipped rather than made false: requiring `ctrlKey === false`
  // there would kill every Windows/Linux binding at once.
  if (IS_MAC && !!combo.ctrl !== e.ctrlKey) return false;
  return e.key.toLowerCase() === combo.key.toLowerCase();
}

/** Display label for a combo, e.g. "⌘⇧K" on Mac, "Ctrl+Shift+K" elsewhere. */
export function comboLabel(combo: Combo): string {
  if (IS_MAC) {
    const mods = `${combo.mod ? "⌘" : ""}${combo.ctrl ? "⌃" : ""}${combo.shift ? "⇧" : ""}${combo.alt ? "⌥" : ""}`;
    return `${mods}${displayKey(combo.key)}`;
  }
  // `ctrl` is deliberately not rendered off-Mac: it never fires there, and
  // "Ctrl+Ctrl+W" is the only thing it could print.
  const parts = [
    combo.mod && "Ctrl",
    combo.shift && "Shift",
    combo.alt && "Alt",
    displayKey(combo.key),
  ].filter(Boolean);
  return parts.join("+");
}

function displayKey(key: string): string {
  if (key === "Escape") return "Esc";
  if (key === "ArrowLeft") return "←";
  if (key === "ArrowRight") return "→";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/**
 * Back / forward, bound the way each platform binds them.
 *
 * Mac gets ⌘[ / ⌘] as the primary pair (Finder, Safari, Xcode) plus ⌘←/⌘→ as
 * the alternates — but the arrow pair only fires outside text entry, because
 * there ⌘← means "jump to line start" and stealing it would break typing.
 * Elsewhere Alt+←/→ is the universal binding and CodeMirror leaves it free, so
 * it works while the cursor is in the manuscript.
 */
export const NAV_BACK_COMBOS: Combo[] = IS_MAC
  ? [{ mod: true, key: "[" }, { mod: true, key: "ArrowLeft" }]
  : [{ alt: true, key: "ArrowLeft" }];

export const NAV_FORWARD_COMBOS: Combo[] = IS_MAC
  ? [{ mod: true, key: "]" }, { mod: true, key: "ArrowRight" }]
  : [{ alt: true, key: "ArrowRight" }];

/**
 * 「关闭」这一族，三层，三平台同一套（VS Code 的分法）：
 *
 * | 动作 | 键 | 实现在哪 |
 * |---|---|---|
 * | 关闭**文档** | `⌘W` / `Ctrl+W` | 这里 → `useGlobalShortcuts` |
 * | 关闭**项目** | `⇧⌘W` / `Ctrl+Shift+W` | `components/layout/ProjectRow.tsx`（项目开着时才挂） |
 * | 关闭**窗口** | `⌥⌘W`（仅 mac） | `src-tauri/src/windowmenu.rs` 的菜单项 |
 *
 * ⌘W 落在最轻的那一档，是因为作者按它的频率也是最高的——而这三个动作里，只有
 * 关文档是随手可撤的（⌘← 回得去）。
 *
 * 这一族曾经不是这样：mac 的菜单原先挂 `PredefinedMenuItem::close_window`，那个
 * 预置项固定带着 ⌘W，而原生菜单先于 webview 收键——一个窗口就是一个工作区，于是
 * 「关文档」的 ⌘W 实际关掉的是整个项目窗口。修法是把关窗口挪到 ⌥⌘W（macOS 上
 * Close All Windows 的位置），⌘W 让回页面；短暂存在过的 ⌃⌘W 后备随之撤掉。
 */
export const CLOSE_DOC_COMBOS: Combo[] = [{ mod: true, key: "w" }];

/** Combos that must yield to a caret — see NAV_BACK_COMBOS. */
export function comboNeedsIdleCaret(combo: Combo): boolean {
  return IS_MAC && (combo.key === "ArrowLeft" || combo.key === "ArrowRight");
}

/** Is the event headed for somewhere the author is typing? */
export function inTextEntry(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  return !!el?.closest("input, textarea, [contenteditable='true'], [contenteditable='']");
}

/** "⌘[ / ⌘←" — every binding for one action, for the shortcuts list. */
export function combosLabel(combos: Combo[]): string {
  return combos.map(comboLabel).join(" / ");
}

/**
 * Screen switching — ⌘1‥⌘5 / Ctrl+1‥Ctrl+5, in the order the icon rail shows
 * them: the three workbench panels, then the two full-window views, then
 * settings.
 *
 * Digits rather than letters because every letter worth having is already
 * spoken for (⌘K/⌘L/⌘J/⌘S, and CodeMirror's markdown keymap), and because a
 * modifier+digit means nothing to a text field — so these fire while the caret
 * sits in the manuscript, which is exactly when the author wants them.
 */
export const SCREEN_COMBOS: { screen: AppScreen; combo: Combo }[] = [
  { screen: "files", combo: { mod: true, key: "1" } },
  { screen: "outline", combo: { mod: true, key: "2" } },
  { screen: "knowledge", combo: { mod: true, key: "3" } },
  { screen: "library", combo: { mod: true, key: "4" } },
  { screen: "settings", combo: { mod: true, key: "5" } },
];

/** Settings answers to its own ⌘, as well as its screen digit. */
const SETTINGS_COMBOS: Combo[] = [
  { mod: true, key: "," },
  { mod: true, key: "5" },
];

/** "dispatch" = wired into useGlobalShortcuts; "info" = implemented locally
 *  (CodeMirror keymap, a component's own listener, a form's Enter/Esc), only
 *  listed here so the Settings shortcuts tab is complete. */
export type ShortcutScope = "dispatch" | "info";

export type ShortcutCategory = "global" | "view" | "file" | "ai" | "editor" | "contextual";

export interface ShortcutDef {
  id: string;
  category: ShortcutCategory;
  /** Required for "dispatch" entries; "info" entries may use this too, or
   *  fall back to keysLabel for combos that don't fit the Combo shape. */
  combo?: Combo;
  /** Freeform display text for info entries a Combo can't express (e.g. "↑ / ↓"). */
  keysLabel?: string;
  /** i18n key under systemSettings.shortcuts.items for this entry's label. */
  labelKey: string;
  scope: ShortcutScope;
}

export const SHORTCUTS: ShortcutDef[] = [
  // ─── Global ───────────────────────────────────────────────────────────
  { id: "commandPalette", category: "global", combo: { mod: true, key: "k" }, labelKey: "commandPalette", scope: "dispatch" },
  { id: "commandPaletteDocs", category: "global", combo: { mod: true, key: "p" }, labelKey: "commandPaletteDocs", scope: "dispatch" },
  { id: "aiChatDrawer", category: "global", combo: { mod: true, key: "l" }, labelKey: "aiChatDrawer", scope: "dispatch" },
  { id: "aiPanel", category: "global", combo: { mod: true, key: "j" }, labelKey: "aiPanel", scope: "dispatch" },
  { id: "closeOverlays", category: "global", combo: { key: "Escape" }, labelKey: "closeOverlays", scope: "dispatch" },
  { id: "navBack", category: "global", keysLabel: combosLabel(NAV_BACK_COMBOS), labelKey: "navBack", scope: "dispatch" },
  { id: "navForward", category: "global", keysLabel: combosLabel(NAV_FORWARD_COMBOS), labelKey: "navForward", scope: "dispatch" },

  // ─── View (screen switching — see SCREEN_COMBOS) ──────────────────────
  { id: "viewFiles", category: "view", combo: { mod: true, key: "1" }, labelKey: "viewFiles", scope: "dispatch" },
  { id: "viewOutline", category: "view", combo: { mod: true, key: "2" }, labelKey: "viewOutline", scope: "dispatch" },
  { id: "viewKnowledge", category: "view", combo: { mod: true, key: "3" }, labelKey: "viewKnowledge", scope: "dispatch" },
  { id: "viewLibrary", category: "view", combo: { mod: true, key: "4" }, labelKey: "viewLibrary", scope: "dispatch" },
  { id: "openSettings", category: "view", keysLabel: combosLabel(SETTINGS_COMBOS), labelKey: "openSettings", scope: "dispatch" },

  // ─── File ─────────────────────────────────────────────────────────────
  { id: "saveFile", category: "file", combo: { mod: true, key: "s" }, labelKey: "saveFile", scope: "dispatch" },
  // 「关闭」三层里的第一层（见 CLOSE_DOC_COMBOS 的表）。面包屑末尾的 ×、⌘W、
  // 文件树右键的「关闭」走的是同一个 `closeDocument()`。
  { id: "closeDoc", category: "file", combo: CLOSE_DOC_COMBOS[0], labelKey: "closeDoc", scope: "dispatch" },
  // 文件面板自己的绑定（components/layout/FileTree.tsx + ProjectRow.tsx）。它们
  // 只在「文件」标签页挂着时监听——动作说的是「这个面板里的东西」，而面板不在，
  // 折叠什么、定位到哪里就都无从谈起。⌥⌘L 而不是设计稿写的 ⇧⌘L：后者已经是
  // 「AI 润色」，两个 dispatch 撞在一起是静默的，先注册的赢。
  { id: "filesCollapseAll", category: "file", combo: { mod: true, alt: true, key: "ArrowLeft" }, labelKey: "filesCollapseAll", scope: "info" },
  { id: "filesRevealCurrent", category: "file", combo: { mod: true, alt: true, key: "l" }, labelKey: "filesRevealCurrent", scope: "info" },
  { id: "filesSwitchProject", category: "file", combo: { mod: true, shift: true, key: "o" }, labelKey: "filesSwitchProject", scope: "info" },
  { id: "filesCloseProject", category: "file", combo: { mod: true, shift: true, key: "w" }, labelKey: "filesCloseProject", scope: "info" },
  // 第三层，只有 mac 有：菜单项本身在 `windowmenu.rs`，这一行只是让快捷键表说全。
  ...(IS_MAC
    ? [{ id: "closeWindow", category: "file", combo: { mod: true, alt: true, key: "w" }, labelKey: "closeWindow", scope: "info" } as ShortcutDef]
    : []),
  // 树自己的键盘操作：焦点在文件树里时才生效（点过任意一行就有焦点）。
  { id: "filesNewDoc", category: "file", combo: { mod: true, key: "n" }, labelKey: "filesNewDoc", scope: "info" },
  { id: "filesNewGroup", category: "file", combo: { mod: true, shift: true, key: "n" }, labelKey: "filesNewGroup", scope: "info" },
  { id: "filesCut", category: "file", combo: { mod: true, key: "x" }, labelKey: "filesCut", scope: "info" },
  { id: "filesCopy", category: "file", combo: { mod: true, key: "c" }, labelKey: "filesCopy", scope: "info" },
  { id: "filesPaste", category: "file", combo: { mod: true, key: "v" }, labelKey: "filesPaste", scope: "info" },
  { id: "filesRename", category: "file", keysLabel: "Enter", labelKey: "filesRename", scope: "info" },
  { id: "filesDelete", category: "file", keysLabel: IS_MAC ? "⌫" : "Delete", labelKey: "filesDelete", scope: "info" },

  // ─── AI ───────────────────────────────────────────────────────────────
  { id: "aiRewrite", category: "ai", combo: { mod: true, shift: true, key: "e" }, labelKey: "aiRewrite", scope: "dispatch" },
  { id: "aiPolish", category: "ai", combo: { mod: true, shift: true, key: "l" }, labelKey: "aiPolish", scope: "dispatch" },
  { id: "aiSummary", category: "ai", combo: { mod: true, shift: true, key: "m" }, labelKey: "aiSummary", scope: "dispatch" },
  { id: "aiBubbleDismiss", category: "ai", combo: { key: "Escape" }, labelKey: "aiBubbleDismiss", scope: "info" },
  // Bound by AiDrawer while it is open on 对话助手: ⌘N there is a new conversation
  // (the file tree's ⌘N needs the tree focused, which the drawer never is).
  { id: "aiNewChat", category: "ai", combo: { mod: true, key: "n" }, labelKey: "aiNewChat", scope: "info" },

  // ─── Editor (CodeMirror keymap — implemented in CodeEditor.tsx) ────────
  { id: "editorBold", category: "editor", combo: { mod: true, key: "b" }, labelKey: "editorBold", scope: "info" },
  { id: "editorItalic", category: "editor", combo: { mod: true, key: "i" }, labelKey: "editorItalic", scope: "info" },
  { id: "editorInlineCode", category: "editor", combo: { mod: true, key: "e" }, labelKey: "editorInlineCode", scope: "info" },
  { id: "editorStrikethrough", category: "editor", combo: { mod: true, shift: true, key: "x" }, labelKey: "editorStrikethrough", scope: "info" },
  { id: "editorLink", category: "editor", combo: { mod: true, shift: true, key: "k" }, labelKey: "editorLink", scope: "info" },
  { id: "editorHeading1", category: "editor", combo: { mod: true, alt: true, key: "1" }, labelKey: "editorHeading1", scope: "info" },
  { id: "editorHeading2", category: "editor", combo: { mod: true, alt: true, key: "2" }, labelKey: "editorHeading2", scope: "info" },
  { id: "editorHeading3", category: "editor", combo: { mod: true, alt: true, key: "3" }, labelKey: "editorHeading3", scope: "info" },
  { id: "editorQuote", category: "editor", combo: { mod: true, shift: true, key: "." }, labelKey: "editorQuote", scope: "info" },
  { id: "editorBulletList", category: "editor", combo: { mod: true, shift: true, key: "8" }, labelKey: "editorBulletList", scope: "info" },
  { id: "editorAiTargetStart", category: "editor", combo: { mod: true, shift: true, key: "[" }, labelKey: "editorAiTargetStart", scope: "info" },
  { id: "editorAiTargetEnd", category: "editor", combo: { mod: true, shift: true, key: "]" }, labelKey: "editorAiTargetEnd", scope: "info" },
  { id: "editorAiTargetClear", category: "editor", combo: { mod: true, shift: true, key: "\\" }, labelKey: "editorAiTargetClear", scope: "info" },
  { id: "editorUndo", category: "editor", combo: { mod: true, key: "z" }, labelKey: "editorUndo", scope: "info" },
  { id: "editorRedo", category: "editor", combo: { mod: true, shift: true, key: "z" }, labelKey: "editorRedo", scope: "info" },
  { id: "editorFind", category: "editor", combo: { mod: true, key: "f" }, labelKey: "editorFind", scope: "info" },

  // ─── Contextual (local to whatever's focused/open) ─────────────────────
  { id: "contextualCloseOverlay", category: "contextual", keysLabel: "Esc", labelKey: "contextualCloseOverlay", scope: "info" },
  { id: "contextualConfirmInput", category: "contextual", keysLabel: "Enter", labelKey: "contextualConfirmInput", scope: "info" },
  { id: "contextualPaletteNav", category: "contextual", keysLabel: "↑ / ↓", labelKey: "contextualPaletteNav", scope: "info" },
];
