/**
 * closeDocument() —— 关掉当前文档的那一个动作（设计稿 01e 屏 1e）。
 *
 * 三个入口（面包屑末尾的 ×、⌘W、文件树右键）共用它，所以「什么时候写盘、什么时候
 * 真的关掉、留不留痕迹」只有这一处定义。这里钉的是它的四条：
 * 干净文档直接关 · 脏文档先落盘再关并留两秒痕迹 · **写盘失败就不关** ·
 * 关一张图片时**不碰**缓冲区里那篇没保存的文档。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../stores/appStore", () => ({
  useAppStore: { getState: () => ({}) },
}));

const h = vi.hoisted(() => ({
  readFile: vi.fn(async (_path: string) => "content"),
  writeFile: vi.fn(async (_path: string, _content: string) => {}),
}));
vi.mock("../fs/fileio", () => ({
  readFile: h.readFile,
  writeFile: h.writeFile,
}));

import { closeDocument, useEditorStore } from "../../stores/editorStore";
import { useProjectStore } from "../../stores/projectStore";

const DOC = "/proj/writing/第十二章.md";
const PIC = "/proj/assets/封面.png";

/** 缓冲区里停着 `path`，脏或不脏。 */
function openBuffer(path: string | null, dirty: boolean) {
  useEditorStore.setState({
    content: "正文", filePath: path, headings: [], isDirty: dirty,
    saveTimer: null, loadError: null, closeNotice: null,
  });
}

describe("closeDocument", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.writeFile.mockClear();
    h.writeFile.mockImplementation(async () => {});
    useProjectStore.setState({ activeFilePath: DOC, wordCount: 3124, charCount: 12480 });
    openBuffer(DOC, false);
  });

  afterEach(() => {
    const { saveTimer } = useEditorStore.getState();
    if (saveTimer) clearTimeout(saveTimer);
    vi.useRealTimers();
  });

  it("关掉干净文档：不写盘、缓冲区清空、不留痕迹", async () => {
    await closeDocument();

    expect(h.writeFile).not.toHaveBeenCalled();
    expect(useProjectStore.getState().activeFilePath).toBeNull();
    expect(useEditorStore.getState().filePath).toBeNull();
    expect(useEditorStore.getState().content).toBe("");
    // 计数归零而不是留着上一篇的——空稿页上没有「3,124 字」这回事。
    expect(useProjectStore.getState().wordCount).toBe(0);
    expect(useEditorStore.getState().closeNotice).toBeNull();
  });

  it("关掉脏文档：先落盘再关，痕迹两秒后自己收走", async () => {
    openBuffer(DOC, true);

    await closeDocument();

    expect(h.writeFile).toHaveBeenCalledWith(DOC, "正文");
    expect(useProjectStore.getState().activeFilePath).toBeNull();
    expect(useEditorStore.getState().closeNotice).toEqual({ name: "第十二章", failed: false });

    await vi.advanceTimersByTimeAsync(2100);
    expect(useEditorStore.getState().closeNotice).toBeNull();
  });

  it("写盘失败就不关：缓冲区是那几行字唯一的副本", async () => {
    openBuffer(DOC, true);
    h.writeFile.mockImplementation(async () => { throw new Error("EACCES"); });

    await closeDocument();

    // 文档还开着、还脏着（saveNow 保住了 isDirty，下一次编辑还会重试），
    // 痕迹说的是「没关成」而不是一句成功回执。
    expect(useProjectStore.getState().activeFilePath).toBe(DOC);
    expect(useEditorStore.getState().filePath).toBe(DOC);
    expect(useEditorStore.getState().isDirty).toBe(true);
    expect(useEditorStore.getState().closeNotice).toEqual({ name: "第十二章", failed: true });
  });

  it("关掉一张图片，不碰缓冲区里那篇还没保存的文档", async () => {
    // 作者打开图片时缓冲区**有意**停在上一篇（AI 侧靠 WritingFocus 判断「还没
    // 就绪」）。关掉图片顺手清缓冲区，等于把那篇的待写自动保存一起取消掉。
    openBuffer(DOC, true);
    useEditorStore.getState().setContent("又写了一句"); // 装上真实的 2s 自动保存
    useProjectStore.setState({ activeFilePath: PIC });

    await closeDocument();

    expect(useProjectStore.getState().activeFilePath).toBeNull();
    expect(useEditorStore.getState().filePath).toBe(DOC);
    expect(useEditorStore.getState().isDirty).toBe(true);
    expect(useEditorStore.getState().closeNotice).toBeNull();
    expect(h.writeFile).not.toHaveBeenCalled();

    // 那次自动保存仍然会到点落盘。
    await vi.advanceTimersByTimeAsync(2100);
    expect(h.writeFile).toHaveBeenCalledWith(DOC, "又写了一句");
  });
});
