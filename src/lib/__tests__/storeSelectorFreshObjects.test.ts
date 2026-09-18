/**
 * No zustand selector may return an object built by the channel/route helpers.
 *
 * `providerFor` / `routeProvider` / `normalizeChannel` (lib/ai/routes) return a
 * fresh `{ ...p }` on every call. Inside `useXStore((s) => …)` that means the
 * snapshot never compares equal to the last one, and React re-renders until it
 * gives up with "Maximum update depth exceeded" (#185) — the whole UI falls to
 * the error boundary the moment the component mounts. Nothing catches it before
 * runtime: types are fine, and the component renders correctly once.
 *
 * It shipped once: P1–P4 swapped `ReasoningControls`' `providers.find(…)` (the
 * store's own object) for `providerFor(…)`, and opening the AI panel crashed.
 * Select `s.providers` and route outside the selector (`useMemo`), or select a
 * primitive off the result (`providerFor(…)?.apiStandard`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const BUILDERS = /\b(providerFor|routeProvider|normalizeChannel)\s*\(/;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "__tests__" && name !== "node_modules") sources(p, out);
    } else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Each `useXStore(` call's argument text, parens balanced. */
function selectorBodies(src: string): string[] {
  const out: string[] = [];
  const re = /\buse[A-Z]\w*Store\s*\(/g;
  while (re.exec(src)) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    out.push(src.slice(re.lastIndex, i - 1));
  }
  return out;
}

/** A selector that builds a channel object and hands it back whole. */
function returnsFreshChannel(body: string): boolean {
  // Reading a primitive off the built object is fine: `…)?.apiStandard`.
  return BUILDERS.test(body) && !/\)\s*\??\.\s*\w+\s*,?\s*$/.test(body.trim());
}

describe("store selectors", () => {
  it("recognises the shape that crashed", () => {
    expect(returnsFreshChannel("(s) =>\n    model ? providerFor(model, s.providers) : undefined,\n  ")).toBe(true);
    expect(returnsFreshChannel("(s) => (m ? providerFor(m, s.providers) : undefined)?.apiStandard")).toBe(false);
    expect(returnsFreshChannel("(s) => s.providers")).toBe(false);
  });

  it("never return an object built by providerFor / routeProvider / normalizeChannel", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      for (const body of selectorBodies(readFileSync(file, "utf8"))) {
        if (returnsFreshChannel(body)) offenders.push(`${file.slice(SRC.length)}: ${body.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
