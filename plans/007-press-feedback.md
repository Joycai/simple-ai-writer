# 007 — 按压反馈统一：transform 进过渡列表 + 缩放收敛到 0.95–0.98

- **Status**: DONE (2026-08-22)
- **Commit**: 9e16885
- **Severity**: MEDIUM
- **Category**: 物理性
- **Estimated scope**: ~18 个 CSS 文件的规则级扫描修正

## Problem

应用有统一的按压语言（`:active { transform: scale(...) }`），但三类执行走样：

**A. `transform` 不在基础规则的 transition 列表里** —— 按下与松开都是 0ms 硬跳，而不是 120ms 内落下再弹回。已核实的典型：

```css
/* src/components/settings/settingsUi.module.css:143-151 — 现状 */
.chip {
  ...
  transition: background var(--transition-fast), color var(--transition-fast),
    border-color var(--transition-fast);   /* ← 没有 transform */
}
.chip:active { transform: scale(0.96); }
```

正确写法的样板就在同一文件里：

```css
/* src/components/settings/settingsUi.module.css:365 — 正确样板 */
  transition: background var(--transition-fast), transform var(--transition-fast),
```

**B. 缩放超出 0.95–0.98 克制区间**（0.92/0.94 在这套安静的纸面美学里显得用力过猛；0.99 又弱到读不出按压）。已知站点（`grep -rn ":active" src/components` 的完整清单为准）：
- `scale(0.92)`：settingsUi.module.css:666、sync.module.css:71、ProvidersModels.module.css:192、ErrorBoundary.module.css:92、PromptViewer.module.css:75
- `scale(0.94)`：SearchPanel.module.css:124、FacetEditModal.module.css:69、SettingsPage.module.css:81、BatchRunModal.module.css:76 区域
- `scale(0.99)`：AiPanel.module.css:580（runBtn）、settingsUi.module.css:218（card）、EntityAiHubModal.module.css:41

**C. 全应用最高频的两组按钮完全没有按压反馈**：图标栏（`IconRail.module.css:24` 区域）与 AI 栏（`AiRail.module.css:26` 区域）的按钮没有任何 `:active` 规则。

## Target

三条规则，全库一致：

1. **凡是 `:active` 里有 `transform` 的选择器**，其基础规则的 `transition` 列表必须包含 `transform var(--transition-fast)`（已包含的不动）。
2. **缩放值收敛**：`0.92`/`0.94` → `scale(0.95)`；`0.99` → `scale(0.98)`；带 `translateY(0) scale(0.98)` 复合值的按原样保留（那是 hover 抬升的落回，已在区间内）。
3. **IconRail 与 AiRail 的按钮补上**：

```css
/* IconRail.module.css / AiRail.module.css — 在按钮基础规则的 transition 里
   加入 transform var(--transition-fast)，并新增： */
.railBtn:active { transform: scale(0.95); }
```
（`.railBtn` 代指两文件中实际的按钮类名——从 `IconRail.module.css:24` / `AiRail.module.css:26` 附近的基础规则读出真实类名。）

## Repo conventions to follow

- 过渡令牌：`--transition-fast: 120ms var(--ease-out)`（tokens.css）。
- 正确样板：`settingsUi.module.css:365`（transform 在列表里）、`sync.module.css:436` 附近同款。
- 逐属性列出 transition，绝不用 `all`（方案 005 刚清零）。

## Steps

1. 跑 `grep -rn ":active" src/components --include=*.css`，得到完整站点清单（Problem 里的清单是 9e16885 时点的快照，以 grep 结果为准）。
2. 对每个含 `transform` 的 `:active` 站点：打开文件，找到同一选择器的基础规则；若其 `transition` 缺 `transform var(--transition-fast)`，加入（保持逐属性风格，追加在列表末尾）。基础规则完全没有 `transition` 的，新增 `transition: transform var(--transition-fast);`。
3. 同一遍里按 Target 规则 2 收敛缩放值（只改 0.92/0.94/0.99 三种；`LibraryView.module.css:362` 的 `cursor: grabbing` 与 `ResizeHandle.module.css:25` 不是按压缩放，跳过）。
4. `src/components/layout/IconRail.module.css` 与 `AiRail.module.css`：按 Target 规则 3 补按压反馈。
5. 复查 `EditorScrollNav.module.css:39`、`HtmlPreview.module.css:37`、`SnippetPicker.module.css:18`、`BatchRunModal.module.css:76/209/230`、`ModelProbePanel.module.css:62` 这些跨行声明站点——`:active` 块体在下一行，规则同样适用。

## Boundaries

- 只动 `transition` 列表、`:active` 的缩放数值、及两个 rail 文件的新增规则；不动颜色、位移、阴影。
- `translateY(0) scale(0.98)` 复合值原样保留。
- 不给菜单行/列表行（ContextMenu、CommandPalette 行、Select option）添加缩放——行级元素的反馈是背景高亮，缩放会让文字晃动。
- 若某站点结构特殊拿不准，跳过并在报告里列出，不要强改。

## Verification

- **Mechanical**: `pnpm tsc --noEmit`、`pnpm build` 通过；`grep -rn "scale(0.9[24])\|scale(0.99)" src/components --include=*.css` 只剩 Boundaries 允许的复合值。
- **Feel check**: `pnpm dev`：
  - 按住设置页任意 chip 不放：应看到 120ms 内缓落到 0.96，松手缓弹回——不再是瞬间跳变。
  - 点图标栏按钮：现在有轻微按压感，与设置页语言一致。
  - DevTools Animations 放慢确认按压曲线是 `--ease-out`。
- **Done when**: 全库 `:active` 缩放都有配套 transform 过渡、数值都在 0.95–0.98，两个 rail 有了按压反馈。
