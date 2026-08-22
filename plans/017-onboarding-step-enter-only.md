# 017 — 首次运行向导换步：enter-only 淡入

- **Status**: BLOCKED (2026-08-23) — 实测 enter-only 的 keyed motion.div 在 prefers-reduced-motion 下停在 initial（opacity:0）。照本方案实施会让首屏对开启动效缩减的用户完全不可见。见 plans/README.md「阻断 B」，修好后再执行
- **Commit**: 78160c2
- **Severity**: LOW（加法项）
- **Category**: 遗漏机会（空间连续性）
- **Estimated scope**: 1 个 TSX 文件，~8 行（含 2 行 import）

## Problem

四步向导的 1→2→3→4 是硬切。面板整体有一次入场（`Onboarding.module.css:22` 的 `scaleIn 220ms`），方案 013 又给它补了谢幕淡出（`closing` + `modal-closing`），**唯独中间的换步没有任何桥接**——而向导底部一直画着进度点和「1 / 4」，在明示这是一段有方向的路径：

```tsx
// src/components/onboarding/Onboarding.tsx:362-364 — 现状
          <div className={styles.form}>
            {renderStep()}
          </div>
```

`renderStep()`（`:153`）按 `step` 返回四个片段之一，四个分支各自 `return (<>…</>)`（`:155-156`、`:218-219`、`:275-276`，以及 step 4 的分支）。React 原地 reconcile，整块 50px padding 的表单内容一帧换掉。

这是全应用**频率最低**的界面——每位作者一生看一次。按频率闸门，这里正是「取悦预算」该花的地方，也是唯一花得起的地方。

## Target

把已有的 `<div className={styles.form}>` 换成一个按 `step` 取 key 的 `motion.div`，**enter-only**：只有 `initial` / `animate`，**没有 `AnimatePresence`，没有 `exit`**。

```tsx
// src/components/onboarding/Onboarding.tsx — 目标（替换 :362-364 三行）
          {/* Enter-only（照 AiPanel.tsx:1410 的注释与方案 004 的先例）：
              换步是直接操纵，新一步应立即落位；keyed motion.div 会重置子树，
              所以这里面不能有本地 useState——本组件的状态全在组件体上。 */}
          <motion.div
            key={step}
            className={styles.form}
            variants={panelFade}
            initial="initial"
            animate="animate"
            transition={springPanel}
          >
            {renderStep()}
          </motion.div>
```

需要新增的两行 import：

```tsx
import { motion } from "motion/react";
import { panelFade, springPanel } from "../../lib/motion";
```

（`../../lib/motion` 是从 `src/components/onboarding/` 出发的正确相对路径；照 `src/components/layout/Sidebar.tsx` 的 import 形式核对。）

### 为什么**不能**用 `AnimatePresence mode="wait"`

这一点是硬性的，仓库已经否决过两次：

1. 方案 004 就是专门把 `mode="wait"` 从侧栏标签切换里**拆掉**的（Status: DONE）。
2. `src/components/ai/AiPanel.tsx:1410-1418` 的注释写着理由：*"an AnimatePresence `mode=\"wait\"` crossfade would hold the outgoing branch on screen for the length of its exit before the new one appears, and a task switch is a direct manipulation that should land under the cursor immediately."*

作者点「下一步」之后必须**立刻**看到下一步。串行的进出场会让每次换步白等两段弹簧时长。

### 为什么把 `.form` 本身变成 motion 元素，而不是在里面再包一层

`.form` 是 `flex: 1` 的 flex 列容器（`Onboarding.module.css:144-149`），而 `renderStep()` 返回的是**片段**，其子元素（含 `styles.spacer`）依赖这个 flex 上下文。在中间插一层新的 div 会把 spacer 的伸缩撑开逻辑打断，布局会塌。让 `motion.div` 直接**接管** `className={styles.form}`，flex 上下文与子元素关系一模一样。

## Repo conventions to follow

- Motion 是设计规范里唯一被批准的 JS 动画库，且**只用于**转场与浮层；本用法属于其中明列的 "Screen / content switches" 一类（见 `docs/reference/design-system.md` → 例外 · 转场与浮层）。
- 精确照抄的范本：`src/components/layout/Sidebar.tsx:121-130`

```tsx
      {/* Enter-only（照 AiPanel.tsx:1384 的注释与先例）：标签切换是直接操纵，
          新面板应立即落位；keyed motion.div 仍会重置子树。 */}
      <motion.div
        key={projectPath ? activeSideTab : "empty"}
        className={isTree ? styles.contentFlush : styles.content}
        variants={panelFade}
        initial="initial"
        animate="animate"
        transition={springPanel}
      >
```

- `panelFade`（`opacity` + 6px 纵向位移）与 `springPanel` 都在 `src/lib/motion.ts`，**直接复用，不要新建预设、不要写内联 transition 对象**。
- `<MotionConfig reducedMotion="user">` 在 `App.tsx` 根部，本处自动遵循 reduced-motion，**不需要**任何本地处理。

## 两条已核实、执行时不必再查的前提

1. **keyed 重挂载是安全的。** `key={step}` 会在每次换步时重置整个子树。`renderStep()` 内部**没有**任何 `useState`——`step` / `closing` / `selected` / `apiKey` / `saving` / `opening` 全部声明在组件体上（`Onboarding.tsx:46-52`）。执行时若发现某个分支里新增了本地 state，停下报告，不要硬上。
2. **不会踩 containing-block 陷阱。** 设计规范提醒：motion 元素动画期间带 `transform`，会成为 `position: fixed` 后代的包含块。本组件内**没有** portal、没有 `Select`、没有 `ContextMenu`，唯一的 `position: fixed` 是根部的 `.backdrop`（`Onboarding.module.css:2`），是祖先不是后代。第 2 步打开的是 Tauri 原生目录对话框（OS 层，不在 DOM 里），同样不受影响。
3. **与方案 013 的谢幕淡出不冲突。** 013 把 `modal-closing` 加在 `.backdrop` 上，其规则 `.modal-closing > *`（`global.css:104-106`）命中的是直接子元素 `.modal`，够不到更深一层的 `.form`。两者作用在不同元素上。

## Steps

1. `src/components/onboarding/Onboarding.tsx`：在文件既有的 import 块末尾追加两行：
   ```tsx
   import { motion } from "motion/react";
   import { panelFade, springPanel } from "../../lib/motion";
   ```
2. 同文件，把 `:362-364` 的
   ```tsx
          <div className={styles.form}>
            {renderStep()}
          </div>
   ```
   整块替换为 Target 一节给出的带注释的 `motion.div` 版本。缩进与周围保持一致。

## Boundaries

- **不要**引入 `AnimatePresence`，**不要**写 `exit` 属性，**不要**写 `mode="wait"`（见 Target 里的两条否决记录）。
- 不动 `renderStep()` 的任何一个分支——四步的内容、字段顺序、按钮、`stepNav` 全部不改。
- 不动向导的步骤流转逻辑（`setStep` 的每一处调用、第 2 步的 dialog 取消分支）。
- 不动 `closing` / `beginDismiss` / `dismiss`（方案 013 的产物）。
- 不动 `Onboarding.module.css`——包括 `.modal` 上既有的 `scaleIn 220ms`（那是整体入场，与换步是两回事）。
- 不新增 `src/lib/motion.ts` 的预设，不写内联 transition。
- 不引入新依赖（`motion` 已在 `package.json`）。
- 若 `:362-364` 的内容与摘录不符（相对 78160c2 有漂移），停下报告。

## Verification

- **Mechanical**:
  - `pnpm tsc --noEmit` 通过。
  - `pnpm build` 通过。
  - `grep -n "AnimatePresence\|mode=\"wait\"\|exit=" src/components/onboarding/Onboarding.tsx` **零命中**。
- **Feel check**: 需要触发首次运行向导。删除/重命名本地的首次运行标记后 `pnpm dev`（若不便，临时在组件里强制渲染即可，**但不要把该改动留在提交里**）：
  - 点「下一步」：新一步应**立即**开始出现并伴 6px 上浮淡入，不应有「旧的先淡出、等一拍、新的才来」的串行感。若感到串行，说明误加了 `AnimatePresence`。
  - 点「上一步」返回：同样立即落位（enter-only 对两个方向一视同仁，这是预期，不是缺陷）。
  - **关键回归**：在第 1 步输入 API key → 前进到第 2 步 → 退回第 1 步，确认输入框里的 key **还在**（证明状态确实在组件体上，keyed 重挂载没有吃掉它）。
  - **关键回归**：走完第 2 步的「选择项目目录」，确认原生对话框正常弹出、取消后停留在原步骤。
  - 走到第 4 步点「开始写作」：确认 013 的整层 160ms 淡出仍然正常，没有被本方案破坏。
  - DevTools → Animations，播放速度 10%：确认只有透明度与 6px 位移，没有缩放、没有横向位移。
  - DevTools → Rendering → `prefers-reduced-motion: reduce`：换步应变为瞬时（`MotionConfig reducedMotion="user"` 的预期行为）。
- **Done when**: 四步之间的前进与后退都有即时的轻微上浮淡入、无串行等待；输入状态跨步保持；013 的谢幕淡出与 `.modal` 的整体入场均无回归。
