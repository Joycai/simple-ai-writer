import { describe, it, expect, vi, beforeEach } from "vitest";
import { assembleContext, bundleToMessages } from "../rag";
import type { LoreIndex } from "../lore";

// The real i18n module touches localStorage at import time (browser-only).
vi.mock("../../i18n", () => ({ default: { t: (key: string) => key } }));

// Mock file I/O so entity summaries load without a Tauri backend.
const files = new Map<string, string>();
vi.mock("../fileio", () => ({
  readFile: async (path: string) => {
    const content = files.get(path);
    if (content == null) throw new Error(`no such file: ${path}`);
    return content;
  },
}));

function makeLoreIndex(): LoreIndex {
  return {
    characters: [
      {
        name: "Aria",
        aliases: ["the Songbird"],
        dirPath: "/proj/.ai-writer/lore/characters/aria",
      },
      {
        name: "Bran",
        aliases: [],
        dirPath: "/proj/.ai-writer/lore/characters/bran",
      },
    ],
    world: [
      {
        name: "Ironhold",
        aliases: ["the Iron City"],
        dirPath: "/proj/.ai-writer/lore/world/ironhold",
      },
    ],
  } as unknown as LoreIndex;
}

beforeEach(() => {
  files.clear();
  files.set("/proj/.ai-writer/lore/characters/aria/index.md", "Aria is a bard.");
  files.set("/proj/.ai-writer/lore/characters/bran/index.md", "Bran is a smith.");
  files.set("/proj/.ai-writer/lore/world/ironhold/index.md", "Ironhold is a fortress city.");
});

describe("assembleContext", () => {
  it("includes lore snippets for entities matched by name or alias", async () => {
    const bundle = await assembleContext(
      "SYS",
      makeLoreIndex(),
      "The Songbird walked into the Iron City.",
      "",
      "Continue the story."
    );
    expect(bundle.loreSnippets).toContain("Aria is a bard.");
    expect(bundle.loreSnippets).toContain("Ironhold is a fortress city.");
    expect(bundle.loreSnippets).not.toContain("Bran is a smith.");
  });

  it("merges manually pinned entities ahead of auto-matched ones, deduped", async () => {
    const bundle = await assembleContext(
      "SYS",
      makeLoreIndex(),
      "Aria sang.",
      "",
      "Continue.",
      {
        manualLorePaths: [
          "/proj/.ai-writer/lore/characters/bran",
          "/proj/.ai-writer/lore/characters/aria", // also auto-matched — must not duplicate
        ],
      }
    );
    const snippets = bundle.loreSnippets.split("\n\n---\n\n");
    expect(snippets).toHaveLength(2);
    expect(snippets[0]).toContain("Bran is a smith.");
    expect(snippets[1]).toContain("Aria is a bard.");
  });

  it("tolerates missing entity files (snippet omitted, no throw)", async () => {
    files.delete("/proj/.ai-writer/lore/characters/aria/index.md");
    const bundle = await assembleContext("SYS", makeLoreIndex(), "Aria sang.", "", "Continue.");
    expect(bundle.loreSnippets).toBe("");
  });

  it("caps recent context and cuts it before the selection", async () => {
    const filler = "x".repeat(5000);
    const doc = `${filler}NEEDLE selected-text tail`;
    const bundle = await assembleContext(
      "SYS",
      makeLoreIndex(),
      doc,
      "selected-text",
      "Rewrite."
    );
    // recent context ends right before the selection…
    expect(bundle.recentContext.endsWith("NEEDLE")).toBe(true);
    expect(bundle.recentContext).not.toContain("selected-text");
    // …and is capped at 800 tokens * 3 chars
    expect(bundle.recentContext.length).toBeLessThanOrEqual(800 * 3);
  });

  it("slices recent context exactly before the selection when given source offsets", async () => {
    const doc = "AAA before-text BBB target CCC after";
    const from = doc.indexOf("target");
    const to = from + "target".length;
    const bundle = await assembleContext(
      "SYS", makeLoreIndex(), doc, "target", "Rewrite.",
      undefined,
      { from, to },
    );
    expect(bundle.recentContext.endsWith("BBB")).toBe(true);
    expect(bundle.recentContext).not.toContain("target");
    expect(bundle.recentContext).not.toContain("after"); // never the doc tail
  });

  it("locates a preview-style selection (missing markdown markup) via normalized match", async () => {
    // Source has bold markers + a list bullet the rendered selection lacks.
    const doc = "开头的一段前文。\n\n- **目标段落的标题** 后面还有正文 BBB";
    const rendered = "目标段落的标题"; // as copied from the preview pane
    const bundle = await assembleContext(
      "SYS", makeLoreIndex(), doc, rendered, "Rewrite.",
    );
    expect(bundle.recentContext).toContain("开头的一段前文");
    expect(bundle.recentContext).not.toContain("目标段落的标题");
    expect(bundle.recentContext).not.toContain("BBB"); // still never the tail
  });

  it("does NOT fall back to the document tail when the selection can't be located", async () => {
    // Rendered/preview selection that doesn't appear verbatim in the source.
    const doc = `${"x".repeat(3000)}THE ACTUAL ENDING`;
    const bundle = await assembleContext(
      "SYS", makeLoreIndex(), doc, "rendered text not in source", "Rewrite.",
    );
    expect(bundle.recentContext).toBe("");
    expect(bundle.recentContext).not.toContain("ENDING");
    // The selection itself is still sent as the edit target.
    expect(bundle.taskText).toContain("rendered text not in source");
  });

  it("honours contextChars to bound the reference range (0 = none)", async () => {
    const doc = "PREAMBLE ".repeat(100) + "SELECTED";
    const none = await assembleContext(
      "SYS", makeLoreIndex(), doc, "SELECTED", "Polish.", { contextChars: 0 },
    );
    expect(none.recentContext).toBe("");
    const some = await assembleContext(
      "SYS", makeLoreIndex(), doc, "SELECTED", "Polish.", { contextChars: 20 },
    );
    expect(some.recentContext.length).toBeLessThanOrEqual(20);
    expect(some.recentContext.length).toBeGreaterThan(0);
  });

  it("ignores stale source offsets that no longer match the selection", async () => {
    const doc = "AAA before-text BBB target CCC after";
    // Offsets point somewhere whose text != selection → must fall back to search.
    const bundle = await assembleContext(
      "SYS", makeLoreIndex(), doc, "target", "Rewrite.",
      undefined,
      { from: 0, to: 3 },
    );
    expect(bundle.recentContext.endsWith("BBB")).toBe(true);
  });

  it("builds task text from selection plus extra requirement", async () => {
    const bundle = await assembleContext(
      "SYS",
      makeLoreIndex(),
      "doc",
      "some selection",
      "Polish this.",
      { requirement: "Keep it short." }
    );
    expect(bundle.taskText).toContain("some selection");
    expect(bundle.taskText).toContain("Polish this.");
    expect(bundle.taskText).toContain("Keep it short.");
  });

  it("estimates tokens from total assembled characters", async () => {
    const bundle = await assembleContext("SYS", makeLoreIndex(), "short doc", "", "Go.");
    expect(bundle.estimatedTokens).toBeGreaterThan(0);
  });
});

describe("bundleToMessages", () => {
  it("produces a system message and a layered user message", async () => {
    const bundle = await assembleContext(
      "You are a writing assistant.",
      makeLoreIndex(),
      "Aria sang in Ironhold.",
      "",
      "Continue the story.",
      { outline: "Chapter 2 outline", additionalKnowledge: "Magic is rare." }
    );
    const messages = bundleToMessages(bundle);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "system", content: "You are a writing assistant." });

    const user = messages[1].content;
    // Layer order: lore → knowledge → outline → recent → task
    const idxLore = user.indexOf("【设定资料】");
    const idxKnowledge = user.indexOf("【附加知识】");
    const idxOutline = user.indexOf("【大纲/写作方向】");
    const idxRecent = user.indexOf("【近期内容】");
    const idxTask = user.indexOf("Continue the story.");
    expect(idxLore).toBeGreaterThanOrEqual(0);
    expect(idxKnowledge).toBeGreaterThan(idxLore);
    expect(idxOutline).toBeGreaterThan(idxKnowledge);
    expect(idxRecent).toBeGreaterThan(idxOutline);
    expect(idxTask).toBeGreaterThan(idxRecent);
  });
});
