import { describe, expect, it } from "vitest";
import { BUILTIN_FORMATS, type DocFormatPreset } from "../format";
import { describeOrigin, FormatResolveError, resolveFormat } from "../resolve";

const PRESETS: DocFormatPreset[] = [
  ...BUILTIN_FORMATS,
  {
    id: "imitated:模板.docx#a1b2",
    label: "模板.docx",
    builtin: false,
    imitatedFrom: "模板.docx",
    format: BUILTIN_FORMATS[2].format,
  },
];

describe("三级来源", () => {
  it("什么都不给就是默认预设——模型不需要做任何事", () => {
    const { format, origin } = resolveFormat(PRESETS, "clean");
    expect(origin).toEqual({ kind: "default", presetId: "clean", presetLabel: "素雅" });
    expect(format.body.font.eastAsia).toBe("思源黑体");
  });

  it("点名一个预设就用它", () => {
    const { origin } = resolveFormat(PRESETS, "clean", { formatId: "gongwen" });
    expect(origin).toEqual({ kind: "preset", presetId: "gongwen", presetLabel: "公文" });
  });

  it("模仿来的预设记得它是从哪份文件读的", () => {
    const { origin } = resolveFormat(PRESETS, "clean", { formatId: "imitated:模板.docx#a1b2" });
    expect(origin).toEqual({ kind: "imitated", presetId: "imitated:模板.docx#a1b2", sourceFile: "模板.docx" });
    expect(describeOrigin(origin)).toBe("照 模板.docx 模仿");
  });
});

describe("指了一个不存在的预设", () => {
  it("抛错，绝不静默回落默认", () => {
    // 回落是这里最坏的行为：模型拼错 id，产出一份合规性为零的文件，没有任何
    // 地方会亮红。
    expect(() => resolveFormat(PRESETS, "clean", { formatId: "gongwn" })).toThrow(FormatResolveError);
    expect(() => resolveFormat(PRESETS, "clean", { formatId: "gongwn" })).toThrow(/gongwen/);
  });
});

describe("overrides", () => {
  it("只动点名的字段，其余沿用底座", () => {
    const { format, origin } = resolveFormat(PRESETS, "clean", {
      formatId: "gongwen",
      overrides: { bodyFontEastAsia: "楷体", lineSpacing: "1.5倍" },
    });
    expect(format.body.font.eastAsia).toBe("楷体");
    expect(format.body.line).toEqual({ rule: "auto", value: 1.5 });
    // 没点名的照旧
    expect(format.body.sizePt).toBe(16);
    expect(format.page.margins.top).toBe(37);
    expect(origin.kind).toBe("overridden");
    if (origin.kind === "overridden") {
      expect(origin.changed).toHaveLength(2);
      // 卡上要摆出「固定值 28 磅 → 1.5 倍」，只说「改了行距」等于什么都没说
      expect(origin.changed).toContainEqual({
        key: "line", label: "行距", from: "固定值 28 磅", to: "1.5 倍行距",
      });
      expect(describeOrigin(origin)).toBe("预设：公文（改了 2 项）");
    }
  });

  it("底座不会被就地改坏", () => {
    const before = BUILTIN_FORMATS[2].format.body.font.eastAsia;
    resolveFormat(PRESETS, "clean", { formatId: "gongwen", overrides: { bodyFontEastAsia: "楷体" } });
    expect(BUILTIN_FORMATS[2].format.body.font.eastAsia).toBe(before);
  });

  it("解析不了就抛错，不忽略", () => {
    // 「行距设成 1.5」被悄悄丢掉，产出看起来完全正常——这正是要避免的。
    expect(() =>
      resolveFormat(PRESETS, "clean", { overrides: { lineSpacing: "宽一点" } }),
    ).toThrow(FormatResolveError);
    expect(() =>
      resolveFormat(PRESETS, "clean", { overrides: { bodySize: "大号" } }),
    ).toThrow(/字号/);
    expect(() =>
      resolveFormat(PRESETS, "clean", { overrides: { firstLineChars: 99 } }),
    ).toThrow(/首行缩进/);
    expect(() =>
      resolveFormat(PRESETS, "clean", { overrides: { marginsMm: [10, 10, 10, 500] } }),
    ).toThrow(/页边距/);
  });

  it("传了 overrides 但一项都没动，就不谎称改过", () => {
    const clean = BUILTIN_FORMATS.find((p) => p.id === "clean")!.format;
    const { origin } = resolveFormat(PRESETS, "clean", {
      overrides: { firstLineChars: clean.body.firstLineChars },
    });
    expect(origin.kind).toBe("default");
  });
});
