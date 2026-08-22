# 006 — 弹出层锚定：从触发器方向出场 + transform-origin

- **Status**: DONE (2026-08-22)
- **Commit**: 9e16885
- **Severity**: MEDIUM
- **Category**: 物理性与出场方向
- **Estimated scope**: 6 个文件（1 个 TSX + 5 个 CSS）

## Problem

触发器锚定的弹出层应该「从触发器长出来」，但现状是四处各自为政、两处方向反了、全库没有一个 `transform-origin`：

1. **Select 下拉**——空间不足时会向上翻（`Select.tsx:64-80` 计算 `up`），但动画无条件用全局 `slideUp`（自下而上 6px），上翻时朝**远离触发器**的方向滑：

```css
/* src/components/common/Select.module.css:51-61 — 现状 */
.menu {
  position: fixed;
  ...
  animation: slideUp 160ms var(--ease-out);
}
```
```tsx
// src/components/common/Select.tsx:71-77 — 现状（up 算完即弃，没有进 state）
    const up = below < wanted && above > below;
    setMenuStyle({
      left: rect.left,
      width: rect.width,
      maxHeight: Math.max(Math.min(wanted, up ? above : below), ROW_HEIGHT * 3),
      ...(up ? { bottom: window.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP }),
    });
```

2. **AiDrawer 会话菜单**——挂在触发器**下方**（`top: calc(100% + 4px)`）却用 `slideUp` **向上**滑入，方向与锚点相悖：

```css
/* src/components/ai/AiDrawer.module.css:104-116 — 现状 */
.sessionMenu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  ...
  animation: slideUp 160ms var(--ease-out);
}
```

3. **ModelSelector**——方向处理是对的（`modelPickerIn` / `modelPickerInUp` 一对本地关键帧，`ModelSelector.module.css:140-156`），但两个帧是 ±4px 的克隆，且缺 `transform-origin`。

4. **ReasoningControls 档位面板**——上挂（`bottom: calc(100% + 6px); right: 0`），方向恰好正确，但又是一份 ±4px 本地克隆帧（`ReasoningControls.module.css:97-102` `dialIn`），缺 origin。

5. **AttachmentTextarea 的 `@` picker**——与 003 已删的 MentionPicker 同病：打字中途卸载重挂、160ms 动画一秒重放数次：

```css
/* src/components/lore/ai/AttachmentTextarea.module.css:14-22 — 现状 */
.picker {
  ...
  animation: slideUp 160ms var(--ease-out);
  max-height: 240px;
}
```

## Target

`global.css` 收两个共享方向帧（含 2% 缩放，配合 transform-origin 产生「从锚点长出」感），四个弹出层按挂载方向取用；AttachmentTextarea 直接删动画（高频打字表面，理由同方案 003）。

```css
/* src/styles/global.css — 在 @keyframes pulseDeep 之后追加 */
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

各处目标：

```css
/* Select.module.css — .menu 默认下挂 */
.menu {
  ...（其余不变）
  animation: dropIn 160ms var(--ease-out);
  transform-origin: top center;
}
/* 新增 */
.menuUp {
  animation-name: riseIn;
  transform-origin: bottom center;
}
```
```tsx
// Select.tsx — up 存入 state，渲染 menu 的元素追加条件类
const [openUp, setOpenUp] = useState(false);
// openMenu 内、setMenuStyle 之前：
setOpenUp(up);
// 渲染处（找到 className={styles.menu} 的元素）：
className={`${styles.menu} ${openUp ? styles.menuUp : ""}`}
```
```css
/* AiDrawer.module.css — .sessionMenu（下挂右对齐） */
  animation: dropIn 160ms var(--ease-out);
  transform-origin: top right;
```
```css
/* ModelSelector.module.css — .popover 下挂左对齐；.popoverUp 上挂 */
.popover {
  ...（其余不变）
  animation: dropIn 140ms var(--ease-out);
  transform-origin: top left;
}
.popoverUp {
  top: auto;
  bottom: calc(100% + 6px);
  animation-name: riseIn;
  transform-origin: bottom left;
}
/* 删除本地 @keyframes modelPickerIn 与 modelPickerInUp */
```
```css
/* ReasoningControls.module.css — .compactPopover（上挂右对齐） */
  animation: riseIn 140ms var(--ease-out);
  transform-origin: bottom right;
/* 删除本地 @keyframes dialIn */
```
```css
/* AttachmentTextarea.module.css — .picker：删除 animation 行，不加新动画 */
```

## Repo conventions to follow

- 共享关键帧住 `src/styles/global.css` 的 "Reusable entrance animations" 块；模块引用本文件未声明的动画名会透传到全局（先例：`AiDrawer.module.css` 引用全局 `slideUp`）。
- 方向感知的先例：`ModelSelector.module.css` 的 `.popoverUp` 覆盖 `animation-name` —— 新的 `.menuUp` 沿用同一手法。
- 弹出层时长保持原值（Select/AiDrawer 160ms，ModelSelector/ReasoningControls 140ms），都在 150–250ms 下拉预算内。

## Steps

1. `src/styles/global.css`：追加 `dropIn` / `riseIn` 两个关键帧（上文目标代码）。
2. `src/components/common/Select.module.css`：`.menu` 的 `animation` 改为 `dropIn 160ms var(--ease-out)`，加 `transform-origin: top center;`；新增 `.menuUp` 规则。
3. `src/components/common/Select.tsx`：新增 `openUp` state，`openMenu` 里 `setOpenUp(up)`，menu 元素 className 追加条件类（上文目标代码；找不到 `styles.menu` 的唯一渲染点就停下报告）。
4. `src/components/ai/AiDrawer.module.css`：`.sessionMenu` 的 `animation` 改 `dropIn`，加 `transform-origin: top right;`。
5. `src/components/ai/ModelSelector.module.css`：`.popover`/`.popoverUp` 按目标改，删除两个本地关键帧。
6. `src/components/ai/ReasoningControls.module.css`：`.compactPopover` 按目标改，删除 `dialIn`。
7. `src/components/lore/ai/AttachmentTextarea.module.css`：删除 `.picker` 的 `animation` 行。

## Boundaries

- 不动各弹出层的定位、尺寸、颜色、z-index。
- 不动全局 `slideUp`（其他表面还在用）。
- 不改 Select 的翻转判定逻辑，只是把已算出的 `up` 存下来。
- 若某处与摘录不符（相对 9e16885 有漂移），停下报告该处、其余照常。

## Verification

- **Mechanical**: `pnpm tsc --noEmit`、`pnpm build` 通过；`grep -n "modelPickerIn\|dialIn" src/ -r` 零命中。
- **Feel check**: `pnpm dev`：
  - 设置页把一个 Select 滚到窗口底部再打开（触发上翻）：菜单应从触发器**向上长出**，不再向上飘离。
  - AI 抽屉头部打开会话菜单：应从按钮下缘**落下**。
  - DevTools Animations 放慢 10%：确认缩放以锚点侧为原点（贴触发器的一边基本不动）。
  - lore 模态里打 `@`：候选列表稳定出现、打字中不再重跳。
- **Done when**: 四个弹出层方向与锚点一致且带 origin，AttachmentTextarea 无入场动画，本地方向帧清零。
