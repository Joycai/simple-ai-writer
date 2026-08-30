/**
 * Facet rows for one list: a plain facet stays a row, facets sharing a
 * mutual-exclusion group collapse into one dashed box in first-seen order,
 * highest priority first inside it.
 *
 * Lives in lib rather than in LoreDetail because **every** presentation of a
 * facet list runs the same grouping: the manage view's flat list, each of its
 * slot sections (屏 19), and the read mode's full-body sections
 * (docs/feature/lore/lore-browse-mode-ui-brief.md §3c) — "同组只注入一条" has
 * to be drawn as one enclosure everywhere, or the rule stops being readable.
 *
 * A group whose facets carry different slots lands in the section of the first
 * one seen — mutually exclusive facets are one 面 by definition, and splitting
 * the box across sections would make the "only one of these is injected" rule
 * unreadable.
 */

import type { LoreFacet } from "./model";

export type FacetBlock =
  | { kind: "facet"; facet: LoreFacet }
  | { kind: "group"; group: string; facets: LoreFacet[] };

export function buildFacetBlocks(facets: readonly LoreFacet[]): FacetBlock[] {
  const blocks: FacetBlock[] = [];
  const byGroup = new Map<string, LoreFacet[]>();
  for (const f of facets) {
    if (!f.group) { blocks.push({ kind: "facet", facet: f }); continue; }
    const existing = byGroup.get(f.group);
    if (existing) { existing.push(f); continue; }
    const list = [f];
    byGroup.set(f.group, list);
    blocks.push({ kind: "group", group: f.group, facets: list });
  }
  for (const list of byGroup.values()) list.sort((a, b) => b.priority - a.priority);
  return blocks;
}
