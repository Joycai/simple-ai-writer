import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  selectLore,
  parsePins,
  galleryNotice,
  DEFAULT_LORE_BUDGET_CHARS,
  GALLERY_BUDGET_SHARE,
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
  return { slot: null, keys: [], group: null, priority: 0, mode: "auto", charCount: 0, ...partial };
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

/**
 * The gallery notice (L0.5).
 *
 * What it guards is a hole, not a feature: an entity used to be injected with
 * no hint that it had pictures at all, so a model holding its whole text had no
 * reason to call read_lore_entity again and never learned the gallery existed.
 * The line is the only thing that closes that — and it must stay *words*, since
 * base64 on every match is the cost read_lore_entity already refuses.
 */
describe("selectLore — gallery notice", () => {
  const withImages = () => {
    const index = makeIndex();
    const aria = index.characters![0] as LoreEntity;
    (aria as { avatarPath: string | null }).avatarPath = `${ARIA}/avatar.png`;
    (aria as { images: LoreEntity["images"] }).images = [
      { file: "portrait.png", desc: "银发，黑色立领窄袖劲装，左手按剑。", slot: "portrait", absPath: `${ARIA}/portrait.png` },
      { file: "scar.png", desc: "", slot: null, absPath: `${ARIA}/scar.png` },
    ] as LoreEntity["images"];
    return index;
  };

  it("names the pictures and what they show, and never carries the pictures", async () => {
    const { text, report } = await selectLore("Aria walked in.", withImages(), []);
    expect(text).toMatch(/配图|Images/);
    expect(text).toContain("avatar.png");
    expect(text).toContain("portrait.png（银发，黑色立领窄袖劲装，左手按剑。）");
    expect(text).toContain("scar.png"); // no description — the filename alone
    expect(text).not.toContain("data:image"); // words, never pixels
    const layer = report.entities[0].layers.find((l) => l.kind === "gallery")!;
    expect(layer.count).toBe(3);
    expect(layer.chars).toBeGreaterThan(0);
  });

  it("sits above the core, not under the last facet", async () => {
    const { text } = await selectLore("Aria walked in.", withImages(), []);
    expect(text.indexOf("portrait.png")).toBeLessThan(text.indexOf("Aria is a bard."));
  });

  it("says nothing at all for an entity with no pictures", async () => {
    const { text, report } = await selectLore("Bran hammered.", makeIndex(), []);
    expect(text).not.toMatch(/配图|Images:/);
    const bran = report.entities.find((e) => e.name === "Bran")!;
    expect(bran.layers.some((l) => l.kind === "gallery")).toBe(false);
    expect(bran.droppedImages).toBeUndefined();
  });

  it("survives a core long enough to eat the whole budget", async () => {
    files.set(`${ARIA}/index.md`, `---\nname: Aria\n---\n${"甲".repeat(5000)}`);
    const { text } = await selectLore("Aria walked in.", withImages(), [], 600);
    expect(text).toContain("portrait.png");
  });

  it("drops the notice — reported — once the gallery share is spent", async () => {
    const index = makeIndex();
    // Every entity carries an identical gallery, so the share runs out part-way.
    for (const e of index.characters!) {
      (e as { images: LoreEntity["images"] }).images = [
        { file: "a.png", desc: "x".repeat(200), slot: null, absPath: `${e.dirPath}/a.png` },
      ] as LoreEntity["images"];
    }
    const budget = 300;
    const { report } = await selectLore("Aria and Bran met.", index, [], budget);
    const injected = report.entities.filter((e) => e.layers.some((l) => l.kind === "gallery"));
    const dropped = report.entities.filter((e) => e.droppedImages);
    expect(injected.length).toBe(1); // one notice fits inside 20% of 300 chars
    expect(dropped.length).toBe(1);
    expect(dropped[0].droppedImages).toBe(1);
    expect(dropped[0].name).toBe("Bran"); // first come, first served
    expect(budget * GALLERY_BUDGET_SHARE).toBeLessThan(2 * 60);
  });

  it("bounds one entity's notice however big its gallery is", () => {
    const many = entity({
      dirPath: ARIA,
      name: "Aria",
      images: Array.from({ length: 30 }, (_, i) => ({
        file: `still-${i}.png`,
        desc: "描述".repeat(60),
        slot: null,
        absPath: `${ARIA}/still-${i}.png`,
      })) as LoreEntity["images"],
    });
    const { text, count } = galleryNotice(many);
    expect(count).toBe(30);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).toContain("still-0.png");
    expect(text).not.toContain("still-29.png");
    expect(text).toMatch(/29|另有|more/);
  });

  it("leaves the image slot out of the injected text (slots never inject)", () => {
    const { text } = galleryNotice(entity({
      dirPath: ARIA,
      name: "Aria",
      images: [{ file: "p.png", desc: "银发", slot: "portrait", absPath: `${ARIA}/p.png` }] as LoreEntity["images"],
    }));
    expect(text).toContain("p.png");
    expect(text).not.toContain("portrait");
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
      slot: null,
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
    const minimal = parseFacetMeta("---\nfacet: 特征\n---\nb", "f.md")!;
    expect(minimal).toMatchObject({ keys: [], group: null, priority: 0, mode: "auto" });
  });
});

/**
 * The facet `slot` field — a facet's place in its category's type schema
 * (docs/lore-entry-type-plan.md). Two things are being pinned here: the value
 * survives a round-trip *including* one no enabled pack declares, and it changes
 * nothing about injection. The second is the invariant the whole "disabling a
 * pack degrades an entry instead of altering it" promise rests on, and it is the
 * kind that breaks silently — no error, just a different prompt.
 */
describe("facet slot (type schema)", () => {
  const meta = (slot?: string) => ({
    title: "外貌", slot, keys: [], group: null, priority: 0, mode: "auto" as const,
  });

  it("round-trips, and keeps a slot no pack declares", () => {
    expect(parseFacetMeta(`---\nfacet: 外貌\nslot: appearance\n---\nTall.`, "a.md")!.slot)
      .toBe("appearance");
    // A slot whose declaring pack is disabled must come back verbatim when it
    // is re-enabled, so the scan may not "clean up" what it can't resolve.
    expect(parseFacetMeta(`---\nfacet: x\nslot: 未知槽位\n---\nb`, "x.md")!.slot)
      .toBe("未知槽位");
    expect(parseFacetMeta(serializeFacetFrontmatter(meta("appearance")) + "\nTall.", "f.md")!.slot)
      .toBe("appearance");
  });

  it("writes nothing at all when unclassified — the absence is the state", () => {
    const bare = serializeFacetFrontmatter(meta());
    expect(bare).not.toContain("slot:");
    expect(parseFacetMeta(bare + "\nTall.", "f.md")!.slot).toBeNull();
  });

  it("changes nothing about what is injected, including an unresolvable slot", async () => {
    const target = "Aria 披上战甲，回想童年。";
    const pins = [`${ARIA}#secret.md`];
    const plain = await selectLore(target, makeIndex(), pins);

    // Same entity, same bodies — every facet classified, on disk as well as in
    // the scanned metadata, one of them into a slot nothing declares.
    const slots: Record<string, string> = {
      "outfit-armor.md": "outfit",
      "outfit-casual.md": "outfit",
      "backstory.md": "backstory",
      "secret.md": "某个未启用能力包的槽位",
      "voice.md": "voice",
    };
    const slotted = makeIndex();
    for (const f of slotted.characters[0].facets) f.slot = slots[f.file] ?? null;
    for (const [file, slot] of Object.entries(slots)) {
      const raw = files.get(`${ARIA}/${file}`)!;
      files.set(`${ARIA}/${file}`, raw.replace("---\nfacet:", `---\nslot: ${slot}\nfacet:`));
    }

    const withSlots = await selectLore(target, slotted, pins);
    expect(withSlots.text).toBe(plain.text);
    expect(withSlots.report).toEqual(plain.report);
  });
});
