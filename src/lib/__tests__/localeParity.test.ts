/**
 * zh-CN.json and en.json must define exactly the same key paths.
 *
 * A missing key is invisible at runtime — i18next quietly falls back to `en`
 * (or to the raw key path when English is the one missing it), so a drift only
 * surfaces when a user on the other language happens to open that screen. This
 * is cheap to check mechanically, so it runs in `pnpm test` with everything else.
 */
import { describe, expect, it } from "vitest";
import zh from "../../i18n/locales/zh-CN.json";
import en from "../../i18n/locales/en.json";

/** Every leaf path in a translation tree, dot-joined. */
function leafPaths(node: unknown, prefix = "", out: string[] = []): string[] {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    out.push(prefix);
    return out;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    leafPaths(value, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

/**
 * i18next plural suffixes are the one legitimate asymmetry: English resolves
 * `key` / `key_other` for one-vs-many, while Chinese has a single CLDR plural
 * category and correctly carries only the base key. So a suffixed path is
 * excused when its base form exists on both sides — but `foo_other` with no
 * `foo` anywhere is still a real gap.
 */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function unpaired(from: string[], other: Set<string>, both: (k: string) => boolean) {
  return from.filter((k) => {
    if (other.has(k)) return false;
    const base = k.replace(PLURAL_SUFFIX, "");
    return base === k || !both(base);
  });
}

describe("locale parity", () => {
  const zhPaths = leafPaths(zh);
  const enPaths = leafPaths(en);
  const zhSet = new Set(zhPaths);
  const enSet = new Set(enPaths);
  const inBoth = (k: string) => zhSet.has(k) && enSet.has(k);

  it("has no zh-CN key missing from en", () => {
    expect(unpaired(zhPaths, enSet, inBoth)).toEqual([]);
  });

  it("has no en key missing from zh-CN", () => {
    expect(unpaired(enPaths, zhSet, inBoth)).toEqual([]);
  });

  // A nested object on one side and a plain string on the other slips past the
  // two checks above; comparing leaf-vs-branch pins the shape of the tree too.
  it("agrees on which paths are leaves", () => {
    const branch = (paths: string[]) =>
      new Set(paths.flatMap((p) => p.split(".").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("."))));
    const zhBranches = branch(zhPaths);
    const enBranches = branch(enPaths);
    expect(zhPaths.filter((k) => enBranches.has(k))).toEqual([]);
    expect(enPaths.filter((k) => zhBranches.has(k))).toEqual([]);
  });

  /**
   * Comparing the two files against each other cannot see a key that is
   * missing from *both* — and that is the case with a visible symptom, because
   * `defaultValue` then supplies the string. Every such default in this
   * codebase happens to be written in Chinese, so an English-speaking author
   * got Chinese UI with nothing anywhere reporting a problem.
   */
  it("defines every key the source actually asks for", () => {
    const missing = sourceKeys().filter((k) => !zhSet.has(k) || !enSet.has(k));
    expect(missing).toEqual([]);
  });
});

/**
 * Literal `t("some.key")` paths used anywhere under src/.
 *
 * Deliberately only literals containing a dot: several call sites build a key
 * from a prefix plus a variable (`editor.search.${key}`, the category filters),
 * which no static scan can resolve — and their bare tails have no dot, so this
 * filter drops exactly those rather than reporting them as gaps.
 */
function sourceKeys(): string[] {
  // Vite reads the tree for us — no node:fs, which this project has no types for.
  const sources = import.meta.glob("../../**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  const keys = new Set<string>();
  const pattern = /\bt\(\s*["'`]([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)["'`]/g;
  for (const [path, source] of Object.entries(sources)) {
    if (path.includes("__tests__")) continue;
    for (const m of source.matchAll(pattern)) keys.add(m[1]);
  }
  return [...keys].sort();
}
