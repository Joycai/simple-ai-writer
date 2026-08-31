# 032 — 「移到分类」浮层补入场与锚定（015 的漏网之鱼）

- **Status**: DONE（门禁已过，目检待作者）
- **Commit**: 43b52e9
- **Severity**: HIGH
- **Category**: 3 物理性与锚定 / 7 内聚
- **Estimated scope**: 1 个 CSS 文件，2 行

> **📌 2026-08-31 修正**：本方案初稿写的是 `dropIn`，**是错的**。执行时经核实，
> `global.css:100` 的注释已把规则定死——「下挂用 dropIn，上挂用 riseIn」——而本
> 菜单的锚点恒为 `above: true`。已全文改为 `riseIn`。若你手上是旧版副本，以本版为准。

## Problem

`src/components/lore/CategoryMoveMenu.module.css:7-17` —— 当前代码：

```css
.menu {
  position: fixed;
  z-index: 420;
  width: 250px;
  background: var(--color-bg-raised);
  border: 1px solid var(--lore-flip-border);
  box-shadow: var(--lore-shadow-modal);
  display: flex;
  flex-direction: column;
  max-height: 70vh;
}
```

**零 `animation`，零 `transform-origin`**（`grep -n "animation\|transform-origin" src/components/lore/CategoryMoveMenu.module.css` 返回空）。

它是一个 portal 到 body、锚定在触发按钮上的浮层——锚点从触发器自己的矩形算出来：

```tsx
/* src/components/lore/LoreWall.tsx:1039 — 当前 */
setCatMove({ x: r.left, y: r.top - 8, above: true });
```

锚定浮层恰恰是**最不能**凭空出现的一类元素：它需要说明自己是从哪儿来的。

加重这一条的是它的邻居：**同一条动作条上**，右键分类芯片打开的是真正的
`ContextMenu`（`LoreWall.tsx:1140`），那个会落下来；而下面一行的「移到分类」
按钮打开的这个，硬切。两个菜单，一条动作条，两种行为。

这与方案 015 是同一性质：015 修的是 `ContextMenu`——方案 006 那份锚定浮层清单的
漏网之鱼。本方案修的是 015 之后**新增**的浮层，它没接上那条约定。

## Target

```css
/* target — src/components/lore/CategoryMoveMenu.module.css */
.menu {
  position: fixed;
  z-index: 420;
  width: 250px;
  background: var(--color-bg-raised);
  border: 1px solid var(--lore-flip-border);
  box-shadow: var(--lore-shadow-modal);
  display: flex;
  flex-direction: column;
  max-height: 70vh;
  /* 上挂用 riseIn 而不是 dropIn——global.css:100 的注释就是这条规则：
     「下挂用 dropIn（从触发器落下），上挂用 riseIn」。本菜单的锚点恒为
     above: true（LoreWall.tsx:1039 是唯一调用点，浮层底边贴着按钮顶边），
     用 dropIn 会让它从 4px 上方掉下来，方向与它实际生长的方向相反。
     原点相应是 bottom left（左沿对齐同 ContextMenu，纵向从按钮那条边长出）。 */
  animation: riseIn 140ms var(--ease-out);
  transform-origin: bottom left;
}
```

即：在 `.menu` 块内**新增两行声明**，其余一字不动。

## Repo conventions to follow

范本（**照抄它的写法，但按上面的理由改 origin**）：

```css
/* src/components/common/ContextMenu.module.css:10-16 — 已有，正确 */
  padding: 5px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-strong);
  box-shadow: var(--shadow-lg);
  animation: dropIn 140ms var(--ease-out);
  transform-origin: top left;
}
```

同一处方的其它落点，可作为交叉参考：
`src/components/ai/ModelSelector.module.css:140`、`src/components/common/Select.module.css:60`、
`src/components/ai/AiDrawer.module.css:115`、`src/components/settings/panes/ProvidersModels.module.css:286`
—— 全部是 `animation: dropIn 140~160ms var(--ease-out)` + 一个 `transform-origin`。

方向的选择不是自由的，`src/styles/global.css:100-109` 已经把规则写在注释里：

```css
/* 触发器锚定的弹出层入场：下挂用 dropIn（从触发器落下），上挂用 riseIn。
   配合各自的 transform-origin 使用。 */
@keyframes dropIn {
  from { opacity: 0; transform: translateY(-4px) scale(0.98); }
  to   { opacity: 1; transform: none; }
}
@keyframes riseIn {
  from { opacity: 0; transform: translateY(4px) scale(0.98); }
  to   { opacity: 1; transform: none; }
}
```

**本菜单上挂，所以用 `riseIn`。** 既有的上挂消费者可作参考——
`src/components/common/Select.module.css:63-66`、`src/components/ai/ModelSelector.module.css:148`、
`src/components/settings/panes/ProvidersModels.module.css:290` 都是
`animation-name: riseIn` + `transform-origin: bottom …`；
`src/components/ai/ReasoningControls.module.css:97` 是直接写全的那种，形状与本方案相同。

**不要新增关键帧。** 模块内 `@keyframes` 与 `global.css` 共用一个全局命名空间，
新增会撞上 `src/lib/__tests__/cssKeyframeNames.test.ts`。

## Steps

1. `src/components/lore/CategoryMoveMenu.module.css` —— 在 `.menu` 规则块内、
   `max-height: 70vh;` 之后，追加：
   ```css
   animation: riseIn 140ms var(--ease-out);
   transform-origin: bottom left;
   ```
   连同 Target 里那段解释「为什么是 riseIn + bottom left」的注释一并写入。
2. 不要动该文件的其它任何规则（`.head`、`.row` 等）。

## Boundaries

- **不要**改 `src/components/lore/LoreWall.tsx`——锚点计算是对的，本方案不碰定位。
- **不要**新增 `@keyframes`（会撞 `cssKeyframeNames.test.ts`）。
- **不要**顺手给 `.row` 补 `:active`——那是另一份方案的范围（LOW 档，本批未立案）。
- **不要**改 `ContextMenu.module.css`，它已经是对的。
- 若代码与摘录对不上（自 43b52e9 起漂移），**停下并报告**。

## Verification

- **机械**：
  - `pnpm exec tsc --noEmit` 无诊断；`pnpm test` 全绿（含 `cssKeyframeNames.test.ts`——
    它会同时证明你**没有**新增关键帧、且 `dropIn` 这个引用不是悬空的）。
  - `pnpm build` 成功。
  - 构建产物核对（本仓库唯一能在不跑应用的前提下证明动画真的会播的检查）：
    `grep -ohE "animation:[^;}]+" dist/assets/*.css | grep -c "riseIn"` —— 应比改动前**多 1**
    （`dropIn` 的计数应**不变**）。带作用域后缀（`_riseIn_<hash>_1` 那种）的引用必须是 **0 处**。
- **目检**（`pnpm tauri dev`，打开一个项目 → 知识库墙）：
  - 选中一个条目，点动作条上的「移到分类」。菜单应从**按钮那条边**向上长出来，
    140ms，不是凭空出现。**方向必须是「升起」而不是「落下」**——若看到它先在
    上方 4px 再向下沉，说明用成了 `dropIn`。
  - 紧接着右键一个分类芯片打开 `ContextMenu`。两个菜单现在应读起来是**同一套语汇**
    ——这条对比是本方案的全部意义，务必连着做一次。
  - DevTools Animations 面板调到 10% 速度再开一次：确认缩放原点在菜单**底部左侧**，
    菜单不是从自己中心或顶部展开的；纵向位移应是 `+4px → 0`（升起），不是 `-4px → 0`。
  - 开系统「减弱动态效果」再开一次：菜单应瞬时出现且**完整可用**（全局
    `global.css:138` 会把时长压到 0.001ms，这是本方案可接受的降级——它是 opacity+
    小位移，不承载信息）。
- **Done when**：`.menu` 带 `riseIn` 与 `bottom left`，产物里 `riseIn` 引用数 +1、
  `dropIn` 不变，且与同屏 `ContextMenu` 的观感同族（方向相反是对的——
  那一个下挂、这一个上挂）。
