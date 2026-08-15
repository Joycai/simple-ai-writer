/**
 * The system-prompt fallback, and the invariant that every caller goes through
 * it.
 *
 * This exists because of a real regression: `bundleToMessages` fell back to the
 * profile's prompt correctly, but `aiTaskStore` had already resolved the slot to
 * `i18n.t("ai.instructions.system")` — the *novel* prompt — before the bundle was
 * ever built. The fallback therefore never fired on the path that matters, and a
 * TTRPG project was silently prompted as a novel. The unit test below passed
 * throughout, because it called `assembleContext("")` directly.
 *
 * So there are two tests here: one for the helper, and one that scans the source
 * for the hardcoded key that defeats it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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
import { resetActiveWorkspace, setActiveWorkspace } from "../profile/active";
import { resolveWorkspace } from "../profile/resolve";
import { BUILTIN_PROFILES, NOVEL_PROFILE, TTRPG_PROFILE } from "../profile/model";

afterEach(() => resetActiveWorkspace());

describe("profileSystemPrompt", () => {
  it("resolves the active profile's key", () => {
    // i18n is mocked to echo keys, so this asserts *which* key is used.
    expect(profileSystemPrompt()).toBe(NOVEL_PROFILE.systemPromptKey);
    setActiveWorkspace(resolveWorkspace(TTRPG_PROFILE, []));
    expect(profileSystemPrompt()).toBe(TTRPG_PROFILE.systemPromptKey);
  });

  it("gives every builtin a distinct prompt key", () => {
    const keys = BUILTIN_PROFILES.map((p) => p.systemPromptKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ── Source guard ─────────────────────────────────────────────────────────────

/**
 * Files allowed to mention the novel prompt key directly, with the reason:
 *   - profile/model.ts   — it *is* the novel profile's declared key
 *   - PromptsPane.tsx    — lists the built-in prompt templates by scene for the
 *                          editor; app-level config, not a per-run fallback
 * Anything else resolving a system prompt must call `profileSystemPrompt()`.
 */
const ALLOWED = ["src/lib/profile/model.ts", "src/components/settings/panes/PromptsPane.tsx"];

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

describe("no hardcoded novel system prompt", () => {
  it("routes every system-prompt fallback through the profile", () => {
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
      "These files reference the novel system prompt directly, which fills the " +
        "system slot before the profile's fallback can apply — a non-novel project " +
        "then gets novel instructions. Call profileSystemPrompt() from lib/context/rag " +
        "instead, or add the file to ALLOWED here with a reason.",
    ).toEqual([]);
  });
});
