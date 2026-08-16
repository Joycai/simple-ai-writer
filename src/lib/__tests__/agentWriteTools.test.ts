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
  // Handles both files and directories — the lore move/delete tools rename
  // whole entity folders, so every key under the prefix has to travel.
  renamePath: vi.fn(async (a: string, b: string) => {
    if (fs.has(a)) {
      fs.set(b, fs.get(a)!);
      fs.delete(a);
      return;
    }
    for (const key of [...fs.keys()]) {
      if (!key.startsWith(a + "/")) continue;
      fs.set(b + key.slice(a.length), fs.get(key)!);
      fs.delete(key);
    }
  }),
  // One level of listing, derived from the flat path map — the chapter tools
  // use it to tell "missing" from "exists" from "is a folder".
  readDir: vi.fn(async (dir: string) => {
    const prefix = dir.replace(/\/+$/, "") + "/";
    const seen = new Map<string, boolean>(); // name → isDirectory
    for (const path of fs.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const cut = rest.indexOf("/");
      if (cut < 0) seen.set(rest, false);
      else seen.set(rest.slice(0, cut), true);
    }
    return [...seen].map(([name, isDirectory]) => ({
      name,
      path: prefix + name,
      isDirectory,
    }));
  }),
}));

import { serializeMemory, type DocMemory } from "../context/memory";
import type { LoreIndex } from "../lore";
import { backupFile } from "../agent/backup";
import { createPlanGate, type LorePlan, type LorePlanStep } from "../agent/plan";
import { executeRegisteredTool, type ToolContext, type ToolId } from "../agent/registry";

const PROJECT = "/proj";
const ALL_TOOLS: ToolId[] = [
  "read_memory", "propose_lore_plan", "create_lore_entity", "update_lore_file",
  "update_facet_meta", "delete_lore_file", "move_lore_entity", "delete_lore_entity",
  "update_memory", "propose_edit",
  "create_chapter", "create_file", "create_directory", "move_chapter", "copy_file", "delete_chapter",
];

/**
 * Standing approval broad enough that the write-tool tests exercise the tools
 * rather than the gate — the gate's own refusals are tested separately.
 */
const OPEN_PLAN: LorePlanStep[] = [
  { action: "create", entity: "Kael", detail: "add the rival" },
  { action: "update", entity: "Ava", detail: "revise the entry" },
  { action: "move", entity: "Ava", detail: "recategorize" },
  { action: "delete", entity: "Ava", detail: "remove the duplicate" },
  { action: "delete", entity: "Ava", file: "armor.md", detail: "retire the armor facet" },
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
  const gate = createPlanGate();
  gate.steps.push(...OPEN_PLAN);
  return {
    projectPath: PROJECT,
    loreIndex: makeLoreIndex(),
    multimodal: false,
    lorePlan: gate,
    requestPlanApproval: async () => ({ approved: true }),
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

// ─── update_facet_meta ───────────────────────────────────────────────────────

describe("update_facet_meta", () => {
  const ARMOR = `${PROJECT}/.ai-writer/lore/characters/ava/armor.md`;

  it("rewrites only the frontmatter, carrying the body through verbatim", async () => {
    const ctx = makeCtx();
    const res = await run("update_facet_meta", {
      entity: "Ava", file: "armor.md",
      keys: ["战甲", "板甲", "银甲"], group: "outfit", priority: 2, mode: "always",
    }, ctx);

    expect(res.content).toContain("keys=[战甲, 板甲, 银甲]");
    expect(res.content).toContain("group=outfit");
    expect(res.content).toContain("mode=always");
    const written = fs.get(ARMOR)!;
    expect(written).toContain('facet: "战甲"');       // untouched field kept
    expect(written).toContain('group: "outfit"');
    expect(written).toContain("priority: 2");
    expect(written).toContain("mode: always");
    expect(written).toContain("她的战甲是黑色的。");   // body survived byte-for-byte
    expect(fs.get(backupsOf()[0])).toBe(FACET_MD);
    expect(ctx.loreChanged).toBe(1);
  });

  it("leaves omitted fields alone and can clear a group", async () => {
    const ctx = makeCtx();
    await run("update_facet_meta", { entity: "Ava", file: "armor.md", group: "outfit" }, ctx);
    await run("update_facet_meta", { entity: "Ava", file: "armor.md", title: "银甲" }, ctx);

    const written = fs.get(ARMOR)!;
    expect(written).toContain('facet: "银甲"');
    expect(written).toContain('group: "outfit"'); // survived the second call
    expect(written).toContain('keys: ["战甲", "板甲"]');

    const cleared = await run("update_facet_meta", { entity: "Ava", file: "armor.md", group: "" }, ctx);
    expect(cleared.content).toContain("group=none");
    expect(fs.get(ARMOR)).not.toContain("group:");
  });

  it("warns when the new metadata makes the facet unreachable", async () => {
    const res = await run("update_facet_meta", { entity: "Ava", file: "armor.md", keys: [] }, makeCtx());
    expect(res.content).toContain("will never be injected");
  });

  it("refuses index.md, non-facet files, unknown files and empty edits", async () => {
    const ctx = makeCtx();
    fs.set(`${PROJECT}/.ai-writer/lore/characters/ava/notes.md`, "just an attachment");

    const reserved = await run("update_facet_meta", { entity: "Ava", file: "index.md", title: "x" }, ctx);
    expect(reserved.content).toContain("app-managed");

    const inert = await run("update_facet_meta", { entity: "Ava", file: "notes.md", title: "x" }, ctx);
    expect(inert.content).toContain("is not a facet");

    const missing = await run("update_facet_meta", { entity: "Ava", file: "ghost.md", title: "x" }, ctx);
    expect(missing.content).toContain("does not exist");

    const noop = await run("update_facet_meta", { entity: "Ava", file: "armor.md" }, ctx);
    expect(noop.content).toContain("at least one of");

    const escape = await run("update_facet_meta", { entity: "Ava", file: "../evil.md", title: "x" }, ctx);
    expect(escape.content).toContain("plain .md filename");

    expect(fs.get(ARMOR)).toBe(FACET_MD);
    expect(ctx.loreChanged).toBe(0);
  });
});

// ─── delete_lore_file ────────────────────────────────────────────────────────

describe("delete_lore_file", () => {
  const ARMOR = `${PROJECT}/.ai-writer/lore/characters/ava/armor.md`;

  it("backs up then removes one facet, leaving the entity intact", async () => {
    const ctx = makeCtx();
    const res = await run("delete_lore_file", {
      entity: "Ava", file: "armor.md", reason: "merged into index",
    }, ctx);

    expect(res.content).toContain("Deleted armor.md");
    expect(fs.has(ARMOR)).toBe(false);
    expect(fs.get(`${PROJECT}/.ai-writer/lore/characters/ava/index.md`)).toBe(INDEX_MD);
    expect(fs.get(backupsOf()[0])).toBe(FACET_MD); // recoverable
    // The run snapshot forgets it, so a later call in the same run sees reality.
    expect(ctx.loreIndex.characters[0].facets).toHaveLength(0);
    expect(ctx.loreIndex.characters[0].mdFiles).toEqual(["index.md"]);
    expect(ctx.loreChanged).toBe(1);
  });

  it("refuses index.md / images.md and reports a file that is not there", async () => {
    const ctx = makeCtx();
    for (const file of ["index.md", "images.md"]) {
      const res = await run("delete_lore_file", { entity: "Ava", file }, ctx);
      expect(res.content).toContain("app-managed");
    }
    const ghost = await run("delete_lore_file", { entity: "Ava", file: "ghost.md" }, ctx);
    expect(ghost.content).toContain("does not exist");
    expect(fs.get(ARMOR)).toBe(FACET_MD);
    expect(ctx.loreChanged).toBe(0);
  });
});

// ─── propose_lore_plan + the gate on every lore write ────────────────────────

const dirOf = (cat: string, id: string) => `${PROJECT}/.ai-writer/lore/${cat}/${id}`;
const AVA_INDEX = `${dirOf("characters", "ava")}/index.md`;
const NEW_INDEX = `---\nname: Ava\naliases: []\ncategory: characters\nsummary: "now a queen"\n---\n\n# Ava\n`;

describe("lore plan gate", () => {
  /** A context whose author has approved nothing yet. */
  const unplanned = (overrides: Partial<ToolContext> = {}) =>
    makeCtx({ lorePlan: createPlanGate(), ...overrides });

  it("refuses every lore write until a plan is approved", async () => {
    const ctx = unplanned();
    const calls: [ToolId, object][] = [
      ["create_lore_entity", { name: "Kael", category: "characters", summary: "x", content: "y" }],
      ["update_lore_file", { entity: "Ava", content: NEW_INDEX }],
      ["move_lore_entity", { entity: "Ava", new_category: "factions" }],
      ["delete_lore_entity", { entity: "Ava" }],
    ];
    for (const [tool, args] of calls) {
      const res = await run(tool, args, ctx);
      expect(res.content).toContain("need an approved plan");
    }
    expect(fs.get(AVA_INDEX)).toBe(INDEX_MD);
    expect(backupsOf()).toHaveLength(0);
    expect(ctx.loreChanged).toBe(0);
  });

  it("lets exactly the approved steps through and refuses the rest", async () => {
    const seen: LorePlan[] = [];
    const ctx = unplanned({
      requestPlanApproval: async (p) => { seen.push(p); return { approved: true }; },
    });

    const plan = await run("propose_lore_plan", {
      summary: "整理重复条目",
      steps: [{ action: "update", entity: "Ava", file: "index.md", detail: "把 summary 改成 queen" }],
    }, ctx);
    expect(seen).toHaveLength(1);
    expect(seen[0].steps[0]).toMatchObject({ action: "update", entity: "Ava", file: "index.md" });
    expect(plan.content).toContain("Plan approved");

    // Covered: goes through, and the step's detail rides back with the result
    // so the log shows intent and outcome together.
    const ok = await run("update_lore_file", { entity: "Ava", content: NEW_INDEX }, ctx);
    expect(ok.content).toContain("Plan step: 把 summary 改成 queen");
    expect(fs.get(AVA_INDEX)).toBe(NEW_INDEX);

    // Same entity, action nobody approved.
    const off = await run("delete_lore_entity", { entity: "Ava" }, ctx);
    expect(off.content).toContain('does not cover "delete"');
    expect(off.content).toContain("update Ava / index.md — 把 summary 改成 queen");
    expect(fs.has(AVA_INDEX)).toBe(true);
  });

  it("matches through aliases but holds the file the step pinned", async () => {
    const ctx = unplanned();
    await run("propose_lore_plan", {
      steps: [{ action: "update", entity: "Ava", file: "index.md", detail: "改 summary" }],
    }, ctx);

    // "阿瓦" is Ava's alias — the same entity, so the gate must not refuse it.
    const alias = await run("update_lore_file", { entity: "阿瓦", content: NEW_INDEX }, ctx);
    expect(alias.content).toContain("Wrote index.md");

    const otherFile = await run("update_lore_file", {
      entity: "Ava", file: "armor.md",
      content: `---\nfacet: "战甲"\nkeys: ["战甲"]\n---\n\n换成银色。`,
    }, ctx);
    expect(otherFile.content).toContain("does not cover");
    expect(fs.get(`${dirOf("characters", "ava")}/armor.md`)).toBe(FACET_MD);
  });

  it("does not let a file-scoped step authorise a whole-entity action", async () => {
    const ctx = unplanned();
    await run("propose_lore_plan", {
      steps: [{ action: "delete", entity: "Ava", file: "armor.md", detail: "退役战甲特征" }],
    }, ctx);

    // Approving "drop this one facet" must never green-light "drop Ava".
    const entity = await run("delete_lore_entity", { entity: "Ava" }, ctx);
    expect(entity.content).toContain("does not cover");
    expect(fs.get(AVA_INDEX)).toBe(INDEX_MD);

    const facet = await run("delete_lore_file", { entity: "Ava", file: "armor.md" }, ctx);
    expect(facet.content).toContain("Deleted armor.md");
  });

  it("hands a rejection back verbatim and keeps the gate shut", async () => {
    const ctx = unplanned({
      requestPlanApproval: async () => ({ approved: false, reason: "别删阿瓦" }),
    });
    const res = await run("propose_lore_plan", {
      steps: [{ action: "delete", entity: "Ava", detail: "重复条目" }],
    }, ctx);

    expect(res.content).toContain("REJECTED");
    expect(res.content).toContain("别删阿瓦");
    const blocked = await run("delete_lore_entity", { entity: "Ava" }, ctx);
    expect(blocked.content).toContain("was not approved");
    expect(fs.get(AVA_INDEX)).toBe(INDEX_MD);
  });

  it("appends a second approved plan instead of revoking the first", async () => {
    const ctx = unplanned();
    await run("propose_lore_plan", {
      steps: [{ action: "update", entity: "Ava", detail: "改 summary" }],
    }, ctx);
    const second = await run("propose_lore_plan", {
      steps: [{ action: "create", entity: "Kael", detail: "新增对手" }],
    }, ctx);
    // The unfinished step rides along so the fresh list doesn't bury it.
    expect(second.content).toContain("Still outstanding from earlier");
    expect(second.content).toContain("update Ava — 改 summary");

    expect((await run("create_lore_entity", {
      name: "Kael", category: "characters", summary: "the rival", content: "# Kael",
    }, ctx)).content).toContain("Created lore entity");
    expect((await run("update_lore_file", { entity: "Ava", content: NEW_INDEX }, ctx)).content)
      .toContain("Wrote index.md");
  });

  it("validates the steps payload before troubling the author", async () => {
    let asked = 0;
    const ctx = unplanned({
      requestPlanApproval: async () => { asked++; return { approved: true }; },
    });

    expect((await run("propose_lore_plan", { steps: [] }, ctx)).content)
      .toContain("at least one change");
    expect((await run("propose_lore_plan", {
      steps: [{ action: "rewrite", entity: "Ava", detail: "x" }],
    }, ctx)).content).toContain("must be one of");
    expect((await run("propose_lore_plan", {
      steps: [{ action: "update", entity: "Ava" }],
    }, ctx)).content).toContain("missing 'detail'");
    expect(asked).toBe(0);
  });
});

// ─── move_lore_entity ────────────────────────────────────────────────────────

describe("move_lore_entity", () => {
  it("renames in place, keeps the old name as an alias, and backs up index.md", async () => {
    const ctx = makeCtx();
    const res = await run("move_lore_entity", { entity: "Ava", new_name: "Ava Reyne" }, ctx);

    expect(res.content).toContain('renamed to "Ava Reyne"');
    const written = fs.get(`${dirOf("characters", "ava")}/index.md`)!;
    expect(written).toContain("name: Ava Reyne");
    expect(written).toContain('"Ava"'); // old name still matches earlier chapters
    expect(written).toContain('"阿瓦"'); // pre-existing alias survived
    expect(fs.get(backupsOf()[0])).toBe(INDEX_MD);
    expect(ctx.loreChanged).toBe(1);
  });

  it("drops the old name when the author is fixing a mistake", async () => {
    const ctx = makeCtx();
    await run("move_lore_entity", {
      entity: "Ava", new_name: "Ada", keep_old_name_as_alias: false,
    }, ctx);
    expect(fs.get(`${dirOf("characters", "ava")}/index.md`)).not.toContain('"Ava"');
  });

  it("moves the whole folder on a category change and keeps the run's snapshot usable", async () => {
    const ctx = makeCtx();
    const res = await run("move_lore_entity", { entity: "Ava", new_category: "factions" }, ctx);

    expect(res.content).toContain("characters → factions");
    expect(fs.has(`${dirOf("characters", "ava")}/index.md`)).toBe(false);
    expect(fs.get(`${dirOf("factions", "ava")}/index.md`)).toContain("category: factions");
    expect(fs.get(`${dirOf("factions", "ava")}/armor.md`)).toBe(FACET_MD); // siblings travelled
    expect(ctx.loreIndex.characters).toHaveLength(0);
    expect(ctx.loreIndex.factions[0].dirPath).toBe(dirOf("factions", "ava"));

    // The next call in the same run must still land — the snapshot moved too.
    const next = await run("update_lore_file", {
      entity: "Ava", file: "armor.md",
      content: `---\nfacet: "战甲"\nkeys: ["战甲"]\n---\n\n换成银色。`,
    }, ctx);
    expect(next.content).toContain("Wrote armor.md");
    expect(fs.get(`${dirOf("factions", "ava")}/armor.md`)).toContain("银色");
  });

  it("rejects an empty move, an unknown category, and a name another entity answers to", async () => {
    const ctx = makeCtx();
    ctx.loreIndex.characters.push({
      ...ctx.loreIndex.characters[0], id: "kael", name: "Kael", aliases: ["凯尔"],
      dirPath: dirOf("characters", "kael"),
    });

    const noop = await run("move_lore_entity", { entity: "Ava" }, ctx);
    expect(noop.content).toContain("nothing to move");

    const badCat = await run("move_lore_entity", { entity: "Ava", new_category: "nope" }, ctx);
    expect(badCat.content).toContain("'new_category' must be one of");

    const clash = await run("move_lore_entity", { entity: "Ava", new_name: "凯尔" }, ctx);
    expect(clash.content).toContain('already resolves to entity "Kael"');

    expect(fs.get(`${dirOf("characters", "ava")}/index.md`)).toBe(INDEX_MD);
    expect(ctx.loreChanged).toBe(0);
  });
});

// ─── delete_lore_entity ──────────────────────────────────────────────────────

describe("delete_lore_entity", () => {
  const trashed = () => [...fs.keys()].filter((p) => p.includes("/backups/deleted-"));

  it("moves the folder into backups (not an unlink) and drops it from the snapshot", async () => {
    const ctx = makeCtx();
    const res = await run("delete_lore_entity", { entity: "Ava", reason: "duplicate of Kael" }, ctx);

    expect(res.content).toContain('Deleted lore entity "Ava"');
    expect(res.content).toContain("can be restored");
    expect(fs.has(`${dirOf("characters", "ava")}/index.md`)).toBe(false);
    // Both files came along, so nothing about the entity is unrecoverable.
    expect(trashed()).toHaveLength(2);
    expect(trashed().some((p) => fs.get(p) === INDEX_MD)).toBe(true);
    expect(ctx.loreIndex.characters).toHaveLength(0);
    expect(ctx.loreChanged).toBe(1);
  });

  it("errors on an unknown entity without touching the project", async () => {
    const ctx = makeCtx();
    const res = await run("delete_lore_entity", { entity: "Nobody" }, ctx);
    expect(res.content).toContain("not found");
    expect(fs.get(`${dirOf("characters", "ava")}/index.md`)).toBe(INDEX_MD);
    expect(trashed()).toHaveLength(0);
    expect(ctx.loreChanged).toBe(0);
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

// ─── propose_edit ────────────────────────────────────────────────────────────

describe("propose_edit", () => {
  const DOC = `${PROJECT}/writing/ch1.md`;

  beforeEach(() => {
    fs.set(DOC, "Ava walked into the hall. The hall was dark. She waited.");
  });

  it("blocks on approval; approved → success message (approver applies, not the tool)", async () => {
    const approvals: object[] = [];
    const ctx = makeCtx({
      requestApproval: async (p) => {
        approvals.push(p);
        return { approved: true, backupPath: "/proj/.ai-writer/backups/x" };
      },
    });
    const res = await run("propose_edit", {
      path: DOC, find: "She waited.", replace: "She ran.", reason: "pacing",
    }, ctx);

    expect(approvals).toHaveLength(1);
    // The approver dispatches on `kind`; an untagged proposal would never apply.
    expect(approvals[0]).toMatchObject({
      kind: "edit", path: DOC, find: "She waited.", replace: "She ran.", reason: "pacing",
    });
    expect(res.content).toContain("approved and applied");
    expect(res.content).toContain("/proj/.ai-writer/backups/x");
    // The tool itself never writes — that's the approver's job.
    expect(fs.get(DOC)).toContain("She waited.");
  });

  it("feeds the user's rejection reason back to the model", async () => {
    const ctx = makeCtx({
      requestApproval: async () => ({ approved: false, reason: "keep the slow pacing" }),
    });
    const res = await run("propose_edit", { path: DOC, find: "She waited.", replace: "She ran." }, ctx);
    expect(res.content).toContain("REJECTED");
    expect(res.content).toContain("keep the slow pacing");
  });

  it("works on a file anywhere in the project, not just under writing/", async () => {
    const proposals: object[] = [];
    const ctx = makeCtx({
      requestApproval: async (p) => {
        proposals.push(p);
        return { approved: true };
      },
    });
    fs.set(`${PROJECT}/大纲.md`, "总纲。待补。");

    const res = await run("propose_edit", {
      path: `${PROJECT}/大纲.md`, find: "待补。", replace: "已定稿。",
    }, ctx);

    expect(proposals).toHaveLength(1);
    expect(res.content).toContain("approved and applied");
  });

  it("validates path containment, find uniqueness, and the approval channel", async () => {
    const ctxOk = makeCtx({ requestApproval: async () => ({ approved: true }) });

    // The .ai-writer refusal is the regression guard for the lore plan gate:
    // letting propose_edit in here would bypass propose_lore_plan wholesale.
    const outside = await run("propose_edit", {
      path: `${PROJECT}/.ai-writer/lore/characters/ava/index.md`, find: "x", replace: "y",
    }, ctxOk);
    expect(outside.content).toContain(".ai-writer");

    const missing = await run("propose_edit", { path: DOC, find: "no such text", replace: "y" }, ctxOk);
    expect(missing.content).toContain("not found");

    const ambiguous = await run("propose_edit", { path: DOC, find: "hall", replace: "cave" }, ctxOk);
    expect(ambiguous.content).toContain("2 times");

    const noChannel = await run("propose_edit", { path: DOC, find: "She waited.", replace: "y" }, makeCtx());
    expect(noChannel.content).toContain("cannot review");
  });
});

// ─── create_chapter / move_chapter / delete_chapter ──────────────────────────
//
// These tools only *propose*; the approver applies. So the assertions are about
// what reaches the card (and what is refused before it ever gets there), never
// about the filesystem changing.

describe("chapter structure tools", () => {
  const CH1 = `${PROJECT}/writing/卷一/第1章.md`;
  const proposals: Record<string, unknown>[] = [];

  /** Approves everything, recording what it was asked to approve. */
  const approving = () =>
    makeCtx({
      requestApproval: async (p) => {
        proposals.push(p as unknown as Record<string, unknown>);
        return { approved: true, backupPath: null };
      },
    });

  beforeEach(() => {
    proposals.length = 0;
    fs.set(CH1, "第一章的正文。");
    fs.set(`${PROJECT}/writing/卷一/第2章.md`, "第二章的正文。");
  });

  describe("create_chapter", () => {
    it("proposes a new chapter with its content, normalising a missing extension", async () => {
      const res = await run(
        "create_chapter",
        { path: `${PROJECT}/writing/卷一/第3章`, content: "第三章开篇。", reason: "接上一章" },
        approving(),
      );

      expect(proposals[0]).toMatchObject({
        kind: "create",
        path: `${PROJECT}/writing/卷一/第3章.md`,
        content: "第三章开篇。",
        reason: "接上一章",
      });
      expect(res.content).toContain("Created");
      // The tool never writes — that is the approver's job.
      expect(fs.has(`${PROJECT}/writing/卷一/第3章.md`)).toBe(false);
    });

    it("accepts an empty chapter but requires the argument", async () => {
      await run("create_chapter", { path: `${PROJECT}/writing/新章.md`, content: "" }, approving());
      expect(proposals).toHaveLength(1);

      const missing = await run("create_chapter", { path: `${PROJECT}/writing/新章2.md` }, approving());
      expect(missing.content).toContain("'content' argument is required");
    });

    it("refuses to overwrite an existing chapter", async () => {
      const res = await run("create_chapter", { path: CH1, content: "x" }, approving());
      expect(res.content).toContain("already exists");
      expect(proposals).toHaveLength(0);
    });

    it("refuses a non-manuscript extension", async () => {
      const res = await run(
        "create_chapter",
        { path: `${PROJECT}/writing/cover.png`, content: "x" },
        approving(),
      );
      expect(res.content).toContain("not a manuscript file");
    });

    it("refuses .ai-writer paths and surfaces a missing approval channel", async () => {
      const outside = await run(
        "create_chapter",
        { path: `${PROJECT}/.ai-writer/lore/x.md`, content: "x" },
        approving(),
      );
      expect(outside.content).toContain(".ai-writer");

      const noChannel = await run(
        "create_chapter",
        { path: `${PROJECT}/writing/新章.md`, content: "x" },
        makeCtx(),
      );
      expect(noChannel.content).toContain("cannot review");
    });

    it("creates a chapter at the project root — free organisation", async () => {
      await run(
        "create_chapter",
        { path: `${PROJECT}/随笔/杂记`, content: "自由组织。" },
        approving(),
      );
      expect(proposals[0]).toMatchObject({
        kind: "create",
        path: `${PROJECT}/随笔/杂记.md`,
      });
    });
  });

  describe("move_chapter", () => {
    it("proposes a move with both paths and whether the source is a folder", async () => {
      const res = await run(
        "move_chapter",
        { path: CH1, new_path: `${PROJECT}/writing/卷二/第1章.md`, reason: "归卷" },
        approving(),
      );

      expect(proposals[0]).toMatchObject({
        kind: "move",
        path: CH1,
        newPath: `${PROJECT}/writing/卷二/第1章.md`,
        isDir: false,
      });
      expect(res.content).toContain("Moved");
    });

    it("recognises a volume folder as the source", async () => {
      await run(
        "move_chapter",
        { path: `${PROJECT}/writing/卷一`, new_path: `${PROJECT}/writing/第一卷` },
        approving(),
      );
      expect(proposals[0]).toMatchObject({ kind: "move", isDir: true });
    });

    it("refuses a destination that already exists, so a move cannot overwrite", async () => {
      const res = await run(
        "move_chapter",
        { path: CH1, new_path: `${PROJECT}/writing/卷一/第2章.md` },
        approving(),
      );
      expect(res.content).toContain("already exists");
      expect(proposals).toHaveLength(0);
    });

    it("refuses moving a folder into its own subtree", async () => {
      const res = await run(
        "move_chapter",
        { path: `${PROJECT}/writing/卷一`, new_path: `${PROJECT}/writing/卷一/子卷` },
        approving(),
      );
      expect(res.content).toContain("into itself");
    });

    it("refuses a missing source, a same-path move, and a destination in .ai-writer", async () => {
      const missing = await run(
        "move_chapter",
        { path: `${PROJECT}/writing/无.md`, new_path: `${PROJECT}/writing/有.md` },
        approving(),
      );
      expect(missing.content).toContain("does not exist");

      const same = await run("move_chapter", { path: CH1, new_path: CH1 }, approving());
      expect(same.content).toContain("same as the source");

      const outside = await run(
        "move_chapter",
        { path: CH1, new_path: `${PROJECT}/.ai-writer/第1章.md` },
        approving(),
      );
      expect(outside.content).toContain(".ai-writer");
    });
  });

  describe("delete_chapter", () => {
    it("proposes a deletion carrying the file's size", async () => {
      const res = await run("delete_chapter", { path: CH1, reason: "与第2章重复" }, approving());

      expect(proposals[0]).toMatchObject({
        kind: "delete",
        path: CH1,
        chars: "第一章的正文。".length,
        reason: "与第2章重复",
      });
      expect(res.content).toContain("backups");
      expect(fs.has(CH1)).toBe(true); // the approver deletes, not the tool
    });

    it("refuses a volume folder — that is the author's own call", async () => {
      const res = await run(
        "delete_chapter",
        { path: `${PROJECT}/writing/卷一`, reason: "整卷废弃" },
        approving(),
      );
      expect(res.content).toContain("not a volume folder");
      expect(proposals).toHaveLength(0);
    });

    it("requires a reason — the author decides from that line alone", async () => {
      const res = await run("delete_chapter", { path: CH1 }, approving());
      expect(res.content).toContain("'reason' argument is required");
    });

    it("refuses a path that does not exist", async () => {
      const res = await run("delete_chapter", { path: `${PROJECT}/writing/无.md`, reason: "x" }, approving());
      expect(res.content).toContain("does not exist");
    });
  });

  describe("create_file", () => {
    it("proposes a file of any type, at any depth in the project", async () => {
      const res = await run(
        "create_file",
        { path: `${PROJECT}/资料/人物表.csv`, content: "名字,身份", reason: "整理人物" },
        approving(),
      );
      expect(proposals[0]).toMatchObject({
        kind: "create",
        path: `${PROJECT}/资料/人物表.csv`,
        content: "名字,身份",
      });
      expect(proposals[0].isDir).toBeUndefined();
      expect(res.content).toContain("Created");
    });

    it("requires an explicit extension rather than silently defaulting", async () => {
      const res = await run("create_file", { path: `${PROJECT}/资料/备注`, content: "x" }, approving());
      expect(res.content).toContain("no file extension");
      expect(res.content).toContain("create_chapter");
      expect(proposals).toHaveLength(0);
    });

    it("refuses .ai-writer paths and existing files", async () => {
      const outside = await run(
        "create_file",
        { path: `${PROJECT}/.ai-writer/profile.json`, content: "{}" },
        approving(),
      );
      expect(outside.content).toContain(".ai-writer");

      const dup = await run("create_file", { path: CH1, content: "x" }, approving());
      expect(dup.content).toContain("already exists");
      expect(proposals).toHaveLength(0);
    });
  });

  describe("create_directory", () => {
    it("proposes an empty folder, flagged isDir for the card and the apply step", async () => {
      const res = await run(
        "create_directory",
        { path: `${PROJECT}/素材/访谈记录`, reason: "备料" },
        approving(),
      );
      expect(proposals[0]).toMatchObject({
        kind: "create",
        path: `${PROJECT}/素材/访谈记录`,
        content: "",
        isDir: true,
      });
      expect(res.content).toContain("Created folder");
    });

    it("refuses when something already exists there", async () => {
      const res = await run("create_directory", { path: CH1 }, approving());
      expect(res.content).toContain("already exists");
      expect(proposals).toHaveLength(0);
    });
  });

  describe("copy_file", () => {
    it("proposes a copy carrying source, destination and isDir", async () => {
      const res = await run(
        "copy_file",
        { path: CH1, dest_dir: `${PROJECT}/writing/卷一`, reason: "留个底稿" },
        approving(),
      );
      expect(proposals[0]).toMatchObject({
        kind: "copy",
        path: CH1,
        destDir: `${PROJECT}/writing/卷一`,
        isDir: false,
      });
      expect(res.content).toContain("Copied");
    });

    it("reports where the copy actually landed when the decision carries resultPath", async () => {
      const ctx = makeCtx({
        requestApproval: async () => ({
          approved: true,
          resultPath: `${PROJECT}/writing/卷一/第1章 (1).md`,
        }),
      });
      const res = await run("copy_file", { path: CH1, dest_dir: `${PROJECT}/writing/卷一` }, ctx);
      expect(res.content).toContain("第1章 (1).md");
    });

    it("accepts the project root itself as the destination", async () => {
      await run("copy_file", { path: CH1, dest_dir: PROJECT }, approving());
      expect(proposals[0]).toMatchObject({ kind: "copy", destDir: PROJECT });
    });

    it("refuses a missing source, a missing destination folder, and .ai-writer", async () => {
      const missing = await run(
        "copy_file",
        { path: `${PROJECT}/writing/无.md`, dest_dir: `${PROJECT}/writing/卷一` },
        approving(),
      );
      expect(missing.content).toContain("does not exist");

      const noDest = await run("copy_file", { path: CH1, dest_dir: `${PROJECT}/不存在` }, approving());
      expect(noDest.content).toContain("create_directory");

      const outside = await run("copy_file", { path: CH1, dest_dir: `${PROJECT}/.ai-writer` }, approving());
      expect(outside.content).toContain(".ai-writer");
      expect(proposals).toHaveLength(0);
    });

    it("refuses copying a folder into its own subtree", async () => {
      const res = await run(
        "copy_file",
        { path: `${PROJECT}/writing/卷一`, dest_dir: `${PROJECT}/writing/卷一` },
        approving(),
      );
      expect(res.content).toContain("into itself");
    });
  });

  it("feeds a rejection reason back to the model for every kind", async () => {
    const rejecting = makeCtx({
      requestApproval: async () => ({ approved: false, reason: "先别动结构" }),
    });

    for (const [tool, args] of [
      ["create_chapter", { path: `${PROJECT}/writing/新.md`, content: "x" }],
      ["create_file", { path: `${PROJECT}/新.json`, content: "{}" }],
      ["create_directory", { path: `${PROJECT}/新目录` }],
      ["move_chapter", { path: CH1, new_path: `${PROJECT}/writing/别处.md` }],
      ["copy_file", { path: CH1, dest_dir: `${PROJECT}/writing/卷一` }],
      ["delete_chapter", { path: CH1, reason: "重复" }],
    ] as const) {
      const res = await run(tool, args, rejecting);
      expect(res.content).toContain("REJECTED");
      expect(res.content).toContain("先别动结构");
    }
  });
});
