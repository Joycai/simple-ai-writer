/**
 * The manuscript read tools against an in-memory project:
 *   - list_files  — recursive grouped listing, natural order, caps
 *   - read_file   — line-based paging and its budget
 *   - search_text — recursive scan, snippet windowing, result caps
 *   - read_image  — path resolution, the multimodal gate, and the size ceiling
 *   - read_slides — the .pptx guard rails and the slide-paging trailer
 * plus the path containment that keeps a model-supplied `folder`/`path` inside
 * the project.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── In-memory manuscript standing in for the Tauri-backed fs ─────────────────
const fs = new Map<string, string>();
/** Paths the directory listing reports but readFile refuses — permission errors. */
const unreadable = new Set<string>();

vi.mock("../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    if (unreadable.has(p)) throw new Error(`EACCES: ${p}`);
    if (!fs.has(p)) throw new Error(`ENOENT: ${p}`);
    return fs.get(p)!;
  }),
  writeFile: vi.fn(async () => {}),
  makeDir: vi.fn(async () => {}),
  fileExists: vi.fn(async (p: string) => fs.has(p)),
}));

/**
 * Rebuild the FileNode tree read_dir_recursive would return, from the flat
 * in-memory paths — so tests declare files, not directory objects. Mirrors the
 * Rust side's dotfile filter: `.ai-writer` (and any dot-entry) never appears.
 */
vi.mock("../project", () => ({
  readDirRecursive: vi.fn(async (dir: string) => {
    interface Node { name: string; path: string; is_dir: boolean; children?: Node[] }
    const roots: Node[] = [];
    const dirs = new Map<string, Node>();
    for (const path of fs.keys()) {
      if (!path.startsWith(dir + "/")) continue;
      const segments = path.slice(dir.length + 1).split("/");
      if (segments.some((s) => s.startsWith("."))) continue;
      let parent: Node[] = roots;
      let prefix = dir;
      for (let i = 0; i < segments.length; i++) {
        prefix += "/" + segments[i];
        const leaf = i === segments.length - 1;
        if (leaf) {
          parent.push({ name: segments[i], path: prefix, is_dir: false });
        } else {
          let node = dirs.get(prefix);
          if (!node) {
            node = { name: segments[i], path: prefix, is_dir: true, children: [] };
            dirs.set(prefix, node);
            parent.push(node);
          }
          parent = node.children!;
        }
      }
    }
    return roots;
  }),
}));

/**
 * Real classification and limits, fake decoding: `imageToDataUrl` reads bytes
 * through the Tauri fs plugin, which is not there in a node test. Sizes come
 * from the in-memory content's length so the ceiling can be exercised.
 */
vi.mock("../fs/images", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fs/images")>()),
  imageToDataUrl: vi.fn(async (p: string) => {
    if (!fs.has(p)) throw new Error(`ENOENT: ${p}`);
    const bytes = new Uint8Array(fs.get(p)!.length);
    return { dataUrl: `data:image/png;base64,${p}`, ext: "png", bytes };
  }),
}));

/**
 * Real classification, fake conversion: the parser is Rust behind an IPC call
 * that does not exist in a node test. The fake deck returns what the Rust side
 * would, so the trailer this file asserts is the real protocol.
 */
const deck = { total: 0 };
vi.mock("../fs/pptx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fs/pptx")>()),
  readPptxSlides: vi.fn(async (path: string, startSlide?: number) => {
    if (!fs.has(path)) throw new Error(`ENOENT: ${path}`);
    const from = startSlide ?? 1;
    if (from > deck.total) throw new Error(`start_slide ${from} is past the end`);
    const to = Math.min(deck.total, from + 4);
    return {
      markdown: Array.from({ length: to - from + 1 }, (_, i) => `<!-- slide ${from + i} -->`).join(
        "\n\n",
      ),
      total_slides: deck.total,
      from_slide: from,
      to_slide: to,
      next_slide: to < deck.total ? to + 1 : null,
    };
  }),
}));

import { executeRegisteredTool, type ToolContext, type ToolId } from "../agent/registry";
import { formatLoreIndex, type ToolResult } from "../agent/tools";
import { MAX_IMAGE_BYTES } from "../fs/images";

const PROJECT = "/proj";
const ALLOWED: ToolId[] = ["list_files", "read_file", "search_text", "read_image", "read_slides"];

const ctx: ToolContext = {
  projectPath: PROJECT,
  loreIndex: {},
  multimodal: false,
};

async function callFull(
  name: ToolId,
  args: Record<string, unknown>,
  over: Partial<ToolContext> = {},
): Promise<ToolResult> {
  return executeRegisteredTool(
    { id: "c1", name, arguments: JSON.stringify(args) },
    ALLOWED,
    { ...ctx, ...over },
  );
}

async function call(name: ToolId, args: Record<string, unknown>): Promise<string> {
  return (await callFull(name, args)).content;
}

const search = (args: Record<string, unknown>) => call("search_text", args);
const list = (args: Record<string, unknown> = {}) => call("list_files", args);
const read = (args: Record<string, unknown>) => call("read_file", args);

beforeEach(() => {
  fs.clear();
  unreadable.clear();
});

describe("list_files", () => {
  it("recurses into volume folders, grouped by absolute folder path", async () => {
    fs.set(`${PROJECT}/序章.md`, "x");
    fs.set(`${PROJECT}/卷一/第1章.md`, "x");
    fs.set(`${PROJECT}/卷一/第2章.md`, "x");
    fs.set(`${PROJECT}/卷二/第3章.md`, "x");

    const out = await list();

    expect(out).toContain("4 files in 3 folders under the project folder");
    expect(out).toContain(`${PROJECT}\n  序章.md`);
    expect(out).toContain(`${PROJECT}/卷一\n  第1章.md\n  第2章.md`);
    expect(out).toContain(`${PROJECT}/卷二\n  第3章.md`);
  });

  it("never lists the app's .ai-writer data", async () => {
    fs.set(`${PROJECT}/第1章.md`, "x");
    fs.set(`${PROJECT}/.ai-writer/lore/characters/ava/index.md`, "x");

    const out = await list();

    expect(out).toContain("第1章.md");
    expect(out).not.toContain(".ai-writer");
  });

  it("orders files and folders numerically", async () => {
    fs.set(`${PROJECT}/writing/卷10/第1章.md`, "x");
    fs.set(`${PROJECT}/writing/卷2/第1章.md`, "x");
    fs.set(`${PROJECT}/writing/第10章.md`, "x");
    fs.set(`${PROJECT}/writing/第2章.md`, "x");

    const out = await list();

    expect(out.indexOf("第2章.md")).toBeLessThan(out.indexOf("第10章.md"));
    expect(out.indexOf("卷2")).toBeLessThan(out.indexOf("卷10"));
  });

  it("scopes to a subfolder", async () => {
    fs.set(`${PROJECT}/卷一/第1章.md`, "x");
    fs.set(`${PROJECT}/卷二/第2章.md`, "x");

    const out = await list({ folder: "卷一" });

    expect(out).toContain("第1章.md");
    expect(out).not.toContain("第2章.md");
  });

  it("rejects a folder that escapes the project or enters .ai-writer", async () => {
    expect(await list({ folder: "../elsewhere" })).toContain(
      "Error: Folder is outside the project",
    );
    expect(await list({ folder: ".ai-writer/lore" })).toContain(
      "Error: Folder is outside the project",
    );
  });

  it("rejects everything on a surface with no project", async () => {
    // An empty projectPath would prefix-match any absolute path — the guard
    // must refuse before the listing is attempted.
    const out = await callFull("list_files", {}, { projectPath: "" });

    expect(out.content).toContain("Error: Folder is outside the project");
  });

  it("reports an empty manuscript", async () => {
    expect(await list()).toContain("No files found in the project folder.");
  });
});

describe("read_file", () => {
  it("returns a short file whole, with no paging note", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, "第一行\n第二行");

    const out = await read({ path: `${PROJECT}/writing/ch1.md` });

    expect(out).toBe("第一行\n第二行");
  });

  // 【当前文件】 hands the model a project-relative path, so it answers with
  // one; a tool that only accepted absolute paths made that file unreadable.
  it("accepts a project-relative path", async () => {
    fs.set(`${PROJECT}/卷一/第1章.md`, "第一行");

    expect(await read({ path: "卷一/第1章.md" })).toBe("第一行");
  });

  it("pages a long file on line boundaries and hands back the next start_line", async () => {
    const line = "甲".repeat(199); // 200 chars with its newline
    fs.set(`${PROJECT}/writing/ch1.md`, Array.from({ length: 50 }, () => line).join("\n"));

    const out = await read({ path: `${PROJECT}/writing/ch1.md` });

    expect(out).toContain("lines 1-20 of 50 shown");
    expect(out).toContain("start_line=21");
    // Cut on a line boundary — no partial line before the note.
    expect(out.split("\n\n[...")[0].split("\n")).toHaveLength(20);
  });

  it("continues from a given start_line", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, "一\n二\n三\n四");

    const out = await read({ path: `${PROJECT}/writing/ch1.md`, start_line: 3 });

    expect(out).toContain("三\n四");
    expect(out).not.toContain("一");
    expect(out).toContain("lines 3-4 of 4 shown");
  });

  it("still returns content when a single line exceeds the budget", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, "甲".repeat(9000));

    const out = await read({ path: `${PROJECT}/writing/ch1.md` });

    expect(out).toContain("cut mid-line");
    expect(out.split("\n\n[...")[0]).toHaveLength(4000);
  });

  it("errors when start_line is past the end", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, "一\n二");

    expect(await read({ path: `${PROJECT}/writing/ch1.md`, start_line: 9 })).toContain(
      "Error: start_line 9 is past the end of the file, which has 2 line(s).",
    );
  });

  it("reads a file anywhere in the project, not just under writing/", async () => {
    fs.set(`${PROJECT}/大纲.md`, "自由组织");

    expect(await read({ path: `${PROJECT}/大纲.md` })).toBe("自由组织");
  });

  it("rejects a path outside the project", async () => {
    expect(await read({ path: "/etc/passwd" })).toContain(
      "Error: Path is outside the project",
    );
  });

  it("rejects the app's .ai-writer data", async () => {
    // Reading profile.json or lore text here would hand it to whoever planted
    // a prompt injection — those files have their own tools.
    fs.set(`${PROJECT}/.ai-writer/profile.json`, "{}");

    expect(await read({ path: `${PROJECT}/.ai-writer/profile.json` })).toContain(
      "Error: Path is outside the project",
    );
  });

  it("rejects everything on a surface with no project", async () => {
    fs.set("/etc/passwd", "root");

    const out = await callFull(
      "read_file",
      { path: "/etc/passwd" },
      { projectPath: "" },
    );

    expect(out.content).toContain("Error: Path is outside the project");
  });
});

describe("search_text", () => {
  it("finds a phrase across volume subfolders with path and line number", async () => {
    fs.set(`${PROJECT}/writing/卷一/第1章.md`, "开场。\n他握紧那柄断剑。\n结束。");
    fs.set(`${PROJECT}/writing/卷二/第10章.md`, "断剑终于换了主人。");
    fs.set(`${PROJECT}/writing/卷二/第2章.md`, "无关内容。");

    const out = await search({ query: "断剑" });

    expect(out).toContain("2 matching lines in 2 files");
    expect(out).toContain(`${PROJECT}/writing/卷一/第1章.md`);
    expect(out).toContain("L2: 他握紧那柄断剑。");
    expect(out).toContain(`${PROJECT}/writing/卷二/第10章.md`);
    expect(out).toContain("L1: 断剑终于换了主人。");
    expect(out).not.toContain("第2章");
  });

  it("orders files numerically so 第2章 comes before 第10章", async () => {
    fs.set(`${PROJECT}/writing/第10章.md`, "剑");
    fs.set(`${PROJECT}/writing/第2章.md`, "剑");

    const out = await search({ query: "剑" });

    expect(out.indexOf("第2章")).toBeLessThan(out.indexOf("第10章"));
  });

  it("matches case-insensitively", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, "The Broken Sword lay there.");

    expect(await search({ query: "broken sword" })).toContain("L1: The Broken Sword lay there.");
  });

  it("scopes to a subfolder when 'folder' is given", async () => {
    fs.set(`${PROJECT}/卷一/第1章.md`, "断剑");
    fs.set(`${PROJECT}/卷二/第1章.md`, "断剑");

    const out = await search({ query: "断剑", folder: "卷一" });

    expect(out).toContain("in 1 file");
    expect(out).toContain("卷一");
    expect(out).not.toContain("卷二");
  });

  it("skips non-manuscript files", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, "sword");
    fs.set(`${PROJECT}/writing/cover.png`, "sword");
    fs.set(`${PROJECT}/writing/notes.txt`, "sword");

    const out = await search({ query: "sword" });

    expect(out).toContain("in 2 files"); // .md and .txt count; .png doesn't
    expect(out).not.toContain("cover.png");
  });

  it("windows long paragraphs around the match instead of dumping the line", async () => {
    const long = "甲".repeat(400) + "断剑" + "乙".repeat(400);
    fs.set(`${PROJECT}/writing/ch1.md`, long);

    const out = await search({ query: "断剑" });
    const snippet = out.split("L1: ")[1].split("\n")[0];

    expect(snippet).toContain("断剑");
    expect(snippet.length).toBeLessThan(220);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("caps hits per file and reports how many were omitted", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, Array.from({ length: 20 }, (_, i) => `剑 ${i}`).join("\n"));

    const out = await search({ query: "剑" });

    expect(out).toContain("20 matching lines in 1 file");
    expect(out).toContain("[... 12 more in this file ...]");
    expect(out).toContain("L8:");
    expect(out).not.toContain("L9:");
  });

  it("caps total hits across files and says so", async () => {
    for (let f = 0; f < 10; f++) {
      fs.set(`${PROJECT}/writing/ch${f}.md`, Array.from({ length: 8 }, () => "剑").join("\n"));
    }

    const out = await search({ query: "剑" });

    expect(out).toContain("80 matching lines in 10 files");
    expect(out).toContain("40 more matching lines not shown");
  });

  it("reports no matches without pretending to have searched nothing", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, "无关内容");

    const out = await search({ query: "断剑" });

    expect(out).toContain('No matches for "断剑"');
    expect(out).toContain("1 file searched");
  });

  it("requires a non-empty query", async () => {
    expect(await search({ query: "   " })).toContain("Error: 'query' argument is required.");
    expect(await search({})).toContain("Error: 'query' argument is required.");
  });

  it("rejects a folder that escapes the project or enters .ai-writer", async () => {
    fs.set(`${PROJECT}/.ai-writer/lore/characters/ava/index.md`, "断剑");

    expect(await search({ query: "断剑", folder: "../elsewhere" })).toContain(
      "Error: Folder is outside the project",
    );
    expect(await search({ query: "断剑", folder: ".ai-writer/lore" })).toContain(
      "Error: Folder is outside the project",
    );
  });

  it("skips an unreadable file rather than failing the whole search", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, "断剑");
    fs.set(`${PROJECT}/writing/ch2.md`, "断剑");
    unreadable.add(`${PROJECT}/writing/ch2.md`);

    const out = await search({ query: "断剑" });

    expect(out).toContain("in 1 file");
    expect(out).toContain("ch1.md");
  });
});

describe("read_image", () => {
  const readImage = (path: string) => callFull("read_image", { path }, { multimodal: true });
  /** A document's illustration, where `saveDocumentAsset` actually puts one. */
  const ILLUSTRATION = `${PROJECT}/writing/卷一/assets/第三章/img-1.png`;

  it("refuses on a text-only model instead of sending pixels it can't read", async () => {
    fs.set(ILLUSTRATION, "x");

    const out = await call("read_image", { path: ILLUSTRATION });

    expect(out).toContain("text-only");
  });

  it("hands an image back as visual input, not as text", async () => {
    fs.set(ILLUSTRATION, "x");

    const out = await readImage(ILLUSTRATION);

    expect(out.imageDataUrls).toEqual([`data:image/png;base64,${ILLUSTRATION}`]);
    // The path too: the model needs it to talk about the picture afterwards
    // (and to ask for an edit of it).
    expect(out.content).toContain(ILLUSTRATION);
  });

  it("resolves a project-relative path", async () => {
    fs.set(ILLUSTRATION, "x");

    const out = await readImage("writing/卷一/assets/第三章/img-1.png");

    expect(out.imageDataUrls).toHaveLength(1);
  });

  it("decodes a link copied out of a document", async () => {
    // `imageMarkdown` percent-encodes each segment, so the link the model reads
    // in a chapter names no file on disk until it is decoded.
    fs.set(ILLUSTRATION, "x");
    const encoded = ILLUSTRATION.split("/").map(encodeURIComponent).join("/");

    const out = await readImage(`/${encoded.slice(1)}`);

    expect(out.imageDataUrls).toHaveLength(1);
  });

  it("reads reference art from anywhere in the project, not just writing/", async () => {
    // Unlike read_file: an image tool can't leak the lore's or the profile's
    // text back to whoever planted an instruction, and the author's reference
    // folder is the ordinary case.
    fs.set(`${PROJECT}/参考图/外套.png`, "x");

    const out = await readImage(`${PROJECT}/参考图/外套.png`);

    expect(out.imageDataUrls).toHaveLength(1);
  });

  it("refuses outright on a surface with no project", async () => {
    // Containment is a prefix test, and every absolute path is inside the
    // empty prefix — so this must be refused before it is reached.
    fs.set("/etc/secret.png", "x");

    const out = await callFull(
      "read_image",
      { path: "/etc/secret.png" },
      { multimodal: true, projectPath: "" },
    );

    expect(out.content).toContain("no project is open");
    expect(out.imageDataUrls).toBeUndefined();
  });

  it("refuses a path that escapes the project", async () => {
    fs.set("/etc/secret.png", "x");

    const out = await readImage(`${PROJECT}/../etc/secret.png`);

    expect(out.content).toContain("outside the project");
    expect(out.imageDataUrls).toBeUndefined();
  });

  it("sends a text file to read_file rather than trying to decode it", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, "断剑");

    const out = await readImage(`${PROJECT}/writing/ch1.md`);

    expect(out.content).toContain("not an image");
    expect(out.content).toContain("read_file");
  });

  it("says how to build a correct path when the file isn't there", async () => {
    // A bare "not found" leaves the model retrying the same wrong spelling —
    // and the two ways to name an image differ.
    const out = await readImage(`${PROJECT}/writing/assets/nope.png`);

    expect(out.content).toContain("list_files");
    expect(out.content).toMatch(/relative to that document/);
  });

  it("refuses a picture too big to send", async () => {
    fs.set(ILLUSTRATION, "x".repeat(MAX_IMAGE_BYTES + 1));

    const out = await readImage(ILLUSTRATION);

    expect(out.content).toContain("too large");
    expect(out.imageDataUrls).toBeUndefined();
  });
});

describe("read_slides", () => {
  const DECK = `${PROJECT}/材料/路演.pptx`;
  const slides = (args: Record<string, unknown>) => call("read_slides", args);

  beforeEach(() => {
    fs.set(DECK, "PK\u0003\u0004…");
    deck.total = 12;
  });

  it("hands back the whole deck with no paging note when it fits", async () => {
    deck.total = 3;

    const out = await slides({ path: DECK });

    expect(out).toContain("<!-- slide 1 -->");
    expect(out).toContain("<!-- slide 3 -->");
    expect(out).not.toContain("[...");
  });

  it("says where it stopped and what to pass next", async () => {
    const out = await slides({ path: DECK });

    expect(out).toContain("slides 1-5 of 12 shown");
    expect(out).toContain("start_slide=6");
  });

  it("resumes from a slide number without re-reporting the start of the deck", async () => {
    const out = await slides({ path: DECK, start_slide: 6 });

    expect(out).toContain("<!-- slide 6 -->");
    expect(out).not.toContain("<!-- slide 1 -->");
    expect(out).toContain("slides 6-10 of 12 shown");
  });

  it("drops the resume note on the last page", async () => {
    const out = await slides({ path: DECK, start_slide: 11 });

    expect(out).toContain("slides 11-12 of 12 shown");
    expect(out).not.toContain("start_slide=");
  });

  it("refuses a file that is not a presentation, naming the tool that reads it", async () => {
    fs.set(`${PROJECT}/notes.md`, "hi");

    const out = await slides({ path: `${PROJECT}/notes.md` });

    expect(out).toContain("read_file");
  });

  it("says legacy .ppt cannot be read rather than failing on the parse", async () => {
    // The zip reader genuinely cannot open an OLE compound file, so the honest
    // answer comes up front — not a mangled result that reads like a short deck.
    const out = await slides({ path: `${PROJECT}/材料/旧稿.ppt` });

    expect(out).toContain(".pptx");
  });

  it("keeps the app's own data off-limits, like read_file", async () => {
    const out = await slides({ path: `${PROJECT}/.ai-writer/lore/x.pptx` });

    expect(out).toContain("outside the project");
  });

  it("sends a model reading a presentation with read_file to the right tool", async () => {
    // Without this the model spends a round on binary noise and concludes the
    // deck is empty.
    const out = await read({ path: DECK });

    expect(out).toContain("read_slides");
  });
});

/**
 * `list_lore_entities`' rendering. The interesting case is an **orphan**
 * category (lib/lore/categories): its entries are readable and editable, but
 * `create_lore_entity` / `move_lore_entity` refuse it, so the listing has to say
 * so — otherwise the model only finds out by having a call rejected.
 */
describe("formatLoreIndex", () => {
  it("marks a category no enabled pack declares, and leaves declared ones bare", () => {
    const out = formatLoreIndex({
      characters: [{ name: "Aria", summary: "骑士" } as never],
      npcs: [{ name: "Guard", summary: "" } as never],
      world: [],
    });
    expect(out).toContain("[characters]\n");
    expect(out).toContain("  - Aria: 骑士");
    expect(out).toMatch(/\[npcs\] {2}\(no enabled capability pack declares this category/);
    expect(out).toContain("  - Guard: (no summary)");
    // An empty category is still not listed, orphan or not.
    expect(out).not.toContain("[world]");
  });
});
