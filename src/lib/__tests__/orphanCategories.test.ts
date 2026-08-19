/**
 * Orphan categories — a lore folder no enabled pack (nor user category)
 * declares, i.e. what disabling a capability pack leaves behind.
 *
 * Before this, `scanLore` walked only the merged category list, so those entries
 * vanished from every surface at once while their folders sat untouched on disk.
 * They are now scanned and listed, and the pinned-down part is the asymmetry:
 * an orphan is an answer to "what is there?" and never to "where may this go?".
 *
 * See docs/lore-entry-type-plan.md §5 and lib/lore/categories.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dirs = new Map<string, { name: string; isDirectory: boolean }[]>();
const files = new Map<string, string>();

vi.mock("../fs/fileio", () => ({
  readDir: async (path: string) => {
    const entries = dirs.get(path);
    if (!entries) throw new Error(`no such directory: ${path}`);
    return entries;
  },
  readFile: async (path: string) => {
    const content = files.get(path);
    if (content == null) throw new Error(`no such file: ${path}`);
    return content;
  },
  fileExists: async (path: string) => files.has(path) || dirs.has(path),
  writeFile: vi.fn(),
  writeBinaryFile: vi.fn(),
  makeDir: vi.fn(),
  renamePath: vi.fn(),
  removeFile: vi.fn(),
}));

import { assignableCategories, indexCategories, scanLore, type LoreIndex } from "../lore";
import { NOVEL_PROFILE, isKnownCategory, resetActiveWorkspace } from "../profile";

const ROOT = "/proj";
const LORE = `${ROOT}/.ai-writer/lore`;

/** Lay out `.ai-writer/lore/<category>/<entity>/index.md` for a whole project. */
function layout(tree: Record<string, string[]>): void {
  dirs.set(LORE, Object.keys(tree).map((name) => ({ name, isDirectory: true })));
  for (const [category, entities] of Object.entries(tree)) {
    dirs.set(`${LORE}/${category}`, entities.map((name) => ({ name, isDirectory: true })));
    for (const entity of entities) {
      const dir = `${LORE}/${category}/${entity}`;
      dirs.set(dir, [{ name: "index.md", isDirectory: false }]);
      files.set(`${dir}/index.md`, `---\nname: ${entity}\n---\nbody`);
    }
  }
}

beforeEach(() => {
  dirs.clear();
  files.clear();
  resetActiveWorkspace(); // the novel pack alone
});

describe("scanLore — orphan folders", () => {
  it("scans a folder no enabled pack declares, keyed by its folder name", async () => {
    // `npcs` belongs to the TTRPG pack, which this project no longer enables.
    layout({ characters: ["aria"], npcs: ["guard", "innkeeper"] });
    const index = await scanLore(ROOT);

    expect(index.npcs.map((e) => e.id)).toEqual(["guard", "innkeeper"]);
    // The category an entry reports is where it lives, exactly as for a
    // declared one — nothing was moved or relabelled to make it listable.
    expect(index.npcs.every((e) => e.category === "npcs")).toBe(true);
    expect(index.npcs[0].dirPath).toBe(`${LORE}/npcs/guard`);
    expect(index.characters.map((e) => e.id)).toEqual(["aria"]);
  });

  it("ignores an empty orphan folder, but keeps every declared category", async () => {
    layout({ characters: [], leftovers: [] });
    const index = await scanLore(ROOT);

    // A declared category is a filter the author can still see; an empty
    // undeclared folder is a phantom nothing can fill (no new entry may be
    // created in an orphan), so it stays out.
    expect(index.characters).toEqual([]);
    expect(index.world).toEqual([]);
    expect("leftovers" in index).toBe(false);
  });

  it("does not re-add a declared category under different casing", async () => {
    // A case-insensitive filesystem reports the folder as it was created; it is
    // the same directory the declared pass already read.
    layout({ Characters: ["aria"] });
    const index = await scanLore(ROOT);
    expect("Characters" in index).toBe(false);
    // Read through the declared id — same directory, one key.
    expect(Object.keys(index).filter((k) => k.toLowerCase() === "characters")).toEqual([
      "characters",
    ]);
  });

  it("survives a project with no lore directory at all", async () => {
    const index = await scanLore(ROOT);
    expect(index.characters).toEqual([]);
    expect(Object.keys(index)).toEqual(NOVEL_PROFILE.categories.map((c) => c.id).concat("custom"));
  });
});

describe("indexCategories", () => {
  const index = (): LoreIndex => ({
    characters: [],
    zeta: [],
    npcs: [],
  });

  it("lists the workspace's categories first, then orphans sorted by id", async () => {
    const cats = indexCategories(index());
    const ids = cats.map((c) => c.id);
    expect(ids.slice(0, NOVEL_PROFILE.categories.length)).toEqual(
      NOVEL_PROFILE.categories.map((c) => c.id),
    );
    // Sorted rather than left in index order: index order is readDir order,
    // which differs per filesystem, and the wall's card order comes from this.
    expect(ids.slice(-2)).toEqual(["npcs", "zeta"]);
    expect(cats.filter((c) => c.orphan).map((c) => c.id)).toEqual(["npcs", "zeta"]);
  });

  it("labels an orphan by its folder id and gives it no type schema", () => {
    const cats = indexCategories(index());
    const npcs = cats.find((c) => c.id === "npcs")!;
    expect(npcs.labelZh).toBe("npcs");
    expect(npcs.labelEn).toBe("npcs");
    // The degraded state: no slots, because the pack that declared them is off.
    expect(npcs.slots).toBeUndefined();
    const characters = cats.find((c) => c.id === "characters")!;
    expect(characters.orphan).toBe(false);
    expect(characters.slots?.length).toBeGreaterThan(0);
  });

  it("enumerates exactly what the index holds — what the author sees is what the model gets", () => {
    // The regression this file exists for: injection walks the index itself
    // (`Object.values`), so any surface enumerating fewer categories would hide
    // entries that are still reaching the prompt.
    const full: LoreIndex = {
      characters: [{ dirPath: "a" } as never],
      npcs: [{ dirPath: "b" } as never, { dirPath: "c" } as never],
    };
    const viaCategories = indexCategories(full).flatMap((c) => full[c.id] ?? []);
    expect(viaCategories).toHaveLength(Object.values(full).flat().length);
  });
});

describe("assignableCategories — the other question", () => {
  it("offers only the workspace's categories by default", () => {
    expect(assignableCategories().map((c) => c.id)).toEqual([
      ...NOVEL_PROFILE.categories.map((c) => c.id),
      "custom",
    ]);
    expect(assignableCategories("characters").map((c) => c.id)).not.toContain("npcs");
  });

  it("adds the entry's own orphan category so a picker can show where it is", () => {
    const ids = assignableCategories("npcs").map((c) => c.id);
    expect(ids).toContain("npcs");
    expect(ids[ids.length - 1]).toBe("npcs");
    // Only *that* orphan: moving into one the workspace can't create stays out.
    expect(assignableCategories("npcs").filter((c) => c.orphan).map((c) => c.id)).toEqual(["npcs"]);
  });

  it("leaves the write guard alone — an orphan is never a creation target", () => {
    // `isKnownCategory` is what every path turning model- or author-supplied
    // text into a directory goes through; listing an orphan must not widen it.
    expect(isKnownCategory("npcs")).toBe(false);
    expect(isKnownCategory("characters")).toBe(true);
  });
});
