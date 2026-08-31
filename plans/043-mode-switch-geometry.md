# 043 — 阅读/管理切换器：消除 3px 几何跳动，补按压

- **Status**: TODO
- **Commit**: 43b52e9（+ PR #430 的 031–040）
- **Severity**: LOW
- **Category**: 5 性能 / 8 该动而没动 / 3 物理性
- **Estimated scope**: 1 个 CSS 文件，约 6 行

## Problem

`src/components/lore/LoreDetail.module.css:1074-1092` —— 当前代码：

```css
.modeSwitch { display: flex; border: 1px solid var(--color-border); }
.modeBtn {
  padding: 5px 13px;
  border: none;
  background: none;
  font: 400 12px/1 var(--font-serif);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--transition-fast);
}
.modeBtn:hover { background: var(--color-bg-hover); }
.modeBtnActive {
  background: var(--color-accent-tint);
  border-left: 3px solid var(--color-sienna);
  color: var(--color-text);
  font-weight: 500;
}
```

选中态比未选中态多了两样**改变固有宽度**的东西：`border-left: 3px`（基态
`border: none`，所以这 3px 是凭空多出来的）和 `font-weight: 500`（字重变粗、
字形变宽）。两者都**不在** `transition` 列表里——而列表里唯一的 `background`
是会渐变的。

于是每次切换（鼠标点或按 `R`）：**背景礼貌地渐变 120ms，同时两个格子的几何
瞬间跳动几像素**。这与方案 020 目检时在 `.railRowOn` 抓到的是**同一个失效模式**
（那次是 `border-left: 3px` + 补偿性 `padding-left` 算错，文字横跳 3px），
README 的「三处更正」一节记着它。

`.modeBtn` 另外也没有 `:active`——仓库有 70+ 处按压反馈，这个双档切换器是漏的。

## Target

让**几何在两态之间恒定**，只让颜色移动：

```css
/* target — src/components/lore/LoreDetail.module.css */
.modeSwitch { display: flex; border: 1px solid var(--color-border); }
.modeBtn {
  padding: 5px 13px;
  /* 基态就占住选中态那 3px 竖条的位置（透明），否则选中时凭空多出 3px、
     两个格子一起横跳——与方案 020 在 .railRowOn 抓到的是同一个失效模式。 */
  border: none;
  border-left: 3px solid transparent;
  background: none;
  font: 400 12px/1 var(--font-serif);
  /* 字重也要占位：500 比 400 宽，只在选中态加粗会让格子变宽。用 text-shadow
     仿粗、字重保持 400，几何因此完全不动。 */
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast),
    border-left-color var(--transition-fast), transform var(--transition-fast);
}
.modeBtn:hover { background: var(--color-bg-hover); }
.modeBtn:active { transform: scale(0.97); }
.modeBtnActive {
  background: var(--color-accent-tint);
  border-left-color: var(--color-sienna);
  color: var(--color-text);
  text-shadow: 0 0 0.4px currentColor;
}
```

三处关键：
- `border-left: 3px solid transparent` 进**基态**，选中态只换 `border-left-color`
  ——宽度两态相同，且颜色可以进过渡（同方案 020 在 collections 的做法）。
- `font-weight: 500` 换成 `text-shadow: 0 0 0.4px currentColor`：视觉上仍然
  "重"一点，但**字形宽度不变**。
- `.modeBtnActive:hover`（`:1092`）保持不变。

## Repo conventions to follow

- 「3px 竖条用基态透明边框占位、只过渡颜色」正是方案 020 在
  `src/components/lore/collections/collections.module.css:277` 落地的写法：
  ```css
  transition: background var(--transition-fast), border-left-color var(--transition-fast);
  ```
  且该文件 `:279-283` 的注释明确写着他们**刻意避免**补偿性 padding，就是为了
  不产生布局跳动。本方案是同一条规则的第二次应用。
- 按压 `scale(0.97)` + `--transition-fast`，与仓库 70+ 处一致。

## Steps

1. `src/components/lore/LoreDetail.module.css` —— `.modeBtn` 基态：
   保留 `border: none`，其后加 `border-left: 3px solid transparent;`；
   把 `transition` 扩成 Target 的四项；写入两段注释。
2. 同文件 —— 新增 `.modeBtn:active { transform: scale(0.97); }`，
   放在 `.modeBtn:hover` 之后、`.modeBtnActive` 之前。
3. 同文件 —— `.modeBtnActive`：`border-left: 3px solid var(--color-sienna)` →
   `border-left-color: var(--color-sienna)`；
   `font-weight: 500` → `text-shadow: 0 0 0.4px currentColor;`
4. 不要动 `.modeSwitch` 与 `.modeBtnActive:hover`。

## Boundaries

- **不要**用 `padding-left` 补偿几何。方案 020 的目检记录（README「三处更正」
  第一条）证明那条路会算错，而且是**静默**错的。
- **不要**改 `.modeSwitch` 的 `border` 或整体尺寸。
- **不要**把 `font-weight` 的补偿做成「基态也 500」——那会让未选中项也变重，
  改变的是设计而不是修缺陷。
- **不要**给切换本身加入场/出场动画：`R` 是无修饰键的高频切换，
  方案 033 刚把那条路上的位移动画删掉，不要从另一头加回来。
- 若代码与摘录对不上，**停下并报告**。

## Verification

- **机械**：`pnpm exec tsc --noEmit` 无诊断；`pnpm test` 全绿；`pnpm build` 成功。
- **目检**（`pnpm tauri dev` → 知识库 → 任一条目）：
  - **这是本方案唯一重要的判据**：反复点切换器（或按 `R`），
    盯住两个格子的**文字左沿**——它们必须**完全不动**。
    改动前每次切换都会横跳几像素。
    最好用 DevTools 量一次：切换前后对同一个 `.modeBtn` 读
    `getBoundingClientRect().width`，两次应**相等**。
  - 竖条的颜色现在应**渐入**（120ms），而不是瞬间出现。
  - 选中项的字仍应看起来比未选中项重一点点。若看起来完全一样，
    把 `text-shadow` 的模糊值从 0.4px 调到 0.5px；若看起来发糊，调到 0.3px。
    **不要**改回 `font-weight`。
  - 按住任一格：轻微缩到 0.97，松开回弹。
  - 开系统「减弱动态效果」：颜色瞬时切换，几何仍然不动。
- **Done when**：切换时文字左沿零位移（DevTools 量得两态宽度相同），
  竖条颜色渐入，按压有反馈。
