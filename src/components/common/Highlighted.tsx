/**
 * Text with its matched fragments marked — the one range highlighter for every
 * list ranked by `lib/search`'s `matchText`. The ⌘K palette and the `@` picker
 * paint a hit the same way because they are the same search; a second copy
 * had already drifted to a different colour token before it was folded here.
 *
 * `ranges` are half-open `[start, end)` over `text`, merged and sorted — the
 * shape `mergeRanges` leaves them in. This side only paints; an overlapping
 * or unsorted pair would render a fragment twice, so merging stays with the
 * search.
 */
import type { MatchRange } from "../../lib/search/globalSearch";
import styles from "./Highlighted.module.css";

export function Highlighted({ text, ranges }: { text: string; ranges: readonly MatchRange[] | undefined }) {
  if (!ranges || ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const r of ranges) {
    if (r.start > at) parts.push(text.slice(at, r.start));
    parts.push(<span key={r.start} className={styles.hl}>{text.slice(r.start, r.end)}</span>);
    at = r.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
