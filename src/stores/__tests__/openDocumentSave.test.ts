/**
 * saveDocument() —— ⌘S 的那一个动作。
 *
 * 钉四条：干净的缓冲区**不写**（外面改过的文件不被陈旧缓冲区盖掉）· 写盘失败
 * **不抛**（⌘S 的监听器没人接这个 rejection），而是在面包屑尾巴留一道「保存
 * 失败 · 名字」两秒，isDirty 照旧是 true · 成功不留痕迹 · 失败说的是**缓冲区**
 * 里那一篇，不是作者此刻看着的那张图片。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../appStore", () => ({
  useAppStore: { getState: () => ({}) },
}));

const h = vi.hoisted(() => ({
  readFile: vi.fn(async (_path: string) => "content"),
  writeFile: vi.fn(async (_path: string, _content: string) => {}),
}));
vi.mock("../../lib/fs/fileio", () => ({
  readFile: h.readFile,
  writeFile: h.writeFile,
}));

import { useEditorStore } from "../editorStore";
import { loadIntoEditor, saveDocument } from "../openDocument";
import { useProjectStore } from "../projectStore";

const DOC = "/proj/writing/第十二章.md";
const PIC = "/proj/assets/封面.png";

describe("saveDocument", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.writeFile.mockClear();
    h.writeFile.mockImplementation(async () => {});
    useProjectStore.setState({ activeFilePath: DOC });
    useEditorStore.setState({
      content: "正文", filePath: DOC, headings: [], isDirty: true,
      saveTimer: null, loadError: null, crumbTrace: null,
    });
  });

  afterEach(() => {
    const { saveTimer } = useEditorStore.getState();
    if (saveTimer) clearTimeout(saveTimer);
    vi.useRealTimers();
  });

  it("写盘成功：落盘、变干净、不留痕迹", async () => {
    await saveDocument();

    expect(h.writeFile).toHaveBeenCalledWith(DOC, "正文");
    expect(useEditorStore.getState().isDirty).toBe(false);
    expect(useEditorStore.getState().crumbTrace).toBeNull();
  });

  it("干净的缓冲区不写盘：在外面改过的文件不被陈旧的缓冲区盖掉", async () => {
    useEditorStore.setState({ isDirty: false });

    await saveDocument();

    expect(h.writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().crumbTrace).toBeNull();
  });

  it("写盘失败：不抛，留两秒「保存失败」痕迹，缓冲区还脏着", async () => {
    h.writeFile.mockImplementation(async () => { throw new Error("EACCES"); });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(saveDocument()).resolves.toBeUndefined();

    expect(useEditorStore.getState().isDirty).toBe(true);
    expect(useEditorStore.getState().crumbTrace).toEqual({ name: "第十二章", kind: "saveFailed" });

    await vi.advanceTimersByTimeAsync(2100);
    expect(useEditorStore.getState().crumbTrace).toBeNull();
    spy.mockRestore();
  });

  it("看着图片按 ⌘S 失败时，痕迹说的是缓冲区里那一篇", async () => {
    useProjectStore.setState({ activeFilePath: PIC });
    h.writeFile.mockImplementation(async () => { throw new Error("ENOSPC"); });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await saveDocument();

    expect(useEditorStore.getState().crumbTrace).toEqual({ name: "第十二章", kind: "saveFailed" });
    spy.mockRestore();
  });
});

describe("loadIntoEditor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.writeFile.mockClear();
    h.writeFile.mockImplementation(async () => {});
    useEditorStore.setState({
      content: "正文", filePath: DOC, headings: [], isDirty: true,
      saveTimer: null, loadError: null, crumbTrace: null,
    });
  });

  afterEach(() => {
    const { saveTimer } = useEditorStore.getState();
    if (saveTimer) clearTimeout(saveTimer);
    vi.useRealTimers();
  });

  it("换下的那篇写盘失败：不抛、不切，痕迹说的是没写下去的那一篇", async () => {
    h.writeFile.mockImplementation(async () => { throw new Error("ENOSPC"); });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(loadIntoEditor("/proj/writing/第十三章.md")).resolves.toBeUndefined();

    expect(useEditorStore.getState().filePath).toBe(DOC);
    expect(useEditorStore.getState().isDirty).toBe(true);
    expect(useEditorStore.getState().crumbTrace).toEqual({ name: "第十二章", kind: "saveFailed" });
    spy.mockRestore();
  });

  it("切换成功不留痕迹", async () => {
    await loadIntoEditor("/proj/writing/第十三章.md");

    expect(useEditorStore.getState().filePath).toBe("/proj/writing/第十三章.md");
    expect(useEditorStore.getState().crumbTrace).toBeNull();
  });
});
