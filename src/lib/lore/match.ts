/**
 * Plain-text entity matching — which lore entities does a piece of text
 * mention? Same semantics as loreSelect's auto-match (case-insensitive
 * name/alias substring, CJK-friendly), but returning the entities themselves
 * instead of assembling context. The library view uses it to show each
 * collection's referenced entities.
 */

import type { LoreEntity, LoreIndex } from "./model";

export function matchEntitiesInText(text: string, index: LoreIndex): LoreEntity[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const out: LoreEntity[] = [];
  for (const entities of Object.values(index)) {
    for (const entity of entities ?? []) {
      const terms = [entity.name, ...(entity.aliases ?? [])];
      if (terms.some((t) => t && lower.includes(t.toLowerCase()))) out.push(entity);
    }
  }
  return out;
}
