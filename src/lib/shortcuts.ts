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
  return e.key.toLowerCase() === combo.key.toLowerCase();
}

/** Display label for a combo, e.g. "⌘⇧K" on Mac, "Ctrl+Shift+K" elsewhere. */
export function comboLabel(combo: Combo): string {
  if (IS_MAC) {
    const mods = `${combo.mod ? "⌘" : ""}${combo.shift ? "⇧" : ""}${combo.alt ? "⌥" : ""}`;
    return `${mods}${displayKey(combo.key)}`;
  }
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
export const SETTINGS_COMBOS: Combo[] = [
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
  // 文件面板自己的绑定（components/layout/FileTree.tsx + ProjectRow.tsx）。它们
  // 只在「文件」标签页挂着时监听——动作说的是「这个面板里的东西」，而面板不在，
  // 折叠什么、定位到哪里就都无从谈起。⌥⌘L 而不是设计稿写的 ⇧⌘L：后者已经是
  // 「AI 润色」，两个 dispatch 撞在一起是静默的，先注册的赢。
  { id: "filesCollapseAll", category: "file", combo: { mod: true, alt: true, key: "ArrowLeft" }, labelKey: "filesCollapseAll", scope: "info" },
  { id: "filesRevealCurrent", category: "file", combo: { mod: true, alt: true, key: "l" }, labelKey: "filesRevealCurrent", scope: "info" },
  { id: "filesSwitchProject", category: "file", combo: { mod: true, shift: true, key: "o" }, labelKey: "filesSwitchProject", scope: "info" },
  { id: "filesCloseProject", category: "file", combo: { mod: true, shift: true, key: "w" }, labelKey: "filesCloseProject", scope: "info" },
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
