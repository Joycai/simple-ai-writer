/**
 * Retired words must not come back.
 *
 * `docs/reference/terminology.md` settles which Chinese word names which
 * concept. The words this file lists lost that arbitration — they described a
 * thing that already had a name, so every one of them is now a synonym the
 * author would read as a *second* feature.
 *
 * Two surfaces are scanned, because the wording lives in two places:
 *
 *   1. `zh-CN.json` — the real string;
 *   2. `t(key, { defaultValue: "…" })` in components — a dormant second copy
 *      that only renders when a key is missing. `localeParity.test.ts` keeps
 *      keys from going missing, so these fallbacks are invisible at runtime and
 *      drift silently: batch A found `roleplay.stale.body` carrying one
 *      sentence in the JSON and a different one in the fallback. Invisible is
 *      exactly why it needs a machine to watch it — nobody notices by reading.
 *
 * Code comments are deliberately *not* scanned. They carry design records and
 * quoted mockup titles (设计稿 03 · 屏 17「AI 执行进度 · 思维链」), and a word
 * ban over prose is a false-positive machine. Each batch sweeps its own
 * comments instead; see terminology.md §4.
 *
 * Adding a word here is how a calibration batch becomes permanent. Adding an
 * exemption is how you say "this one means something else" — and having to name
 * the key makes that claim explicit rather than a widened regex.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import zh from "../../i18n/locales/zh-CN.json";

interface Retired {
  /** The word that lost. */
  word: string;
  /** What to write instead — quoted back in the failure message. */
  instead: string;
  /**
   * Key paths (for the JSON scan) or file basenames (for the fallback scan)
   * where the word means something else and is allowed to stay.
   */
  allow?: string[];
}

const RETIRED: Retired[] = [
  { word: "词条", instead: "条目（知识库）/ 词对（翻译词典）" },
  { word: "主词条", instead: "主条目" },
  { word: "前情记忆", instead: "前情提要" },
  { word: "前情摘要", instead: "前情提要（故事记忆）/ 前情（扮演转场）" },
  { word: "思维链", instead: "思考过程" },
  { word: "底稿", instead: "以此为基础" },
  { word: "生成插图", instead: "生成图片" },
  { word: "修改插图", instead: "修改图片" },
  { word: "图像生成", instead: "图片生成" },
  {
    // 「设定」 survives in three senses that are not the knowledge base: the verb
    // (不设定 / 无身份设定) and one line of roleplay prose. Naming them is the
    // point — a looser regex would let the noun back in.
    word: "设定",
    instead: "知识库 / 条目",
    allow: [
      "roleplay.persona.none",
      "roleplay.persona.narratorNote",
      "roleplay.empty.body",
      // The model-facing prompt layer is batch F, deliberately not done yet.
      "ai.instructions.",
    ],
  },
];

/** Every leaf path → string in the zh-CN tree. */
function leaves(node: unknown, prefix = "", out: [string, string][] = []) {
  if (typeof node === "string") {
    out.push([prefix, node]);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      leaves(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

/** Every .ts/.tsx file under src/, minus this test's own directory. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "__tests__") continue;
      sources(path, out);
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      out.push(path);
    }
  }
  return out;
}

const SRC = join(process.cwd(), "src");
/** `defaultValue: "…"` — single-line literals, which is how they are written. */
const FALLBACK = /defaultValue:\s*"((?:[^"\\]|\\.)*)"/g;

describe("retired terminology", () => {
  const entries = leaves(zh);

  it.each(RETIRED)("$word is gone from zh-CN.json (use $instead)", ({ word, instead, allow = [] }) => {
    const hits = entries
      .filter(([key, value]) => value.includes(word) && !allow.some((a) => key.startsWith(a)))
      .map(([key, value]) => `  ${key}: ${value.slice(0, 60)}`);
    expect(hits, `「${word}」已退役，请改用「${instead}」：\n${hits.join("\n")}`).toEqual([]);
  });

  it.each(RETIRED)("$word is gone from defaultValue fallbacks (use $instead)", ({ word, instead, allow = [] }) => {
    const hits: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf-8");
      for (const m of text.matchAll(FALLBACK)) {
        if (!m[1].includes(word)) continue;
        // A fallback is exempt when the key it backs is exempt. The key sits
        // just before it in the same call, so the surrounding text carries it.
        const call = text.slice(Math.max(0, m.index - 120), m.index);
        if (allow.some((a) => call.includes(a))) continue;
        hits.push(`  ${file.slice(SRC.length + 1)}: ${m[1].slice(0, 60)}`);
      }
    }
    expect(hits, `「${word}」已退役，请改用「${instead}」：\n${hits.join("\n")}`).toEqual([]);
  });
});
