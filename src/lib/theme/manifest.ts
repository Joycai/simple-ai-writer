/**
 * A theme file's metadata — the `--theme-*` custom properties.
 *
 * They sit in the same `:root` block as the tokens (docs/feature/theme-system-plan.md
 * §5, 设计稿 05i 屏 1f): the validator parses the file once with the browser's
 * own CSS parser, and the metadata falls out of that same pass. Nothing here
 * touches the DOM — `validate.ts` hands over the `--theme-*` pairs it found
 * and this module decides what they mean.
 *
 *   --theme-name     宣纸          the name the grid shows (required)
 *   --theme-kind     ui | markdown (absent = ui)
 *   --theme-scheme   light | dark  (ui: required — which band it belongs to)
 *   --theme-extends  paper | night (ui: the same-polarity built-in, and only that)
 *                    manuscript | clean | … (markdown: the built-in it sits on)
 *   --theme-version, --theme-author   optional, read but not drawn
 */
import type { ColorScheme } from "./scheme";
import { BUILTIN_THEME_FOR_SCHEME } from "./scheme";

export type ThemeKind = "ui" | "markdown";

export interface ThemeMeta {
  name: string;
  kind: ThemeKind;
  /** ui only. */
  scheme?: ColorScheme;
  extends: string;
  version?: string;
  author?: string;
}

/**
 * Why a rule, a declaration or a whole file was refused. A *code*, not a
 * sentence: the card translates it (`systemSettings.general.reason.<code>`
 * in the locale files) with `params` filled in, so an English interface
 * never shows a Chinese reason and the tests pin codes rather than prose.
 */
export type ThemeReasonCode =
  | "uiSelector" | "uiProperty" | "uiScale" | "uiUnknown" | "uiSchemeMedia" | "uiAtRule"
  | "mdSelector" | "mdCombinator" | "mdRoot" | "mdAtRule" | "mdUrl"
  | "missingMeta" | "badKind" | "badExtendsUi" | "badExtendsMd"
  | "unreadableFile" | "reservedUiId" | "reservedMdId" | "uiInProject";

/** One dropped rule or declaration — what the card's 详情 table shows. */
export interface ThemeProblem {
  /** 1-based index of the top-level rule in the file; 0 = the file as a whole. */
  rule: number;
  selector?: string;
  reason: ThemeReasonCode;
  /** Interpolated into the translated reason. */
  params?: Record<string, string>;
}

export const THEME_META_PREFIX = "--theme-";
export const THEME_FILE_EXT = ".css";

/** The built-in ids — reserved; a file with one of these names cannot install. */
export const BUILTIN_UI_IDS: readonly string[] = ["paper", "night"];
export const BUILTIN_MARKDOWN_IDS: readonly string[] = ["manuscript", "clean", "magazine", "wechat", "typewriter"];

/**
 * A theme's id is its file name without the extension — Typora's convention,
 * and the thing the author already sees in the folder. `null` for anything
 * that is not a `.css` file with a name.
 */
export function themeIdFromFileName(fileName: string): string | null {
  if (!fileName.endsWith(THEME_FILE_EXT)) return null;
  const id = fileName.slice(0, -THEME_FILE_EXT.length).trim();
  if (!id || id.startsWith(".")) return null;
  return id;
}

/** A metadata value as the CSSOM hands it back: whitespace and one layer of quotes off. */
export function cleanMetaValue(raw: string): string {
  const v = raw.trim();
  const q = v[0];
  if ((q === '"' || q === "'") && v.length >= 2 && v.endsWith(q)) return v.slice(1, -1).trim();
  return v;
}

export interface MetaReading {
  /** Absent when the file cannot be used — the required fields are missing. */
  meta?: ThemeMeta;
  /** Why, in the words the card shows. Empty when `meta` is present and clean. */
  problems: ThemeProblem[];
}

/**
 * Decide what a file's `--theme-*` pairs mean.
 *
 * Missing name or (for a ui theme) missing / invalid scheme is the one
 * "cannot use" case (设计稿 1c 屏 02: 「缺 --theme-name / --theme-scheme」).
 * Everything else degrades: an unknown kind reads as ui, an `extends` that
 * names a different polarity's built-in is corrected and noted — the cascade
 * bases a ui theme on its scheme's built-in whatever the file says.
 */
export function readThemeMeta(pairs: Record<string, string>, rule = 1): MetaReading {
  const get = (k: string) => {
    const raw = pairs[THEME_META_PREFIX + k];
    return raw === undefined ? undefined : cleanMetaValue(raw);
  };
  const problems: ThemeProblem[] = [];
  const name = get("name");
  const kindRaw = get("kind");
  const kind: ThemeKind = kindRaw === "markdown" ? "markdown" : "ui";
  if (kindRaw !== undefined && kindRaw !== "ui" && kindRaw !== "markdown") {
    problems.push({ rule, selector: `${THEME_META_PREFIX}kind`, reason: "badKind", params: { kind: kindRaw } });
  }

  const schemeRaw = get("scheme");
  const scheme: ColorScheme | undefined =
    schemeRaw === "light" || schemeRaw === "dark" ? schemeRaw : undefined;

  const missing: string[] = [];
  if (!name) missing.push(`${THEME_META_PREFIX}name`);
  if (kind === "ui" && !scheme) missing.push(`${THEME_META_PREFIX}scheme`);
  if (missing.length) {
    problems.push({ rule, selector: ":root", reason: "missingMeta", params: { fields: missing.join(" / ") } });
    return { problems };
  }

  let ext = get("extends");
  if (kind === "ui") {
    const expected = BUILTIN_THEME_FOR_SCHEME[scheme as ColorScheme];
    if (ext !== undefined && ext !== expected) {
      problems.push({ rule, selector: `${THEME_META_PREFIX}extends`, reason: "badExtendsUi", params: { base: expected } });
    }
    ext = expected;
  } else if (!ext || !BUILTIN_MARKDOWN_IDS.includes(ext)) {
    if (ext) {
      problems.push({
        rule,
        selector: `${THEME_META_PREFIX}extends`,
        reason: "badExtendsMd",
        params: { list: BUILTIN_MARKDOWN_IDS.join(" / "), base: BUILTIN_MARKDOWN_IDS[0] },
      });
    }
    ext = BUILTIN_MARKDOWN_IDS[0];
  }

  const version = get("version");
  const author = get("author");
  return {
    meta: {
      name: name as string,
      kind,
      ...(kind === "ui" ? { scheme } : {}),
      extends: ext,
      ...(version ? { version } : {}),
      ...(author ? { author } : {}),
    },
    problems,
  };
}
