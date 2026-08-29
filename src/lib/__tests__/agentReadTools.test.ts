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
 * Real classification and limits, fake reading: `imageForModel` goes through
 * the Tauri fs plugin and then a canvas, neither of which exists in a node
 * test. Sizes come from the in-memory content's length so the tool's own
 * ceiling can still be exercised — what that ceiling now means is "even after
 * downscaling", and the downscaling itself is tested in imageDownscale.test.
 * Partial so `downscaleNote` stays real, since the tool result quotes it.
 */
vi.mock("../image/normalize", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../image/normalize")>()),
  imageForModel: vi.fn(async (p: string) => {
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
import { formatLoreIndex, readLoreEntity, type ToolResult } from "../agent/tools";
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
  // The line numbers are the whole point of the contract rewrite_lines and
  // propose_edit depend on (docs/feature/agent/edit-loop-plan.md §4.1): a model
  // that has to COUNT lines in 4000 unnumbered characters cannot name a region,
  // and a `find` rebuilt from memory loses a space and fails the match.
  it("numbers every line and says the numbers are not file content", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, "第一行\n第二行");

    const out = await read({ path: `${PROJECT}/writing/ch1.md` });

    expect(out).toContain("     1\t第一行\n     2\t第二行");
    expect(out).toContain("whole file, 2 lines");
    expect(out).toContain("never copy it into an edit");
  });

  // Uniform, not conditional: "read_file output has line numbers" is a fact the
  // model can rely on; "long reads have line numbers" is a judgement it has to
  // make first, and it would make it while writing the very argument that then
  // fails to match.
  it("numbers a whole short file too, not just a paged one", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, "只有一行");

    expect(await read({ path: `${PROJECT}/writing/ch1.md` })).toContain("     1\t只有一行");
  });

  // 【当前文件】 hands the model a project-relative path, so it answers with
  // one; a tool that only accepted absolute paths made that file unreadable.
  it("accepts a project-relative path", async () => {
    fs.set(`${PROJECT}/卷一/第1章.md`, "第一行");

    expect(await read({ path: "卷一/第1章.md" })).toContain("     1\t第一行");
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

  // The numbers a continued read carries are the file's, not the page's —
  // otherwise every rewrite_lines after the first page would name a region
  // 20 lines above the one the model meant.
  it("continues from a given start_line and numbers from there", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, "一\n二\n三\n四");

    const out = await read({ path: `${PROJECT}/writing/ch1.md`, start_line: 3 });

    expect(out).toContain("     3\t三\n     4\t四");
    expect(out).not.toContain("一");
    expect(out).toContain("lines 3-4 of 4 shown");
  });

  it("still returns content when a single line exceeds the budget", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, "甲".repeat(9000));

    const out = await read({ path: `${PROJECT}/writing/ch1.md` });

    expect(out).toContain("cut mid-line");
    // The budget is spent on file content; the gutter rides on top of it, so
    // the cut is still exactly 4000 characters of the file itself.
    expect(out.split("\n\n[...")[0]).toHaveLength(4000 + "     1\t".length);
  });

  // The counterpart of read_slides' deck index: a map of the file arrives with
  // the page that could not hold it, so "rewrite the 风险 section" does not
  // begin by paging 4000 characters at a time until that section goes by.
  describe("heading index", () => {
    // Seven lines per section, so the fourth heading is well past one page.
    const long = (headings: string[]) =>
      headings.map((h) => `${h}\n${`${"文".repeat(199)}\n`.repeat(6)}`).join("");

    it("leads a paged document with its headings and their line numbers", async () => {
      fs.set(`${PROJECT}/报告.md`, long(["# 总述", "## 现状", "## 风险", "## 建议"]));

      const out = await read({ path: `${PROJECT}/报告.md` });

      expect(out).toContain("Headings in this file");
      expect(out).toContain("L1  总述");
      expect(out).toContain("L15  风险");
      // Nesting is visible, so the model can tell a section from a subsection.
      expect(out).toContain("  L8  现状");
      // And it comes before the page it indexes.
      expect(out.indexOf("L22  建议")).toBeLessThan(out.indexOf("     1\t# 总述"));
    });

    it("omits the index when the whole file came back", async () => {
      fs.set(`${PROJECT}/短.md`, "# 一\n正文\n## 二\n正文");
      expect(await read({ path: `${PROJECT}/短.md` })).not.toContain("Headings in this file");
    });

    it("omits it for a document with nothing to index", async () => {
      fs.set(`${PROJECT}/白.txt`, `${"字".repeat(199)}\n`.repeat(40));
      const out = await read({ path: `${PROJECT}/白.txt` });
      expect(out).toContain("lines 1-20 of");
      expect(out).not.toContain("Headings in this file");
    });

    // extractHeadings skips fenced code, which is what keeps a shell prompt or
    // a CSS id in an .html page from being indexed as a section.
    it("does not index a '#' inside a code fence", async () => {
      fs.set(
        `${PROJECT}/手册.md`,
        `# 标题\n\n\`\`\`sh\n# 这是注释\n\`\`\`\n\n## 小节\n${`${"文".repeat(199)}\n`.repeat(30)}`,
      );

      const out = await read({ path: `${PROJECT}/手册.md` });
      const index = out.split("     1\t")[0];

      expect(index).toContain("L1  标题");
      expect(index).toContain("L7  小节");
      // The comment is in the page below, of course — what matters is that it
      // is not offered as a section anyone could name.
      expect(index).not.toContain("这是注释");
    });
  });

  it("errors when start_line is past the end", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, "一\n二");

    expect(await read({ path: `${PROJECT}/writing/ch1.md`, start_line: 9 })).toContain(
      "Error: start_line 9 is past the end of the file, which has 2 line(s).",
    );
  });

  it("reads a file anywhere in the project, not just under writing/", async () => {
    fs.set(`${PROJECT}/大纲.md`, "自由组织");

    expect(await read({ path: `${PROJECT}/大纲.md` })).toContain("自由组织");
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

    expect(out).toContain("2 matching lines in 2 documents");
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

    expect(out).toContain("in 1 document");
    expect(out).toContain("卷一");
    expect(out).not.toContain("卷二");
  });

  it("skips non-manuscript files", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, "sword");
    fs.set(`${PROJECT}/writing/cover.png`, "sword");
    fs.set(`${PROJECT}/writing/notes.txt`, "sword");

    const out = await search({ query: "sword" });

    expect(out).toContain("in 2 documents"); // .md and .txt count; .png doesn't
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

  // A handful of hits means the search FOUND the place, and what happens next
  // is an edit there — which needs the surrounding text. Without this it is
  // another read_file round for a passage this call already had in memory.
  describe("context around a hit", () => {
    it("gives the neighbouring lines when there are few hits", async () => {
      fs.set(`${PROJECT}/writing/ch1.md`, "一\n二\n他握紧那柄断剑。\n四\n五");

      const out = await search({ query: "断剑" });

      expect(out).toContain("> L3: 他握紧那柄断剑。");
      expect(out).toContain("  L1: 一");
      expect(out).toContain("  L5: 五");
      expect(out).toContain('">" marks the matching line');
    });

    it("does not run off the top or bottom of the file", async () => {
      fs.set(`${PROJECT}/writing/ch1.md`, "断剑\n二");
      const out = await search({ query: "断剑" });
      expect(out).toContain("> L1: 断剑");
      expect(out).toContain("  L2: 二");
    });

    // Thirty hits means the query has not found anything yet — the answer is a
    // narrower query, not five times more text.
    it("stays terse when the hits are many", async () => {
      fs.set(`${PROJECT}/writing/ch1.md`, Array.from({ length: 12 }, (_, i) => `剑 ${i}`).join("\n"));

      const out = await search({ query: "剑" });

      expect(out).not.toContain("> L");
      expect(out).toContain("  L1: 剑 0");
    });
  });

  it("caps hits per file and reports how many were omitted", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, Array.from({ length: 20 }, (_, i) => `剑 ${i}`).join("\n"));

    const out = await search({ query: "剑" });

    expect(out).toContain("20 matching lines in 1 document");
    expect(out).toContain("[... 12 more in this file ...]");
    expect(out).toContain("L8:");
    expect(out).not.toContain("L9:");
  });

  it("caps total hits across files and says so", async () => {
    for (let f = 0; f < 10; f++) {
      fs.set(`${PROJECT}/writing/ch${f}.md`, Array.from({ length: 8 }, () => "剑").join("\n"));
    }

    const out = await search({ query: "剑" });

    expect(out).toContain("80 matching lines in 10 documents");
    expect(out).toContain("40 more matching lines in documents not shown");
  });

  it("reports no matches without pretending to have searched nothing", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, "无关内容");

    const out = await search({ query: "断剑" });

    expect(out).toContain('No matches for "断剑"');
    expect(out).toContain("1 document and 0 knowledge-base files searched");
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

    expect(out).toContain("in 1 document");
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
    // An empty category gets no header of its own — it moves to the one-line
    // "no entries yet" summary instead (asserted below).
    expect(out).not.toContain("[world]");
    expect(out).toMatch(/Categories with no entries yet[^\n]*world/);
  });

  /**
   * id↔标签对照。模型看到的一直只有英文文件夹 id，作者说的却是标签——「characters
   * 就是人物」这件事在这里说出来之前，模型的正解是新建一个「人物」分类（真实事故，
   * 见 docs/feature/agent/lore-category-visibility-plan.md）。
   */
  it("pairs a declared category with the label the author actually sees", () => {
    const out = formatLoreIndex(
      { characters: [{ name: "Aria", summary: "骑士" } as never] },
      null,
      undefined,
      true,
    );
    expect(out).toContain("[characters(人物)]");
    // The pairing sentence rides along: parameters take the id, not the label.
    expect(out).toContain("take the id, never the label");
  });

  it("lists declared-but-empty categories as valid targets instead of hiding them", () => {
    const out = formatLoreIndex(
      { characters: [{ name: "Aria", summary: "" } as never] },
      null,
      undefined,
      true,
    );
    expect(out).toContain("Categories with no entries yet");
    expect(out).toContain("world(世界观)");
  });

  it("tells an empty project where entries may go, not just that nothing is here", () => {
    const out = formatLoreIndex({}, null, undefined, true);
    expect(out).toContain("No lore entities found in this project.");
    expect(out).toContain("characters(人物)");
  });

  it("does not call a category emptied by the 取材范围 empty", () => {
    // Under a fence the fence note explains the narrowing; a category whose
    // entries are merely out of scope must not read as "no entries yet".
    const index = {
      characters: [{ name: "Aria", summary: "", collections: ["小说A"] }] as never[],
      world: [] as never[],
    };
    expect(formatLoreIndex(index, "小说A")).not.toContain("Categories with no entries yet");
  });

  /**
   * 取材范围（lib/lore/collections）。被挡掉的条目要**报出数量**：一份安静缩短过的
   * 清单读起来就是「这个项目只有这几条」，模型于是理直气壮地告诉作者他的人物不存在。
   */
  it("narrows to the active collection and says how many it left out", () => {
    const index = {
      characters: [
        { name: "Aria", summary: "骑士", collections: ["小说A"] },
        { name: "Bran", summary: "游侠", collections: ["小说B"] },
        { name: "Dorn", summary: "", collections: [] },
      ] as never[],
    };
    const out = formatLoreIndex(index, "小说A");
    expect(out).toContain("  - Aria [小说A]: 骑士");
    expect(out).not.toContain("Bran");
    expect(out).toContain('collection "小说A"');
    expect(out).toContain("2 further entries are filed elsewhere");
  });

  /**
   * 归属要出现在清单里。模型要归档得**一致**，就得先看得见现有的归档长什么样——
   * 否则它只能一条条 read_lore_entity 读过去，那才是真的贵。
   */
  it("lists the collections and tags each entry with its own", () => {
    const index = {
      characters: [
        { name: "Aria", summary: "骑士", collections: ["小说A", "出版方案"] },
        { name: "Dorn", summary: "", collections: [] },
      ] as never[],
    };
    const out = formatLoreIndex(index, null, ["小说A", "出版方案", "空集合"]);
    expect(out).toContain("Collections: 小说A (1) · 出版方案 (1) · 空集合 (0)");
    expect(out).toContain("  - Aria [小说A, 出版方案]: 骑士");
    // 未归集什么都不标：「没有方括号」就是答案，比写一个 (unfiled) 便宜，而且让
    // 还没分家的条目一眼扫得出来。
    expect(out).toContain("  - Dorn: (no summary)");
  });

  it("costs a project with no collections nothing at all", () => {
    const index = { characters: [{ name: "Aria", summary: "骑士", collections: [] }] as never[] };
    expect(formatLoreIndex(index)).not.toContain("Collections:");
  });

  it("says so when the active collection is empty rather than looking like an empty project", () => {
    const index = { characters: [{ name: "Aria", summary: "", collections: ["小说A"] }] as never[] };
    expect(formatLoreIndex(index, "小说B")).toContain('No lore entities in the collection "小说B"');
  });
});

describe("search_text — 知识库这一侧", () => {
  /**
   * 在这一片之前，`.ai-writer/lore/` 对任何搜索都不可见（Rust 的 read_dir_recursive
   * 跳点目录），于是「哪一条条目提到了青铜钥匙」只能靠逐条 read_lore_entity 试——
   * 五十条条目就是最多五十轮，每轮重发整份工具 schema。
   */
  const LORE = "/proj/.ai-writer/lore";
  const entity = (
    name: string,
    id: string,
    mdFiles: string[],
    collections: string[] = [],
  ) => ({ name, dirPath: `${LORE}/characters/${id}`, mdFiles, images: [], facets: [], collections });

  const KEY = entity("云锦", "yunjin", ["index.md", "outfit.md"]);
  const OTHER = entity("陆沉", "luchen", ["index.md"]);
  const withLore = (args: Record<string, unknown>, over: Partial<ToolContext> = {}) =>
    callFull("search_text", args, { loreIndex: { characters: [KEY, OTHER] } as never, ...over })
      .then((r) => r.content);

  beforeEach(() => {
    fs.set(`${KEY.dirPath}/index.md`, "她收着一枚青铜钥匙。");
    fs.set(`${KEY.dirPath}/outfit.md`, "素色长衫。");
    fs.set(`${OTHER.dirPath}/index.md`, "无关。");
  });

  it("finds the entry that mentions a term, without opening entries one by one", async () => {
    const out = await withLore({ query: "青铜钥匙" });

    expect(out).toContain("Knowledge base — 1 matching line in 1 entry file");
    expect(out).toContain("云锦 · index.md");
    expect(out).toContain("> L1: 她收着一枚青铜钥匙。");
  });

  /**
   * The label is the whole point: `edit_lore_file` takes entity + file, so a
   * hit reported as a path would be a coordinate no write tool on that side
   * accepts — and the model would reach for propose_edit, which refuses
   * .ai-writer.
   */
  it("names the two arguments edit_lore_file actually takes", async () => {
    const out = await withLore({ query: "青铜钥匙" });

    expect(out).toContain("edit_lore_file's 'entity' and 'file' arguments");
    expect(out).not.toContain(`${LORE}/characters/yunjin/index.md`);
  });

  it("keeps the two sides in their own blocks, each with its own counts", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, "青铜钥匙躺在桌上。");

    const out = await withLore({ query: "青铜钥匙" });

    expect(out).toContain("1 matching line in 1 document");
    expect(out).toContain("Knowledge base — 1 matching line in 1 entry file");
    expect(out.indexOf("/proj/writing/ch1.md")).toBeLessThan(out.indexOf("云锦 · index.md"));
  });

  /**
   * A shared cap would let a common word in the manuscript spend the whole
   * allowance before the entry that *defines* it is ever reported.
   */
  it("does not let a flooded manuscript starve the knowledge base", async () => {
    for (let f = 0; f < 10; f++) {
      fs.set(`${PROJECT}/writing/ch${f}.md`, Array.from({ length: 8 }, () => "钥匙").join("\n"));
    }
    fs.set(`${KEY.dirPath}/index.md`, "她收着一枚钥匙。");

    const out = await withLore({ query: "钥匙" });

    expect(out).toContain("40 more matching lines in documents not shown");
    expect(out).toContain("云锦 · index.md");
  });

  /**
   * The context decision is per section: the manuscript here is past the
   * threshold and the knowledge base is not, so only one side loses it.
   */
  it("still gives the lore hit its context when the manuscript is drowning", async () => {
    for (let f = 0; f < 10; f++) {
      fs.set(`${PROJECT}/writing/ch${f}.md`, Array.from({ length: 8 }, () => "钥匙").join("\n"));
    }
    fs.set(`${KEY.dirPath}/index.md`, "上一行\n她收着一枚钥匙。\n下一行");

    const out = await withLore({ query: "钥匙" });

    expect(out).toContain("> L2: 她收着一枚钥匙。");
    expect(out).toContain("  L1: 上一行");
    expect(out).toContain("  L3: 下一行");
  });

  it("skips the gallery manifest, which is not prose", async () => {
    const g = entity("图鉴", "tujian", ["index.md", "images.md"]);
    fs.set(`${g.dirPath}/index.md`, "无关。");
    fs.set(`${g.dirPath}/images.md`, "## a.png\n青铜钥匙");

    const out = await callFull(
      "search_text", { query: "青铜钥匙" }, { loreIndex: { items: [g] } as never },
    ).then((r) => r.content);

    expect(out).toContain('No matches for "青铜钥匙"');
  });

  /**
   * A scan is automatic discovery, which is the one thing 取材范围 narrows —
   * so the fence holds, and the count of what it held back is reported rather
   * than hidden (an entry can still be read by name).
   */
  it("honours 取材范围 and says how many entries it did not search", async () => {
    const inScope = entity("云锦", "yunjin", ["index.md"], ["小说A"]);
    const out = await callFull(
      "search_text",
      { query: "青铜钥匙" },
      { loreIndex: { characters: [inScope, OTHER] } as never, loreScope: "小说A" },
    ).then((r) => r.content);

    expect(out).toContain("云锦 · index.md");
    expect(out).toContain('limited to the collection "小说A"');
    expect(out).toContain("1 further entry is filed elsewhere");
  });

  /**
   * A folder is a manuscript path, so narrowing to one is narrowing to that
   * subtree — not "narrow one side and quietly ignore it on the other". The
   * miss says so, because that is where the wrong conclusion gets drawn.
   */
  it("skips the knowledge base when 'folder' narrows the call, and says it did", async () => {
    fs.set(`${PROJECT}/卷一/ch1.md`, "无关。");

    const out = await withLore({ query: "青铜钥匙", folder: "卷一" });

    expect(out).toContain('No matches for "青铜钥匙"');
    expect(out).toContain("The knowledge base was not searched");
    expect(out).not.toContain("云锦");
  });
});

describe("read_lore_entity — 互斥组标注", () => {
  /**
   * 注入路径一组只挑一条（lib/context/loreSelect 的 group 互斥）；这条路径做不到，
   * 因为「读一条条目」就是读它的全部。少了这句话，模型拿到一个角色的两套服装、
   * 地位相同，然后写出一场混搭——看起来像模型的毛病，其实是少了一句提示。
   */
  const KAEL = "/proj/.ai-writer/lore/characters/kael";
  const index = {
    characters: [{
      name: "Kael",
      dirPath: KAEL,
      mdFiles: ["index.md", "outfit-armor.md", "outfit-casual.md", "backstory.md"],
      images: [],
      facets: [
        { file: "outfit-armor.md", title: "战甲", group: "outfit" },
        { file: "outfit-casual.md", title: "便装", group: "outfit" },
        { file: "backstory.md", title: "背景", group: null },
      ],
    }],
  } as never;

  beforeEach(() => {
    fs.set(KAEL + "/index.md", "A knight.");
    fs.set(KAEL + "/outfit-armor.md", "Silver plate.");
    fs.set(KAEL + "/outfit-casual.md", "Linen dress.");
    fs.set(KAEL + "/backstory.md", "Orphaned young.");
  });

  it("给同组的特征标出互斥，不给无组的加噪声", async () => {
    const { content } = await readLoreEntity("c1", "Kael", index, false);
    expect(content).toContain("=== outfit-armor.md === [group: outfit —");
    expect(content).toContain("=== outfit-casual.md === [group: outfit —");
    expect(content).toContain("=== backstory.md ===\nOrphaned young.");
    expect(content).not.toContain("=== index.md === [group");
  });

  it("两套服装照旧都读得到——标注是提示，不是过滤", async () => {
    const { content } = await readLoreEntity("c1", "Kael", index, false);
    expect(content).toContain("Silver plate.");
    expect(content).toContain("Linen dress.");
  });
});
