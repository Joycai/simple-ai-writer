/**
 * 排版格式过配置备份这道门。
 *
 * 同 `configTransferPrompts.test.ts` 守着的是同一类事故：`parseConfigBundle`
 * 逐字段重建每一条，所以**它没点名的字段会被安静地丢掉**——一份备份还原之后
 * 页边距全变回默认，而任何地方都不会报错。
 *
 * 这里另外钉两条只属于排版格式的规矩：备份里的一律当自建（内置那几套随版本
 * 走，不该被一份旧备份改写），以及一份还没有排版格式的旧备份要照常打开。
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
  execute: vi.fn(async () => {}),
  select: vi.fn(async () => [] as { name: string }[]),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.0.0-test" }));
vi.mock("../project", () => ({
  getGlobalDb: async () => ({ execute: h.execute, select: h.select }),
  getGlobalDbPath: async () => "/app-data/config.db",
}));
vi.mock("../keyStore", () => ({ saveApiKey: async () => {}, loadApiKey: async () => null }));
vi.mock("../fs/transfer", () => ({
  openTextFileDialog: async () => null,
  saveTextFileDialog: async () => null,
}));

const { parseConfigBundle, CONFIG_BACKUP_KIND } = await import("../ai/configTransfer");
const { BUILTIN_FORMATS } = await import("../docx/format");

const GONGWEN = BUILTIN_FORMATS.find((p) => p.id === "gongwen")!.format;

const bundle = (docFormats: unknown[] | undefined) => ({
  kind: CONFIG_BACKUP_KIND,
  version: 1,
  providers: [],
  models: [],
  prompts: [{ id: "sys", name: "系统", content: "hi", scene: "system" }],
  prefs: [],
  ...(docFormats === undefined ? {} : { docFormats }),
});

const parse = (raw: unknown) => parseConfigBundle(raw, []);

describe("parseConfigBundle · 排版格式", () => {
  it("整套格式原样过门——页边距、网格、页码、标题编号一个都不能掉", () => {
    const out = parse(bundle([{ id: "custom-1", label: "甲方标书", format: GONGWEN }]));
    expect(out.docFormats).toHaveLength(1);
    expect(out.docFormats[0].format).toEqual(GONGWEN);
  });

  it("记得它是从哪份文件模仿来的", () => {
    const out = parse(bundle([
      { id: "custom-1", label: "甲方标书", imitatedFrom: "甲方模板.docx", format: GONGWEN },
    ]));
    expect(out.docFormats[0].imitatedFrom).toBe("甲方模板.docx");
  });

  it("备份里的一律当自建——内置那几套随版本走，不该被旧备份改写", () => {
    const out = parse(bundle([{ id: "gongwen", label: "公文", builtin: true, format: GONGWEN }]));
    expect(out.docFormats[0].builtin).toBe(false);
  });

  it("一条里的一个字段坏了，那一条其余照常，别的条不受影响", () => {
    const out = parse(bundle([
      { id: "a", label: "甲", format: { ...GONGWEN, body: { ...GONGWEN.body, sizePt: "三号" } } },
      { id: "b", label: "乙", format: GONGWEN },
    ]));
    expect(out.docFormats).toHaveLength(2);
    expect(out.docFormats[0].format.body.font.eastAsia).toBe("仿宋_GB2312");
    expect(out.docFormats[0].format.body.sizePt).toBeGreaterThan(0);
    expect(out.docFormats[1].format).toEqual(GONGWEN);
  });

  it("没有 id 或名字的条目丢掉——那不是一套格式", () => {
    const out = parse(bundle([{ format: GONGWEN }, { id: "x", format: GONGWEN }]));
    expect(out.docFormats).toEqual([]);
  });

  it("排版格式出现之前写的备份照常打开", () => {
    const out = parse(bundle(undefined));
    expect(out.docFormats).toEqual([]);
    expect(out.prompts).toHaveLength(1);
  });

  it("一份只有排版格式的备份也是有效备份", () => {
    const raw = { ...bundle([{ id: "custom-1", label: "甲", format: GONGWEN }]), prompts: [] };
    expect(() => parse(raw)).not.toThrow();
  });
});
