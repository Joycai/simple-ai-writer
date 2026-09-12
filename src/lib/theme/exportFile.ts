/**
 * 「把当前主题导出为文件」 — the one path from zero to a theme of one's own
 * (docs/feature/theme-system-plan.md §10, 设计稿 05i 屏 1f).
 *
 * It writes a complete `.css` into the themes folder, every core token with a
 * comment saying what it colours. The author changes a few lines and the name,
 * and the grid picks it up on the next reload. Written straight to the folder
 * rather than through a save dialog (1z C2): a theme anywhere else would not
 * appear in the grid, so asking where would be a false choice. Name
 * collisions get a number, never a prompt.
 *
 * The six roles the design's excerpt shows come first — those are the lines a
 * first-time author reads — and every other core token follows under 「进阶」.
 * Real token names throughout: the file is what the validator will read back.
 */
import { fileExists, writeFile } from "../fs/fileio";
import { joinPath } from "../paths";
import type { TokenContract } from "./contract";
import { THEME_FILE_EXT } from "./manifest";
import { displayThemeName, type ThemeEntry } from "./registry";
import { resolveTokenValue } from "./export";

/** The six the design leads with, in its order, with the role each plays. */
export const LEAD_TOKENS: readonly { name: string; zh: string; en: string }[] = [
  { name: "--color-bg-base", zh: "编辑区底 · 也是排版样张的底", en: "editor ground · the sample's paper too" },
  { name: "--color-bg-elevated", zh: "侧栏 / AI 栏 / 表头", en: "sidebar / AI rail / table heads" },
  { name: "--color-border", zh: "分栏线、卡描边", en: "panel rules, card edges" },
  { name: "--color-text-primary", zh: "正文", en: "body text" },
  { name: "--color-text-muted", zh: "次级文字、路径、计数", en: "secondary text, paths, counts" },
  { name: "--color-sienna", zh: "唯一强调色 · 选中、链接、进度", en: "the one accent · selection, links, progress" },
];

/** Roles for the rest of the core, by family — one comment per line in the file. */
const ROLES: Record<string, { zh: string; en: string }> = {
  "--color-bg-surface": { zh: "卡片、输入框底", en: "cards, inputs" },
  "--color-bg-hover": { zh: "行悬停", en: "row hover" },
  "--color-bg-tinted": { zh: "轻微着色的面", en: "faintly tinted surfaces" },
  "--color-bg-overlay": { zh: "模态遮罩", en: "modal scrim" },
  "--color-text-secondary": { zh: "说明文字", en: "descriptions" },
  "--color-text-faint": { zh: "占位、禁用", en: "placeholders, disabled" },
  "--color-text-ghost": { zh: "最淡的一档文字", en: "the faintest text" },
  "--color-sienna-hover": { zh: "强调色的悬停态", en: "accent on hover" },
  "--color-amber": { zh: "暖色副强调", en: "warm secondary accent" },
  "--color-amber-soft": { zh: "暖色的淡底", en: "warm wash" },
  "--color-border-soft": { zh: "更轻的分隔线", en: "lighter rules" },
  "--color-border-strong": { zh: "更重的描边、悬停边", en: "stronger edges, hover borders" },
  "--color-success": { zh: "成功", en: "success" },
  "--color-warning": { zh: "提醒", en: "warning" },
  "--color-error": { zh: "出错", en: "error" },
  "--color-type-text-bg": { zh: "模型类型标签 · 文本", en: "model type tag · text" },
  "--color-type-text-fg": { zh: "同上，字色", en: "same, foreground" },
  "--color-type-multimodal-bg": { zh: "模型类型标签 · 多模态", en: "model type tag · multimodal" },
  "--color-type-multimodal-fg": { zh: "同上，字色", en: "same, foreground" },
  "--color-type-image-bg": { zh: "模型类型标签 · 生图", en: "model type tag · image" },
  "--color-type-image-fg": { zh: "同上，字色", en: "same, foreground" },
  "--color-type-video-bg": { zh: "模型类型标签 · 视频", en: "model type tag · video" },
  "--color-type-video-fg": { zh: "同上，字色", en: "same, foreground" },
  "--shadow-sm": { zh: "阴影 · 小", en: "shadow · small" },
  "--shadow-md": { zh: "阴影 · 中", en: "shadow · medium" },
  "--shadow-lg": { zh: "阴影 · 大", en: "shadow · large" },
  "--shadow-xl": { zh: "阴影 · 浮层", en: "shadow · overlays" },
  "--shadow-drawer": { zh: "抽屉的侧阴影", en: "drawer side shadow" },
  "--glass-bg": { zh: "毛玻璃底", en: "glass ground" },
  "--glass-bg-strong": { zh: "毛玻璃底 · 更透", en: "glass ground · stronger" },
  "--glass-border": { zh: "毛玻璃边", en: "glass edge" },
};

const COPY_SUFFIX = { zh: "副本", en: "copy" } as const;

/** The full text of the file `entry` exports to. */
export function themeFileText(entry: ThemeEntry, contract: TokenContract, isZh: boolean): string {
  const name = `${displayThemeName(entry, isZh)}-${isZh ? COPY_SUFFIX.zh : COPY_SUFFIX.en}`;
  const t = (zh: string, en: string) => (isZh ? zh : en);
  const scheme = entry.scheme ?? "light";
  const value = (n: string) => resolveTokenValue(entry, scheme, n, contract) ?? "";
  const line = (n: string, role: string) => `  ${n}: ${value(n)};`.padEnd(46) + `/* ${role} */`;
  const lead = LEAD_TOKENS.map((l) => line(l.name, t(l.zh, l.en)));
  const leadNames = new Set(LEAD_TOKENS.map((l) => l.name));
  const rest = contract.core
    .filter((n) => !leadNames.has(n))
    .map((n) => line(n, ROLES[n] ? t(ROLES[n].zh, ROLES[n].en) : ""));
  return `/* ${t("外观主题 · 只声明令牌。布局、圆角、字体不在此列。", "Appearance theme · tokens only. Layout, corners and type are not a theme's to change.")}
   ${t(`叠在内置的 ${entry.extends} 之上：没写到的令牌从它取，删掉一行就是回到它的值。`, `Sits on the built-in ${entry.extends}: any token left out comes from there; delete a line to fall back.`)} */
:root {
  --theme-name: ${name};${" ".repeat(Math.max(1, 30 - name.length))}/* ${t("网格里显示的名字", "the name the grid shows")} */
  --theme-scheme: ${scheme};${" ".repeat(Math.max(1, 30 - scheme.length))}/* ${t("light | dark，决定它属于哪一头", "light | dark — which band it belongs to")} */
  --theme-extends: ${entry.extends};${" ".repeat(Math.max(1, 29 - entry.extends.length))}/* ${t("没写到的令牌从这套内置取", "tokens left out come from this built-in")} */

${lead.join("\n")}

  /* ${t("进阶 · 通常不用碰", "Advanced · usually left alone")} */
${rest.join("\n")}
}
`;
}

/** `<name>-副本.css`, numbered when taken: `纸-副本 2.css`. */
async function freeThemeFileName(dir: string, base: string): Promise<string> {
  let fileName = `${base}${THEME_FILE_EXT}`;
  for (let n = 2; await fileExists(joinPath(dir, fileName)); n++) {
    fileName = `${base} ${n}${THEME_FILE_EXT}`;
  }
  return fileName;
}

/** Write the export and return where it landed. */
export async function exportThemeToFolder(
  entry: ThemeEntry,
  dir: string,
  contract: TokenContract,
  isZh: boolean,
): Promise<{ fileName: string; path: string }> {
  const base = `${displayThemeName(entry, isZh)}-${isZh ? COPY_SUFFIX.zh : COPY_SUFFIX.en}`;
  const fileName = await freeThemeFileName(dir, base);
  const path = joinPath(dir, fileName);
  await writeFile(path, themeFileText(entry, contract, isZh));
  return { fileName, path };
}
