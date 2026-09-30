/**
 * whenFocusSettles() —— 一个手势里既打开文件又发一轮对话时，等缓冲区追上。
 *
 * `setActiveFilePath` 是同步的，编辑器的载入是提交后的 effect；中间发出的那一轮
 * 取到的焦点是点击前的那一篇。这里钉的是它的三条：已经是那一篇就立刻回 ·
 * 缓冲区追上就回 true · 超时、载入失败、作者转头打开或关掉了别的就回 false。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../appStore", () => ({
  useAppStore: { getState: () => ({}) },
}));
vi.mock("../../lib/fs/fileio", () => ({
  readFile: vi.fn(async () => "content"),
  writeFile: vi.fn(async () => {}),
}));

import { useEditorStore } from "../editorStore";
import { focusBlockOf, getWritingFocus, whenFocusSettles } from "../openDocument";
import { useProjectStore } from "../projectStore";

const NOTE = "/proj/卷一/index.md";
const OLD = "/proj/卷一/第3章.md";

function buffer(path: string | null) {
  useEditorStore.setState({
    content: "正文", filePath: path, headings: [], isDirty: false,
    saveTimer: null, loadError: null, crumbTrace: null,
  });
}

describe("whenFocusSettles", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    buffer(OLD);
    useProjectStore.setState({ activeFilePath: NOTE });
  });
  afterEach(() => vi.useRealTimers());

  it("resolves at once when the editor already holds the file", async () => {
    buffer(NOTE);
    await expect(whenFocusSettles(NOTE)).resolves.toBe(true);
  });

  it("resolves true once the editor catches up", async () => {
    const p = whenFocusSettles(NOTE);
    buffer(NOTE);
    await expect(p).resolves.toBe(true);
  });

  it("gives up after the timeout with the old document still in the buffer", async () => {
    const p = whenFocusSettles(NOTE, 1000);
    vi.advanceTimersByTime(1000);
    await expect(p).resolves.toBe(false);
  });

  it("gives up when the author opens something else in the meantime", async () => {
    const p = whenFocusSettles(NOTE);
    useProjectStore.setState({ activeFilePath: "/proj/卷二/第1章.md" });
    await expect(p).resolves.toBe(false);
  });

  it("gives up at once when the document is closed or deleted, not after the timeout", async () => {
    const p = whenFocusSettles(NOTE);
    useProjectStore.setState({ activeFilePath: null });
    await expect(p).resolves.toBe(false);
  });

  it("gives up at once when the load of that file fails", async () => {
    const p = whenFocusSettles(NOTE);
    useEditorStore.setState({ loadError: { path: NOTE, message: "not utf-8" } });
    await expect(p).resolves.toBe(false);
  });

  it("ignores a load error left behind by an earlier attempt on the same file", async () => {
    useEditorStore.setState({ loadError: { path: NOTE, message: "earlier" } });
    const p = whenFocusSettles(NOTE);
    useEditorStore.setState({ wordCount: 3 });
    buffer(NOTE);
    await expect(p).resolves.toBe(true);
  });

  it("is over before it starts when nobody opened that file", async () => {
    useProjectStore.setState({ activeFilePath: OLD });
    await expect(whenFocusSettles(NOTE)).resolves.toBe(false);
  });

  it("is over before it starts for a file the editor never loads", async () => {
    // No timer advance: a .pptx or a picture has no load whose end to wait for.
    for (const path of ["/proj/卷一/调研.pptx", "/proj/卷一/封面.png"]) {
      useProjectStore.setState({ activeFilePath: path });
      await expect(whenFocusSettles(path)).resolves.toBe(false);
    }
  });
});

/**
 * focusBlockOf() —— 焦点没就绪时，是「还在载入」还是「永远不会载入」。
 *
 * AI 面板靠它决定那一行说什么：一份 `.pptx` 底下写着「正在载入…」读起来就是卡死了。
 */
describe("focusBlockOf", () => {
  const open = (path: string | null) => useProjectStore.setState({ activeFilePath: path });
  const block = () => focusBlockOf(getWritingFocus(), useEditorStore.getState().loadError);

  beforeEach(() => buffer(OLD));

  it("nothing blocks a settled focus, or no document at all", () => {
    open(OLD);
    expect(block()).toBeNull();
    open(null);
    expect(block()).toBeNull();
  });

  it("an ordinary load in flight is not a block", () => {
    open(NOTE);
    expect(block()).toBeNull();
  });

  it("a picture is 'image'", () => {
    open("/proj/卷一/封面.png");
    expect(block()).toBe("image");
  });

  it("a convertible file is 'notDocument' without any read having failed", () => {
    open("/proj/卷一/调研.pptx");
    expect(block()).toBe("notDocument");
  });

  it("a file whose read failed is 'notDocument'; someone else's failure is not", () => {
    open("/proj/卷一/素材.zip");
    expect(block()).toBeNull();
    useEditorStore.setState({ loadError: { path: "/proj/卷一/别的.zip", message: "x" } });
    expect(block()).toBeNull();
    useEditorStore.setState({ loadError: { path: "/proj/卷一/素材.zip", message: "x" } });
    expect(block()).toBe("notDocument");
  });
});
