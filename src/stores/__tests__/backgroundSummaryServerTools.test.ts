/**
 * Background summaries never carry the model's server tools.
 *
 * `connOptions` copies `Model.serverTools` into every request built from a
 * model row, which is right for the author's own tasks and wrong for the
 * summaries the app writes on its own (前情摘要, collection digests): there is
 * nothing to look up or compute, and on DashScope a declared code interpreter
 * alone adds ~800 input tokens and extra inference passes per request.
 *
 * Source-scanned rather than driven, because both stores reach
 * `streamCompletion` only past project, file and model resolution — and what
 * has to hold is simply that each call site overrides the field.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The argument text of every `streamCompletion({ … })` call in a file. */
function streamCalls(src: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf("streamCompletion({", from);
    if (at < 0) return out;
    let depth = 0;
    let i = at + "streamCompletion(".length;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    out.push(src.slice(at, i + 1));
    from = i;
  }
}

describe.each(["memoryStore.ts", "digestStore.ts"])("%s", (file) => {
  it("sends no server tools on any summary request", () => {
    const calls = streamCalls(readFileSync(join(here, "..", file), "utf8"));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      // After the spread, so it overrides what connOptions copied in.
      expect(call).toMatch(/\.\.\.connOptions\([^)]*\),[\s\S]*serverTools: undefined,/);
    }
  });
});
