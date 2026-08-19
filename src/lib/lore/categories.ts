/**
 * Which categories a *scanned index* contains, as opposed to which ones the
 * workspace declares.
 *
 * These are two different questions and the app needs both:
 *
 *   - **"where may this go?"** — `loreCategories()` / `isKnownCategory()` in
 *     lib/profile. Only the merged workspace's categories are answers: they are
 *     the folder names a new entry, a model-supplied category, or a move may
 *     create. Orphans are never an answer here.
 *   - **"what is there?"** — this module. The merged categories *plus* the
 *     orphan folders the scan found (`scanLore`), because those hold real
 *     entries that are listed, editable and injectable.
 *
 * Conflating the two is the specific bug this file exists to prevent: with the
 * scan producing orphan keys, a surface that still enumerates
 * `loreCategories()` shows the author *fewer* entries than the injection path
 * (`selectLore` walks the index itself) puts in front of the model — entries
 * nobody can see quietly entering prompts. Every "list what exists" loop goes
 * through `indexCategories`; every "pick a destination" control through
 * `loreCategories()` or `assignableCategories`.
 */

import { loreCategories } from "../profile/active";
import type { ProfileCategory } from "../profile/model";
import type { CategoryId, LoreIndex } from "./model";

/**
 * One category of a scanned index. Carries the type schema (`slots` /
 * `imageSlots`) for a declared category and, by construction, none for an
 * orphan — which is exactly the degraded state.
 */
export interface IndexedCategory extends ProfileCategory {
  /** No enabled pack and no user-defined category declares this folder. */
  orphan: boolean;
}

/**
 * The orphan's label is its **folder name**, not the label of the disabled pack
 * that once declared it. Borrowing that label would present the category as if
 * its schema were still in effect, and the raw id is also the honest answer for
 * a folder made by hand or arriving with someone else's project.
 */
function orphanCategory(id: CategoryId): IndexedCategory {
  return { id, labelZh: id, labelEn: id, orphan: true };
}

/**
 * Every category present in `index`: the merged workspace's, in workspace
 * order (including the empty ones — an empty category is still a filter), then
 * the orphans sorted by id.
 *
 * Orphans are sorted rather than left in index order because index order is
 * `readDir` order, which is filesystem-dependent: the wall's card order, the
 * palette's list and the detail pager's ‹ › are all derived from this and must
 * not shuffle between machines.
 */
export function indexCategories(index: LoreIndex): IndexedCategory[] {
  const known = loreCategories();
  const out: IndexedCategory[] = known.map((cat) => ({ ...cat, orphan: false }));
  const seen = new Set(known.map((cat) => cat.id.toLowerCase()));
  const orphans = Object.keys(index).filter((id) => !seen.has(id.toLowerCase()));
  orphans.sort((a, b) => a.localeCompare(b));
  for (const id of orphans) out.push(orphanCategory(id));
  return out;
}

/**
 * The categories an existing entry may be *assigned* to: the workspace's, plus
 * the entry's own category when that is an orphan.
 *
 * The exception matters. A picker built from the workspace list alone would not
 * contain the value it is displaying, so it would show the author some other
 * category as if it were the entry's own — and the first save after that moves
 * the folder. Including the current orphan keeps "stay where you are" on the
 * menu; moving *into* an orphan stays impossible, which is the right
 * asymmetry: migrating out of a disabled pack's folder is a fine thing to do,
 * filling one the workspace can't create is not.
 */
export function assignableCategories(current?: CategoryId | null): IndexedCategory[] {
  const known: IndexedCategory[] = loreCategories().map((cat) => ({ ...cat, orphan: false }));
  if (!current || known.some((cat) => cat.id === current)) return known;
  return [...known, orphanCategory(current)];
}
