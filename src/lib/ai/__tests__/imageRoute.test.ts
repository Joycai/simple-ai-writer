/**
 * The effective image route has one owner (docs/feature/image-route.md): the
 * derivation per family, the async flag riding only on DashScope, and a source
 * guard that no other file compares a declared route against one of the three
 * derivable values — the shape the drawer once had and the native route broke.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { defaultImageCaps } from "../configDb";
import { effectiveAsyncTask, effectiveImageRoute, routeConventions } from "../imageRoute";
import { wireSummary } from "../modelSummary";
import type { ApiStandard, ImageRoute } from "../types";

/** A `Record` so a new standard fails to compile here until someone says where it draws. */
const DERIVED: Record<ApiStandard, ImageRoute> = {
  openai: "images-api",
  openai_compat: "images-api",
  openai_responses: "images-api",
  openai_responses_compat: "images-api",
  anthropic: "images-api",
  anthropic_compat: "images-api",
  gemini: "gemini",
  gemini_compat: "gemini",
  dashscope_compat: "dashscope",
};
const STANDARDS = Object.keys(DERIVED) as ApiStandard[];
const ROUTES: ImageRoute[] = ["images-api", "chat", "gemini", "dashscope", "comfyui", "ark"];

describe("effectiveImageRoute", () => {
  it("derives from the family of the model's current route when nothing is declared", () => {
    for (const std of STANDARDS) {
      expect(effectiveImageRoute(std), std).toBe(DERIVED[std]);
      expect(effectiveImageRoute(std, {}), std).toBe(DERIVED[std]);
    }
  });

  it("lets a declaration win on every route", () => {
    for (const std of STANDARDS) {
      for (const route of ROUTES) expect(effectiveImageRoute(std, { route })).toBe(route);
    }
  });

  it("never derives chat, comfyui or ark — for them the declaration is the answer", () => {
    const derived = new Set(STANDARDS.map((s) => effectiveImageRoute(s)));
    for (const r of ["chat", "comfyui", "ark"] as const) expect(derived.has(r)).toBe(false);
  });
});

describe("effectiveAsyncTask", () => {
  it("is on only where the pictures go to DashScope native", () => {
    for (const std of STANDARDS) {
      for (const route of [undefined, ...ROUTES]) {
        const on = effectiveAsyncTask(std, { route, asyncTask: true });
        expect(on, `${std} ${route}`).toBe(effectiveImageRoute(std, { route }) === "dashscope");
        expect(effectiveAsyncTask(std, { route, asyncTask: false })).toBe(false);
        expect(effectiveAsyncTask(std, { route })).toBe(false);
      }
    }
  });

  it("keeps the flag on 自动 on the native route — the review-round-2 regression", () => {
    expect(effectiveAsyncTask("dashscope_compat", { asyncTask: true })).toBe(true);
    // The same row moved to 百炼's Chat route draws through /images/generations,
    // and a stale flag must not follow it there.
    expect(effectiveAsyncTask("openai_compat", { asyncTask: true })).toBe(false);
  });
});

describe("defaultImageCaps reads the effective route first", () => {
  it("edits by default wherever the route's models all do", () => {
    expect(defaultImageCaps("dashscope_compat").edit).toBe(true);
    expect(defaultImageCaps("openai_compat", { route: "dashscope" }).edit).toBe(true);
    expect(defaultImageCaps("openai_compat", { route: "ark" }).edit).toBe(true);
    // Declared away from DashScope on the native route: the standard's answer.
    expect(defaultImageCaps("dashscope_compat", { route: "images-api" }).edit).toBe(false);
    expect(defaultImageCaps("openai_compat").edit).toBe(false);
  });

  it("agrees with routeConventions on every combination", () => {
    for (const std of STANDARDS) {
      for (const route of [undefined, ...ROUTES]) {
        if (routeConventions(effectiveImageRoute(std, { route })).edit) {
          expect(defaultImageCaps(std, { route }).edit, `${std} ${route}`).toBe(true);
        }
      }
    }
  });
});

describe("「将发送」 lists the effective route", () => {
  it("names what 自动 resolves to on this route", () => {
    const image = { type: "image" as const, modelId: "wan2.7-image" };
    expect(wireSummary(image, "dashscope_compat")[0]).toEqual({ key: "route", value: "dashscope" });
    expect(wireSummary(image, "openai_compat")[0]).toEqual({ key: "route", value: "images-api" });
    expect(wireSummary({ ...image, caps: { route: "chat" } }, "dashscope_compat")[0])
      .toEqual({ key: "route", value: "chat" });
  });
});

// ─── The guard ────────────────────────────────────────────────────────────────

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
/** A declared route (`caps.route`, the drawer's `capsRoute`, a conn's or draft's `route`) compared to a derivable value. */
const DECLARED_VS_DERIVABLE =
  /\b(?:caps\??\.route|capsRoute|conn\.route|draft\.route)\s*[!=]==?\s*["'](?:images-api|gemini|dashscope)["']/g;
const OWNER = "lib/ai/imageRoute.ts";

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "__tests__") yield* sources(p);
    } else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      yield p;
    }
  }
}

describe("no reader derives the image route on its own", () => {
  it("the pattern catches what it is for", () => {
    const hits = (src: string) => src.match(DECLARED_VS_DERIVABLE)?.length ?? 0;
    expect(hits('open={form.capsRoute === "dashscope"}')).toBe(1);
    expect(hits('if (m.caps?.route !== "gemini") x();')).toBe(1);
    expect(hits('model.caps?.route === "comfyui"')).toBe(0);
  });

  it("only imageRoute.ts compares a declared route with images-api / gemini / dashscope", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file).split("\\").join("/");
      if (rel === OWNER) continue;
      for (const m of readFileSync(file, "utf8").match(DECLARED_VS_DERIVABLE) ?? []) offenders.push(`${rel}: ${m}`);
    }
    // Ask `effectiveImageRoute` (or the drawer's `draftRoute`) instead: 自动
    // on DashScope's native route *is* dashscope, and a declaration read
    // doesn't know that.
    expect(offenders).toEqual([]);
  });
});
