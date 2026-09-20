/**
 * The shipped theme examples (`themes/*.css` at the repo root) must be what
 * the guide beside them promises: complete metadata, a built-in base, and
 * every rule inside the fence its kind is held to — the `.md-body` subtree
 * for a typography theme, the token contract for an appearance theme. An
 * author downloads one of these as the *reference* for the format; a sample
 * that installs with a problems card would teach the wrong lesson in the most
 * authoritative place.
 *
 * The app validates over the browser's CSSOM (`validate.ts`); vitest runs in
 * node with no CSSOM, so this walks the text with a small brace tokenizer
 * and hands each selector / url / token name to the **same predicates** the
 * runtime uses. It is a guard for files we author, not a second parser: a
 * malformed file fails here rather than being tolerated.
 *
 * An appearance theme gets two checks the runtime does not make, because they
 * are promises of the *samples* rather than of the format: it writes the whole
 * core contract (a partial one silently inherits its base's hues, which on a
 * differently-coloured ground reads as a bug), and its accent and body text
 * clear the contrast its own header claims.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_MARKDOWN_IDS, BUILTIN_UI_IDS, THEME_FILE_EXT, readThemeMeta, themeIdFromFileName,
} from "../manifest";
import { isAllowedUrl, isMdSelector, isThemeSelector, splitSelectors, urlsIn } from "../validate";
import { tokenTier } from "../contract";
import { TOKEN_CONTRACT } from "../contractData";
import { BUILTIN_THEME_FOR_SCHEME } from "../scheme";

const THEMES_DIR = fileURLToPath(new URL("../../../../themes/", import.meta.url));

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

/** Every `--theme-*` pair in the file, wherever it sits — the kind comes first. */
function metaOf(css: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const visit = (text: string) => {
    for (const { head, body } of blocks(text)) {
      if (CONDITIONAL.test(head)) visit(body);
      else if (head.startsWith("@")) continue;
      else for (const [name, value] of declarations(body)) {
        if (name.startsWith("--theme-")) meta[name] = value;
      }
    }
  };
  visit(css);
  return meta;
}

/** Every fence violation of a *typography* theme. */
function mdViolations(css: string, nested = false): string[] {
  const bad: string[] = [];
  for (const { head, body } of blocks(css)) {
    if (head.startsWith("@")) {
      if (CONDITIONAL.test(head)) {
        bad.push(...mdViolations(body, true));
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
      for (const [name] of declarations(body)) {
        if (!name.startsWith("--theme-")) bad.push(`:root ${name} (only --theme-* belongs there)`);
      }
      continue;
    }
    for (const sel of splitSelectors(head)) {
      if (!isMdSelector(sel)) bad.push(`selector outside the fence: ${sel}`);
    }
    for (const [name, value] of declarations(body)) {
      for (const u of urlsIn(value)) if (!isAllowedUrl(u)) bad.push(`${head} ${name}: url ${u}`);
    }
  }
  return bad;
}

/** Every contract violation of an *appearance* theme, and the tokens it writes. */
function uiViolations(css: string, id: string): { bad: string[]; tokens: Record<string, string> } {
  const bad: string[] = [];
  const tokens: Record<string, string> = {};
  for (const { head, body } of blocks(css)) {
    if (head.startsWith("@")) {
      bad.push(`at-rule not allowed: ${head}`);
      continue;
    }
    if (!isThemeSelector(head, id)) {
      bad.push(`selector outside the contract: ${head}`);
      continue;
    }
    for (const [name, value] of declarations(body)) {
      if (name.startsWith("--theme-")) continue;
      if (!name.startsWith("--")) {
        bad.push(`${head} ${name} (a plain property, not a token)`);
        continue;
      }
      const tier = tokenTier(TOKEN_CONTRACT, name);
      if (tier === "core" || tier === "derived") tokens[name] = value;
      else bad.push(`${head} ${name} (${tier ?? "unknown"} — not a theme's to set)`);
    }
  }
  return { bad, tokens };
}

// ── Contrast, for the two promises an appearance sample makes ────────────────

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const files = readdirSync(THEMES_DIR).filter((f) => f.endsWith(THEME_FILE_EXT));
const readme = readFileSync(THEMES_DIR + "README.md", "utf-8");

describe("themes/ — the shipped examples", () => {
  it("ships at least one of each kind", () => {
    const kinds = files.map((f) => metaOf(readFileSync(THEMES_DIR + f, "utf-8"))["--theme-kind"]);
    expect(kinds).toContain("markdown");
    expect(kinds).toContain("ui");
  });

  for (const file of files) {
    describe(file, () => {
      const css = readFileSync(THEMES_DIR + file, "utf-8");
      const meta = metaOf(css);
      const id = themeIdFromFileName(file);
      const isUi = meta["--theme-kind"] !== "markdown";

      it("has an installable id", () => {
        expect(id).not.toBeNull();
        const reserved = isUi ? BUILTIN_UI_IDS : BUILTIN_MARKDOWN_IDS;
        expect(reserved, "a built-in id is reserved").not.toContain(id);
      });

      it("is listed in the guide beside it", () => {
        expect(readme).toContain(`\`${file}\``);
      });

      if (isUi) {
        const { bad, tokens } = uiViolations(css, id ?? "");

        it("declares complete appearance metadata on its polarity's base", () => {
          const reading = readThemeMeta(meta);
          expect(reading.problems).toEqual([]);
          expect(reading.meta?.kind).toBe("ui");
          const scheme = reading.meta?.scheme;
          expect(scheme).toBeDefined();
          // The header must *say* the base, not fall back to it silently — a
          // sample is read as the format's reference.
          expect(meta["--theme-extends"]).toBe(BUILTIN_THEME_FOR_SCHEME[scheme!]);
        });

        it("writes tokens the contract knows, and nothing else", () => {
          expect(bad).toEqual([]);
        });

        it("writes the whole core contract", () => {
          expect(TOKEN_CONTRACT.core.filter((t) => !(t in tokens))).toEqual([]);
        });

        it("carries its accent and its body text over its own ground", () => {
          const ground = tokens["--color-bg-base"];
          expect(contrast(tokens["--color-sienna"], ground)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(tokens["--color-text-primary"], ground)).toBeGreaterThanOrEqual(7);
        });
      } else {
        const bad = mdViolations(css);

        it("declares complete markdown metadata on a built-in base", () => {
          const reading = readThemeMeta(meta);
          expect(reading.problems).toEqual([]);
          expect(reading.meta?.kind).toBe("markdown");
          expect(BUILTIN_MARKDOWN_IDS).toContain(reading.meta?.extends);
          expect(meta["--theme-extends"]).toBeTruthy();
        });

        it("keeps every rule inside the .md-body fence", () => {
          expect(bad).toEqual([]);
        });
      }
    });
  }
});
