/**
 * The app's slider (设计稿 20, 滑块 anatomy) — first used by 设置 → 上下文与记忆
 * → 对话归纳, built to be reused.
 *
 * It borrows everything from controls that already exist: the thumb is the
 * switch's 14×14 square knob, the track is the input border thickened to 2px,
 * the disabled colours are the switch's OFF colours. The one new thing is the
 * tick row. Two behaviours the mockup pins down:
 *
 * - **Log scale** (`scale="log2"`): 8k–512k spans 64×; on a linear track 8k–32k
 *   would sit in the first 5%. Position = log₂(v ÷ min) ÷ log₂(max ÷ min).
 * - **Snapping**: with `snapToTicks`, a pointer within 4px of a tick lands on
 *   it, and only that landing animates (70ms) — the feel is "clicks in", not
 *   "springs back". Leaving a tick has no transition.
 *
 * The readout beside it is the caller's: the value is the truth, the slider
 * is its mirror, so the same number can also arrive from a typed field.
 */
import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import styles from "./Slider.module.css";

export interface SliderTick {
  value: number;
  label: string;
}

/** Step size at a value, for the arrow keys and for rounding a pointer position. */
export type SliderStep = number | ((value: number) => number);

interface Props {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  scale?: "linear" | "log2";
  ticks?: SliderTick[];
  /** Land on a tick when the pointer is within 4px of it. */
  snapToTicks?: boolean;
  step: SliderStep;
  /** Arrow keys with Shift move this many steps at once. */
  shiftMultiplier?: number;
  disabled?: boolean;
  ariaLabel: string;
  /** Spoken value, e.g. "128k" — the number alone reads wrong for tokens. */
  valueText?: string;
}

const SNAP_PX = 4;

export function Slider({
  value, min, max, onChange, scale = "linear", ticks = [], snapToTicks = false,
  step, shiftMultiplier = 1, disabled = false, ariaLabel, valueText,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [snapping, setSnapping] = useState(false);

  const stepAt = useCallback(
    (v: number) => (typeof step === "function" ? step(v) : step),
    [step],
  );
  const clamp = useCallback((v: number) => Math.min(max, Math.max(min, v)), [min, max]);
  const toPos = useCallback(
    (v: number) => (scale === "log2" ? Math.log2(v / min) / Math.log2(max / min) : (v - min) / (max - min)),
    [scale, min, max],
  );
  const fromPos = useCallback(
    (p: number) => (scale === "log2" ? min * Math.pow(max / min, p) : min + p * (max - min)),
    [scale, min, max],
  );

  /** Pointer position → value, snapping to a tick when close enough. */
  const resolve = useCallback((p: number, trackWidth: number): { value: number; snapped: boolean } => {
    if (snapToTicks) {
      for (const t of ticks) {
        if (Math.abs(toPos(t.value) - p) * trackWidth <= SNAP_PX) return { value: t.value, snapped: true };
      }
    }
    const raw = fromPos(p);
    const s = stepAt(raw);
    return { value: clamp(Math.round(raw / s) * s), snapped: false };
  }, [snapToTicks, ticks, toPos, fromPos, stepAt, clamp]);

  const applyPointer = (e: PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (!track) return;
    const r = track.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const next = resolve(p, r.width);
    setSnapping(next.snapped);
    if (next.value !== value) onChange(next.value);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    // Keyboard takes over from where the pointer left off.
    thumbRef.current?.focus({ preventScroll: true });
    applyPointer(e);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    applyPointer(e);
  };
  const onPointerUp = () => {
    if (!dragging) return;
    setDragging(false);
    setSnapping(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const mult = e.shiftKey ? shiftMultiplier : 1;
    const sorted = [...ticks].map((t) => t.value).sort((a, b) => a - b);
    let next: number | null = null;
    switch (e.key) {
      case "ArrowRight": case "ArrowUp":
        next = value + stepAt(value) * mult; break;
      case "ArrowLeft": case "ArrowDown":
        // Step size of the value just below, so crossing a step boundary
        // downward moves by the finer step, not the coarser one.
        next = value - stepAt(value - 1) * mult; break;
      case "Home": next = min; break;
      case "End": next = max; break;
      case "PageUp": next = sorted.find((t) => t > value) ?? max; break;
      case "PageDown": next = [...sorted].reverse().find((t) => t < value) ?? min; break;
      default: return;
    }
    e.preventDefault();
    const v = clamp(next);
    setSnapping(ticks.some((t) => t.value === v));
    if (v !== value) onChange(v);
  };

  const pct = toPos(clamp(value)) * 100;

  return (
    <div className={`${styles.slider} ${disabled ? styles.disabled : ""}`}>
      <div
        ref={trackRef}
        className={styles.track}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className={styles.rail} />
        <div className={`${styles.fill} ${snapping ? styles.snapping : ""}`} style={{ width: `${pct}%` }} />
        <div
          ref={thumbRef}
          className={`${styles.thumb} ${snapping ? styles.snapping : ""} ${dragging ? styles.dragging : ""}`}
          style={{ left: `calc(${pct}% - 7px)` }}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={ariaLabel}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={valueText}
          aria-disabled={disabled || undefined}
          onKeyDown={onKeyDown}
        />
      </div>
      {ticks.length > 0 && (
        <div className={styles.ticks} aria-hidden>
          {ticks.map((t) => (
            <div key={t.value} className={styles.tick} style={{ left: `${toPos(t.value) * 100}%` }}>
              <span className={styles.tickMark} />
              <span className={styles.tickLabel}>{t.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
