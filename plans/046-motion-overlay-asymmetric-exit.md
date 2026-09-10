# 046 — Motion 浮层退场收快：AI 抽屉、抽屉遮罩、设置页（不对称时长）

- **Status**: DONE（2026-09-10，门禁已过；浏览器实测设置页退场 WAAPI 时长 160ms、只动 opacity，证实 variant 级 transition 生效；抽屉 200ms 那条预览面板里读不到，已由作者在真窗口目检通过）
- **Commit**: 484fe4b
- **Severity**: MEDIUM
- **Category**: 4 可打断与时序
- **Estimated scope**: 1 个文件（`src/lib/motion.ts`），三个 variant 的 `exit` 各加一个 `transition`，约 +12 行（含注释）

## Problem

全应用的浮层退场约定是**进得从容、出得利落**，而且写成了具体数字：

```ts
/* src/components/common/ModalShell.tsx:43 — 已有 */
const EXIT_MS = 160;
```
```css
/* src/styles/global.css:118-125 — 已有 */
/* ModalShell 关闭中：整层淡出、面板轻微收缩；期间吞掉输入。 */
.modal-closing {
  animation: fadeOut 160ms var(--ease-out) forwards;
  pointer-events: none;
}
.modal-closing > * {
  animation: scaleOut 160ms var(--ease-out) forwards;
}
```
```css
/* src/components/settings/panes/ProvidersModels.module.css:501-510 — 已有 */
/* 关闭中：进 220ms / 出 160ms，与 ModalShell 的 modal-closing 同一节奏；
   期间吞掉输入。 */
.drawerLayerClosing .scrim {
  animation: fadeOut 160ms var(--ease-out) forwards;
  pointer-events: none;
}
.drawerLayerClosing .drawer {
  animation: slideOutRight 160ms var(--ease-out) forwards;
  pointer-events: none;
}
```

**只有三个 Motion 浮层例外**——它们的退场和入场用同一条 transition：

```tsx
/* src/components/ai/AiDrawer.tsx:126-148 — 当前（节选） */
        <motion.div
          key="ai-backdrop"
          ...
          variants={overlayFade}
          ...
          transition={overlayFadeTransition}   // 200ms，进出同一条
        />
      ...
      <motion.aside
        key="ai-drawer"
        ...
        variants={drawerVariants}              // = useMotionPreset(drawerSlide)
        ...
        transition={springDrawer}              // 弹簧，进出同一条
      >
```
```tsx
/* src/components/settings/SettingsPage.tsx:105-114 — 当前 */
    <motion.div
      className={styles.page}
      variants={pageVariants}                  // = useMotionPreset(panelFade)
      initial="initial"
      animate="animate"
      exit="exit"
      // An overlay surface, not a peer view: the design system's 200ms fade,
      // not the screen-switch spring.
      transition={overlayFadeTransition}       // 200ms，进出同一条
    >
```

- AI 抽屉：`springDrawer`（`src/lib/motion.ts:131-136`，stiffness 360 / damping 40 / mass 0.9）阻尼比 ≈ 1.11（过阻尼），
  抽屉宽达 1180px（`AiDrawer.module.css:17`），按参数估算收尾要拖到约 0.4–0.6s。关闭（Esc / ⌘J / ⌘L / 点遮罩 / ✕）是系统响应，这段拖尾全部是等待。
- 抽屉遮罩、设置页：退场 200ms，比全库其他浮层的 160ms 慢一档。

**本方案不改入场，也不改「要不要动画」。** 方案 014 的 Boundaries 已把 AiDrawer / SettingsPage 定为
「低频抽屉/整页，不适用本准则」——那是既定判断，这里照单全收，只把退场时长对齐到全库约定（AUDIT §4：
「Asymmetric timing: deliberate phases animate slower; the system's response snaps」）。

## Target

Motion 里 **variant 自己带的 `transition` 优先于组件上的 `transition` prop**，所以只改 `motion.ts` 的三个 `exit`，
TSX 一个字不用动：

```ts
/* target — src/lib/motion.ts，panelFade（:97-101） */
export const panelFade: Variants = {
  initial: { opacity: 0, transform: "translateY(6px)" },
  animate: { opacity: 1, transform: "translateY(0px)" },
  // Exits carry their own, shorter transition (plan 046): closing is the
  // system's response and snaps at the app's 160ms exit (ModalShell EXIT_MS,
  // .modal-closing). A variant-level transition wins over the component's
  // `transition` prop, so the enter timing at each call site is untouched.
  exit: { opacity: 0, transform: "translateY(-6px)", transition: { duration: 0.16, ease: EASE_OUT } },
};
```

```ts
/* target — src/lib/motion.ts，overlayFade（:118-122） */
export const overlayFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0, transition: { duration: 0.16, ease: EASE_OUT } },
};
```

```ts
/* target — src/lib/motion.ts，drawerSlide（:126-130） */
/** Right-side drawer slide-over (AI assistant panel). Enters on `springDrawer`;
 *  leaves on a 200ms tween — a dismissal should not trail a spring's tail across
 *  a 1180px panel (plan 046). */
export const drawerSlide: Variants = {
  initial: { transform: "translateX(100%)" },
  animate: { transform: "translateX(0%)" },
  exit: { transform: "translateX(100%)", transition: { duration: 0.2, ease: EASE_OUT } },
};
```

数值出处：浮层退场 160ms = `ModalShell.tsx:43` 的 `EXIT_MS`；抽屉退场 200ms 取 AUDIT 抽屉预算（200–500ms）下沿——
比 160ms 多一档，因为它走的距离是模态收缩的几十倍。曲线 `EASE_OUT` = `src/lib/motion.ts:30`（与 `--ease-out` 同值）。
退场用 ease-out（AUDIT §2：「Entering or exiting → ease-out」）。

## Repo conventions to follow

- 退场 160ms 的范本：`src/components/common/ModalShell.tsx:43`、`src/styles/global.css:118-125`、`src/components/settings/panes/ProvidersModels.module.css:501-510`。
- `useMotionPreset()`（`src/lib/motion.ts:39-54`）在 reduced-motion 下只剥 `transform`，**保留**其余键——
  `transition` 会原样留下。抽屉的 `exit` 在减动效下变成只有 `transition` 的空目标，AnimatePresence 立即移除，
  与今天减动效下抽屉无位移的行为一致。**不需要**任何额外处理。
- 现有预设的注释语言是英文（见 `motion.ts` 全文），新注释保持英文。

## Steps

1. `src/lib/motion.ts` `panelFade` 的 `exit:` 行 —— 按 Target 替换，并在它上方加那段四行 `//` 注释。
   **只改 `exit:` 这一行和新增注释**；`panelFade` 上方的 `/** … */` 注释可能已被方案 044 改过措辞，保持现状。
2. `src/lib/motion.ts` `overlayFade` 的 `exit:` 行 —— 按 Target 替换。
3. `src/lib/motion.ts` `drawerSlide` —— 把上方的 `/** Right-side drawer slide-over (AI assistant panel). */` 换成 Target 里的三行注释；`exit:` 行按 Target 替换。
4. 不动 `springDrawer`、`overlayFadeTransition`、`springScreen`、`springPanel`、任何 `initial` / `animate`。

## Boundaries

- **不要**改 `AiDrawer.tsx`、`SettingsPage.tsx`、`App.tsx`。
- **不要**加「键盘打开就不动画」之类的来源判断——方案 014 已把这两个表面定为低频、适用标准动画。
- **不要**改入场时长或弹簧参数。
- `panelFade` 另有 `AiPanel.tsx` 一个消费者，但它是 enter-only（没有 `exit` prop），本改动对它无影响——**不要**因此去碰 AiPanel。
- 若 `motion.ts` 的摘录与代码对不上（自 484fe4b 起漂移，或方案 044 已改过相邻行），只要三个 `exit:` 行本身能找到就继续；找不到则**停下并报告**。

## Verification

- **机械**：`pnpm exec tsc --noEmit` 无诊断（`transition` 是 `TargetAndTransition` 的合法键）；`pnpm test` 全绿；`pnpm build` 成功。
- **接线核验**（`pnpm dev`，在**可见**的浏览器标签页里做——隐藏标签页 rAF 不派发，读数会说谎，见 `docs/issues/motion-enter-only-hidden-tab.md`）：
  - 打开 AI 抽屉（⌘J），等它停稳；按 Esc，**立刻**在 DevTools 控制台跑
    `document.getAnimations().map(a => [a.effect?.target?.className, a.effect?.getComputedTiming().duration])`
    → 抽屉那条应为 `200`，遮罩那条应为 `160`。
  - 打开设置（⌘,），按 Esc，同样读一次 → 设置页那条应为 `160`。
  - 若读到的仍是弹簧的时长或 200（设置页/遮罩），说明 variant 级 `transition` 没有生效——**停下并报告**，不要改成在 TSX 里传 `exit={{…}}`。
- **目检**：
  - ⌘J 开抽屉：滑入与改动前**完全一样**（弹簧）。Esc 关：明显比打开利落，没有贴着右边缘慢慢蹭出去的尾巴。
  - 快速连按两次 ⌘J（关到一半又打开）：抽屉从当前位置折返，**不跳回边缘重来**。
  - ⌘, 开设置：淡入与改动前一样；Esc 关：比打开略快。
  - DevTools → Animations 面板 10% 速度看一次关抽屉：一段匀滑减速的位移，终点前没有长时间几乎不动的拖尾。
  - Rendering → Emulate `prefers-reduced-motion: reduce`：抽屉开关无位移（与改动前一致），遮罩与设置页仍是短淡入淡出。
- **Done when**：三处退场时长读数为 200 / 160 / 160，入场不变，门禁三项通过。
