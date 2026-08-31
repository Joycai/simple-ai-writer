# 042 — 阅读模式补齐悬停过渡与缩放入口的按压反馈

- **Status**: TODO
- **Commit**: 43b52e9（+ PR #430 的 031–040）
- **Severity**: LOW
- **Category**: 3 物理性 / 7 内聚
- **Estimated scope**: 1 个 CSS 文件，约 8 行

> **📌 2026-08-31 更正**：本方案 §B 初稿引的 `.tocItem` 代码块**抄错了**——
> 那串 `10px` / `--color-text-faint` 是 `.tocSub` 的值，`.tocItem` 实际是
> `11px` / `--color-text-muted`，且还有 `gap: 9px; padding: 5px 0; border: none;`。
> 已按实际代码更正。**结论不受影响**：`.tocItem` 确实有基态规则、确实没有
> `:hover`，而 Target 写的是「既有声明不变」的纯追加，处方不变。
> （执行者照方案办事、发现不符后按判断继续而非停下，是对的。）

## Problem

`LoreReadView` 是 `5f9d25a` 之后落地的一整张新界面（435 行 CSS）。它的
`.editMark`（`:167-192`）是全库范本级的写法，但同一个文件里有三处悬停**硬切**、
两个缩放入口**零反馈**。

### A. 三处悬停变色没有 `transition`

```css
/* src/components/lore/LoreReadView.module.css:324 — 当前 */
.nextName:hover { color: var(--color-accent); }
/* :393 — 当前 */
.tocSub:hover { color: var(--color-text-secondary); }
```

`.nextName` 是页脚「下一条」的条目名（19px 衬线，翻页的主要入口），
`.tocSub` 是页边目录的子项。两者的父级规则都没有声明 `transition`，于是颜色瞬切。
而同文件三节之上的 `.sect`（`:156`）与 `.editMark` 都正确地带着
`var(--transition-fast)`——**不一致发生在一个文件之内**。

### B. `.tocItem` 是主项，却比子项少一个悬停态

```css
/* src/components/lore/LoreReadView.module.css — 当前，无 :hover */
.tocItem {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 5px 0;
  border: none;
  background: none;
  text-align: left;
  font: 400 11px/1.5 var(--font-mono);
  color: var(--color-text-muted);
  cursor: pointer;
}
```
子项 `.tocSub` 有悬停反馈，**父项没有**。目录里主项才是主要的跳转目标，
指针落在它上面时界面不承认。

### C. 两个 `cursor: zoom-in` 的入口没有任何按压或悬停反馈

```css
/* src/components/lore/LoreReadView.module.css:88-95 — 当前 */
.cover {
  width: 150px;
  height: 88px;
  flex-shrink: 0;
  object-fit: cover;
  border: 1px solid var(--color-border);
  cursor: zoom-in;
}
/* :273 — 当前 */
.figure { margin: 0; cursor: zoom-in; min-width: 0; }
```

两者都接着灯箱（`LoreReadView.tsx:400` 与 `:348`）。`cursor: zoom-in` 是它们
**全部**的可点提示；点下去到灯箱挂载之间没有任何回执。AUDIT §3 正是这一条。

## Target

```css
/* target — .nextName（在其基态规则里加 transition，不是加在 :hover 上） */
.nextName {
  /* …既有声明不变… */
  cursor: pointer;
  transition: color var(--transition-fast);
}
.nextName:hover { color: var(--color-accent); }

/* target — 目录主项与子项 */
.tocItem {
  /* …既有声明不变… */
  cursor: pointer;
  transition: color var(--transition-fast);
}
.tocItem:hover { color: var(--color-text-secondary); }
.tocSub { transition: color var(--transition-fast); }
.tocSub:hover { color: var(--color-text-secondary); }

/* target — 两个缩放入口 */
.cover {
  /* …既有声明不变… */
  cursor: zoom-in;
  transition: border-color var(--transition-fast), transform var(--transition-fast);
}
.cover:hover { border-color: var(--color-border-strong); }
.cover:active { transform: scale(0.99); }

.figure { margin: 0; cursor: zoom-in; min-width: 0; }
.figureImg { transition: transform var(--transition-fast); }
.figure:active .figureImg { transform: scale(0.99); }
```

按压幅度取 **0.99** 而不是常用的 0.97/0.98：这两个是较大的图像块
（150×88 与整格图），同样的比例在大面积上读起来的位移量要大得多。

## Repo conventions to follow

- 过渡一律挂在**基态**选择器上、逐属性列出、零 `all` —— 这是方案 020 在
  collections 子系统确立的做法，本方案沿用。
- `--transition-fast` = `120ms var(--ease-out)`（`tokens.css:52`）。
- 同文件的范本：`.sect`（`:156`）`transition: background var(--transition-fast);`
  与 `.editMark`（`:167-192`）。
- 按压幅度参考 AUDIT §3 的 0.95–0.98 区间；本方案因面积大而取 0.99，
  这是**刻意的偏离**，理由写在上面。

## Steps

1. `src/components/lore/LoreReadView.module.css` —— `.nextName` 基态加
   `transition: color var(--transition-fast);`（不要动它的 `:hover`）。
2. 同文件 —— `.tocItem` 基态加同样的 `transition`，并**新增**
   `.tocItem:hover { color: var(--color-text-secondary); }`
   （与 `.tocSub:hover` 同色，两级目录的悬停语汇一致）。
3. 同文件 —— `.tocSub` 加基态 `transition: color var(--transition-fast);`
   **先确认 `.tocSub` 有没有自己的基态规则块**：若只有 `:hover` 一条，
   就新建一条基态规则；若已有，追加声明即可。
4. 同文件 —— `.cover` 按 Target 加 `transition` + `:hover` + `:active`。
5. 同文件 —— 给 `.figureImg`（`:274` 起）加 `transition: transform var(--transition-fast);`，
   并新增 `.figure:active .figureImg { transform: scale(0.99); }`。
   **按压挂在图片上而不是 `<figure>` 上**：`<figure>` 还包着图注，
   整块缩放会让文字跟着抖。

## Boundaries

- **不要**给 `.cover` 或 `.figureImg` 加 `:hover` 位移（`translateY`）。
  它们嵌在一张"纸"里，浮起会破坏纸面的平整感——这与按钮不同。
- **不要**碰 `.editMark`（`:167-192`）：它已经是范本（`opacity` 揭示 +
  `:focus-visible` 并入揭示选择器，键盘用户不会聚焦到不可见控件上）。
- **不要**碰 `.sect` / `.flash`（`:156` / `:165`）——方案 033 刚动过那一带。
- **不要**新增关键帧、Motion 预设，或 `prefers-reduced-motion` 块
  （全是 opacity/颜色/微缩放，全局归零是可接受降级）。
- 若代码与摘录对不上，**停下并报告**。

## Verification

- **机械**：`pnpm exec tsc --noEmit` 无诊断；`pnpm test` 全绿；`pnpm build` 成功。
  `grep -c "var(--transition-fast)" src/components/lore/LoreReadView.module.css`
  应比改动前多 5。
- **目检**（`pnpm tauri dev` → 知识库 → 任一条目 → 按 `R` 进阅读模式）：
  - 悬停页脚「下一条」的条目名：颜色应**渐变**到 accent，不再瞬切。
  - 窗口拉宽到出页边目录（≥1300px 容器查询档）：悬停主项应有反应，
    且与子项的反应**同色同速**。
  - 悬停档案头封面：边框加深；**按住**：轻微缩到 0.99，松开回弹。
  - 图库里按住一张图：只有**图片**缩，图注文字不动
    （若文字跟着抖，说明第 5 步挂到 `.figure` 上了）。
  - 点开灯箱确认仍正常工作（本方案不碰点击逻辑）。
  - 开系统「减弱动态效果」：颜色与边框仍然变化（瞬时），功能完整。
- **Done when**：三处悬停都是渐变、目录两级语汇一致、两个缩放入口有按压，
  且图注不随按压位移。
