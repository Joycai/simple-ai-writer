/**
 * The snippet library's pure layer: which snippets exist, how they group, how
 * a search narrows them, and where a hit sits inside a line.
 *
 * Everything here is a function of the prompt list — no store, no DOM — so the
 * picker (`components/ai/SnippetPicker`) and the settings pane
 * (`settings/panes/PromptsPane`) can render *the same* sectioning from the same
 * rules. That shared sectioning is a design requirement, not a convenience:
 * "一处学会两处都认得" (设计稿 1g).
 *
 * Design: `docs/feature/prompt-snippets-ui-brief.md`, 设计稿 `10 提示词库`.
 */

import { SNIPPET_SCENE, type Prompt } from "./configDb";

/** At or below this many snippets the picker drops its search box, chips and
 *  section headers — "三行还要搜，是给列表加仪式" (设计稿 1b). */
export const SIMPLE_MAX = 5;

/** How many recently-used snippets the 「常用」 section carries. */
export const FREQUENT_MAX = 5;

/** The chip row. Groups are sections, never chips — the chip row is a filter,
 *  not the organising axis (设计稿 1a). */
export type SnippetFilter = "all" | "frequent" | "ungrouped";

export type SectionKind = "frequent" | "group" | "ungrouped";

export interface SnippetSection {
  /** Stable key for React and for keyboard-cursor maths. */
  key: string;
  kind: SectionKind;
  /** The author's own group name; empty for the frequent/ungrouped sections. */
  group: string;
  items: Prompt[];
  /** Under a search, how many of this section's rows matched. */
  hits: number;
}

export function isSnippet(p: Prompt): boolean {
  return p.scene === SNIPPET_SCENE;
}

export function snippetsOf(prompts: Prompt[]): Prompt[] {
  return prompts.filter(isSnippet);
}

/** The author's group names, ordered the way every list shows them: biggest
 *  section first, 「未分组」 excluded (it is always rendered last, separately). */
export function groupNames(snips: Prompt[]): string[] {
  const counts = new Map<string, number>();
  for (const s of snips) {
    const g = (s.group ?? "").trim();
    if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([g]) => g);
}

/** Most recently inserted first. Never used = never frequent. */
export function frequentSnippets(snips: Prompt[], max = FREQUENT_MAX): Prompt[] {
  return snips
    .filter((s) => (s.lastUsedAt ?? 0) > 0)
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .slice(0, max);
}

export function ungroupedSnippets(snips: Prompt[]): Prompt[] {
  return snips.filter((s) => !(s.group ?? "").trim());
}

/** Name or body, case-insensitive. The picker searches both, so a snippet the
 *  author never named well is still reachable by what it says (设计稿 1b). */
export function matches(s: Prompt, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return s.name.toLowerCase().includes(q) || s.content.toLowerCase().includes(q);
}

export interface SectionOptions {
  filter?: SnippetFilter;
  query?: string;
  /** Set false for the settings pane, which always shows every section and
   *  puts 「未分组」 *first* — that page's daily job is filing the inbox. */
  frequentSection?: boolean;
}

/**
 * The section list both surfaces render.
 *
 * 「常用」 is deliberately **not** de-duplicated against the group sections: a
 * snippet showing up twice is cheaper than "the one I just used vanished"
 * (设计稿 1b). Under a search only sections with hits survive, and each keeps
 * its hit count for the header.
 */
export function buildSections(snips: Prompt[], opts: SectionOptions = {}): SnippetSection[] {
  const { filter = "all", query = "", frequentSection = true } = opts;
  const q = query.trim();

  const pool =
    filter === "frequent" ? frequentSnippets(snips)
    : filter === "ungrouped" ? ungroupedSnippets(snips)
    : snips;

  const keep = (list: Prompt[]) => list.filter((s) => matches(s, q));
  const sections: SnippetSection[] = [];
  const push = (key: string, kind: SectionKind, group: string, items: Prompt[]) => {
    const kept = keep(items);
    if (kept.length > 0) sections.push({ key, kind, group, items: kept, hits: kept.length });
  };

  // 「常用」 only leads the unfiltered list: under a chip the author already
  // said what he wants to see, and repeating rows there would be noise.
  if (frequentSection && filter === "all") {
    push("frequent", "frequent", "", frequentSnippets(pool));
  }
  if (filter !== "ungrouped") {
    for (const g of groupNames(pool)) {
      push(`g:${g}`, "group", g, pool.filter((s) => (s.group ?? "").trim() === g));
    }
  }
  if (filter !== "frequent") {
    push("ungrouped", "ungrouped", "", ungroupedSnippets(pool));
  }
  return sections;
}

/** Chip counts. Always computed over the whole library, never over the current
 *  filter — a chip that renumbered itself when picked would be unreadable. */
export function chipCounts(snips: Prompt[]): Record<SnippetFilter, number> {
  return {
    all: snips.length,
    frequent: frequentSnippets(snips).length,
    ungrouped: ungroupedSnippets(snips).length,
  };
}

/** The rows Enter/↑↓ walk, in render order and flattened across sections. */
export function flatten(sections: SnippetSection[]): Prompt[] {
  return sections.flatMap((s) => s.items);
}

/** The one preview line. Never a second line: "行高一致比多看几个字重要"
 *  (设计稿 1d④). */
export function previewLine(content: string): string {
  const first = content.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  return first.trim();
}

export interface HitSlice {
  before: string;
  hit: string;
  after: string;
  /** The preview was re-cut from the match, so it needs a leading ellipsis. */
  leadEllipsis: boolean;
}

/**
 * Where the query lands inside a line, with the line re-cut around it.
 *
 * A hit late in a long body would otherwise be invisible — the preview would
 * show the opening words and the author could not tell *why* the row matched.
 * `lead` characters of run-up are kept so the hit is not flush against the edge.
 */
export function hitSlice(line: string, query: string, lead = 8): HitSlice | null {
  const q = query.trim();
  if (!q) return null;
  const at = line.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return null;
  const from = Math.max(0, at - lead);
  return {
    before: line.slice(from, at),
    hit: line.slice(at, at + q.length),
    after: line.slice(at + q.length),
    leadEllipsis: from > 0,
  };
}

/** Runs of `{{…}}` in a body. They are *literal text* — no substitution, no tab
 *  stops — marked only so the author can see what is left to fill in
 *  (设计稿 1d②). Returns alternating plain/placeholder parts. */
export function splitPlaceholders(text: string): { text: string; placeholder: boolean }[] {
  const parts: { text: string; placeholder: boolean }[] = [];
  const re = /\{\{[^}\n]*\}\}/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), placeholder: false });
    parts.push({ text: m[0], placeholder: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), placeholder: false });
  return parts;
}

export function countPlaceholders(text: string): number {
  return splitPlaceholders(text).filter((p) => p.placeholder).length;
}

/**
 * The insertion rule, in one place: append to the end with a newline in front,
 * and no leading newline when the box is empty (设计稿 1d①). Every input
 * surface calls this rather than re-deriving it — three copies of a one-liner
 * is how they drift.
 */
export function appendSnippet(current: string, body: string): string {
  return current.trim() ? `${current}\n${body}` : body;
}

/** The name a right-click save pre-fills: the body's opening, trimmed to a
 *  handful of characters so ⏎ alone is a reasonable answer (设计稿 1c④). */
export function defaultSnippetName(body: string, max = 8): string {
  const line = previewLine(body);
  return line.length > max ? line.slice(0, max) : line;
}
