/**
 * The manuscript read tools against an in-memory project:
 *   - list_files  — recursive grouped listing, natural order, caps
 *   - read_file   — line-based paging and its budget
 *   - search_text — recursive scan, snippet windowing, result caps
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
 * in-memory paths — so tests declare files, not directory objects.
 */
vi.mock("../project", () => ({
  readDirRecursive: vi.fn(async (dir: string) => {
    interface Node { name: string; path: string; is_dir: boolean; children?: Node[] }
    const roots: Node[] = [];
    const dirs = new Map<string, Node>();
    for (const path of fs.keys()) {
      if (!path.startsWith(dir + "/")) continue;
      const segments = path.slice(dir.length + 1).split("/");
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

import { executeRegisteredTool, type ToolContext, type ToolId } from "../agent/registry";

const PROJECT = "/proj";
const ALLOWED: ToolId[] = ["list_files", "read_file", "search_text"];

const ctx: ToolContext = {
  projectPath: PROJECT,
  loreIndex: {},
  multimodal: false,
};

async function call(name: ToolId, args: Record<string, unknown>): Promise<string> {
  const result = await executeRegisteredTool(
    { id: "c1", name, arguments: JSON.stringify(args) },
    ALLOWED,
    ctx,
  );
  return result.content;
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
    fs.set(`${PROJECT}/writing/序章.md`, "x");
    fs.set(`${PROJECT}/writing/卷一/第1章.md`, "x");
    fs.set(`${PROJECT}/writing/卷一/第2章.md`, "x");
    fs.set(`${PROJECT}/writing/卷二/第3章.md`, "x");

    const out = await list();

    expect(out).toContain("4 files in 3 folders under writing/");
    expect(out).toContain(`${PROJECT}/writing\n  序章.md`);
    expect(out).toContain(`${PROJECT}/writing/卷一\n  第1章.md\n  第2章.md`);
    expect(out).toContain(`${PROJECT}/writing/卷二\n  第3章.md`);
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
    fs.set(`${PROJECT}/writing/卷一/第1章.md`, "x");
    fs.set(`${PROJECT}/writing/卷二/第2章.md`, "x");

    const out = await list({ folder: "卷一" });

    expect(out).toContain("第1章.md");
    expect(out).not.toContain("第2章.md");
  });

  it("rejects a folder that escapes writing/", async () => {
    expect(await list({ folder: "../.ai-writer" })).toContain(
      "Error: Folder is outside the project writing directory.",
    );
  });

  it("reports an empty manuscript", async () => {
    expect(await list()).toContain("No files found in writing/.");
  });
});

describe("read_file", () => {
  it("returns a short file whole, with no paging note", async () => {
    fs.set(`${PROJECT}/writing/ch1.md`, "第一行\n第二行");

    const out = await read({ path: `${PROJECT}/writing/ch1.md` });

    expect(out).toBe("第一行\n第二行");
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

  it("rejects a path outside the project", async () => {
    expect(await read({ path: "/etc/passwd" })).toContain(
      "Error: Path is outside the project writing directory.",
    );
  });

  it("rejects a path inside the project but outside writing/", async () => {
    fs.set(`${PROJECT}/.ai-writer/profile.json`, "{}");

    expect(await read({ path: `${PROJECT}/.ai-writer/profile.json` })).toContain(
      "Error: Path is outside the project writing directory.",
    );
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
    fs.set(`${PROJECT}/writing/卷一/第1章.md`, "断剑");
    fs.set(`${PROJECT}/writing/卷二/第1章.md`, "断剑");

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

  it("rejects a folder that escapes writing/", async () => {
    fs.set(`${PROJECT}/.ai-writer/lore/characters/ava/index.md`, "断剑");

    const out = await search({ query: "断剑", folder: "../.ai-writer/lore" });

    expect(out).toContain("Error: Folder is outside the project writing directory.");
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
