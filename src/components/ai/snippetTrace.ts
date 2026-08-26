/**
 * The one-line trace an insert or a save leaves behind, shared between the
 * context menu that *creates* a snippet and the picker entry that *displays*
 * the confirmation.
 *
 * It is deliberately not in a zustand store: this is ephemeral chrome with a
 * timer, not application state, and putting it in `aiStore` would make every
 * subscriber of the prompt list re-render twice a second while it fades. A
 * module-level emitter + `useSyncExternalStore` keeps it to the two components
 * that show it.
 *
 * 设计稿 1c⑤ / 1d①: no toast — the confirmation is a hairline and a word, in
 * place, gone in a second and a half.
 */

import { useSyncExternalStore } from "react";

export type SnippetTraceKind = "inserted" | "saved";

export interface SnippetTrace {
  kind: SnippetTraceKind;
  /** Snippet name, for 「已插入『冷处理改写』」. */
  name: string;
  /** Where a saved snippet landed, for 「已存入『未分组』」. */
  group?: string;
  /** How many `{{…}}` the inserted body carried, so the line can say so. */
  placeholders?: number;
  /** Runs the ⌘Z affordance: undoes this insert or deletes this new snippet. */
  undo?: () => void;
  /** 退场中：CSS 播完淡出才真正卸载。见 showSnippetTrace 的两段计时器。 */
  leaving?: boolean;
  /** Monotonic id so a second trace replaces the first cleanly. */
  seq: number;
}

/** 1.6s for a save, 2.4s for an insert — the insert line names a snippet the
 *  author may want to read back, the save line only confirms. */
const HOLD_MS: Record<SnippetTraceKind, number> = { saved: 1600, inserted: 2400 };

/** 退场淡出的时长，必须与 SnippetPicker.module.css 的 .trace.traceLeaving 一致。 */
const LEAVE_MS = 160;

let current: SnippetTrace | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function showSnippetTrace(t: Omit<SnippetTrace, "seq">): void {
  if (timer) clearTimeout(timer);
  current = { ...t, seq: ++seq };
  emit();
  const mine = current.seq;
  timer = setTimeout(() => {
    // Only clear if nothing newer arrived — a second trace owns the screen.
    // 写成显式 null 判断而不是 `current?.seq !== mine`：后者虽然也能让 TS 收窄，
    // 但下一行要展开 current，判断写死更不容易在改动中失效。
    if (current === null || current.seq !== mine) return;
    // 先标记退场、让 CSS 淡出，160ms 后才真的卸载。直接置 null 会把一条
    // 刻意做得安静的确认切掉，退场反而成了全屏最硬的一次跳变。
    current = { ...current, leaving: true };
    emit();
    timer = setTimeout(() => {
      if (current?.seq === mine) { current = null; emit(); }
    }, LEAVE_MS);
  }, HOLD_MS[t.kind]);
}

export function clearSnippetTrace(): void {
  if (timer) clearTimeout(timer);
  current = null;
  emit();
}

export function useSnippetTrace(): SnippetTrace | null {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => current,
    () => null,
  );
}
