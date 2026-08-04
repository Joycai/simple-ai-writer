/**
 * Structured lore citations — the `[[lore:目标]]` / `[[lore:目标|显示文字]]`
 * syntax the bid-response prompts instruct the model to cite its 依据 with.
 *
 * The renderer (lib/fs/markdown.ts) turns the syntax into a `.lore-cite` span
 * carrying the raw target; everything semantic happens here so it can be
 * tested without a DOM: resolving a target against the lore index, and the
 * document-level click delegate that navigates to the cited entry.
 *
 * A citation resolves by, in order:
 *   1. entity name (exact, case-insensitive),
 *   2. alias (exact, case-insensitive),
 *   3. the `category/id` tail of the entity's dirPath ("capabilities/multi-tenant").
 *
 * Name-first is deliberate: the model sees entity *names* in the 【…】 context
 * blocks and in `list_lore_entities` output, so names are what it can cite
 * without being taught an id scheme.
 */

import type { LoreEntity, LoreIndex } from "./model";

/** Attribute the renderer stamps on citation spans; the delegate reads it. */
export const CITE_ATTR = "data-lore-cite";

export interface ParsedCitation {
  /** What to resolve — entity name, alias, or category/id. */
  target: string;
  /** Author-facing text; defaults to the target when no `|label` was given. */
  label: string;
}

/** Split the inside of `[[lore:…]]` into target and optional display label. */
export function parseCiteBody(body: string): ParsedCitation | null {
  const pipe = body.indexOf("|");
  const target = (pipe >= 0 ? body.slice(0, pipe) : body).trim();
  const label = pipe >= 0 ? body.slice(pipe + 1).trim() : "";
  if (!target) return null;
  return { target, label: label || target };
}

/** All entities of an index, flattened. */
function allEntities(index: LoreIndex): LoreEntity[] {
  return Object.values(index).flat();
}

/** Resolve a citation target to its entity, or null when nothing matches. */
export function resolveCitation(target: string, index: LoreIndex): LoreEntity | null {
  const wanted = target.trim().toLowerCase();
  if (!wanted) return null;
  const entities = allEntities(index);
  return (
    entities.find((e) => e.name.toLowerCase() === wanted) ??
    entities.find((e) => e.aliases.some((a) => a.toLowerCase() === wanted)) ??
    entities.find((e) => {
      // dirPath is absolute with either separator; compare its category/id tail.
      const tail = e.dirPath.split(/[\\/]/).slice(-2).join("/").toLowerCase();
      return tail === wanted;
    }) ??
    null
  );
}

/**
 * Mark unresolvable citations in already-rendered HTML. Separated from the
 * renderer because `renderMarkdown` is pure and index-free — validity is a
 * property of the *project*, checked by the surfaces that have one (Preview).
 */
export function annotateCitations(root: HTMLElement, index: LoreIndex): void {
  root.querySelectorAll<HTMLElement>(`[${CITE_ATTR}]`).forEach((el) => {
    const target = el.getAttribute(CITE_ATTR) ?? "";
    if (resolveCitation(target, index)) el.removeAttribute("data-missing");
    else el.setAttribute("data-missing", "true");
  });
}

/**
 * Install one document-level click delegate that navigates any `.lore-cite`
 * to its entry: request the entity's detail view and switch to the lore wall.
 * Delegated at the document so every surface that renders markdown (preview,
 * agent chat, approval cards) gets the behaviour without wiring of its own.
 * Returns the uninstaller; installed once from App.
 */
export function installCitationNavigation(): () => void {
  const onClick = async (event: MouseEvent) => {
    const el = (event.target as HTMLElement | null)?.closest?.(`[${CITE_ATTR}]`);
    if (!el) return;
    const target = el.getAttribute(CITE_ATTR) ?? "";
    // Lazy store imports keep this module store-free for tests.
    const { useLoreStore } = await import("../../stores/loreStore");
    const entity = resolveCitation(target, useLoreStore.getState().index);
    if (!entity) return; // rendered as data-missing; nothing to navigate to
    const { useAppStore } = await import("../../stores/appStore");
    useLoreStore.getState().requestDetail(entity.dirPath);
    useAppStore.getState().setMainView("lore-wall");
  };
  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}
