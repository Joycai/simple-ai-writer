/**
 * Which endpoint an image model's calls take — the one place that answers it.
 *
 * An image model carries a *declared* route (`ImageCaps.route`, empty = 自动)
 * and has an *effective* one: the declaration when there is one, else the
 * default of the protocol family its current route speaks. Every reader that
 * asks "where will this picture be drawn" — the client, the generate modal,
 * the drawer's async toggle, what a save keeps, the edit / size seeds — asks
 * here. Two readers deriving it separately is how DashScope's native route
 * broke twice: once in the client, once in the drawer that only read the
 * declaration (docs/feature/image-route.md).
 */

import { familyOf, type ApiStandard, type ImageRoute, type ProtocolFamily } from "./types";

/** The routes a model can land on without declaring one. */
type DerivedImageRoute = "images-api" | "gemini" | "dashscope";

/**
 * Where an undeclared model goes, per family of its current route. A `Record`
 * so the next family does not compile until it picks one — the fifth fell
 * through a `=== "gemini" ? … : "images-api"` into a 404.
 *
 * `chat`, `comfyui` and `ark` are never derived, so for them the declaration
 * *is* the effective route; the type above is what guarantees that.
 */
const DERIVED: Record<ProtocolFamily, DerivedImageRoute> = {
  openai: "images-api",
  responses: "images-api",
  // Claude draws nothing; an image model here is already a mistake, and this
  // is the answer it always had.
  anthropic: "images-api",
  gemini: "gemini",
  // Under `/api/v1` the only image endpoint is the native one —
  // `/images/generations` there is a 404.
  dashscope: "dashscope",
};

/** The declarations the answer depends on — structural, so `ImageCaps` and `ImageConn` both fit. */
interface ImageRouteDecl {
  route?: ImageRoute;
  asyncTask?: boolean;
}

/**
 * The route this model's image calls take. `standard` is the model's current
 * route's standard (`providerFor(model).apiStandard`), not the channel's primary.
 */
export function effectiveImageRoute(standard: ApiStandard, decl?: Pick<ImageRouteDecl, "route">): ImageRoute {
  return decl?.route || DERIVED[familyOf(standard)];
}

/**
 * Whether the call is submitted as a DashScope async task. The flag means
 * nothing on any other route, so it is only ever read through here — a stale
 * one left on a row that moved away cannot steer another client.
 */
export function effectiveAsyncTask(standard: ApiStandard, decl?: ImageRouteDecl): boolean {
  return effectiveImageRoute(standard, decl) === "dashscope" && decl?.asyncTask === true;
}

/**
 * What every model on a route is known to do — seeded when the route becomes a
 * model's effective one. DashScope's image models all edit and write sizes
 * 宽*高; every Seedream version takes reference images (10–14).
 */
export function routeConventions(route: ImageRoute): { edit?: true; sizes?: string } {
  switch (route) {
    case "dashscope":
      return { edit: true, sizes: "1024*1024, 1328*1328" };
    case "ark":
      return { edit: true };
    default:
      return {};
  }
}
