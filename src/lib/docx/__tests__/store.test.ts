/**
 * 预设列表的几条纯逻辑。真正要钉住的是**默认指向一个不存在的预设**时会发生
 * 什么——删掉默认那一套之后如果不复核，下一次导出就会报「找不到格式」，而那
 * 时作者早就忘了自己删过东西。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../project", () => ({ getGlobalDb: async () => { throw new Error("no db in tests"); } }));
vi.mock("../../prefs", () => {
  const store = new Map<string, string>();
  return {
    readPref: (k: string) => store.get(k) ?? "",
    writePref: (k: string, v: string) => { store.set(k, v); },
  };
});

import { BUILTIN_FORMATS, DEFAULT_FORMAT_ID } from "../format";
import { nextCustomId, useDocFormatStore } from "../../../stores/docFormatStore";

describe("新预设的 id", () => {
  it("从现有 id 推下一个序号——同一份列表永远得到同一个答案", () => {
    expect(nextCustomId(BUILTIN_FORMATS)).toBe("custom-1");
    const withOne = [...BUILTIN_FORMATS, { ...BUILTIN_FORMATS[0], id: "custom-1", builtin: false }];
    expect(nextCustomId(withOne)).toBe("custom-2");
  });

  it("补空档，不是一直往后加", () => {
    const gapped = [
      { ...BUILTIN_FORMATS[0], id: "custom-2", builtin: false },
      { ...BUILTIN_FORMATS[0], id: "custom-3", builtin: false },
    ];
    expect(nextCustomId(gapped)).toBe("custom-1");
  });
});

describe("默认预设", () => {
  it("初始值落在一个真实存在的预设上", () => {
    const { presets, defaultId } = useDocFormatStore.getState();
    expect(presets.some((p) => p.id === defaultId)).toBe(true);
    expect(defaultId).toBe(DEFAULT_FORMAT_ID);
  });

  it("选中和默认是两条独立的通道", () => {
    const { setDefault, select } = useDocFormatStore.getState();
    select("gongwen");
    expect(useDocFormatStore.getState().defaultId).toBe(DEFAULT_FORMAT_ID);
    expect(useDocFormatStore.getState().selectedId).toBe("gongwen");
    setDefault("bid");
    expect(useDocFormatStore.getState().defaultId).toBe("bid");
    // 设了默认不该顺手改掉「我在看哪一个」
    expect(useDocFormatStore.getState().selectedId).toBe("gongwen");
  });

  it("读不出自建预设也不该让这一页打不开", async () => {
    // getGlobalDb 在测试里直接抛错——hydrate 必须吞掉它，只显示内置那几套。
    await useDocFormatStore.getState().hydrate();
    expect(useDocFormatStore.getState().hydrated).toBe(true);
    expect(useDocFormatStore.getState().presets).toHaveLength(BUILTIN_FORMATS.length);
  });
});
