/**
 * Which files the `@` picker offers, derived from the project tree.
 *
 * The classification is the whole feature: a kind this misses is a file the
 * author can see in the sidebar and cannot hand to the assistant.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));

const { classifyProjectFile, projectFilesFromTree } = await import("../fs/images");
type Node = Parameters<typeof projectFilesFromTree>[0][number];

const file = (name: string, dir = "/p"): Node => ({
  name,
  path: `${dir}/${name}`,
  is_dir: false,
});

describe("projectFilesFromTree", () => {
  it("takes text documents, html deliverables and images", () => {
    const files = projectFilesFromTree([
      file("第1章.md"),
      file("笔记.txt"),
      file("旧稿.markdown"),
      file("架构图.HTML"),
      file("页面.htm"),
      file("封面.png"),
    ]);
    expect(files.map((f) => [f.name, f.kind])).toEqual([
      ["第1章.md", "text"],
      ["笔记.txt", "text"],
      ["旧稿.markdown", "text"],
      ["架构图.HTML", "text"],
      ["页面.htm", "text"],
      ["封面.png", "image"],
    ]);
  });

  it("skips what neither the editor nor a model can read", () => {
    const files = projectFilesFromTree([
      file("标书.docx"),
      file("project.db"),
      file("noext"),
    ]);
    expect(files).toEqual([]);
  });

  it("descends into folders and keeps their paths", () => {
    const files = projectFilesFromTree([
      { name: "第一卷", path: "/p/第一卷", is_dir: true, children: [file("第1章.md", "/p/第一卷")] },
      { name: "空的", path: "/p/空的", is_dir: true },
      file("大纲.md"),
    ]);
    expect(files.map((f) => f.path)).toEqual(["/p/第一卷/第1章.md", "/p/大纲.md"]);
  });
});

// The single-file entry point (file tree's 发送到助手) must answer exactly as
// the tree walk does — it is the same classification, exposed for one node.
describe("classifyProjectFile", () => {
  it("agrees with projectFilesFromTree on every kind", () => {
    expect(classifyProjectFile("第1章.md", "/p/第1章.md")).toEqual({
      name: "第1章.md", path: "/p/第1章.md", kind: "text",
    });
    expect(classifyProjectFile("封面.PNG", "/p/封面.PNG")?.kind).toBe("image");
    expect(classifyProjectFile("页面.htm", "/p/页面.htm")?.kind).toBe("text");
  });

  it("refuses what no model can take raw", () => {
    expect(classifyProjectFile("标书.docx", "/p/标书.docx")).toBeNull();
    expect(classifyProjectFile("project.db", "/p/project.db")).toBeNull();
    expect(classifyProjectFile("noext", "/p/noext")).toBeNull();
  });
});
