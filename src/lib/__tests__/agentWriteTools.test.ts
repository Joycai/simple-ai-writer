/**
 * L1 write-tool tests: backup-before-write, structural validation, and the
 * memory segment-rewrite protocol — all against an in-memory filesystem.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── In-memory filesystem standing in for the Tauri-backed fileio ─────────────
const fs = new Map<string, string>();

vi.mock("../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    if (!fs.has(p)) throw new Error(`ENOENT: ${p}`);
    return fs.get(p)!;
  }),
  writeFile: vi.fn(async (p: string, c: string) => void fs.set(p, c)),
  appendFile: vi.fn(async (p: string, c: string) => void fs.set(p, (fs.get(p) ?? "") + c)),
  writeBinaryFile: vi.fn(async () => {}),
  makeDir: vi.fn(async () => {}),
  fileExists: vi.fn(async (p: string) => fs.has(p)),
  removeDir: vi.fn(async () => {}),
  removeFile: vi.fn(async (p: string) => void fs.delete(p)),
  renamePath: vi.fn(async (a: string, b: string) => {
    fs.set(b, fs.get(a) ?? "");
    fs.delete(a);
  }),
  readDir: vi.fn(async () => []),
}));

import { serializeMemory, type DocMemory } from "../context/memory";
import type { LoreIndex } from "../lore";
import { backupFile } from "../agent/backup";
import { executeRegisteredTool, type ToolContext, type ToolId } from "../agent/registry";

const PROJECT = "/proj";
const ALL_TOOLS: ToolId[] = [
  "read_memory", "create_lore_entity", "update_lore_file", "update_memory",
];

const INDEX_MD = `---\nname: Ava\naliases: []\ncategory: characters\nsummary: "the protagonist"\n---\n\n# Ava\n`;
const FACET_MD = `---\nfacet: "战甲"\nkeys: ["战甲", "板甲"]\n---\n\n她的战甲是黑色的。\n`;

function makeLoreIndex(): LoreIndex {
  return {
    characters: [
      {
        id: "ava",
        category: "characters",
        dirPath: `${PROJECT}/.ai-writer/lore/characters/ava`,
        name: "Ava",
        aliases: ["阿瓦"],
        summary: "the protagonist",
        avatarPath: null,
        mdFiles: ["index.md", "armor.md"],
        images: [],
        facets: [
          { file: "armor.md", title: "战甲", keys: ["战甲"], group: null, priority: 0, mode: "auto", charCount: 10 },
        ],
      },
    ],
  } as unknown as LoreIndex;
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext & {
  loreChanged: number;
  memoryChanged: number;
} {
  const counters = { loreChanged: 0, memoryChanged: 0 };
  return {
    projectPath: PROJECT,
    loreIndex: makeLoreIndex(),
    multimodal: false,
    onLoreChanged: () => void counters.loreChanged++,
    onMemoryChanged: () => void counters.memoryChanged++,
    get loreChanged() { return counters.loreChanged; },
    get memoryChanged() { return counters.memoryChanged; },
    ...overrides,
  };
}

function run(name: ToolId, args: object, ctx: ToolContext) {
  return executeRegisteredTool(
    { id: "t1", name, arguments: JSON.stringify(args) },
    ALL_TOOLS,
    ctx,
  );
}

const backupsOf = () =>
  [...fs.keys()].filter((p) => p.startsWith(`${PROJECT}/.ai-writer/backups/`));

beforeEach(() => {
  fs.clear();
  fs.set(`${PROJECT}/.ai-writer/lore/characters/ava/index.md`, INDEX_MD);
  fs.set(`${PROJECT}/.ai-writer/lore/characters/ava/armor.md`, FACET_MD);
});

// ─── backupFile ──────────────────────────────────────────────────────────────

describe("backupFile", () => {
  it("snapshots an existing file into .ai-writer/backups", async () => {
    const src = `${PROJECT}/.ai-writer/lore/characters/ava/index.md`;
    const dest = await backupFile(PROJECT, src);
    expect(dest).toMatch(/\.ai-writer\/backups\/agent-\d+-\.ai-writer-lore-characters-ava-index\.md$/);
    expect(fs.get(dest!)).toBe(INDEX_MD);
  });

  it("returns null for a file that does not exist yet", async () => {
    expect(await backupFile(PROJECT, `${PROJECT}/nope.md`)).toBeNull();
  });
});

// ─── create_lore_entity ──────────────────────────────────────────────────────

describe("create_lore_entity", () => {
  it("creates a new entity with generated frontmatter and fires the refresh hook", async () => {
    const ctx = makeCtx();
    const res = await run("create_lore_entity", {
      name: "Kael", category: "characters", summary: "the rival",
      aliases: ["凯尔"], content: "# Kael\n\nA rival swordsman.",
    }, ctx);

    expect(res.content).toContain("Created lore entity");
    const written = fs.get(`${PROJECT}/.ai-writer/lore/characters/kael/index.md`);
    expect(written).toContain('name: Kael');
    expect(written).toContain('"凯尔"');
    expect(written).toContain("A rival swordsman.");
    expect(ctx.loreChanged).toBe(1);
  });

  it("rejects a duplicate name (also via alias) and an unknown category", async () => {
    const ctx = makeCtx();
    const dup = await run("create_lore_entity", {
      name: "阿瓦", category: "characters", summary: "x", content: "y",
    }, ctx);
    expect(dup.content).toContain("already exists");

    const badCat = await run("create_lore_entity", {
      name: "New", category: "nope", summary: "x", content: "y",
    }, ctx);
    expect(badCat.content).toContain("'category' must be one of");
    expect(ctx.loreChanged).toBe(0);
  });
});

// ─── update_lore_file ────────────────────────────────────────────────────────

describe("update_lore_file", () => {
  const NEW_INDEX = `---\nname: Ava\naliases: []\ncategory: characters\nsummary: "now a queen"\n---\n\n# Ava\n\nCrowned in book two.\n`;

  it("backs up then overwrites index.md and fires the refresh hook", async () => {
    const ctx = makeCtx();
    const res = await run("update_lore_file", { entity: "Ava", content: NEW_INDEX }, ctx);

    expect(res.content).toContain("backed up to");
    expect(fs.get(`${PROJECT}/.ai-writer/lore/characters/ava/index.md`)).toBe(NEW_INDEX);
    const backups = backupsOf();
    expect(backups).toHaveLength(1);
    expect(fs.get(backups[0])).toBe(INDEX_MD); // the original survived
    expect(ctx.loreChanged).toBe(1);
  });

  it("rejects index.md without frontmatter name, leaving the file untouched", async () => {
    const ctx = makeCtx();
    const res = await run("update_lore_file", { entity: "Ava", content: "# Ava\n\nno frontmatter" }, ctx);
    expect(res.content).toContain("frontmatter");
    expect(fs.get(`${PROJECT}/.ai-writer/lore/characters/ava/index.md`)).toBe(INDEX_MD);
    expect(backupsOf()).toHaveLength(0);
    expect(ctx.loreChanged).toBe(0);
  });

  it("rejects a category change through index.md", async () => {
    const res = await run("update_lore_file", {
      entity: "Ava",
      content: `---\nname: Ava\ncategory: world\nsummary: "x"\n---\nbody`,
    }, makeCtx());
    expect(res.content).toContain("changing the category");
  });

  it("keeps facet files facets — content without facet frontmatter is rejected", async () => {
    const ctx = makeCtx();
    const bad = await run("update_lore_file", { entity: "Ava", file: "armor.md", content: "plain text" }, ctx);
    expect(bad.content).toContain("facet");
    expect(fs.get(`${PROJECT}/.ai-writer/lore/characters/ava/armor.md`)).toBe(FACET_MD);

    const good = await run("update_lore_file", {
      entity: "Ava", file: "armor.md",
      content: `---\nfacet: "战甲"\nkeys: ["战甲"]\n---\n\n升级为银色。`,
    }, ctx);
    expect(good.content).toContain("backed up");
    expect(fs.get(`${PROJECT}/.ai-writer/lore/characters/ava/armor.md`)).toContain("银色");
  });

  it("refuses path traversal, non-md files, and images.md", async () => {
    const ctx = makeCtx();
    for (const file of ["../evil.md", "sub/evil.md", "note.txt", "images.md"]) {
      const res = await run("update_lore_file", { entity: "Ava", file, content: "x" }, ctx);
      expect(res.content).toMatch(/^Error/);
    }
    expect(ctx.loreChanged).toBe(0);
  });

  it("creates a brand-new attachment file without requiring a backup", async () => {
    const res = await run("update_lore_file", {
      entity: "Ava", file: "history.md", content: "Her early years…",
    }, makeCtx());
    expect(res.content).toContain("new file");
    expect(fs.get(`${PROJECT}/.ai-writer/lore/characters/ava/history.md`)).toBe("Her early years…");
  });
});

// ─── read_memory / update_memory ─────────────────────────────────────────────

describe("read_memory / update_memory", () => {
  const DOC = `${PROJECT}/writing/ch1.md`;
  const MEMORY: DocMemory = {
    sourcePath: "writing/ch1.md",
    coveredChars: 200,
    updatedAt: "2026-07-01T00:00:00.000Z",
    segments: [
      { from: 0, to: 100, hash: "aaaa0000", summary: "Ava leaves home." },
      { from: 100, to: 200, hash: "bbbb1111", summary: "Ava meets Kael." },
    ],
  };

  beforeEach(() => {
    fs.set(`${PROJECT}/.ai-writer/memory/writing/ch1.md`, serializeMemory(MEMORY));
  });

  it("read_memory lists segments with indices and ranges", async () => {
    const res = await run("read_memory", { path: DOC }, makeCtx());
    expect(res.content).toContain("[segment 0] chars 0–100");
    expect(res.content).toContain("Ava meets Kael.");
  });

  it("update_memory rewrites one summary, keeps ranges/hashes, backs up first", async () => {
    const ctx = makeCtx();
    const res = await run("update_memory", {
      path: DOC, segment_index: 1, summary: "Ava befriends Kael instead.",
    }, ctx);

    expect(res.content).toContain("Updated memory segment 1");
    expect(res.content).toContain("backed up to");
    expect(ctx.memoryChanged).toBe(1);

    const raw = fs.get(`${PROJECT}/.ai-writer/memory/writing/ch1.md`)!;
    expect(raw).toContain("Ava befriends Kael instead.");
    expect(raw).toContain("Ava leaves home."); // other segment untouched
    expect(raw).toContain('"hash":"bbbb1111"'); // protocol preserved
    expect(fs.get(backupsOf()[0])).toContain("Ava meets Kael."); // original recoverable
  });

  it("update_memory errors on a bad index and on documents without memory", async () => {
    const bad = await run("update_memory", { path: DOC, segment_index: 9, summary: "x" }, makeCtx());
    expect(bad.content).toContain("out of range");

    const none = await run("update_memory", {
      path: `${PROJECT}/writing/ch2.md`, segment_index: 0, summary: "x",
    }, makeCtx());
    expect(none.content).toContain("No story memory");
  });

  it("rejects paths outside the project", async () => {
    const res = await run("read_memory", { path: "/elsewhere/ch1.md" }, makeCtx());
    expect(res.content).toContain("outside the project");
  });
});
