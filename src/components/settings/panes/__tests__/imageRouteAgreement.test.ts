/**
 * The drawer and the image client agree on where a model's pictures go
 * (docs/feature/image-route.md §4).
 *
 * A property test over random (protocol family, declared route, asyncTask)
 * rows and random edit sequences — pick an endpoint, flip the async switch,
 * move the model's protocol route, save and reopen. After every save, what the
 * reopened drawer shows (the effective route, the async switch on screen and
 * its position) is compared with what the real client does: `generateImage`,
 * fed by the real `imageConnOf` on the real `providerFor`, with `fetch`
 * stubbed to record the one request it makes.
 *
 * Both sides are the functions the app calls — `imageCapsDraft.ts` is what the
 * drawer renders from and saves with — so the test cannot pass on a copy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ImageCaps, Model, Provider } from "../../../../lib/ai/configDb";
import { generateImage, imageConnOf } from "../../../../lib/ai/image";
import { normalizeChannel, providerFor, routeProvider } from "../../../../lib/ai/routes";
import type { ApiStandard, ImageRoute, ProtocolFamily } from "../../../../lib/ai/types";
import {
  draftFromCaps, draftRoute, imageCapsToSave, routeSeed, showsAsyncToggle, type ImageCapsDraft,
} from "../imageCapsDraft";

const FAMILIES: ProtocolFamily[] = ["openai", "responses", "gemini", "anthropic", "dashscope"];
const DECLARED: (ImageRoute | "")[] = ["", "images-api", "chat", "gemini", "dashscope", "comfyui", "ark"];
/**
 * What the random walks draw from — weighted toward the corner where the two
 * sides have disagreed (自动 on the native route, the async switch). Uniform
 * draws reached "native · 自动 · async on" at a save in none of 359 saves.
 */
const WALK_FAMILIES: ProtocolFamily[] = [...FAMILIES, "dashscope", "dashscope", "dashscope"];
const WALK_ROUTES: (ImageRoute | "")[] = [...DECLARED, "", "", "dashscope"];

/** A txt2img graph the comfyui route can submit — an input, not a producer's output. */
const WORKFLOW = JSON.stringify({
  "3": {
    class_type: "KSampler",
    inputs: { seed: 5, positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] },
  },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "old" } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "bad hands" } },
  "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } },
});

/** One channel with a route per family, so a model can be moved between all five. */
const CHANNEL: Provider = normalizeChannel({
  id: "ch", name: "relay", baseUrl: "", apiStandard: "openai_compat", createdAt: 0,
  platform: "custom", host: "https://relay.example.com",
  endpoints: FAMILIES.map((family) => ({ family, official: false })),
});

/** The standard the drawer asks with while it is on `family`. */
const drawerStandard = (family: ProtocolFamily): ApiStandard => routeProvider(CHANNEL, family)!.apiStandard;

/** mulberry32 — seeded, so a failure names a walk that can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

// ─── The client side ──────────────────────────────────────────────────────────

interface Observed {
  route: ImageRoute;
  async: boolean;
}

/** Where the client's first request went, read off the wire rather than off any resolver. */
async function observe(model: Model): Promise<Observed> {
  const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    sent.push({
      url: String(url),
      headers: new Headers(init.headers),
      body: init.body ? JSON.parse(String(init.body)) : {},
    });
    // Refused before anything is drawn: one request is all this needs.
    return new Response(JSON.stringify({ error: { message: "stop" } }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }));
  try {
    const provider = providerFor(model, [CHANNEL]);
    if (!provider) throw new Error("model lost its route");
    await generateImage(imageConnOf(model, provider, "k"), { prompt: "a lighthouse" }).catch(() => undefined);
  } finally {
    vi.unstubAllGlobals();
  }
  expect(sent.length, "the client made no request").toBeGreaterThan(0);
  const { url, headers, body } = sent[0];
  const path = new URL(url).pathname;
  if (path.endsWith("/services/aigc/image-generation/generation")) {
    expect(headers.get("X-DashScope-Async")).toBe("enable");
    return { route: "dashscope", async: true };
  }
  if (path.endsWith("/services/aigc/multimodal-generation/generation")) return { route: "dashscope", async: false };
  if (path.endsWith(":generateContent")) return { route: "gemini", async: false };
  if (path.endsWith("/chat/completions")) return { route: "chat", async: false };
  if (path.endsWith("/prompt")) return { route: "comfyui", async: false };
  // Same path, different body: Seedream's carries `watermark`, never `n`.
  if (path.endsWith("/images/generations")) return { route: "watermark" in body ? "ark" : "images-api", async: false };
  throw new Error(`unclassified request ${url}`);
}

// ─── The drawer side ──────────────────────────────────────────────────────────

/** The drawer's state that matters here: which protocol route it is on, and the image draft. */
interface Drawer {
  family: ProtocolFamily;
  draft: ImageCapsDraft;
}

/** What the author sees about the endpoint. */
function shown(d: Drawer) {
  const std = drawerStandard(d.family);
  const asyncShown = showsAsyncToggle(std, d.draft);
  return { route: draftRoute(std, d.draft)!, asyncShown, asyncOn: asyncShown && d.draft.asyncTask };
}

/** The endpoint dropdown's onChange (ModelDrawer): seed by the effective route, then set. */
function pickRoute(d: Drawer, route: ImageRoute | ""): Drawer {
  const std = drawerStandard(d.family);
  const seed = routeSeed(draftRoute(std, d.draft), draftRoute(std, { route }), d.draft.sizes.join(", "));
  return { ...d, draft: { ...d.draft, route, ...applySeed(seed) } };
}

/** `switchRoute` (ModelDrawer): the same seed, from the protocol side. */
function switchFamily(d: Drawer, family: ProtocolFamily): Drawer {
  const seed = routeSeed(
    draftRoute(drawerStandard(d.family), d.draft),
    draftRoute(drawerStandard(family), d.draft),
    d.draft.sizes.join(", "),
  );
  return { family, draft: { ...d.draft, ...applySeed(seed) } };
}

function applySeed(seed: ReturnType<typeof routeSeed>): Partial<ImageCapsDraft> {
  return {
    ...(seed.edit ? { edit: true } : {}),
    ...(seed.sizes ? { sizes: seed.sizes.split(",").map((x) => x.trim()) } : {}),
  };
}

/** Save and reopen: `imageCapsToSave` → the row → `draftFromCaps`, with the route saved as `activeRoute`. */
function save(d: Drawer, row: Model): { drawer: Drawer; row: Model } {
  const caps: ImageCaps = imageCapsToSave(d.draft, drawerStandard(d.family), {
    caps: row.caps,
    standard: providerFor(row, [CHANNEL])?.apiStandard,
  });
  const next: Model = { ...row, caps, activeRoute: d.family };
  // The workflow is re-imported state the drawer keeps beside the caps; the
  // walk keeps one on hand so picking comfyui never saves an empty route.
  return { row: next, drawer: { family: d.family, draft: { ...draftFromCaps(caps), comfyWorkflow: WORKFLOW } } };
}

function newRow(): Model {
  return {
    id: "m", providerId: CHANNEL.id, modelId: "img-1", name: "img", type: "image",
    enabled: true, priceIn: 0, priceCachedIn: 0, priceOut: 0, createdAt: 0,
  } as Model;
}

// ─── The properties ──────────────────────────────────────────────────────────

afterEach(() => vi.unstubAllGlobals());

describe("drawer and client agree on the image route", () => {
  it("on every (family, declared route, asyncTask) row", async () => {
    for (const family of FAMILIES) {
      for (const route of DECLARED) {
        for (const asyncTask of [false, true]) {
          const drawer: Drawer = {
            family,
            draft: { route, dialect: "", edit: false, asyncTask, sizes: [], comfyWorkflow: WORKFLOW },
          };
          const saved = save(drawer, newRow());
          const want = shown(saved.drawer);
          const got = await observe(saved.row);
          const label = `${family} · ${route || "自动"} · async ${asyncTask}`;
          expect(got.route, label).toBe(want.route);
          expect(got.async, label).toBe(want.asyncOn);
          // A switch that was on screen and on before the save still is.
          const before = shown(drawer);
          if (before.asyncShown) expect(want.asyncOn, label).toBe(asyncTask);
        }
      }
    }
  });

  it("after every save in random edit sequences", async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      let drawer: Drawer = {
        family: pick(r, WALK_FAMILIES),
        draft: { route: pick(r, WALK_ROUTES), dialect: "", edit: false, asyncTask: r() < 0.5, sizes: [], comfyWorkflow: WORKFLOW },
      };
      let row = newRow();
      const log: string[] = [`start ${drawer.family} ${drawer.draft.route || "自动"} async=${drawer.draft.asyncTask}`];
      for (let step = 0; step < 12; step++) {
        const op = r();
        if (op < 0.25) {
          const route = pick(r, WALK_ROUTES);
          drawer = pickRoute(drawer, route);
          log.push(`pick ${route || "自动"}`);
        } else if (op < 0.55) {
          // The author can only flip a switch that is on screen.
          if (shown(drawer).asyncShown) {
            drawer = { ...drawer, draft: { ...drawer.draft, asyncTask: !drawer.draft.asyncTask } };
            log.push(`async → ${drawer.draft.asyncTask}`);
          }
        } else if (op < 0.75) {
          const family = pick(r, WALK_FAMILIES);
          drawer = switchFamily(drawer, family);
          log.push(`route ${family}`);
        } else {
          const before = shown(drawer);
          ({ drawer, row } = save(drawer, row));
          log.push("save");
          const after = shown(drawer);
          const got = await observe(row);
          const label = `seed ${seed}: ${log.join(" → ")}`;
          // What the author saw before saving is what they see on reopening…
          expect(after, label).toEqual(before);
          // …and what the client does.
          expect(got, label).toEqual({ route: after.route, async: after.asyncOn });
        }
      }
    }
  });

  // Review round 2 of the DashScope-native PR, pinned by name: switching the
  // endpoint from DashScope 原生 back to 自动 on the native route used to hide
  // the switch and drop `asyncTask` on save, so wan text-to-image failed.
  it("keeps the async task when a native-route model goes back to 自动", async () => {
    let drawer: Drawer = {
      family: "dashscope",
      draft: { route: "dashscope", dialect: "", edit: true, asyncTask: true, sizes: [], comfyWorkflow: "" },
    };
    let row = newRow();
    ({ drawer, row } = save(drawer, row));
    drawer = pickRoute(drawer, "");
    expect(shown(drawer)).toEqual({ route: "dashscope", asyncShown: true, asyncOn: true });
    ({ drawer, row } = save(drawer, row));
    expect(row.caps?.asyncTask).toBe(true);
    expect(row.caps?.route).toBeUndefined();
    expect(await observe(row)).toEqual({ route: "dashscope", async: true });
  });

  // The boundary dashscope-native-plan.md §3 recorded: 自动 on the native
  // route used to derive images-api and 404 at /api/v1/images/generations.
  it("draws an undeclared native-route model through DashScope native", async () => {
    const { row } = save({
      family: "dashscope",
      draft: { route: "", dialect: "", edit: false, asyncTask: false, sizes: [], comfyWorkflow: "" },
    }, newRow());
    expect(await observe(row)).toEqual({ route: "dashscope", async: false });
  });
});
