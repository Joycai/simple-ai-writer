import type { ContextBreakdown, PreflightBreakdown } from "../../lib/agent/contextBreakdown";
import { CONTEXT_SEGMENT_ORDER } from "../../lib/agent/contextSegments";

/** Scale only the drawing on overflow; the displayed usage remains uncapped. */
export function contextRingArcs(context: ContextBreakdown) {
  const span = Math.max(context.ceilingTokens, context.usedTokens);
  if (context.contextSize <= 0 || !Number.isFinite(span) || span <= 0) return [];
  let offset = 0;
  return CONTEXT_SEGMENT_ORDER.filter((key) => key !== "free").map((key) => {
    const tokens = context.segments.find((segment) => segment.key === key)?.tokens ?? 0;
    const length = Math.min(100 - offset, Math.max(0, Number.isFinite(tokens) ? tokens / span * 100 : 0));
    const arc = { key, length, offset };
    offset += length;
    return arc;
  }).filter((arc) => arc.length > 0);
}

/** Unknown retrieval is a patterned remainder, never reported as free capacity. */
export function preflightRingArcs(pre: PreflightBreakdown) {
  const span = Math.max(pre.ceilingTokens, pre.lowerBoundTokens);
  if (pre.contextSize <= 0 || !Number.isFinite(span) || span <= 0) return [];
  let offset = 0;
  return pre.segments.filter(seg => seg.key !== "unknown").map(seg => {
    const length = Math.min(100 - offset, Math.max(0, Number.isFinite(seg.tokens) ? seg.tokens / span * 100 : 0));
    const arc = { key: seg.key, length, offset };
    offset += length;
    return arc;
  }).filter(arc => arc.length > 0);
}

export function contextPopoverPosition(rect: { left: number; top: number; bottom: number }, width: number, height: number) {
  const margin = 8;
  const panelWidth = Math.min(320, Math.max(0, width - margin * 2));
  const above = Math.max(0, rect.top - margin * 2);
  const below = Math.max(0, height - rect.bottom - margin * 2);
  const up = above >= 240 || above >= below;
  return {
    left: Math.max(margin, Math.min(rect.left - 88, width - panelWidth - margin)),
    width: panelWidth,
    maxHeight: up ? above : below,
    ...(up ? { bottom: Math.max(margin, height - rect.top + margin) } : { top: rect.bottom + margin }),
  };
}
