import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/appStore";
import { useThemeStore } from "../../../stores/themeStore";
import { displayThemeName } from "../../../lib/theme/registry";
import type { ContentMode } from "../../../lib/theme/contentColors";
import { MarkdownPreview } from "../../common/MarkdownPreview";
import { Section, Row } from "./bits";
import styles from "./ContentColors.module.css";

export function ContentColors() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const mode = useAppStore((s) => s.contentMode);
  const light = useAppStore((s) => s.contentLight);
  const dark = useAppStore((s) => s.contentDark);
  const set = useAppStore((s) => s.setContentColors);
  const entries = useThemeStore((s) => s.content);
  const mdId = useAppStore((s) => s.markdownTheme);
  const legacyColors = useThemeStore((s) => s.markdown.find((e) => e.id === mdId)?.ownColors);
  return <Section label={zh ? "Markdown 配色" : "Markdown colours"}>
    <Row title={zh ? "配色模式" : "Colour mode"} desc={zh ? "仅影响正文展示；菜单、按钮和编辑器继续使用界面配色。" : "Applies to rendered content. Menus, controls and the source editor keep the interface palette."}>
      <select className={styles.select} aria-label={zh ? "Markdown 配色模式" : "Markdown colour mode"} value={mode} onChange={(e) => set(e.target.value as ContentMode)}>
        <option value="follow">{zh ? "跟随界面配色" : "Follow interface colours"}</option>
        <option value="auto">{zh ? "独立配色 · 跟随明暗" : "Independent · follow light/dark"}</option>
        <option value="light">{zh ? "独立配色 · 固定浅色" : "Independent · always light"}</option>
        <option value="dark">{zh ? "独立配色 · 固定深色" : "Independent · always dark"}</option>
      </select>
    </Row>
    {mode !== "follow" && (["light", "dark"] as const).filter((s) => mode === "auto" || mode === s).map((scheme) =>
      <Row key={scheme} title={zh ? (scheme === "light" ? "浅色内容" : "深色内容") : `${scheme} content`}>
        <select className={styles.select} aria-label={zh ? `${scheme === "light" ? "浅色" : "深色"}内容配色` : `${scheme} content palette`}
          value={scheme === "light" ? light : dark} onChange={(e) => set(mode, scheme === "light" ? e.target.value : light, scheme === "dark" ? e.target.value : dark)}>
          {entries.filter((e) => e.scheme === scheme || e.id === (scheme === "light" ? light : dark)).map((e) => <option key={`${e.source}:${e.path ?? e.id}`} value={e.id} disabled={!e.usable || e.scheme !== scheme}>
            {displayThemeName(e, zh)}{!e.usable || e.scheme !== scheme ? (zh ? "（不可用，使用基础配色）" : " (unavailable; using base palette)") : ""}
          </option>)}
        </select>
      </Row>)}
    {legacyColors && <p className={styles.note}>{zh ? "当前排版含自定义颜色，部分元素可能保留原色。" : "This typography includes custom colours; some elements may retain them."}</p>}
    {entries.some((e) => e.problems.length) && <p className={styles.note}>{zh ? "部分内容主题声明未通过校验；仅加载支持的六位十六进制颜色变量。内置主题如需修改，请复制并更改文件名。" : "Some declarations were rejected. Only supported six-digit hex colour tokens are loaded. Rename a copy to customise a built-in palette."}</p>}
    <div className={styles.preview}><MarkdownPreview source={zh ? "# 暖棕标题\n\n## 豆绿章节\n\n### 灰紫小节\n\n正文与 **重点**，以及 [链接](https://example.com)。\n\n> 引用内容与 `行内代码`。" : "# Clay heading\n\n## Sage section\n\n### Muted purple\n\nBody text with **emphasis** and a [link](https://example.com).\n\n> A quote with `inline code`."} /></div>
  </Section>;
}
