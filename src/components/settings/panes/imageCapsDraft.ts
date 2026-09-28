/**
 * The model drawer's image section as pure functions — what the async toggle
 * shows, what a save keeps, what a route change seeds.
 *
 * Every question here is about the *effective* route (`effectiveImageRoute`),
 * the same answer the image client dispatches on. Reading the declaration
 * instead is how switching a native-route model back to 自动 once dropped its
 * `asyncTask` while the client still drew through DashScope
 * (docs/feature/image-route.md). Kept out of the component so the
 * drawer-vs-client property test calls what the drawer calls.
 */
import { analyzeComfyWorkflow, parseComfyWorkflow } from "../../../lib/comfy/workflow";
import type { ImageCaps } from "../../../lib/ai/configDb";
import type { ImageDialect } from "../../../lib/ai/imageDialects";
import { effectiveImageRoute, routeConventions } from "../../../lib/ai/imageRoute";
import type { ApiStandard, ImageRoute } from "../../../lib/ai/types";

/** The image section as the drawer holds it. */
export interface ImageCapsDraft {
  /** The declared route; "" = 自动. */
  route: ImageRoute | "";
  /** "" = generic (the free-form sizes list). */
  dialect: ImageDialect | "";
  edit: boolean;
  /** The async switch's position — kept only where the effective route is dashscope. */
  asyncTask: boolean;
  sizes: string[];
  /** comfyui only: the imported workflow JSON, verbatim. */
  comfyWorkflow: string;
}

/** The draft a stored row opens as — the inverse of `imageCapsToSave` for every field the drawer shows. */
export function draftFromCaps(caps: ImageCaps | undefined): ImageCapsDraft {
  return {
    route: caps?.route ?? "",
    dialect: caps?.dialect ?? "",
    edit: caps?.edit ?? false,
    asyncTask: caps?.asyncTask ?? false,
    sizes: caps?.sizes ?? [],
    comfyWorkflow: caps?.comfy?.workflow ?? "",
  };
}

const declOf = (route: ImageRoute | ""): { route?: ImageRoute } => (route ? { route } : {});

/**
 * The route this draft would draw through on `standard` — the drawer's current
 * route's standard, which the save writes as the model's `activeRoute`.
 * Absent standard (the channel is gone) leaves nothing to derive from, so the
 * declaration answers alone.
 */
export function draftRoute(standard: ApiStandard | undefined, draft: Pick<ImageCapsDraft, "route">): ImageRoute | undefined {
  return standard ? effectiveImageRoute(standard, declOf(draft.route)) : draft.route || undefined;
}

/** Whether the async switch is on screen: the call would go to DashScope native. */
export function showsAsyncToggle(standard: ApiStandard | undefined, draft: Pick<ImageCapsDraft, "route">): boolean {
  return draftRoute(standard, draft) === "dashscope";
}

/**
 * What changing the effective route seeds: the new route's conventions, when
 * it actually changed. Sizes only fill a blank — an author's own list is never
 * overwritten. Either control can move it — the endpoint dropdown or the
 * model's protocol route (auto on native is DashScope, auto on Chat is not).
 */
export function routeSeed(
  from: ImageRoute | undefined,
  to: ImageRoute | undefined,
  sizesText: string,
): { edit?: true; sizes?: string } {
  if (!to || from === to) return {};
  const c = routeConventions(to);
  return {
    ...(c.edit ? { edit: true as const } : {}),
    ...(c.sizes && !sizesText.trim() ? { sizes: c.sizes } : {}),
  };
}

/**
 * The caps a save writes.
 *
 * `existing` is the row as stored and the standard it was drawing on, for the
 * one field the drawer has no control for (`maxRefs`).
 */
export function imageCapsToSave(
  draft: ImageCapsDraft,
  standard: ApiStandard | undefined,
  existing?: { caps?: ImageCaps; standard?: ApiStandard },
): ImageCaps {
  // comfyui is never derived (lib/ai/imageRoute), so the declaration is it.
  const isComfy = draft.route === "comfyui";
  // Input-image support there is a fact of the imported workflow — the
  // LoadImage count — not a declaration, so it cannot disagree with the graph.
  const comfySlots = isComfy
    ? (() => {
        const parsed = parseComfyWorkflow(draft.comfyWorkflow);
        return "graph" in parsed ? analyzeComfyWorkflow(parsed.graph).loadImageNodes.length : 0;
      })()
    : 0;
  const route = draftRoute(standard, draft);
  const prev = existing?.caps;
  const prevRoute = prev ? draftRoute(existing?.standard, { route: prev.route ?? "" }) : undefined;
  return {
    edit: isComfy ? comfySlots > 0 : draft.edit,
    ...(isComfy && comfySlots > 0 ? { maxRefs: comfySlots } : {}),
    // Off comfyui the drawer has no control for the cap, so it keeps the one
    // the row came with (a starter row's 10 / 14) — rebuilding without it
    // silently lifted the input-image limit on every save. Only while the row
    // still draws through the same endpoint the same way: a comfyui row's
    // LoadImage count, or lite's 14 on a row switched to pro's dialect (10),
    // would be a wrong limit, which is worse than none — the endpoint's own
    // 400 costs nothing.
    ...(!isComfy && prev?.maxRefs && prevRoute === route && (prev.dialect ?? "") === draft.dialect
      ? { maxRefs: prev.maxRefs } : {}),
    // A dialect belongs to cloud parameter vocabularies; on comfyui the
    // free-form sizes list is the whole story.
    ...(!isComfy && draft.dialect ? { dialect: draft.dialect } : {}),
    // A dialect supersedes the free-form list, but an existing list is kept so
    // switching back to 通用 restores it untouched.
    ...(draft.sizes.length ? { sizes: draft.sizes } : {}),
    ...(draft.route ? { route: draft.route } : {}),
    // Saved exactly when the switch is on screen and on: only while the call
    // goes to DashScope native — by the effective route, so 自动 on the native
    // route keeps it and a move off it clears it.
    ...(showsAsyncToggle(standard, draft) && draft.asyncTask ? { asyncTask: true } : {}),
    // The workflow travels only while the route is comfyui.
    ...(isComfy ? { comfy: { workflow: draft.comfyWorkflow } } : {}),
  };
}

