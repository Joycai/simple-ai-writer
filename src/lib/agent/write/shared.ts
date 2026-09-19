/**
 * What more than one of the write-tool modules (`lib/agent/write/*`) needs and
 * no one of them owns: the proposal id counter, and two helpers on the run's
 * lore snapshot. Split out of `writeTools.ts` (docs/feature/code-structure-plan.md
 * P6) — kept here rather than in either user so the modules do not import
 * each other in a circle.
 */


import { type CategoryId, type LoreEntity, type LoreIndex } from "../../lore";


let proposalCounter = 0;
/**
 * One counter for every proposal id the write tools mint — a lore step card and
 * a manuscript card share it, so no two cards in a session ever get one id.
 */
export function nextProposalSeq(): number {
  return ++proposalCounter;
}

/**
 * Keep the run's lore snapshot honest after a folder-level change.
 *
 * ctx.loreIndex is captured at run start (see registry.ToolContext). `syncLore`
 * now folds the rescan back into it, so this is the *fallback* rather than the
 * only repair: it is what keeps the snapshot honest on a surface that supplies
 * no `onLoreChanged` (lore/generator, lore/splitter — both pass `loreIndex:
 * {}`) and when a rescan fails. Without either, the next call in the same run
 * resolves the entity to a directory that no longer exists, and the model gets
 * a baffling ENOENT for the move it just made successfully.
 *
 * Pass `next: null` to drop the entity entirely.
 */
export function relocateInSnapshot(
  loreIndex: LoreIndex,
  entity: LoreEntity,
  next: { category: CategoryId; id: string; dirPath: string } | null,
): void {
  if (next && next.category === entity.category) {
    entity.id = next.id;
    entity.dirPath = next.dirPath;
    return;
  }
  const from = loreIndex[entity.category];
  const at = from ? from.indexOf(entity) : -1;
  if (at >= 0) from.splice(at, 1);
  if (!next) return;
  entity.category = next.category;
  entity.id = next.id;
  entity.dirPath = next.dirPath;
  (loreIndex[next.category] ??= []).push(entity);
}

export function withAlias(aliases: string[], extra: string): string[] {
  const lower = extra.toLowerCase();
  return aliases.some((a) => a.toLowerCase() === lower) ? aliases : [...aliases, extra];
}
