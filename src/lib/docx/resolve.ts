/**
 * 三级格式来源的合并：**本次明确指定 > 参考模仿的文件 > 默认预设**。
 *
 * 纯函数，**永远有结果**——默认预设兜底，所以「作者没特别指定」这条不需要模型
 * 做任何事，省略参数即可（01-agent-design I3）。
 *
 * 两条不肯让步的行为，都是「静默地对不上」的反面：
 *
 * - **指了一个不存在的预设 → 抛错，不回落默认。** 回落是这里最坏的行为：作者说
 *   「照甲方模板」，模型拼错了 id，然后静默地用默认格式导出一份合规性为零的
 *   文件，没有任何地方会亮红。
 * - **override 解析不出来 → 抛错，不忽略。** 「行距设成 1.5」被悄悄丢掉，产出
 *   看起来完全正常。
 */

import {
  type DocFormat,
  type DocFormatPreset,
  formatLineSpacing,
  formatSize,
  parseLineSpacing,
  parseSize,
} from "./format";

/**
 * 作者本次点名要改的东西。**故意只收五个字段**：对话里临时点名的九成是这五个
 * （「用仿宋」「三号」「行距1.5倍」「不要首行缩进」「页边距窄一点」）。再多就
 * 该建一个预设——一次性的三十字段格式没有人能校对，也没法复用。
 *
 * 字号和行距收字符串而不是数字，因为作者说的是「三号」和「固定值28磅」。
 */
export interface DocFormatOverrides {
  bodyFontEastAsia?: string;
  bodyFontAscii?: string;
  /** 「三号」或「16」。 */
  bodySize?: string;
  /** 「固定值28磅」/「最小值20磅」/「1.5倍」。 */
  lineSpacing?: string;
  firstLineChars?: number;
  /** 上 右 下 左，毫米。 */
  marginsMm?: [number, number, number, number];
}

/**
 * 一处临时改动。**必须带 from/to**：审批卡要把「固定值 28 磅 → 1.5 倍」原样
 * 摆出来，只说「改了行距」等于什么都没说。
 */
export interface FormatChange {
  key: "font" | "size" | "line" | "indent" | "page";
  label: string;
  from: string;
  to: string;
}

export type FormatOrigin =
  | { kind: "default"; presetId: string; presetLabel: string }
  | { kind: "preset"; presetId: string; presetLabel: string }
  | { kind: "imitated"; presetId: string; sourceFile: string }
  | { kind: "overridden"; base: FormatOrigin; changed: FormatChange[] };

/** 解析不下去时抛这个，让工具把原话回给模型而不是崩在半路。 */
export class FormatResolveError extends Error {}

export interface ResolvedFormat {
  format: DocFormat;
  origin: FormatOrigin;
}

export function resolveFormat(
  presets: readonly DocFormatPreset[],
  defaultId: string,
  args: { formatId?: string; overrides?: DocFormatOverrides } = {},
): ResolvedFormat {
  const wanted = args.formatId?.trim();
  const preset = wanted
    ? presets.find((p) => p.id === wanted)
    : presets.find((p) => p.id === defaultId) ?? presets[0];

  if (!preset) {
    throw new FormatResolveError(
      wanted
        ? `没有 id 为 "${wanted}" 的排版格式。可用的是：${presets.map((p) => p.id).join(", ")}`
        : "没有任何可用的排版格式。",
    );
  }

  const base: FormatOrigin = preset.imitatedFrom
    ? { kind: "imitated", presetId: preset.id, sourceFile: preset.imitatedFrom }
    : wanted
      ? { kind: "preset", presetId: preset.id, presetLabel: preset.label }
      : { kind: "default", presetId: preset.id, presetLabel: preset.label };

  if (!args.overrides || Object.keys(args.overrides).length === 0) {
    return { format: preset.format, origin: base };
  }

  const { format, changed } = applyOverrides(preset.format, args.overrides);
  // 传了 overrides 但一个字段都没动（全是空串 / undefined），origin 不该谎称
  // 「改了 0 项」——那会在卡上多出一个没有内容的徽标。
  if (changed.length === 0) return { format: preset.format, origin: base };
  return { format, origin: { kind: "overridden", base, changed } };
}

function applyOverrides(
  base: DocFormat,
  ov: DocFormatOverrides,
): { format: DocFormat; changed: FormatChange[] } {
  const changed: FormatChange[] = [];
  const body = { ...base.body, font: { ...base.body.font } };
  const page = { ...base.page, margins: { ...base.page.margins } };

  if (ov.bodyFontEastAsia?.trim() && ov.bodyFontEastAsia.trim() !== base.body.font.eastAsia) {
    body.font.eastAsia = ov.bodyFontEastAsia.trim();
    changed.push({ key: "font", label: "中文字体", from: base.body.font.eastAsia, to: body.font.eastAsia });
  }
  if (ov.bodyFontAscii?.trim() && ov.bodyFontAscii.trim() !== base.body.font.ascii) {
    body.font.ascii = ov.bodyFontAscii.trim();
    changed.push({ key: "font", label: "西文字体", from: base.body.font.ascii, to: body.font.ascii });
  }
  if (ov.bodySize?.trim()) {
    const pt = parseSize(ov.bodySize);
    if (pt === null) throw new FormatResolveError(`看不懂字号 "${ov.bodySize}"——写「三号」或「16磅」。`);
    if (pt !== base.body.sizePt) {
      body.sizePt = pt;
      changed.push({ key: "size", label: "字号", from: formatSize(base.body.sizePt), to: formatSize(pt) });
    }
  }
  if (ov.lineSpacing?.trim()) {
    const ls = parseLineSpacing(ov.lineSpacing);
    if (ls === null) {
      throw new FormatResolveError(
        `看不懂行距 "${ov.lineSpacing}"——写「固定值28磅」「最小值20磅」或「1.5倍」。`,
      );
    }
    const before = base.body.line ? formatLineSpacing(base.body.line) : "单倍行距";
    if (formatLineSpacing(ls) !== before) {
      body.line = ls;
      changed.push({ key: "line", label: "行距", from: before, to: formatLineSpacing(ls) });
    }
  }
  if (ov.firstLineChars !== undefined) {
    if (!Number.isFinite(ov.firstLineChars) || ov.firstLineChars < 0 || ov.firstLineChars > 10) {
      throw new FormatResolveError(`首行缩进 ${ov.firstLineChars} 不合理——填 0 到 10 之间的字符数。`);
    }
    if (ov.firstLineChars !== base.body.firstLineChars) {
      const say = (n: number) => (n > 0 ? `${n} 字符` : "无");
      changed.push({ key: "indent", label: "首行缩进", from: say(base.body.firstLineChars), to: say(ov.firstLineChars) });
      body.firstLineChars = ov.firstLineChars;
    }
  }
  if (ov.marginsMm) {
    const [top, right, bottom, left] = ov.marginsMm;
    for (const v of ov.marginsMm) {
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        throw new FormatResolveError(`页边距 ${v}mm 不合理——填 0 到 100 之间的毫米数（顺序是 上 右 下 左）。`);
      }
    }
    const say = (m: { top: number; right: number; bottom: number; left: number }) =>
      `上${m.top} 右${m.right} 下${m.bottom} 左${m.left} mm`;
    if (say({ top, right, bottom, left }) !== say(base.page.margins)) {
      changed.push({ key: "page", label: "页边距", from: say(base.page.margins), to: say({ top, right, bottom, left }) });
      page.margins = { top, right, bottom, left };
    }
  }

  return { format: { ...base, body, page }, changed };
}

/** 审批卡 header 上的那句话。 */
export function describeOrigin(origin: FormatOrigin): string {
  switch (origin.kind) {
    case "default":
      return `默认格式：${origin.presetLabel}`;
    case "preset":
      return `预设：${origin.presetLabel}`;
    case "imitated":
      return `照 ${origin.sourceFile} 模仿`;
    case "overridden":
      return `${describeOrigin(origin.base)}（改了 ${origin.changed.length} 项）`;
  }
}
