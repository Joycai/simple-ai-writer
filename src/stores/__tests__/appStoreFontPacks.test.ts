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
    applied: [] as [string, string][],
    removeGate: null as Promise<void> | null,
    /** Bytes on disk per pack while it isn't installed. */
    leftover: new Map<string, number>(),
  };
});

vi.mock("../../lib/theme/fontPacks", async (orig) => {
  const real = await orig<typeof import("../../lib/theme/fontPacks")>();
  return {
    ...real,
    fontPackData: async (id: string) => ({ id, version: "1", weights: [{ weight: 400, sheet: ["s.css", 10, ""], chunks: [["a.woff2", 90, ""]] }] }),
    readInstalled: async (id: string) => h.installed.has(id),
    leftoverBytes: async (id: string) => (h.installed.has(id) ? 0 : (h.leftover.get(id) ?? 0)),
    installFontPack: h.install,
    packFacesCss: h.faces,
    removeFontPack: async (id: string) => {
      if (h.removeGate) await h.removeGate;
      h.installed.delete(id);
      h.leftover.delete(id);
    },
  };
});
vi.mock("../../lib/theme/install", async (orig) => ({
  ...(await orig<typeof import("../../lib/theme/install")>()),
  applyFontFaces: (id: string, css: string) => void h.applied.push([id, css]),
}));

import { FontPackError } from "../../lib/theme/fontPacks";
import { useAppStore } from "../appStore";

const state = () => useAppStore.getState();
const fresh = () =>
  useAppStore.setState({
    fontScheme: "manuscript",
    fontFaces: {},
    fontPacks: {
      harmonyos: { status: "absent", done: 0, total: 0 },
      misans: { status: "absent", done: 0, total: 0 },
    },
  });

beforeEach(() => {
  h.installed.clear();
  h.leftover.clear();
  h.applied.length = 0;
  h.removeGate = null;
  h.faces.mockReset().mockImplementation(async (ids: string[]) => ids.map((id) => `/*${id}*/`).join("\n"));
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
    expect(state().fontFaces.misans).toBe("/*misans*/");
    expect(h.applied[h.applied.length - 1]).toEqual(["misans", "/*misans*/"]);
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
    expect(state().fontFaces.misans).toBe("");
    expect(h.applied[h.applied.length - 1]).toEqual(["misans", ""]);
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

describe("what a failed download leaves behind", () => {
  it("a failure records the bytes it left, and clearing the pack in use switches to 黑 and forgets them", async () => {
    h.install.mockImplementation(async (id: string) => {
      h.leftover.set(id, 2_600_000);
      throw new FontPackError("network", "down");
    });
    state().setFontScheme("misans");
    await state().downloadFontPack("misans");
    expect(state().fontPacks.misans).toMatchObject({ status: "error", leftover: 2_600_000 });

    await state().removeFontPack("misans");
    expect(state().fontScheme).toBe("hei");
    expect(state().fontPacks.misans.status).toBe("absent");
    expect(state().fontPacks.misans.leftover).toBeUndefined();
  });

  it("a failure that left nothing offers nothing to clear", async () => {
    h.install.mockRejectedValue(new FontPackError("network", "down"));
    await state().downloadFontPack("misans");
    expect(state().fontPacks.misans.leftover).toBeUndefined();
  });

  it("the leftovers outlive a restart (the error doesn't), and a finished download drops them", async () => {
    h.leftover.set("misans", 1_000);
    await state().initFontPacks({ download: false });
    expect(state().fontPacks.misans).toMatchObject({ status: "absent", leftover: 1_000 });
    expect(state().fontPacks.harmonyos.leftover).toBeUndefined();

    await state().downloadFontPack("misans");
    expect(state().fontPacks.misans.status).toBe("ready");
    expect(state().fontPacks.misans.leftover).toBeUndefined();
  });
});

describe("the disk is the truth, not the state", () => {
  it("re-picking a pack another window deleted fetches it again", async () => {
    useAppStore.setState({ fontPacks: { ...state().fontPacks, misans: { status: "ready", done: 100, total: 100 } } });
    state().setFontScheme("misans"); // state says ready; the disk doesn't have it
    await state().downloadFontPack("misans");
    expect(h.install).toHaveBeenCalledTimes(1);
    expect(state().fontPacks.misans.status).toBe("ready");
  });

  it("a pick during a removal waits for it, then downloads", async () => {
    await state().downloadFontPack("misans");
    state().setFontScheme("song");
    let open!: () => void;
    h.removeGate = new Promise<void>((r) => (open = r));
    const removing = state().removeFontPack("misans");
    try {
      expect(state().fontPacks.misans.status).toBe("absent");
      state().setFontScheme("misans"); // picked again mid-removal
    } finally {
      open(); // never leave a removal hanging for the tests after this one
    }
    await removing;
    await state().downloadFontPack("misans");
    expect(h.install).toHaveBeenCalledTimes(2);
    expect(state().fontPacks.misans.status).toBe("ready");
    expect(h.installed.has("misans")).toBe(true);
  });

  it("one pack's unreadable faces don't take the other pack's down", async () => {
    h.installed.add("harmonyos").add("misans");
    h.faces.mockImplementation(async (ids: string[]) => {
      if (ids.includes("misans")) throw new Error("gone");
      return "/*harmonyos*/";
    });
    await state().initFontPacks();
    expect(state().fontFaces).toEqual({ harmonyos: "/*harmonyos*/", misans: "" });
  });
});

describe("reloadFromPrefs × font packs", () => {
  it("a config import (no keys) fetches the chosen pack", async () => {
    localStorage.setItem("app:fontScheme", "misans");
    state().reloadFromPrefs();
    await state().downloadFontPack("misans");
    expect(h.install).toHaveBeenCalledTimes(1);
  });

  it("another window's change (focus sync) only looks — it never downloads", async () => {
    localStorage.setItem("app:fontScheme", "misans");
    state().reloadFromPrefs(["app:fontScheme"]);
    await Promise.resolve();
    expect(state().fontScheme).toBe("misans");
    expect(h.install).not.toHaveBeenCalled();
  });
});

describe("initFontPacks", () => {
  it("reads which packs are here, sets their sizes, injects their faces", async () => {
    h.installed.add("harmonyos");
    await state().initFontPacks();
    expect(state().fontPacks.harmonyos).toEqual({ status: "ready", done: 100, total: 100 });
    expect(state().fontPacks.misans).toEqual({ status: "absent", done: 0, total: 100 });
    expect(state().fontFaces).toEqual({ harmonyos: "/*harmonyos*/", misans: "" });
    expect(h.install).not.toHaveBeenCalled();
  });

  it("fetches the chosen pack when this machine doesn't have it (a restored backup)", async () => {
    useAppStore.setState({ fontScheme: "misans" });
    await state().initFontPacks();
    await state().downloadFontPack("misans");
    expect(h.install).toHaveBeenCalledTimes(1);
    expect(state().fontPacks.misans.status).toBe("ready");
  });

  it("without download, it only looks", async () => {
    useAppStore.setState({ fontScheme: "misans" });
    await state().initFontPacks({ download: false });
    expect(h.install).not.toHaveBeenCalled();
    expect(state().fontPacks.misans.status).toBe("absent");
  });

  it("keeps a failure's error code when the pack still isn't here", async () => {
    useAppStore.setState({ fontPacks: { ...state().fontPacks, misans: { status: "error", error: "integrity", done: 0, total: 0 } } });
    await state().initFontPacks({ download: false });
    expect(state().fontPacks.misans).toEqual({ status: "error", error: "integrity", done: 0, total: 100 });
  });

  it("the stored choice survives validation", () => {
    localStorage.setItem("app:fontScheme", "harmonyos");
    state().reloadFromPrefs(["app:fontScheme"]);
    expect(state().fontScheme).toBe("harmonyos");
  });
});
