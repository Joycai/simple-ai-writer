# 003 — 删掉高频/键盘触发表面的入场动画

- **Status**: DONE (2026-08-22)
- **Commit**: 0f49132
- **Severity**: HIGH
- **Category**: 目的与频率
- **Estimated scope**: 3 个 CSS 文件，每处删 1 行

## Problem

三个被极高频触发的表面各带一段 mount-only 入场动画。规则：键盘触发、一天上百次的动作**不该有动画**；每天几十次的要删或大幅削减。这三处不仅高频，还因为组件按条件 return null 而在**每次触发时重新 mount、把关键帧从零重放**：

1. **查找/替换栏**（Ctrl/⌘F，键盘触发）——每次打开都从透明闪入 160ms，关闭时反而硬切（无退出动画），越用越注意到这种不对称：

```css
/* src/components/editor/SearchPanel.module.css:5-14 — 现状 */
.panel {
  font-family: var(--font-sans);
  ...
  border-bottom: 1px solid var(--color-border);
  animation: fadeIn 160ms var(--ease-out);
}
```

2. **`@` 提及选择器**——打字过程中出现。`MentionPicker.tsx:251` 是 `if (items.length === 0) return null;`，某个按键把候选滤到零再滤回来，portal 就卸载重挂、动画**在一个词的中途重放**；快速打字者一秒能触发数次：

```css
/* src/components/common/MentionPicker.module.css:4-17 — 现状 */
.picker {
  ...
  animation: slideUp 160ms var(--ease-out);
  max-height: 240px;
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
```

3. **选中文本浮出的 AI 气泡**——`InlineAiBubble.tsx:111` 是 `if (!live || dismissed) return null;`，由 `selectionchange` 驱动：mousedown 使选区塌缩即卸载，再选中即重挂。**每一次选中文本**（写作应用的核心手势）都重放一遍 160ms 的 scaleIn，包括重选同一段：

```css
/* src/components/ai/InlineAiBubble.module.css:1-10 — 现状 */
.bubble {
  position: fixed;
  ...
  animation: scaleIn 160ms var(--ease-out);
  font-family: var(--font-sans);
}
```

（⌘K 命令面板同属此类，但 `docs/reference/design-system.md` 明文把它列为 Motion 进出场的既定决策，本方案不动它。）

## Target

三处的 `animation:` 行直接删除——这些表面出现时都已锚定在明确位置（编辑器顶边 / 光标旁 / 选区旁），瞬时出现不突兀，反而更快。附带删除 MentionPicker 的本地 `slideUp` 克隆（它遮蔽了 `global.css:59` 的全局同名帧，删引用后声明成为死代码）。

```css
/* SearchPanel.module.css — 目标：.panel 里不再有 animation 行 */
/* MentionPicker.module.css — 目标：.picker 里不再有 animation 行，@keyframes slideUp 整块删除 */
/* InlineAiBubble.module.css — 目标：.bubble 里不再有 animation 行 */
```

## Repo conventions to follow

- 设计规范第 3 条（`docs/reference/design-system.md`）：「克制精致动画……subtle motion」——删除高频入场动画与之一致，不是背离。
- 仓库自身的先例：`AgentLog`/`AgentChat` 的流式列表行就刻意没有入场动画。

## Steps

1. `src/components/editor/SearchPanel.module.css`：删除第 13 行 `animation: fadeIn 160ms var(--ease-out);`。
2. `src/components/common/MentionPicker.module.css`：删除第 10 行 `animation: slideUp 160ms var(--ease-out);`，并删除第 14-17 行整个 `@keyframes slideUp` 块。
3. `src/components/ai/InlineAiBubble.module.css`：删除第 8 行 `animation: scaleIn 160ms var(--ease-out);`。

## Boundaries

- 不动 `CommandPalette`（既定设计决策）。
- 不动这三个组件的 TSX 逻辑、定位、尺寸。
- 不删 `global.css` 里的任何关键帧。
- 若行号/内容与摘录不符（相对 0f49132 有漂移），停下报告。

## Verification

- **Mechanical**: `pnpm tsc --noEmit`、`pnpm build` 通过。
- **Feel check**: `pnpm dev`：
  - 连按 Ctrl+F / Escape 五次：查找栏即现即隐，无闪烁感，开与关对称。
  - 在聊天/扮演输入框打 `@` 后连续输入并删改：候选列表稳定出现，不再中途「跳一下」。
  - 在编辑器里反复拖选文字：AI 气泡随选区即时出现，不再每次都缩放弹入。
- **Done when**: 三个表面的出现均为瞬时，且无任何回归（定位、交互不变）。
