# 049 — 令牌与节奏收敛（041 的漏网之鱼）

- **Status**: DONE（2026-09-10，门禁已过；tokens.css 之外 cubic-bezier 回零，产物 var(--ease-settle) = 10；作者目检通过；SessionTabs 定为 240ms，注释已改为记录该决定）
- **Commit**: 484fe4b
- **Severity**: LOW
- **Category**: 7 内聚与令牌
- **Estimated scope**: 12 个文件（含生成文件与设计文档），六处同一类修法，每处 1–4 行

> 体例同方案 022 / 041：新代码没接上既有约定，而不是约定错了。六处全部来自第九批（041，基准 43b52e9 + PR #430）之后的提交。

## Problem

### A. 手写 `cubic-bezier` 回到了 10 处

方案 022 立下、033 重申的不变量：**`tokens.css` 之外不允许出现手写 `cubic-bezier`**，判据是
`grep -rn "cubic-bezier" src --include='*.css' | grep -v tokens.css` 为空。当前命中 10 处，全是同一条曲线：

```
src/components/settings/SettingsPage.module.css:184:    max-height 240ms cubic-bezier(0.2, 0.8, 0.2, 1),
src/components/settings/SettingsPage.module.css:185:    opacity 240ms cubic-bezier(0.2, 0.8, 0.2, 1);
src/components/settings/panes/ModelDrawer.module.css:26:  transition: grid-template-rows 200ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 160ms;
src/components/settings/panes/ModelDrawer.module.css:133:  transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
src/components/settings/panes/Lab.module.css:14:  animation: goIn 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
src/components/settings/panes/ContextMemory.module.css:79:.sliderRow { transition: opacity 200ms cubic-bezier(0.2, 0.8, 0.2, 1); }
src/components/settings/panes/ContextMemory.module.css:98:  animation: tagIn 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
src/components/settings/panes/ContextMemory.module.css:140:  animation: tagIn 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
src/components/common/Slider.module.css:62:.thumb.snapping { transition: left 70ms cubic-bezier(0.2, 0.8, 0.2, 1), background var(--transition-fast); }
src/components/common/Slider.module.css:63:.fill.snapping { transition: width 70ms cubic-bezier(0.2, 0.8, 0.2, 1); }
```

（前 8 处来自 `c9066a0`，2026-09-02「按设计稿 18 给『实验室』与『上下文与记忆』补形」。）

这条曲线**不是** `--ease-out` 的抄错——它是设计稿明文给的值，`docs/reference/design-system.md:378` 写着
「200ms `cubic-bezier(.2,.8,.2,1)`, opacity 160ms, same curve both ways」。所以修法**不是**换成 `--ease-out`（那会改掉设计），
而是给它一个令牌名，让以后重调曲线不会静默跳过这 10 处。

### B. 一条裸 `ease-out` 关键字

```css
/* src/components/settings/SettingsPage.module.css:191-196 — 当前 */
/* The flash: the item arrives dyed accent-tint (no transition in), then the
   class is dropped and this 500ms ease-out carries the tint back to paper. */
.navCollapse .navItem {
  transition: background 500ms ease-out, color var(--transition-fast),
    transform var(--transition-fast);
}
```

方案 041 把「全库仅有的四条裸 `ease`」清到了零；内置关键字 `ease-out` 是同一类弱曲线（AUDIT §2：「Built-in CSS easings are too weak」）。
**500ms 本身是设计值**（`SettingsPage.tsx:49-51`：「设计稿 05b … fading out within ~500ms」），不改。只换曲线。

### C. 一个 spinner 周期偏离 0.8s

```css
/* src/components/lore/CategoryMoveMenu.module.css:49 — 当前 */
  animation: spin 900ms linear infinite;
```

方案 002 定下「统一 spinner 的 0.8s」。本行来自 `487271d`（2026-09-06）。

### D. `pulseDeep` 五个消费者里只有一个换了缓动

```css
/* src/components/ai/ChatMark.module.css:16 — 当前 */
  animation: pulseDeep 1.4s ease-in-out infinite;
```

另外四个消费者都是 `pulseDeep 1.4s infinite`（`WriterTurn.module.css:390`、`RoleplayRoster.module.css:214`、`RoleplayChat.module.css:431`、`SceneTransition.module.css:272`）。
方案 041 D 项正是以「同样的 `1.4s infinite`」为由把 `writerPulse` 并进 `pulseDeep` 的。同一个「在跑」的圆点在不同面板里节奏不同。

### E. 注释与实现不一致

```css
/* src/components/ai/SessionTabs.module.css:46-48 — 当前 */
/* 新会话 pressed while an empty tab already existed: that tab flashes its top
   line once (设计稿 02b 屏 1g), 120ms, instead of a second blank tab appearing. */
.tabFlash { animation: tabFlash 240ms var(--ease-out); }
```

注释写 120ms，代码是 240ms（同一次提交 `1d8b9b7` 写下的两者）。

### F. 一段注释说「必须转」，下一行却让它停

```css
/* src/components/ai/AgentChat.module.css:885-893 — 当前 */
/* reduced-motion 下加载指示仍需转动——静止的残环与卡死无法区分。
   本地类 + !important 压过 global.css 的一刀切兜底（specificity 0,1,0 > 0,0,0）。 */
@media (prefers-reduced-motion: reduce) {
  .queueSpinner { animation: none; }
  .thinkingSpinner {
    animation-duration: 1.6s !important;
    animation-iteration-count: infinite !important;
  }
}
```

行为本身是对的——方案 009 的原则是「只恢复首要工作信号」，而排队卡表达的是「在等前一轮」，
那句话由卡片文字（`.queueText`）承担，不是模型在干活。但读者看到的是一段自相矛盾的注释。

## Target

### A

```css
/* target — src/styles/tokens.css，Easing 块（:74-77） */
    /* Easing */
    --ease-out:    cubic-bezier(0.32, 0.72, 0, 1);
    --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
    --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
    /* In-place folds, chips and snaps in settings (设计稿 05b/05c/18): fast
       start, soft landing, no overshoot. design-system.md 「只动被点控件下方」. */
    --ease-settle: cubic-bezier(0.2, 0.8, 0.2, 1);
```

十处 `cubic-bezier(0.2, 0.8, 0.2, 1)` 一律替换为 `var(--ease-settle)`，**时长与属性一个不动**：

```css
/* SettingsPage.module.css:183-185 */
  transition:
    max-height 240ms var(--ease-settle),
    opacity 240ms var(--ease-settle);
/* ModelDrawer.module.css:26 */
  transition: grid-template-rows 200ms var(--ease-settle), opacity 160ms;
/* ModelDrawer.module.css:133 */
  transition: transform 200ms var(--ease-settle);
/* Lab.module.css:14 */
  animation: goIn 200ms var(--ease-settle);
/* ContextMemory.module.css:79 */
.sliderRow { transition: opacity 200ms var(--ease-settle); }
/* ContextMemory.module.css:98 与 :140 */
  animation: tagIn 200ms var(--ease-settle);
/* Slider.module.css:62-63 */
.thumb.snapping { transition: left 70ms var(--ease-settle), background var(--transition-fast); }
.fill.snapping { transition: width 70ms var(--ease-settle); }
```

注意 `ModelDrawer.module.css:26` 的 `opacity 160ms` **没有**写曲线（默认 `ease`）——那是设计文档原文「opacity 160ms」，本方案**不**给它补曲线。

### B

```css
/* target — src/components/settings/SettingsPage.module.css:191-196 */
/* The flash: the item arrives dyed accent-tint (no transition in), then the
   class is dropped and this 500ms fade (设计稿 05b) carries the tint back to paper. */
.navCollapse .navItem {
  transition: background 500ms var(--ease-out), color var(--transition-fast),
    transform var(--transition-fast);
}
```

### C

```css
/* target — src/components/lore/CategoryMoveMenu.module.css:49 */
  animation: spin 0.8s linear infinite;
```

### D

```css
/* target — src/components/ai/ChatMark.module.css:16 */
  animation: pulseDeep 1.4s infinite;
```

### E

```css
/* target — src/components/ai/SessionTabs.module.css:46-47 */
/* 新会话 pressed while an empty tab already existed: that tab flashes its top
   line once (设计稿 02b 屏 1g), instead of a second blank tab appearing. 稿上标
   120ms，实现取 240ms——120ms 分到升、降两段各 60ms，2px 的线几乎看不出来。
   作者目检后二选一：改这里的时长，或删掉这半句。 */
```

### F

```css
/* target — src/components/ai/AgentChat.module.css:885-886 */
/* reduced-motion 下加载指示仍需转动——静止的残环与卡死无法区分。
   本地类 + !important 压过 global.css 的一刀切兜底（specificity 0,1,0 > 0,0,0）。
   排队圈是例外：排队卡说的是「在等前一轮」，不是「模型在干活」，那句话由卡片文字
   （.queueText）承担，所以它在减动效下停住（方案 009：只恢复首要工作信号）。 */
```

### 设计文档

```
/* target — docs/reference/design-system.md:32 */
- **Easing**: `--ease-out` (enter/expand, default), `--ease-spring` (brief pop accents only), `--ease-in-out` (symmetric size/position), `--ease-settle` (in-place folds, chips and snaps in settings — fast start, soft landing, no overshoot).
```

`docs/reference/design-system.md:378` 行内的 `` 200ms `cubic-bezier(.2,.8,.2,1)` `` 替换为 `` 200ms `var(--ease-settle)` ``，该行其余文字不动。

## Repo conventions to follow

- 令牌住 `src/styles/tokens.css` 的 `@layer tokens.scale`；改完**必须**跑 `node scripts/gen-theme-contract.ts` 重新生成 `src/lib/theme/contractData.ts`，**不要手改**。
- 同类收敛的范本：方案 022、041（`plans/041-token-and-keyframe-consolidation.md`）。
- **不要删 `--ease-spring`**——方案 041 专门记过：它零消费者，但是 design-system.md 记载的设计词汇，删它是设计决策不是清理。

## Steps

1. `src/styles/tokens.css:77` 之后按 Target A 插入注释 + `--ease-settle`。
2. 跑 `node scripts/gen-theme-contract.ts`；确认 `contractData.ts` 的 `"scale"` 数组出现 `"--ease-settle"`。
3. 按 Target A 替换十处 `cubic-bezier(0.2, 0.8, 0.2, 1)`（五个文件）。
4. 按 Target B 改 `SettingsPage.module.css:191-196`（注释 + 那一条 transition）。
5. 按 Target C 改 `CategoryMoveMenu.module.css:49`。
6. 按 Target D 改 `ChatMark.module.css:16`。
7. 按 Target E 改 `SessionTabs.module.css:46-47` 的注释；`:48` 的代码不动。
8. 按 Target F 改 `AgentChat.module.css:885-886` 的注释；`@media` 块内容不动。
9. 按「设计文档」一节改 `design-system.md:32` 与 `:378`。

## Boundaries

- **不改任何时长**（C 除外），**不改任何曲线的数值**——只是给同一个值一个名字。
- **不要**把 `--ease-settle` 的消费点换成 `--ease-out`，也不要把别处的 `--ease-out` 换成 `--ease-settle`。
- **不要**改 `.tabFlash` 的 240ms、`.queueSpinner` 的 `1.1s` 与 `animation: none`（二者都来自对着设计稿 23 的复核提交 `807256c` / `1d8b9b7`）。
- **不要**改 `pulseDeep` 关键帧本身，也不要改其他四个 `pulseDeep` 消费者。
- **不要**删 `--ease-spring`。
- 若方案 047 已先落地（`tokens.css` 里已有 `--motion-shift`、`ContextMemory`/`Lab` 的关键帧体已改），不冲突：本方案改的是 `animation:` 那一行，不是关键帧体；第 2 步重新生成即可。
- 若任一摘录与代码对不上（自 484fe4b 起漂移），**停下并报告**。

## Verification

- **机械**：
  - `grep -rn "cubic-bezier" src --include='*.css' | grep -v tokens.css` → **必须为空**（022/033 的不变量回到零）。
  - `grep -rnE "(transition|animation)[^;]*[0-9](ms|s) (ease|ease-in|ease-out|ease-in-out)\b" src --include='*.css'` → **必须为空**。
  - `grep -rn "spin 900ms\|pulseDeep 1.4s ease-in-out" src` → 空。
  - `pnpm exec tsc --noEmit` 无诊断；`pnpm test` 全绿（**含** `themeContract.test.ts`——第 2 步的生成文件就是它在查）；`pnpm build` 成功。
  - 产物：`grep -o "var(--ease-settle)" dist/assets/*.css | wc -l` → 10；`grep -c "cubic-bezier(.2,.8,.2,1)\|cubic-bezier(0.2, 0.8, 0.2, 1)" dist/assets/*.css` 只应命中令牌声明本身。
- **目检**（`pnpm dev` 浏览器即可——设置页不依赖项目）：本方案的判据是**什么都没变**。
  - 设置 → 实验室：拨一个带「接着去 …」的开关，提示行的 2px 落位与改动前一致；把 Word 导出开关打开，导航里「排版格式」展开 + 染色淡出与改动前一致。
  - 设置 → 上下文与记忆：「生效中」标签入场、滑杆行淡入与改动前一致。
  - 模型抽屉：折叠区展开/收起、chevron 旋转与改动前一致。
  - 任一 `Slider` 拖到刻度附近松手：70ms 吸附与改动前一致。
  - DevTools 选中上述任一元素，Computed → `transition-timing-function` / `animation-timing-function` 应显示 `cubic-bezier(0.2, 0.8, 0.2, 1)`（令牌已解析）。
- **Done when**：两条 grep 为空、门禁三项通过、设置页各处手感与改动前一致。
