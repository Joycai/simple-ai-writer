/**
 * The shipped typography-theme examples (`themes/*.css` at the repo root)
 * must be what the guide beside them promises: complete metadata, a
 * built-in base, every selector inside the `.md-body` fence, every `url()`
 * allowed. An author downloads one of these as the *reference* for the
 * format — a sample that installs with a problems card would teach the
 * wrong lesson in the most authoritative place.
 *
 * The app validates over the browser's CSSOM (`validate.ts`); vitest runs in
 * node with no CSSOM, so this walks the text with a small brace tokenizer
 * and hands each selector / url to the **same predicates** the runtime uses.
 * It is a guard for files we author, not a second parser: a malformed file
 * fails here rather than being tolerated.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_MARKDOWN_IDS, THEME_FILE_EXT, readThemeMeta, themeIdFromFileName } from "../theme/manifest";
import { isAllowedUrl, isMdSelector, splitSelectors, urlsIn } from "../theme/validate";

const THEMES_DIR = fileURLToPath(new URL("../../../themes/", import.meta.url));

interface Block {
  head: string;
  body: string;
}

/** Top-level `head { body }` blocks of a stylesheet, comments stripped. */
function blocks(css: string): Block[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Block[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) {
      expect(text.slice(i).trim(), "stray text outside any block").toBe("");
      break;
    }
    const head = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    for (; j < text.length && depth > 0; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
    }
    expect(depth, `unbalanced braces after "${head}"`).toBe(0);
    out.push({ head, body: text.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

/** `name: value` pairs of a declaration block (no nested blocks). */
function declarations(body: string): [string, string][] {
  return body
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const colon = d.indexOf(":");
      expect(colon, `declaration without a colon: "${d}"`).toBeGreaterThan(0);
      return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()];
    });
}

const CONDITIONAL = /^@(media|supports|container)\b/;

/** Every fence violation in `css`, as strings the failure message can list. */
function violations(css: string, meta: Record<string, string>, nested = false): string[] {
  const bad: string[] = [];
  for (const { head, body } of blocks(css)) {
    if (head.startsWith("@")) {
      if (CONDITIONAL.test(head)) {
        bad.push(...violations(body, meta, true));
      } else if (/^@(font-face|keyframes)\b/.test(head)) {
        for (const [, value] of head.startsWith("@font-face") ? declarations(body) : []) {
          for (const u of urlsIn(value)) if (!isAllowedUrl(u)) bad.push(`${head}: url ${u}`);
        }
      } else {
        bad.push(`at-rule not allowed: ${head}`);
      }
      continue;
    }
    if (head === ":root") {
      if (nested) bad.push(":root inside a conditional block");
      for (const [name, value] of declarations(body)) {
        if (name.startsWith("--theme-")) meta[name] = value;
        else bad.push(`:root ${name} (only --theme-* belongs there)`);
      }
      continue;
    }
    for (const sel of splitSelectors(head)) {
      if (!isMdSelector(sel)) bad.push(`selector outside the fence: ${sel}`);
    }
    for (const [name, value] of declarations(body)) {
      if (name.startsWith("--theme-")) meta[name] = value;
      for (const u of urlsIn(value)) if (!isAllowedUrl(u)) bad.push(`${head} ${name}: url ${u}`);
    }
  }
  return bad;
}

const files = readdirSync(THEMES_DIR).filter((f) => f.endsWith(THEME_FILE_EXT));

describe("themes/ — the shipped typography examples", () => {
  it("ships at least one example", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    describe(file, () => {
      const css = readFileSync(THEMES_DIR + file, "utf-8");
      const meta: Record<string, string> = {};
      const bad = violations(css, meta);

      it("has an installable id", () => {
        const id = themeIdFromFileName(file);
        expect(id).not.toBeNull();
        expect(BUILTIN_MARKDOWN_IDS, "a built-in id is reserved").not.toContain(id);
      });

      it("declares complete markdown metadata on a built-in base", () => {
        const reading = readThemeMeta(meta);
        expect(reading.problems).toEqual([]);
        expect(reading.meta?.kind).toBe("markdown");
        expect(BUILTIN_MARKDOWN_IDS).toContain(reading.meta?.extends);
        // The header must *say* the base, not fall back to it silently — a
        // sample is read as the format's reference.
        expect(meta["--theme-extends"]).toBeTruthy();
      });

      it("keeps every rule inside the .md-body fence", () => {
        expect(bad).toEqual([]);
      });

      it("is listed in the guide beside it", () => {
        const readme = readFileSync(THEMES_DIR + "README.md", "utf-8");
        expect(readme).toContain(`\`${file}\``);
      });
    });
  }
});
