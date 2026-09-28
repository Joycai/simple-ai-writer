/**
 * 出图的有效路线只有一个主人：`lib/ai/imageRoute.ts`（docs/feature/image-route.md）。
 *
 * 抽屉曾经拿声明值（`form.capsRoute === "dashscope"`）回答「图会打到哪」，而客户端按
 * 有效路线派发——DashScope 原生线路上的「自动」就这样两头都错过一次。`images-api` /
 * `gemini` / `dashscope` 是**可推导**的三个值：模型没声明时也可能落在它们上，所以拿
 * 声明值直接和它们比，答的就不是请求真正去的地方。这条扫 `src/` 全部源码，
 * 除 `imageRoute.ts` 本身外，不许出现这种比较。
 *
 * `chat` / `comfyui` / `ark` 永远不会被推出来，对它们「声明值 ≡ 有效路线」由类型保证，
 * 所以 `caps.route === "comfyui"` 不在拦的范围里。
 *
 * **被它拦下时。** 改问 `effectiveImageRoute`（抽屉里是 `draftRoute` / `showsAsyncToggle`）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const OWNER = "lib/ai/imageRoute.ts";

/** A declared route: `caps.route` (`?.` / `!.`), the drawer's `capsRoute`, a conn's or a draft's `route`. */
const DECL = String.raw`(?:caps[?!]?\.route|capsRoute|conn\.route|draft\.route)`;
const DERIVABLE = String.raw`["'](?:images-api|gemini|dashscope)["']`;
const PATTERN = new RegExp(
  [
    String.raw`\b${DECL}\s*[!=]==?\s*${DERIVABLE}`,
    String.raw`${DERIVABLE}\s*[!=]==?\s*[\w.?!]*${DECL}`,
    // A switch on the declaration answers every case from it, derivable ones included.
    String.raw`switch\s*\(\s*[\w.?!]*${DECL}\s*\)`,
  ].join("|"),
  "g",
);

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
    const hits = (src: string) => src.match(PATTERN)?.length ?? 0;
    expect(hits('open={form.capsRoute === "dashscope"}')).toBe(1);
    expect(hits('if (m.caps?.route !== "gemini") x();')).toBe(1);
    expect(hits('if ("images-api" === model.caps!.route) x();')).toBe(1);
    expect(hits("switch (model.caps?.route) {")).toBe(1);
    expect(hits('model.caps?.route === "comfyui"')).toBe(0);
    expect(hits('route === "dashscope"')).toBe(0);
  });

  it("only imageRoute.ts compares a declared route with images-api / gemini / dashscope", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file).split("\\").join("/");
      scanned++;
      if (rel === OWNER) continue;
      for (const m of readFileSync(file, "utf8").match(PATTERN) ?? []) offenders.push(`${rel}: ${m}`);
    }
    expect(scanned).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
