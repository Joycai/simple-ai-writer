import { useCallback, useRef } from "react";
import type { KeyboardEvent } from "react";

/**
 * Enter-to-submit that survives a CJK IME.
 *
 * A Chinese/Japanese IME owns the Enter key while its candidate window is up:
 * Space picks the highlighted candidate, Enter commits the *raw letters* the
 * author typed. Such an Enter must never reach a submit handler, or typing
 * pinyin and pressing Enter fires off a half-written message.
 *
 * `KeyboardEvent.isComposing` is supposed to say so, and on its own it is what
 * every guard in this codebase used to check. It is not enough on Windows:
 * WebView2 with Microsoft Pinyin (and Sogou) dispatches `compositionend`
 * *before* the `keydown` for that same Enter, so by the time the handler runs
 * the flag has already flipped back to false. Hence the belt and braces below —
 * our own composition flag, the legacy 229 keycode, and a short grace window
 * after composition ends that catches the reordered case.
 *
 * The grace window is far shorter than a deliberate second keypress, so
 * "commit the pinyin, then press Enter again to send" still works.
 */
const COMMIT_GRACE_MS = 100;

/** What {@link imeOwnsKey} needs to know; the hook keeps it in refs. */
export interface CompositionState {
  /** Between `compositionstart` and `compositionend`. */
  composing: boolean;
  /** `performance.now()` of the last `compositionend`; -Infinity if never. */
  endedAt: number;
}

/** The fields of a keyboard event this decision reads. Pure, so it is testable. */
export interface KeyLike {
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * True when the key belongs to the IME rather than to the app — the handler
 * must bail out.
 *
 * Not only about Enter: while the candidate window is up the IME also owns
 * Escape, where it means "drop these candidates" rather than "close the
 * dialog" (see components/common/ModalShell).
 */
export function imeOwnsKey(e: KeyLike, state: CompositionState, now: number): boolean {
  return (
    state.composing ||
    e.isComposing === true ||
    e.keyCode === 229 ||
    now - state.endedAt < COMMIT_GRACE_MS
  );
}

export interface ImeGuard {
  /** Spread onto the input/textarea whose Enter key submits. */
  imeProps: {
    onCompositionStart: () => void;
    onCompositionEnd: () => void;
  };
  /** Ask before acting on Enter: `if (guard.isComposing(e)) return;` */
  isComposing: (e: KeyboardEvent) => boolean;
}

/**
 * Composition tracking for one field. Every Enter-submits input the author can
 * type prose into should use this instead of reading `isComposing` directly.
 */
export function useImeGuard(): ImeGuard {
  const state = useRef<CompositionState>({ composing: false, endedAt: -Infinity });

  const onCompositionStart = useCallback(() => {
    state.current.composing = true;
  }, []);

  const onCompositionEnd = useCallback(() => {
    state.current.composing = false;
    state.current.endedAt = performance.now();
  }, []);

  const isComposing = useCallback(
    (e: KeyboardEvent) => imeOwnsKey(e.nativeEvent, state.current, performance.now()),
    [],
  );

  return { imeProps: { onCompositionStart, onCompositionEnd }, isComposing };
}
