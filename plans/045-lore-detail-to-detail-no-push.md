# 045 — 知识库「条目 → 条目」不再推入推出

- **Status**: DONE（2026-09-10，PR #575；作者真窗口目检通过，含 LoreDetail 状态重置回归）
- **Commit**: 484fe4b
- **Severity**: MEDIUM
- **Category**: 5 起点与物理感 / 1 目的与频率
- **Estimated scope**: 1 个文件（`src/components/lore/LoreWall.tsx`），挪一个 `key` + 改注释，约 10 行

## Problem

知识库的网格 ↔ 详情用 Motion 做 iOS 式推进（design-system.md 的既定用例，**本方案保留它**）。
但推进层的 `key` 绑的是**条目**，不是「在详情里」这件事：

```tsx
/* src/components/lore/LoreWall.tsx:645-665 — 当前 */
      <AnimatePresence initial={false}>
        {/* Keyed by entity: LoreDetail seeds internal state from the entity it
            mounted with, so going straight from one entry to another (a
            citation click, a history step) has to remount it. */}
        {detailEntity ? (
          <motion.div
            key={`detail:${detailEntity.dirPath}`}
            variants={forwardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={springScreen}
            style={fillLayer}
          >
            <LoreDetail
              entity={detailEntity}
              initialEditing={detailEditing}
              onBack={() => openDetail(null)}
            />
          </motion.div>
        ) : (
```

`pushForward`（`src/lib/motion.ts:81-85`）：

```ts
export const pushForward: Variants = {
  initial: { opacity: 0, transform: "translateX(40px)" },
  animate: { opacity: 1, transform: "translateX(0px)" },
  exit: { opacity: 0, transform: "translateX(40px)" },
};
```

于是**详情 → 详情**的每一次换条目，都是一次完整的 AnimatePresence 退场 + 入场：
旧页从 0 滑向右边 40px，新页从右边 40px 滑向 0，两张同形的纸**反向交叉**滑过，
`springScreen` 约 0.3s 才落定。触发点很多，而且都是「在同一层里换内容」，没有空间跳转：

- 详情头部的上一条 / 下一条：`src/components/lore/LoreDetail.tsx:1075`、`:1080`
- 阅读态页脚「下一条」：`LoreDetail.tsx:1213`
- 正文里点引用、命令面板跳条目：`src/components/command/CommandPalette.tsx:349`
- 前进 / 后退（快捷键与鼠标侧键）：`src/stores/navStore.ts:73`

这还和方案 033 自己写下的验收判据**直接矛盾**。033 给阅读态的换条目配了一次 120ms 纯淡入
（`LoreReadView.module.css:19`），它的 Verification 写着：

> DevTools Animations 面板 10% 速度看一次换条目：应只有 opacity 在变，**不应**有任何 X 方向位移。

外层这层推进恰好就是那段 X 方向位移——033 的淡入是对的，被外层盖住了。

`key` 挂在推进层上的**原因**（注释里写的：LoreDetail 从挂载时的条目初始化内部状态，换条目必须重挂）
是真实的，但它只要求 **LoreDetail** 重挂，不要求**推进层**重挂。

## Target

推进层的 `key` 固定为 `"detail"`；按条目重挂的 `key` 下移到 `<LoreDetail>` 本身。

- 网格 → 详情：推进层从无到有 → 仍然推入（不变）。
- 详情 → 网格：推进层卸载 → 仍然推出（不变）。
- 详情 → 详情：推进层保持挂载、不播任何动画；`LoreDetail` 按新 `key` 重挂（内部状态照旧重置），
  阅读态由方案 033 的 120ms 淡入接住，管理态一帧换页（与 033「管理台分支没有任何入场」一致）。

```tsx
/* target — src/components/lore/LoreWall.tsx:645-665 */
      <AnimatePresence initial={false}>
        {detailEntity ? (
          <motion.div
            // 键固定为 "detail"（方案 045）：推入/推出只属于「网格 ↔ 详情」这一次空间
            // 跳转。条目 → 条目（上一条/下一条、引用、前进后退）不再换这一层——否则旧页
            // 向右退、新页从右进，两张同形的纸反向交叉滑过，还盖掉阅读态自己的淡入。
            key="detail"
            variants={forwardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={springScreen}
            style={fillLayer}
          >
            {/* Keyed by entity: LoreDetail seeds internal state from the entity it
                mounted with, so going straight from one entry to another (a
                citation click, a history step) has to remount it. The key sits on
                LoreDetail, not on the motion layer, so that remount is not a push. */}
            <LoreDetail
              key={detailEntity.dirPath}
              entity={detailEntity}
              initialEditing={detailEditing}
              onBack={() => openDetail(null)}
            />
          </motion.div>
        ) : (
```

## Repo conventions to follow

- `entity.dirPath` 是条目的稳定身份（条目文件夹的绝对路径）——方案 033 在 `LoreDetail.tsx` 里给
  `<LoreReadView>` 用的也是 `key={entity.dirPath}`，同一个理由，照抄。**不要**用 `entity.id`（跨分类可能重名）。
- React 的 `key` 变化 = 卸载 + 全新挂载，与 `key` 放在父层还是子层无关——LoreDetail 的「换条目必重挂」语义完全不变。
- `pushForward` / `pushBackdrop` / `springScreen` 保持原值（design-system.md 的既定用例，方案 004/025 均未改动）。

## Steps

1. `src/components/lore/LoreWall.tsx:646-648` —— 删除 `{/* Keyed by entity: … has to remount it. */}` 这段 JSX 注释（它会被移进 `motion.div` 里面，见第 3 步）。
2. `src/components/lore/LoreWall.tsx:651` —— `key={`detail:${detailEntity.dirPath}`}` 改为 `key="detail"`，并在它**上方**加入 Target 里那段 `//` 注释（三行）。
3. `src/components/lore/LoreWall.tsx:659` —— 在 `<LoreDetail` 之前插入 Target 里那段 JSX 注释（四行）；在 `<LoreDetail` 的第一行属性位置加 `key={detailEntity.dirPath}`，**放在 `entity={detailEntity}` 之前**。
4. 其余属性（`variants` / `initial` / `animate` / `exit` / `transition` / `style`，以及 `entity` / `initialEditing` / `onBack`）一个字不动。网格分支（`:666` 起的 `key="grid"` 那个 `motion.div`）不动。

## Boundaries

- **不要**改 `src/lib/motion.ts` 的任何预设。
- **不要**改网格分支、`AnimatePresence` 的 `initial={false}`、`fillLayer`。
- **不要**给管理态补换条目动效来「凑对称」——方案 033 已经论证过两边不做位移就是对称的。
- **不要**动 `LoreDetail.tsx` / `LoreReadView.tsx`（033 的 `key` 与淡入保持原样）。
- **不要**动 `navStore` / 快捷键。
- 若摘录与代码对不上（自 484fe4b 起漂移），**停下并报告**。

## Verification

- **机械**：
  - `grep -n 'detail:\${' src/components/lore/LoreWall.tsx` → **必须为空**。
  - `pnpm exec tsc --noEmit` 无诊断；`pnpm test` 全绿；`pnpm build` 成功。
- **目检**（需 `pnpm tauri dev` + 一个至少有三条知识库条目的项目；浏览器 dev server 打不开项目）：
  - **不变的部分**：网格点一张卡 → 详情仍从右推入、网格略向左退；点返回 → 详情仍向右推出。
  - **变的部分**：在详情里连点「下一条」/「上一条」——**没有任何横向位移、没有两页交叉**。
    阅读态每次都有一次极短的淡入（033）；管理态一帧换页。
  - 滚到某条目正文中段再点「下一条」：新条目仍从**顶部**开始（033 的回归，务必一起验）。
  - **状态重置回归（最重要）**：在条目 A 进入编辑态或展开某一节，然后点「下一条」到 B——
    B 必须是**全新状态**，不继承 A 的编辑态/展开态。若继承了，说明 `key` 没挂到 `LoreDetail` 上。
  - 在两个条目之间用后退/前进（快捷键或鼠标侧键）：无位移。从详情后退到网格：仍有推出。
  - DevTools → Animations 面板 10% 速度录一次「下一条」：只允许看到 opacity（033 的 `fadeIn`），
    **不应**有 transform 动画——这正是 033 Verification 里那条原本过不了的判据。
- **Done when**：grep 为空、门禁三项通过；详情内换条目零位移，网格↔详情推进不变，换条目后 LoreDetail 状态完全重置。
