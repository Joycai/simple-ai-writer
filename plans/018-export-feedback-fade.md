# 018 — 导出按钮回执：淡入 + 消除宽度跳动

- **Status**: DONE (2026-08-23 落地；2026-08-26 复核生效)。曾因「阻断 A · keyframe 作用域」不生效，该阻断已随 `vite.config.ts` 切 LightningCSS 解决——2026-08-26 核对构建产物确认本方案的动画引用已命中定义、真的在播。本方案无需再改
- **Commit**: 78160c2
- **Severity**: LOW（加法项）
- **Category**: 遗漏机会（状态呈现）
- **Estimated scope**: 1 个 TSX + 1 个 CSS，~6 行（第 3 步为条件性，见下）

## Problem

`ExportMenu` 的文件头注释自己点明了它的处境：

```tsx
// src/components/layout/ExportMenu.tsx:9-11 — 现状注释
 * There is no toast in this app, so the button reports its own outcome for a
 * moment: copying to the clipboard is otherwise completely silent, and an
 * author who sees nothing happen tries again.
```

也就是说，这个按钮是**全应用唯一的成功回执**。但它自己就是一帧硬切：

```tsx
// src/components/layout/ExportMenu.tsx:92-96 — 现状
        {status ? <Check size={12} /> : null}
        {status ?? t("editor.export")}
        {!status && <ChevronDown size={9} strokeWidth={2} className={styles.ctrlChevron} />}
```

`status` 由 `flash()`（`:40-44`）置位、2000ms 后清空。两个问题：

1. **「✓ 已复制」瞬间替换「导出 ▾」**，没有任何过渡。承担着「刚才那一下成功了」这条信息的一闪，恰恰是最容易被余光漏掉的那种一闪。
2. **按钮宽度随之跳变**。`.ctrl` 没有任何宽度约束：

```css
/* src/components/layout/TitleBar.module.css:160-171 — 现状 */
.ctrl {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 0;
  background: transparent;
  border: none;
  color: var(--color-text-dim);
  font: 400 12px/1 var(--font-sans);
  cursor: pointer;
  transition: color var(--transition-fast);
}
```

「导出」+ chevron 与「✓ 已复制」的渲染宽度不同，切换时会推动标题栏里相邻的控件。**给硬切加淡入而不处理宽度，只会把这次位移显得更明显。**

## Target

### A. 回执淡入（必做）

把两种状态各自包一层 span，只给成功态加入场动画：

```tsx
// src/components/layout/ExportMenu.tsx — 目标（替换 :92-96 的三行）
        {status ? (
          <span className={styles.ctrlStatus}>
            <Check size={12} />
            {status}
          </span>
        ) : (
          <>
            {t("editor.export")}
            <ChevronDown size={9} strokeWidth={2} className={styles.ctrlChevron} />
          </>
        )}
```

```css
/* src/components/layout/TitleBar.module.css — 目标：新增一条规则 */
/* 全应用唯一的成功回执（见 ExportMenu.tsx 头注释）——淡入让它不至于被余光漏掉。
   只做入场：2000ms 后的复位不携带信息，给它淡出只会把视线拉回一个已经没话说的按钮。 */
.ctrlStatus {
  display: flex;
  align-items: center;
  gap: 5px;
  animation: fadeIn var(--transition-base);
}
```

`--transition-base` 是 `200ms var(--ease-out)`（`tokens.css`），与方案 011 给保存指示圆点选的时长同值——两者是同一类「刚才那一下成功了吗」的信号，理应同速。`fadeIn` 是 `global.css:51` 的共享帧。

**只做入场、不做复位动画**是一个明确决定，不是遗漏：2000ms 后的复位不携带任何信息，作者早已读完那个 ✓；给它加淡出反而会在两秒后把视线重新拽回一个没话说的按钮。理由已写进上面的 CSS 注释。

### B. 宽度跳动（条件性 —— 先量再改）

**不要凭猜写一个 `min-width` 数值。** 两个语言包（`zh-CN` / `en`）的「导出 / Export」「已复制 / Copied」「已保存 / Saved」渲染宽度各不相同，硬编码一个 px 值要么夹字要么留白。按下面的量法处理：

1. `pnpm dev`，打开一个文档，DevTools 选中导出按钮，记下 `offsetWidth`。
2. 点「导出为 Markdown」触发回执，再记一次 `offsetWidth`。
3. 中英文各做一遍（设置 → 通用 → 语言）。
4. **若四个数里最大与最小之差 ≤ 8px**：不改，收工——这点位移肉眼无感，加约束反而在标题栏留一块空白。
5. **若差值 > 8px**：给 `.ctrl` 加 `min-width`，取四个数里的**最大值**向上取整到 2 的倍数：
   ```css
   /* 值由实测得出，见方案 018 步骤 B —— 取中英文四种状态里最宽的一个 */
   min-width: <实测最大值>px;
   justify-content: flex-end;
   ```
   `justify-content: flex-end` 让按钮靠右对齐（它在标题栏右侧控件组里），宽度兜底不会把文字推离原位。

把实际量到的四个数字与最终结论写进 PR 描述，别只写「加了 min-width」。

## Repo conventions to follow

- `fadeIn` 是 `global.css:51` 的共享帧；模块引用本文件未声明的动画名会透传到全局（先例遍布各模态）。**不要**本地重声明。
- 时长用令牌而不是字面量：`var(--transition-base)`（已含缓动）。同类先例是方案 011 给 `TitleBar.module.css` 的 `.saveDot` 加的 `transition: background var(--transition-base);`——就在本文件里，可直接对照。
- reduced-motion 走 `global.css:122` 全局兜底，不加本地反压。回执是文字加图标，归零后信息完整保留（作者仍能读到「✓ 已复制」，只是没有淡入）。
- i18n：`status` 的文案来自 `t("editor.exportCopied")` 等既有 key，**不新增、不改动任何 i18n 条目**。

## Steps

1. `src/components/layout/TitleBar.module.css`：在 `.ctrlChevron` 规则（`:175-177`）之后新增 Target A 给出的 `.ctrlStatus` 规则（连同注释）。
2. `src/components/layout/ExportMenu.tsx`：把 `:92-96` 的三行替换为 Target A 给出的三元结构。`Check` 与 `ChevronDown` 的 import 已存在（`:15`），无需改动 import。
3. **（条件性）** 按 Target B 的五步实测宽度；仅在差值 > 8px 时给 `.ctrl` 追加 `min-width` 与 `justify-content: flex-end`。差值 ≤ 8px 则跳过本步并在 PR 里说明。

## Boundaries

- 不动 `ExportMenu.tsx` 的导出逻辑：`run()`、`flash()`、`current()`、`FEEDBACK_MS`、timer 清理、三个 `ContextMenuEntry` 全部保持原样。
- 不动 `FEEDBACK_MS`（2000ms 是既有产品决定，不在本方案范围）。
- 不给复位（`status` → `null`）加任何动画（理由见 Target A）。
- 不改 `.ctrl` 的颜色、padding、字体、hover——第 3 步若执行，只加 `min-width` 与 `justify-content` 两行。
- 不动 `TitleBar.module.css` 里的其他规则，尤其不动方案 011 加的 `.saveDot`。
- 不引入 toast 组件、不引入 Motion、不加新依赖。
- 不新增或修改 i18n 条目。
- 若 `:92-96` 或 `.ctrl` 与摘录不符（相对 78160c2 有漂移），停下报告。

## Verification

- **Mechanical**:
  - `pnpm tsc --noEmit` 通过。
  - `pnpm build` 通过。
  - `grep -n "@keyframes" src/components/layout/TitleBar.module.css` **零命中**（确认没有本地克隆 `fadeIn`）。
- **Feel check**: `pnpm dev`，打开一个文档：
  - 点「导出 ▾」→「导出为 Markdown」：`✓ 已复制` 应**淡入**（约 200ms），明显比原先的硬切容易被余光捕捉到。
  - 等 2000ms：按钮复位为「导出 ▾」，**这一下是硬切，符合预期**（见 Target A 的决定）。
  - **关键回归**：在回执还挂着的 2 秒内再次点击按钮 —— 菜单应正常打开，`flash` 的 timer 应被 `:42` 的 `clearTimeout` 正确重置，不出现回执卡住或提前消失。
  - **关键回归**：连续快速触发三次导出，确认没有动画堆叠、没有闪烁。
  - 「导出为 HTML」（走系统保存对话框，取消时**不应**出现回执）与「导出 PDF」（本就不 flash）各试一次，确认回执只在该出现时出现。
  - 观察标题栏右侧：回执出现与消失时，相邻控件**不应**明显跳动。若跳动明显，回到 Steps 第 3 步实测并加 `min-width`。
  - 切到英文界面（设置 → 通用 → 语言）重跑一遍上述两项宽度观察。
  - DevTools → Rendering → `prefers-reduced-motion: reduce`：回执瞬时出现，文字与 ✓ 完整可读。
- **Done when**: 成功回执淡入可感；2 秒复位无残留、无卡死；快速连点无堆叠；中英文下标题栏均无刺眼的宽度跳动（或已用实测值兜底）。
