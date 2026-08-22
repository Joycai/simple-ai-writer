# 014 — ⌘K 命令面板去动画（决策变更）

- **Status**: DONE (2026-08-22)
- **Commit**: 7b95145
- **Severity**: MEDIUM（高频键盘表面）
- **Category**: 目的与频率
- **Estimated scope**: CommandPalette.tsx + 1 行 CSS + 2 处文档

## Problem

⌘K 命令面板是键盘触发、一天上百次的表面，审计准则对这一档的裁定是「**不做动画，永远**」（Raycast 即无任何进出场）。现状是完整的 Motion 进出场：

```tsx
// src/components/command/CommandPalette.tsx:172-192 — 现状
    <AnimatePresence>
      {showCommandPalette && (
      <motion.div
        key="cmd-backdrop"
        className={styles.backdrop}
        onClick={() => setShowCommandPalette(false)}
        variants={overlayFade}
        initial="initial"
        animate="animate"
        exit="exit"
        transition={overlayFadeTransition}
      >
        <motion.div
          className={styles.palette}
          onClick={(e) => e.stopPropagation()}
          variants={modalPop}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={springPanel}
        >
```

⌘K 是**开关切换**（`useGlobalShortcuts.ts:38-41`），快速连按会把退出弹簧接进入弹簧。此前审计将其记为「既定设计」搁置（design-system.md 把 CommandPalette 列为 Motion 进出场的 sanctioned 用例）；本方案是对该决策的**显式变更**，需同步改文档。

## Target

面板与内容**即现即隐**：两个 `motion.div` 降级为普通 `div`，删 `AnimatePresence`、variants、transitions。唯一保留的缓冲是背板 scrim 的一次 **80ms 纯透明度入场**（CSS，无退出）——不为「动效」，只为免去每次 ⌘K 深色背板整幅闪现的生硬；面板本体与输入框聚焦不被任何动画延迟。

```tsx
// CommandPalette.tsx — 目标
    {showCommandPalette && (
      <div
        className={styles.backdrop}
        onClick={() => setShowCommandPalette(false)}
      >
        <div className={styles.palette} onClick={(e) => e.stopPropagation()}>
          ...children 不变...
        </div>
      </div>
    )}
```

```css
/* CommandPalette.module.css — .backdrop 追加一行（80ms 快到不构成"动画感"，
   仅垫掉 scrim 的整幅闪现；面板本体无任何动画） */
  animation: fadeIn 80ms var(--ease-out);
```

文档同步（决策变更必须落档）：

1. `docs/reference/design-system.md`（约 :195，Motion 的 sanctioned 用例列表）：把 CommandPalette 从「Overlay enter *and* exit」名单里移除，并在该段补一句：命令面板为键盘高频表面，刻意零动画（scrim 80ms 淡入除外），是对原决策的变更。
2. `src/lib/motion.ts`（:72-76 的 overlay 注释与 :98 `modalPop` 的注释提到 palette）：措辞里去掉 command palette 的例子（`modalPop` 本身保留——SettingsPage 等还在用；若 `springPanel`/`overlayFadeTransition` 因此再无使用者，**不要删**，其他表面仍引用）。

## Repo conventions to follow

- `fadeIn` 共享帧在 `global.css:51`；`--ease-out` 令牌。
- `AnimatePresence`/preset 的 import 清理注意 `noUnusedLocals`（先例：004 移除 Sidebar 的 AnimatePresence import）。
- 决策类变更写进 `docs/reference/design-system.md`，不留口头约定（CLAUDE.md 的文档纪律）。

## Steps

1. `src/components/command/CommandPalette.tsx`：按 Target 把两个 `motion.div` 改为 `div`，删除 `AnimatePresence` 包裹、`key="cmd-backdrop"`、全部 `variants/initial/animate/exit/transition` props；清理不再使用的 import（`AnimatePresence`、`motion`、`overlayFade`、`overlayFadeTransition`、`modalPop`、`springPanel`——以文件内实际引用为准）。
2. `src/components/command/CommandPalette.module.css`：`.backdrop` 规则追加 `animation: fadeIn 80ms var(--ease-out);`。
3. `docs/reference/design-system.md`：按 Target 更新 Motion 用例段落。
4. `src/lib/motion.ts`：更新两处注释措辞；不删任何 preset。

## Boundaries

- 不动面板的过滤逻辑、键盘导航、聚焦行为。
- 不动 `modalPop`/`springPanel`/`overlayFade` preset 本身（其他表面在用）。
- 不动 AiDrawer / SettingsPage 的 Motion 进出场（它们是低频抽屉/整页，不适用本准则）。
- 若代码与摘录不符（相对 7b95145 有漂移），停下报告。

## Verification

- **Mechanical**: `pnpm tsc --noEmit`（尤其确认无 unused import）、`pnpm build` 通过。
- **Feel check**: `pnpm dev`：
  - 按 ⌘K：面板与输入框**瞬时**出现、光标立即可打字；scrim 无整幅闪现感。
  - 再按 ⌘K / Escape：瞬时消失，无退出残影。
  - 快速连按 ⌘K 五次：无动画堆积、无闪烁。
  - 对照 AiDrawer（⌘L）：抽屉滑入滑出不受影响。
- **Done when**: ⌘K 双向瞬时、文档两处已记录决策变更、其余 Motion 表面零回归。
