/**
 * The system-prompt seam, and the invariant that every caller goes through it.
 *
 * The prompt is one neutral writing-collaborator identity for every project —
 * packs add tasks and categories, never a persona. `profileSystemPrompt()` in
 * lib/context/rag is still the single seam every caller must resolve through:
 * it is where a future per-project override would land, and the history here
 * is a real regression — `aiTaskStore` once resolved the slot to the i18n key
 * directly, so the then-per-pack fallback never fired on the path that
 * mattered. The source guard below keeps callers honest.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("../fs/fileio", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(),
  writeBinaryFile: vi.fn(),
  readDir: vi.fn(),
  makeDir: vi.fn(),
  fileExists: vi.fn(),
  renamePath: vi.fn(),
  removeFile: vi.fn(),
}));

import { profileSystemPrompt } from "../context/rag";

describe("profileSystemPrompt", () => {
  it("resolves the one neutral key, whatever is enabled", () => {
    // i18n is mocked to echo keys, so this asserts *which* key is used.
    expect(profileSystemPrompt()).toBe("ai.instructions.system");
  });
});

// ── Source guard ─────────────────────────────────────────────────────────────

/**
 * Files allowed to mention the system prompt key directly, with the reason:
 *   - context/rag.ts     — it *is* the seam; the key lives here
 *   - PromptsPane.tsx    — lists the built-in prompt templates by scene for the
 *                          editor; app-level config, not a per-run fallback
 * Anything else resolving a system prompt must call `profileSystemPrompt()`.
 */
const ALLOWED = ["src/lib/context/rag.ts", "src/components/settings/panes/PromptsPane.tsx"];

/**
 * Every source file's text, keyed by repo-relative path.
 *
 * Read through Vite's `import.meta.glob` rather than `node:fs`: the project's
 * tsconfig has no `@types/node`, so a filesystem walk here would run fine under
 * vitest and then fail `tsc --noEmit` in CI.
 */
const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

describe("no hardcoded system prompt key", () => {
  it("routes every system-prompt fallback through profileSystemPrompt()", () => {
    const hits = Object.entries(SOURCES)
      .filter(([path]) => !path.includes("/__tests__/"))
      .filter(([, text]) => text.includes('ai.instructions.system"'))
      .map(([path]) => path.replace(/^\//, ""));

    // Prove the scan works before trusting that it found nothing. A broken walk
    // or a path-separator mismatch would otherwise make this guard pass forever
    // — the failure mode of every source-scanning test.
    expect(hits).toEqual(expect.arrayContaining(ALLOWED));

    const offenders = hits.filter((path) => !ALLOWED.includes(path));

    expect(
      offenders,
      "These files reference the system prompt's i18n key directly, which " +
        "bypasses the one seam a future per-project override would land in. " +
        "Call profileSystemPrompt() from lib/context/rag instead, or add the " +
        "file to ALLOWED here with a reason.",
    ).toEqual([]);
  });
});
