/**
 * 字体方案 × 可下载字体包（appStore 的 fontPacks 一片）。
 *
 * 「选了」和「有了」是两件事：`app:fontScheme` 只记选择，文件在不在本机看磁盘。
 * 这里钉住：选中未下载的包就开始下载、下载中重复点只跑一次、失败带错误码且保留
 * 选择、删在用的包先退回黑体、启动时读盘并补下被选中却缺席的包。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const mem = new Map<string, string>();
  const g = globalThis as Record<string, unknown>;
  g.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  };
  const noop = () => {};
  g.window = {
    addEventListener: noop,
    removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  };
  g.document = {
    documentElement: { setAttribute: noop, getAttribute: () => null },
    addEventListener: noop,
    removeEventListener: noop,
  };
  return {
    installed: new Set<string>(),
    install: vi.fn(),
    faces: vi.fn(async (ids: string[]) => ids.map((id) => `/*${id}*/`).join("\n")),
    applied: [] as string[],
  };
});

vi.mock("../../lib/theme/fontPacks", async (orig) => {
  const real = await orig<typeof import("../../lib/theme/fontPacks")>();
  return {
    ...real,
    fontPackData: async (id: string) => ({ id, version: "1", weights: [{ weight: 400, sheet: ["s.css", 10, ""], chunks: [["a.woff2", 90, ""]] }] }),
    readInstalled: async (id: string) => h.installed.has(id),
    installFontPack: h.install,
    packFacesCss: h.faces,
    removeFontPack: async (id: string) => void h.installed.delete(id),
  };
});
vi.mock("../../lib/theme/install", async (orig) => ({
  ...(await orig<typeof import("../../lib/theme/install")>()),
  applyFontFaces: (css: string) => void h.applied.push(css),
}));

import { FontPackError } from "../../lib/theme/fontPacks";
import { useAppStore } from "../appStore";

const state = () => useAppStore.getState();
const fresh = () =>
  useAppStore.setState({
    fontScheme: "manuscript",
    fontFaces: "",
    fontPacks: {
      harmonyos: { status: "absent", done: 0, total: 0 },
      misans: { status: "absent", done: 0, total: 0 },
    },
  });

beforeEach(() => {
  h.installed.clear();
  h.applied.length = 0;
  h.install.mockReset().mockImplementation(async (id: string, opts?: { onProgress?: (d: number, t: number) => void }) => {
    opts?.onProgress?.(50, 100);
    opts?.onProgress?.(100, 100);
    h.installed.add(id);
  });
  fresh();
});

describe("setFontScheme × font packs", () => {
  it("picking a pack that isn't here starts its download, and it lands ready with faces injected", async () => {
    state().setFontScheme("misans");
    expect(state().fontScheme).toBe("misans");
    expect(state().fontPacks.misans.status).toBe("downloading");
    await state().downloadFontPack("misans"); // joins the running one
    expect(h.install).toHaveBeenCalledTimes(1);
    expect(state().fontPacks.misans).toMatchObject({ status: "ready", done: 100 });
    expect(state().fontFaces).toBe("/*misans*/");
    expect(h.applied[h.applied.length - 1]).toBe("/*misans*/");
    expect(localStorage.getItem("app:fontScheme")).toBe("misans");
  });

  it("a system scheme downloads nothing", () => {
    state().setFontScheme("kai");
    expect(h.install).not.toHaveBeenCalled();
  });

  it("a failure keeps the choice and records the code", async () => {
    h.install.mockRejectedValue(new FontPackError("integrity", "bad"));
    state().setFontScheme("harmonyos");
    await state().downloadFontPack("harmonyos");
    expect(state().fontScheme).toBe("harmonyos");
    expect(state().fontPacks.harmonyos).toMatchObject({ status: "error", error: "integrity" });

    // Retry clears the error and succeeds.
    h.install.mockReset().mockImplementation(async (id: string) => void h.installed.add(id));
    await state().downloadFontPack("harmonyos");
    expect(state().fontPacks.harmonyos.status).toBe("ready");
    expect(state().fontPacks.harmonyos.error).toBeUndefined();
  });

  it("an unknown failure is reported as network", async () => {
    h.install.mockRejectedValue(new Error("boom"));
    await state().downloadFontPack("misans");
    expect(state().fontPacks.misans.error).toBe("network");
  });

  it("a pack already on disk is marked ready without fetching", async () => {
    h.installed.add("misans");
    await state().downloadFontPack("misans");
    expect(h.install).not.toHaveBeenCalled();
    expect(state().fontPacks.misans.status).toBe("ready");
  });
});

describe("removeFontPack", () => {
  it("deleting the pack in use switches to 黑 first, then forgets it", async () => {
    state().setFontScheme("misans");
    await state().downloadFontPack("misans");
    await state().removeFontPack("misans");
    expect(state().fontScheme).toBe("hei");
    expect(state().fontPacks.misans.status).toBe("absent");
    expect(state().fontFaces).toBe("");
    expect(h.install).toHaveBeenCalledTimes(1); // switching to 黑 downloads nothing
  });

  it("deleting a pack not in use leaves the choice alone", async () => {
    await state().downloadFontPack("harmonyos");
    state().setFontScheme("song");
    await state().removeFontPack("harmonyos");
    expect(state().fontScheme).toBe("song");
    expect(state().fontPacks.harmonyos.status).toBe("absent");
  });
});

describe("initFontPacks", () => {
  it("reads which packs are here, sets their sizes, injects their faces", async () => {
    h.installed.add("harmonyos");
    await state().initFontPacks();
    expect(state().fontPacks.harmonyos).toEqual({ status: "ready", done: 100, total: 100 });
    expect(state().fontPacks.misans).toEqual({ status: "absent", done: 0, total: 100 });
    expect(state().fontFaces).toBe("/*harmonyos*/");
    expect(h.install).not.toHaveBeenCalled();
  });

  it("fetches the chosen pack when this machine doesn't have it (a restored backup)", async () => {
    useAppStore.setState({ fontScheme: "misans" });
    await state().initFontPacks();
    await state().downloadFontPack("misans");
    expect(h.install).toHaveBeenCalledTimes(1);
    expect(state().fontPacks.misans.status).toBe("ready");
  });

  it("the stored choice survives validation", () => {
    localStorage.setItem("app:fontScheme", "harmonyos");
    state().reloadFromPrefs(["app:fontScheme"]);
    expect(state().fontScheme).toBe("harmonyos");
  });
});
