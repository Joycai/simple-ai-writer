# 005 — 合成层友好属性 + 缓动令牌归位（机械批量修）

- **Status**: DONE (2026-08-22)
- **Commit**: 0f49132
- **Severity**: MEDIUM
- **Category**: 性能 / 缓动与时长
- **Estimated scope**: 5 个 CSS 文件，每处 1-2 行

## Problem

五处各自独立的小病灶，同一类修法（改成合成层友好的属性、或把手写值归位到令牌），合并为一个机械批量方案。

**A. 设置页开关旋钮动画 `left`**（每次布局+重绘；教科书式该用 `translateX` 的场景）：

```css
/* src/components/settings/settingsUi.module.css:184-193 — 现状 */
.toggleKnob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  background: var(--stg-knob);
  transition: left var(--transition-fast), background var(--transition-fast);
}
.toggleOn .toggleKnob { left: 24px; background: var(--stg-bg-input); }
```

**B/C. 两处 `transition: all`**——`all` 把未预期属性也拉进插值（选中态实际变化 background/border-color/color 三个属性；主题切换时这些 chip 还会在 View Transition 之上叠一层多余 tween）：

```css
/* src/components/lore/LoreDetail.module.css:996 — 现状（.imgSlotChip） */
  transition: all var(--transition-fast);
```
```css
/* src/components/lore/FacetEditModal.module.css:368 — 现状（.slotChip） */
  transition: all var(--transition-fast);
```

**D. 文件树折叠箭头**：裸 `ease` + 脱离令牌的 130ms（文件树展开是 100+次/天 的操作）：

```css
/* src/components/layout/FileTree.module.css:164-167 — 现状 */
.chevronIcon {
  transition: transform 130ms ease;
  opacity: 0.7;
}
```

**E. 模型探测面板**：手写复刻了 `--transition-fast`（120ms）却把曲线降级成内建 `ease`：

```css
/* src/components/settings/ModelProbePanel.module.css:50 — 现状 */
  transition: background 120ms ease, transform 120ms ease;
```

## Target

```css
/* A — settingsUi.module.css 目标 */
.toggleKnob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  background: var(--stg-knob);
  transition: transform var(--transition-fast), background var(--transition-fast);
}
.toggleOn .toggleKnob { transform: translateX(21px); background: var(--stg-bg-input); }
```
（21px = 原 `left: 24px` − 基准 `left: 3px`，视觉终点完全一致。）

```css
/* B — LoreDetail.module.css:996 目标 */
  transition: background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast);
```
```css
/* C — FacetEditModal.module.css:368 目标 */
  transition: background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast);
```
```css
/* D — FileTree.module.css:165 目标 */
  transition: transform var(--transition-fast);
```
```css
/* E — ModelProbePanel.module.css:50 目标 */
  transition: background var(--transition-fast), transform var(--transition-fast);
```

## Repo conventions to follow

- 令牌：`src/styles/tokens.css:52-54` — `--transition-fast: 120ms var(--ease-out);`。全库正确写法的样板：`src/components/settings/settingsUi.module.css:143-144`（逐属性列出 + 全走令牌）。
- 该仓库明令「不要手写与令牌重复的值」（tokens.css 首行注释："All UI reads from these vars, never raw values"）。

## Steps

1. `src/components/settings/settingsUi.module.css`：第 191 行 `transition: left ...` → `transition: transform ...`；第 193 行 `left: 24px;` → `transform: translateX(21px);`（`background` 部分保留）。
2. `src/components/lore/LoreDetail.module.css`：第 996 行按目标替换。
3. `src/components/lore/FacetEditModal.module.css`：第 368 行按目标替换。
4. `src/components/layout/FileTree.module.css`：第 165 行按目标替换。
5. `src/components/settings/ModelProbePanel.module.css`：第 50 行按目标替换。

## Boundaries

- 只改列出的这几行；不动这些选择器里的其他声明。
- 不改 `:hover` / `:active` / 选中态的颜色值本身。
- 不引入新令牌。
- 若某行与摘录不符（相对 0f49132 有漂移），停下报告该处、其余照常。

## Verification

- **Mechanical**: `pnpm tsc --noEmit`、`pnpm build` 通过；`grep -rn "transition: all" src/` 零命中。
- **Feel check**: `pnpm dev`：
  - 设置页拨任意开关：旋钮滑到的位置与修改前一致（右端对齐），滑动平顺。
  - 知识库条目详情 / 特征编辑弹窗里点选配图槽位 chip：选中态颜色过渡与之前观感一致。
  - 文件树展开/折叠文件夹：箭头旋转手感略干脆（120ms + 强曲线）。
  - DevTools Rendering → Paint flashing：拨动开关时旋钮不再触发重绘矩形（transform 走合成层）。
- **Done when**: 全部替换完成、视觉终点不变、`transition: all` 清零。
