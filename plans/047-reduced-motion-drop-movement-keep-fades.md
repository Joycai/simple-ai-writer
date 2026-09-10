# 047 — reduced-motion 全局兜底：去位移、留淡入（决策变更，重开 009）

- **Status**: DONE（2026-09-10，门禁已过；Chromium 下同步探针实测减动效只剩淡入、普通模式数值不变；WKWebView 与真窗口目检待作者）
- **Commit**: 484fe4b
- **Severity**: MEDIUM
- **Category**: 6 无障碍
- **Estimated scope**: 约 14 个文件——`tokens.css` + 生成的 `contractData.ts`、`global.css`、5 个带位移关键帧的模块、5 个带无限装饰动画的模块、2 处注释、1 个测试、1 处设计文档；每处 1–6 行

> **这是对方案 009 的显式变更**，体例同 014 / 031。建议单独审阅、单独成 PR。
>
> 009 当时的判断是「全局块保持不动（一刀切兜底仍然正确：入场动画、位移、脉冲都该停）」，
> 然后在每个 spinner 模块里打 `!important` 补丁。`plans/README.md` 第六批「一处未解决的观察」
> 已经记下这条的缺口：**归零而非变柔**，并写明「届时该讨论的是全局策略，不是在单个组件里打补丁」。
> 本方案就是那次讨论的落地。

## Problem

```css
/* src/styles/global.css:137-145 — 当前 */
/* Respect reduced-motion preference */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}
```

三个问题：

1. **它把「更少更柔」做成了「零」**（AUDIT §6：「Reduced motion means fewer and gentler animations, **not zero** — keep transitions that aid comprehension, remove position changes」）。
   所有模态、弹出层、抽屉的 opacity 淡入淡出一并消失。JS 那一侧做对了——`useMotionPreset()`
   （`src/lib/motion.ts:32-54`）只剥 `transform`、保留 opacity——CSS 这一侧没有对应物，两套动效系统在减动效下行为不一致。
2. **补丁模式在漏。** 每个加载 spinner 都得记得在本模块写一段 `animation-duration: 1.6s !important; animation-iteration-count: infinite !important`，
   否则减动效下就冻成一个与卡死无法区分的残环。009 补了 10 处，035（2026-08-31）又补了 2 处，
   `src/components/common/ImageLightbox.module.css:56`（`1191573`，2026-09-01）**已经漏了**（方案 048 单独修）。
3. **与 JS 时序脱节。** `ModalShell` 关闭时仍等 `EXIT_MS = 160`（`ModalShell.tsx:43`）才卸载，但 `.modal-closing` 的淡出被压成 0.001ms——
   减动效用户看到的是「瞬间消失 + 160ms 什么都点不了」。方案 029 的 Boundaries 专门记过同一个「看不见的 160ms 空窗」。

## Target

**机制**：一个 L0 乘数 `--motion-shift`，平时为 `1`，减动效下为 `0`。所有**带位移的**进出场关键帧把 translate/scale 的偏移量乘上它——
减动效下关键帧照常播放 opacity，位移归零。全局块只保留 transition 与滚动的归零，不再碰 `animation-*`。

### 1. 令牌

```css
/* target — src/styles/tokens.css，tokens.scale 里 Transitions 块（:79-82）之后新增 */

    /* Motion distance multiplier. Shared entrance/exit keyframes multiply their
       translate/scale offsets by this; global.css sets it to 0 under
       prefers-reduced-motion, so those animations keep their opacity fade and
       drop the movement (plan 047). Not a theme knob. */
    --motion-shift: 1;
```

### 2. 全局关键帧（`src/styles/global.css:71-116`）

```css
/* target — 只改有位移的 6 个；fadeIn / blink / pulse / spin / pulseDeep / fadeOut 不动 */
@keyframes scaleIn {
  from { opacity: 0; transform: scale(calc(1 - 0.04 * var(--motion-shift))); }
  to   { opacity: 1; transform: scale(1); }
}
@keyframes slideUp {
  from { opacity: 0; transform: translateY(calc(6px * var(--motion-shift))); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes slideInRight {
  from { opacity: 0; transform: translateX(calc(24px * var(--motion-shift))); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes dropIn {
  from { opacity: 0; transform: translateY(calc(-4px * var(--motion-shift))) scale(calc(1 - 0.02 * var(--motion-shift))); }
  to   { opacity: 1; transform: none; }
}
@keyframes riseIn {
  from { opacity: 0; transform: translateY(calc(4px * var(--motion-shift))) scale(calc(1 - 0.02 * var(--motion-shift))); }
  to   { opacity: 1; transform: none; }
}
@keyframes scaleOut {
  to { opacity: 0; transform: scale(calc(1 - 0.03 * var(--motion-shift))); }
}
```

核对：`1 - 0.04 = 0.96`、`1 - 0.02 = 0.98`、`1 - 0.03 = 0.97`——**平时的数值与今天逐一相同**。

### 3. 全局 reduced-motion 块（`src/styles/global.css:137-145`）

```css
/* target */
/* Respect reduced-motion preference — fewer and gentler, not zero (plan 047).
   · Movement: --motion-shift → 0, so every entrance/exit keyframe keeps its
     opacity fade and loses its translate/scale. A keyframe that moves things
     must multiply its offset by var(--motion-shift) (cssKeyframeNames.test.ts).
   · Transitions (hover, press, folds) still collapse to instant, as before.
   · Infinite decorations (pulses, blinking carets, shimmer) are switched off with
     `animation: none` in their own modules. Loading spinners keep turning; the
     local `animation-duration: 1.6s !important` blocks now only slow them down. */
@media (prefers-reduced-motion: reduce) {
  :root { --motion-shift: 0; }
  *, *::before, *::after {
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
  .cursor-blink { animation: none; }
}
```

（`global.css` 不在任何 `@layer` 里，所以这条 `:root` 覆盖压得过 `tokens.scale` 层里的 `1`。）

### 4. 模块内带位移的关键帧（5 个）

```css
/* src/components/settings/panes/ContextMemory.module.css:101-104 */
@keyframes tagIn {
  from { opacity: 0; transform: translateY(calc(-2px * var(--motion-shift))); }
  to { opacity: 1; transform: none; }
}

/* src/components/settings/panes/Lab.module.css:36-39 */
@keyframes goIn {
  from { opacity: 0; transform: translateY(calc(-2px * var(--motion-shift))); }
  to { opacity: 1; transform: none; }
}

/* src/components/ai/SnippetPicker.module.css:112-115 */
@keyframes snipRise {
  from { opacity: 0; transform: translateY(calc(2px * var(--motion-shift))); }
  to   { opacity: 1; transform: translateY(0); }
}

/* src/components/roleplay/SceneTransition.module.css:12-15 */
@keyframes transitionGrow {
  from { opacity: 0.85; transform: translateY(calc(4px * var(--motion-shift))); }
  to { opacity: 1; transform: none; }
}

/* src/components/settings/panes/ProvidersModels.module.css:491-493 */
@keyframes slideOutRight {
  to { opacity: 0; transform: translateX(calc(24px * var(--motion-shift))); }
}
```

### 5. 无限装饰动画在减动效下显式关掉

方案 009 的原则保持不变：**只有加载 spinner 该继续转**；脉冲点、闪烁光标、扫光在减动效下停住。
旧的一刀切会顺带冻住它们，新规则不再碰 `animation-*`，所以它们要各自写 `animation: none`。
已经写了的（不用动）：`RoleplayChat .streamDot`、`RoleplayRoster .dotLive`、`ChatMark .running`、`ScriptText .caret`、`AgentChat .queueSpinner`。
**还没写的 6 个**：

```css
/* src/components/ai/AiPanel.module.css:946-952 —— 在已有块内追加一条 */
@media (prefers-reduced-motion: reduce) {
  .spinner,
  .draftSpinner {
    animation-duration: 1.6s !important;
    animation-iteration-count: infinite !important;
  }
  .cursor { animation: none; }
}

/* src/components/lore/ai/LoreRunProgress.module.css:219-224 —— 在已有块内追加一条 */
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 1.6s !important;
    animation-iteration-count: infinite !important;
  }
  .stepActive,
  .thinkingCursor { animation: none; }
}

/* src/components/roleplay/SceneTransition.module.css:402-407 —— 在已有块内追加一条 */
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 1.6s !important;
    animation-iteration-count: infinite !important;
  }
  .stepLive { animation: none; }
}

/* src/components/ai/AgentChat.module.css:887-893 —— 在已有块内追加一条 */
@media (prefers-reduced-motion: reduce) {
  .queueSpinner { animation: none; }
  .thinkingSpinner {
    animation-duration: 1.6s !important;
    animation-iteration-count: infinite !important;
  }
  .turnImageLoading,
  .turnImageLoading::after { animation: none; }
}
```

（`::after` 那一支是给方案 050 准备的——050 把扫光挪到伪元素上。两种顺序执行都成立。）

```css
/* src/components/ai/WriterTurn.module.css —— 在 .stripPulse 规则（:385-392）之后新增 */
@media (prefers-reduced-motion: reduce) {
  .stripPulse { animation: none; }
}
```

### 6. 两处已过期的注释

```css
/* target — src/components/lore/LoreReadView.module.css:21-26 整段替换 */
/* 这里**没有** prefers-reduced-motion 本地块，是故意的：这次入场是纯 opacity，
   而全局兜底（global.css，方案 047）在减动效下只去位移、保留淡入——它原样播放
   就是正确的降级。不要在这里补 @media 块。 */
```

```css
/* target — src/components/ai/AgentChat.module.css:501-502 两行替换（:498-500 保留） */
   减动效下它照常淡出：纯 opacity，全局兜底（方案 047）只去位移——这道残影是信息，
   不是装饰，本来就不该被撤掉。 */
```

### 7. 把新约定变成测试

在 `src/lib/__tests__/cssKeyframeNames.test.ts` 里加一条断言：**关键帧体里出现 `translate` 或 `scale(`，就必须出现 `var(--motion-shift)`**。

```ts
/* target — 加在 KEYWORDS 常量之后、describe 之前 */
/** `@keyframes name { … }` 的名字与花括号体（逐字符配平，关键帧里有嵌套的 from/to 块）。 */
function keyframeBodies(text: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  for (const m of text.matchAll(/@(?:-\w+-)?keyframes\s+([\w-]+)\s*\{/g)) {
    const start = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let i = start;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    out.push({ name: m[1], body: text.slice(start, i - 1) });
  }
  return out;
}

/**
 * 不靠乘数的例外。`shimmer` 是加载占位的扫光：减动效下由 AgentChat.module.css 的
 * `animation: none` 整个关掉，不是「保留淡入去位移」那一类。
 */
const SHIFT_EXEMPT = new Set(["shimmer"]);
```

```ts
/* target — 加在 describe 块内、最后一个 it 之后 */
  it("会位移的关键帧都乘了 --motion-shift", () => {
    // reduced-motion 下全局只把 --motion-shift 置 0（global.css，方案 047）：关键帧照播
    // opacity、位移归零。写死偏移量的关键帧会在减动效下照样滑动，而且不报任何错。
    const offenders = files
      .flatMap((f) =>
        keyframeBodies(f.text)
          .filter((k) => !SHIFT_EXEMPT.has(k.name))
          .filter((k) => /translate|scale\(/.test(k.body) && !k.body.includes("var(--motion-shift)"))
          .map((k) => `${k.name} — ${f.path}`),
      )
      .sort();
    expect(offenders).toEqual([]);
  });
```

（`spin` 只有 `rotate`，不会命中；`fadeIn` / `pulse` 等只有 opacity，不会命中。）

### 8. 设计文档

```
/* target — docs/reference/design-system.md:29 */
5. **无障碍** — All motion must degrade under `prefers-reduced-motion` (handled globally in `global.css`: movement drops via `--motion-shift`, opacity fades stay — so a keyframe that moves must multiply its offset by `var(--motion-shift)`; infinite decorations set `animation: none` locally; spinners keep turning). Keyboard focus uses the unified `:focus-visible` ring, not just a border-color swap.
```

## Repo conventions to follow

- L0 令牌住 `src/styles/tokens.css` 的 `@layer tokens.scale` → `:root`（`:30-31` 起），改完**必须**跑
  `node scripts/gen-theme-contract.ts` 重新生成 `src/lib/theme/contractData.ts`（`themeContract.test.ts:123` 会提示这条命令）。**不要手改** `contractData.ts`。
- 本地 reduced-motion 块的写法与位置：照 `src/components/ai/AgentLog.module.css:392-397`（文件尾、类选择器）。
- 关键帧名字全局唯一的不变量由方案 019 的测试守着；本方案**不新增、不删除**任何关键帧，只改关键帧体。
- 验动画的方法论：`docs/issues/motion-enter-only-hidden-tab.md`「教训」一节——用 Web Animations API 读，不看截图、不用 `setTimeout` 采样。

## Steps

1. `src/styles/tokens.css` —— 在 `--transition-slow: 320ms var(--ease-out);`（`:82`）之后按 Target §1 加入空行 + 注释 + `--motion-shift: 1;`。
2. 跑 `node scripts/gen-theme-contract.ts`，确认输出里 scale 数量比之前多 1，`src/lib/theme/contractData.ts` 的 `"scale"` 数组里出现 `"--motion-shift"`。
3. `src/styles/global.css:71-116` —— 按 Target §2 替换 `scaleIn` / `slideUp` / `slideInRight` / `dropIn` / `riseIn` / `scaleOut` 六个关键帧体，其余关键帧与注释不动。
4. `src/styles/global.css:137-145` —— 按 Target §3 整块替换（含注释）。
5. 按 Target §4 改五个模块关键帧体（`tagIn` / `goIn` / `snipRise` / `transitionGrow` / `slideOutRight`）。只改 `transform` 值，`opacity` 与 `to` 块不动。
6. 按 Target §5 改五个文件的 reduced-motion 块（四个追加进已有块，`WriterTurn.module.css` 新增一个块）。**已有的 spinner 规则一个字不动。**
7. 按 Target §6 替换两处注释。
8. 按 Target §7 给 `src/lib/__tests__/cssKeyframeNames.test.ts` 加辅助函数、豁免集合与一条 `it`。
9. 按 Target §8 替换 `docs/reference/design-system.md:29`。
10. **反向验证第 8 步的测试**：临时把 `global.css` 里 `slideUp` 的 `calc(6px * var(--motion-shift))` 改回 `6px`，跑 `pnpm test src/lib/__tests__/cssKeyframeNames.test.ts`，
    确认新断言报出 `slideUp — src/styles/global.css`；然后**还原**。

## Boundaries

- **不要**删或改 12 个模块里既有的 spinner 豁免块（`animation-duration: 1.6s !important` 那些）。新规则下它们从「复活」变成「减速」，依然正确；
  它们头上那句「压过 global.css 的一刀切兜底」的注释会变得不准，**留作后续清理，本方案不碰**（README 已记录）。
- **不要**碰 `transition-duration` 的归零——hover / press / 折叠在减动效下继续瞬时，这不是本方案的议题。
- **不要**改 `spin`（旋转不是本方案意义上的「位移」，spinner 就该转）。
- **不要**改 Motion / JS 侧（`useMotionPreset`、`MotionConfig reducedMotion="user"`、`appStore.applyThemeAnimated` 的减动效跳过）。
- **不要**动已有的 `animation: none` 本地块（RoleplayChat / RoleplayRoster / ChatMark / ScriptText / AgentChat `.queueSpinner` / DocFormat `.drawer`），
  也不要动 `CodeEditor.module.css` 的 caret 静态色带、`FileTree.module.css` 的 `springFill` 规则。
- **不要**新增或删除任何 `@keyframes`。
- 若任一关键帧体、reduced-motion 块与摘录对不上（自 484fe4b 起漂移，例如方案 049 已改过 `ContextMemory.module.css` / `Lab.module.css` 里 `animation:` 那一行——那一行不是本方案要改的，关键帧体本身对得上就继续），否则**停下并报告**。

## Verification

- **机械**：
  - `pnpm exec tsc --noEmit` 无诊断。
  - `pnpm test` 全绿——**含** `themeContract.test.ts`（第 2 步的生成）与 `cssKeyframeNames.test.ts`（第 8 步的新断言 + 第 10 步的反向验证已做）。
  - `pnpm build` 成功。
  - 产物核对：`grep -o "var(--motion-shift)" dist/assets/*.css | wc -l` → **13**（6 个全局关键帧里 8 处——`dropIn`/`riseIn` 各 2 处——加 5 个模块关键帧各 1 处；令牌声明与 `:root { --motion-shift: 0 }` 不含 `var(`，不计入。LightningCSS 可能把 `calc(6px * var(…))` 压成 `calc(6px*var(…))`，数 `var(--motion-shift)` 即可）。
  - `grep -o "animation-duration:.001ms" dist/assets/*.css` 与 `grep -o "animation-duration:0.001ms" dist/assets/*.css` → **均为空**（一刀切的 animation 部分已消失）。
- **接线核验**（`pnpm dev`，可见标签页；DevTools → Rendering → Emulate CSS media feature `prefers-reduced-motion: reduce`）：
  - 设置页里打开任一 `Select` 下拉；在控制台：
    ```js
    const a = document.getAnimations().find(x => x.animationName === "dropIn");
    a.pause(); a.currentTime = 0;
    getComputedStyle(a.effect.target).transform   // 减动效："none" 或 "matrix(1, 0, 0, 1, 0, 0)"；关掉模拟重做：带平移/缩放的 matrix
    getComputedStyle(a.effect.target).opacity     // 两种模式都是 "0"——淡入还在
    a.effect.getComputedTiming().duration         // 两种模式都是 160
    ```
  - 设置 → 供应商与模型 → 打开一个供应商抽屉：减动效下 `slideInRight` 同样读数（`transform` 为恒等、opacity 从 0 起、时长 220）。
- **目检**：
  - 减动效开：模态、下拉、供应商抽屉都**淡入淡出**、没有任何滑动或缩放；关模态时不再有「瞬间消失后空等 160ms」。
  - 减动效开：能看到的加载 spinner 仍在转（半速）；脉冲点、闪烁光标静止。
  - 减动效关：所有入场与改动前**逐帧一致**（数值没变，只是写成了乘 1）。DevTools Animations 面板 10% 速度对比一次 `Select` 下拉。
  - **macOS / WKWebView**（若作者有 Mac）：减动效关时下拉仍有 4px 下落。若在 WKWebView 上下拉完全没有位移、只剩淡入，说明该引擎不认关键帧里的 `var()`——
    这是**安全的退化**（只是没有位移），但要**停下并报告**，由作者决定是否接受，不要自行改写成别的机制。
- **Done when**：门禁三项通过、产物里一刀切的 animation 归零已不存在、减动效下关键帧只剩 opacity、spinner 仍转、装饰动画静止、正常模式逐帧不变。
