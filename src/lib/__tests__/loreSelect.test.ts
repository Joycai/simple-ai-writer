import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  selectLore,
  parsePins,
  DEFAULT_LORE_BUDGET_CHARS,
} from "../context/loreSelect";
import { parseFacetMeta, serializeFacetFrontmatter } from "../lore/entity";
import type { LoreEntity, LoreFacet, LoreIndex } from "../lore";

// Mock file I/O so entity/facet bodies load without a Tauri backend.
// entity.ts (imported for parseFacetMeta) destructures more names than
// loreSelect uses, so every export it touches must exist on the mock.
const files = new Map<string, string>();
vi.mock("../fs/fileio", () => ({
  readFile: async (path: string) => {
    const content = files.get(path);
    if (content == null) throw new Error(`no such file: ${path}`);
    return content;
  },
  writeFile: vi.fn(),
  writeBinaryFile: vi.fn(),
  readDir: vi.fn(),
  makeDir: vi.fn(),
  fileExists: vi.fn(),
  renamePath: vi.fn(),
  removeFile: vi.fn(),
}));

const ARIA = "/proj/.ai-writer/lore/characters/aria";

function facet(partial: Partial<LoreFacet> & { file: string; title: string }): LoreFacet {
  return { keys: [], group: null, priority: 0, mode: "auto", charCount: 0, ...partial };
}

function entity(partial: Partial<LoreEntity> & { dirPath: string; name: string }): LoreEntity {
  return {
    id: partial.dirPath.split("/").pop()!,
    category: "characters",
    aliases: [],
    summary: "",
    avatarPath: null,
    mdFiles: [],
    images: [],
    facets: [],
    ...partial,
  } as LoreEntity;
}

function makeIndex(): LoreIndex {
  return {
    characters: [
      entity({
        dirPath: ARIA,
        name: "Aria",
        aliases: ["the Songbird"],
        summary: "北境骑士团副团长",
        facets: [
          facet({ file: "outfit-armor.md", title: "战甲形象", keys: ["战甲", "battle"], group: "outfit", priority: 2 }),
          facet({ file: "outfit-casual.md", title: "便装形象", keys: ["便装", "tavern"], group: "outfit", priority: 1 }),
          facet({ file: "backstory.md", title: "背景故事", keys: ["童年"] }),
          facet({ file: "secret.md", title: "隐藏设定", mode: "manual" }),
          facet({ file: "voice.md", title: "语言习惯", mode: "always" }),
        ],
      }),
      entity({ dirPath: "/proj/.ai-writer/lore/characters/bran", name: "Bran" }),
    ],
  };
}

beforeEach(() => {
  files.clear();
  files.set(`${ARIA}/index.md`, "---\nname: Aria\n---\nAria is a bard.");
  files.set(`${ARIA}/outfit-armor.md`, "---\nfacet: 战甲形象\n---\nSilver plate armor.");
  files.set(`${ARIA}/outfit-casual.md`, "---\nfacet: 便装形象\n---\nLinen dress.");
  files.set(`${ARIA}/backstory.md`, "---\nfacet: 背景故事\n---\nOrphaned young.");
  files.set(`${ARIA}/secret.md`, "---\nfacet: 隐藏设定\n---\nShe is the lost heir.");
  files.set(`${ARIA}/voice.md`, "---\nfacet: 语言习惯\n---\nSpeaks tersely.");
  files.set("/proj/.ai-writer/lore/characters/bran/index.md", "Bran is a smith.");
});

describe("selectLore — layered activation", () => {
  it("injects summary + core for a matched entity; facets stay out without keys", async () => {
    const { text, report } = await selectLore("Aria walked in.", makeIndex(), []);
    expect(text).toContain("## Aria");
    expect(text).toContain("北境骑士团副团长");
    expect(text).toContain("Aria is a bard.");
    expect(text).not.toContain("Silver plate armor.");
    expect(text).not.toContain("Orphaned young.");
    // always-mode facet rides along with the entity match
    expect(text).toContain("Speaks tersely.");
    // manual-mode facet never auto-fires
    expect(text).not.toContain("lost heir");
    const aria = report.entities.find((e) => e.name === "Aria")!;
    expect(aria.droppedFacets).toContainEqual({ file: "secret.md", title: "隐藏设定", reason: "manual-only" });
    expect(aria.droppedFacets.some((d) => d.file === "backstory.md" && d.reason === "no-key")).toBe(true);
  });

  it("activates a facet via secondary key AND entity match (frontmatter stripped)", async () => {
    const { text, report } = await selectLore("Aria drew her sword for battle.", makeIndex(), []);
    expect(text).toContain("### 战甲形象");
    expect(text).toContain("Silver plate armor.");
    expect(text).not.toContain("facet: 战甲形象"); // frontmatter must not leak
    const aria = report.entities.find((e) => e.name === "Aria")!;
    const armor = aria.layers.find((l) => l.file === "outfit-armor.md")!;
    expect(armor.matchedKeys).toEqual(["battle"]);
  });

  it("does NOT activate facets when only the key matches but the entity doesn't", async () => {
    const { text } = await selectLore("A battle raged somewhere.", makeIndex(), []);
    expect(text).not.toContain("Silver plate armor.");
    expect(text).not.toContain("## Aria");
  });

  it("resolves same-group conflicts by priority with a deterministic tie-break", async () => {
    // Both outfit keys present — armor (priority 2) must win over casual (1).
    const { text, report } = await selectLore("Aria left the tavern for battle.", makeIndex(), []);
    expect(text).toContain("Silver plate armor.");
    expect(text).not.toContain("Linen dress.");
    const aria = report.entities.find((e) => e.name === "Aria")!;
    expect(aria.droppedFacets).toContainEqual({ file: "outfit-casual.md", title: "便装形象", reason: "group-lost" });
  });

  it("lets pins override group exclusion — two pinned same-group facets both inject", async () => {
    const { text } = await selectLore("Aria changes clothes.", makeIndex(), [
      `${ARIA}#outfit-armor.md`,
      `${ARIA}#outfit-casual.md`,
    ]);
    expect(text).toContain("Silver plate armor.");
    expect(text).toContain("Linen dress.");
  });

  it("facet pin implies its entity: summary + core ride along", async () => {
    // Match target mentions nobody — only the pin brings Aria in.
    const { text, report } = await selectLore("A quiet morning.", makeIndex(), [
      `${ARIA}#secret.md`,
    ]);
    expect(text).toContain("## Aria");
    expect(text).toContain("Aria is a bard.");
    expect(text).toContain("She is the lost heir."); // manual facet, pinned in
    expect(report.entities[0].reason).toBe("pinned");
  });

  it("skips stale pins whose entity no longer exists", async () => {
    const { text, report } = await selectLore("Nothing here.", makeIndex(), [
      "/proj/.ai-writer/lore/characters/deleted",
    ]);
    expect(text).toBe("");
    expect(report.entities).toHaveLength(0);
  });

  it("skips a facet pin whose facet file was deleted — no invisible entity pin", async () => {
    const { text, report } = await selectLore("Nothing here.", makeIndex(), [
      `${ARIA}#deleted-facet.md`,
    ]);
    expect(text).toBe("");
    expect(report.entities).toHaveLength(0);
  });

  it("treats a raw pin matching an entity dirPath verbatim as an entity pin even with '#' in the path", async () => {
    const dir = "/proj/.ai-writer/lore/characters/route_#7";
    const index: LoreIndex = {
      characters: [entity({ dirPath: dir, name: "Route Seven" })],
    };
    files.set(`${dir}/index.md`, "A haunted road.");
    const { text, report } = await selectLore("Nothing here.", index, [dir]);
    expect(text).toContain("A haunted road.");
    expect(report.entities[0].reason).toBe("pinned");
  });

  it("drops a facet whole when it exceeds the remaining budget (never truncates)", async () => {
    files.set(`${ARIA}/outfit-armor.md`, `---\nfacet: 战甲形象\n---\n${"甲".repeat(5000)}`);
    const budget = 200 + "Aria is a bard.".length + 60;
    const { text, report } = await selectLore("Aria rode to battle.", makeIndex(), [], budget);
    expect(text).toContain("Aria is a bard.");
    expect(text).not.toContain("甲甲甲");
    const aria = report.entities.find((e) => e.name === "Aria")!;
    expect(aria.droppedFacets.some((d) => d.file === "outfit-armor.md" && d.reason === "budget")).toBe(true);
  });

  it("truncates an oversized core at a paragraph boundary", async () => {
    files.set(`${ARIA}/index.md`, `para one.\n\n${"long ".repeat(500)}`);
    const { text, report } = await selectLore("Aria smiled.", makeIndex(), [], 120);
    expect(text).toContain("para one.");
    expect(text).not.toContain("long long");
    const core = report.entities[0].layers.find((l) => l.kind === "core")!;
    expect(core.truncated).toBe(true);
  });

  it("keeps summaries even when the budget is exhausted (L0 guarantee)", async () => {
    const { text } = await selectLore("Aria smiled.", makeIndex(), [], 10);
    expect(text).toContain("北境骑士团副团长");
  });

  it("handles legacy entities without facet fields (regression guard)", async () => {
    const index = {
      characters: [
        { name: "Bran", aliases: [], dirPath: "/proj/.ai-writer/lore/characters/bran" },
      ],
    } as unknown as LoreIndex;
    const { text } = await selectLore("Bran hammered.", index, []);
    expect(text).toContain("Bran is a smith.");
  });

  it("reports budget accounting", async () => {
    const { report } = await selectLore("Aria smiled.", makeIndex(), []);
    expect(report.budgetChars).toBe(DEFAULT_LORE_BUDGET_CHARS);
    expect(report.usedChars).toBeGreaterThan(0);
    expect(report.usedChars).toBeLessThanOrEqual(DEFAULT_LORE_BUDGET_CHARS);
  });
});

describe("parsePins", () => {
  it("parses bare dirPaths and dirPath#facet forms", () => {
    expect(parsePins(["/a/b", "/a/b#outfit.md"])).toEqual([
      { dirPath: "/a/b", facetFile: null },
      { dirPath: "/a/b", facetFile: "outfit.md" },
    ]);
  });
});

describe("parseFacetMeta", () => {
  it("parses a full facet frontmatter", () => {
    const raw = `---\nfacet: 战甲形象\nkeys: [战甲, 板甲]\ngroup: outfit\npriority: 2\nmode: manual\n---\nBody text.`;
    expect(parseFacetMeta(raw, "outfit-armor.md")).toEqual({
      file: "outfit-armor.md",
      title: "战甲形象",
      keys: ["战甲", "板甲"],
      group: "outfit",
      priority: 2,
      mode: "manual",
      charCount: "Body text.".length,
    });
  });

  it("round-trips a title/group that would otherwise parse as JSON, and apostrophe keys", () => {
    const meta = {
      title: "[1]",
      keys: ["a, b", "Zoe's"],
      group: "[x]",
      priority: 0,
      mode: "auto" as const,
    };
    const parsed = parseFacetMeta(serializeFacetFrontmatter(meta) + "\nB.", "f.md")!;
    expect(parsed.title).toBe("[1]");
    expect(parsed.keys).toEqual(["a, b", "Zoe's"]);
    expect(parsed.group).toBe("[x]");
  });

  it("round-trips through serializeFacetFrontmatter (CJK keys, commas, quotes)", () => {
    const meta = {
      title: "战甲形象",
      keys: ["战甲", "plate, armor", '带"引号"的'],
      group: "outfit",
      priority: 2,
      mode: "manual" as const,
    };
    const raw = serializeFacetFrontmatter(meta) + "\nBody.";
    const parsed = parseFacetMeta(raw, "f.md")!;
    expect(parsed.title).toBe(meta.title);
    expect(parsed.keys).toEqual(meta.keys);
    expect(parsed.group).toBe("outfit");
    expect(parsed.priority).toBe(2);
    expect(parsed.mode).toBe("manual");
    expect(parsed.charCount).toBe("Body.".length);
  });

  it("returns null for non-facet files and defaults partial frontmatter", () => {
    expect(parseFacetMeta("just an attachment", "notes.md")).toBeNull();
    expect(parseFacetMeta("---\nname: x\n---\nbody", "notes.md")).toBeNull();
    const minimal = parseFacetMeta("---\nfacet: 侧面\n---\nb", "f.md")!;
    expect(minimal).toMatchObject({ keys: [], group: null, priority: 0, mode: "auto" });
  });
});
