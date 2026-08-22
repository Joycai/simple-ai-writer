# 008 — 模态退出动画：在 ModalShell 一处解决

- **Status**: DONE (2026-08-22，ConfirmDialog 按修正后的嵌套形态落地)
- **Commit**: 9e16885
- **Severity**: MEDIUM
- **Category**: 可中断性 / 一致性
- **Estimated scope**: ModalShell.tsx + global.css + ConfirmDialog.tsx，~60 行

## Problem

`lib/motion.ts:72-76` 的注释声称 mount-only CSS 模态入场已被 AnimatePresence 取代，实际只迁移了三个大表面（AiDrawer/CommandPalette/SettingsPage）。其余 11 个模态仍是 `fadeIn 200ms + scaleIn 240ms` 入场、**关闭一帧硬切**：ConfirmDialog、ErrorBoundary、BatchRunModal、ImageGenModal、PromptViewer、sync、LoreSplitModal、LoreImproveModal、LoreGenerator、FacetEditModal、Onboarding（`grep -rn "scaleIn 2" src/components --include=*.css` 可复核）。

逐个迁移 11 个模态到 AnimatePresence 代价大且重复。但其中大多数已经路由过共享壳 `src/components/common/ModalShell.tsx`（12 个消费者，见 `grep -rn "ModalShell" src`）——壳持有 overlay 元素（`ModalShell.tsx:132-137`）并且所有关闭路径都汇聚在 `requestCloseRef.current`（`ModalShell.tsx:71-80`，backdrop 与 Escape 都走它）：

```tsx
// src/components/common/ModalShell.tsx:132-137 — 现状
  return createPortal(
    <div className={overlayClassName} onMouseDown={onMouseDown} onMouseUp={onMouseUp}>
      <ModalErrorBoundary onClose={onClose}>{children}</ModalErrorBoundary>
    </div>,
    document.body,
  );
```

在壳里实现一次「先播退出、再真关闭」，所有消费者的 backdrop/Escape 关闭立即受益；按钮触发的关闭通过一个 context 逐步接入（本方案先接 ConfirmDialog 作为样板）。

## Target

**1. ModalShell 增加 closing 状态与 context：**

```tsx
// ModalShell.tsx — 新增（文件顶部）
import { createContext, useContext, useState } from "react";  // 并入现有 import

/** 子组件用它关闭模态即可获得退出动画；直接调 onClose 则立即关闭（旧行为）。 */
const ModalCloseContext = createContext<(() => void) | null>(null);
export function useModalClose(): (() => void) | null {
  return useContext(ModalCloseContext);
}
const EXIT_MS = 160;
```

```tsx
// ModalShell 组件体内 — 新增
const [closing, setClosing] = useState(false);
const beginClose = () => {
  if (closing) return;
  setClosing(true);
  window.setTimeout(onClose, EXIT_MS);
};
```

`requestCloseRef.current` 里把末尾的 `onClose();` 改为 `beginClose();`（isDirty confirm 逻辑不动）。渲染改为：

```tsx
  return createPortal(
    <div
      className={`${overlayClassName} ${closing ? "modal-closing" : ""}`}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
    >
      <ModalCloseContext.Provider value={beginClose}>
        <ModalErrorBoundary onClose={onClose}>{children}</ModalErrorBoundary>
      </ModalCloseContext.Provider>
    </div>,
    document.body,
  );
```

**2. global.css 定义退出动画**（`modal-closing` 是全局类，作用于任意 overlay 及其面板子元素）：

```css
/* src/styles/global.css — 关键帧块追加 */
@keyframes fadeOut {
  to { opacity: 0; }
}
@keyframes scaleOut {
  to { opacity: 0; transform: scale(0.97); }
}

/* ModalShell 关闭中：整层淡出、面板轻微收缩；期间吞掉输入。 */
.modal-closing {
  animation: fadeOut 160ms var(--ease-out) forwards;
  pointer-events: none;
}
.modal-closing > * {
  animation: scaleOut 160ms var(--ease-out) forwards;
}
```

**3. ConfirmDialog 接入 context（样板消费者）：**

> **⚠ 执行中发现并修正**：`useModalClose()` **不能**写在渲染 `<ModalShell>` 的那个组件体里——Provider 在壳的内部（树的下方），钩子在壳的**子组件**里调用才拿得到。正确形态是把面板拆成嵌套组件：

```tsx
// ConfirmDialog.tsx — 正确形态：外层只渲染壳，面板拆成壳的子组件
export function ConfirmDialog(props: Props) {
  return (
    <ModalShell overlayClassName={styles.overlay} onClose={props.onClose}>
      <ConfirmDialogPanel {...props} />
    </ModalShell>
  );
}
function ConfirmDialogPanel({ ... }: Props) {
  const requestClose = useModalClose() ?? onClose;
  // 取消按钮 onClick={onClose} → onClick={requestClose}
  // 确认按钮 onClick 里的 onClose() → requestClose()
}
```

## Repo conventions to follow

- ModalShell 的头注释就写着「壳已解决的事不在消费者里重复解决」——退出动画正属此类。
- 关键帧住 `global.css` 的共享块；`--ease-out` 令牌；160ms 与弹出层入场同级（模态入场 240ms、退出更快，符合「退出比进入快」的惯例）。
- `ModalErrorBoundary` 包裹保持原位（`ModalShell.tsx:129-134` 注释说明了它的作用）。

## Steps

1. `src/styles/global.css`：追加 `fadeOut`/`scaleOut` 关键帧与 `.modal-closing` 规则（上文目标代码）。
2. `src/components/common/ModalShell.tsx`：按目标代码加 context、`closing` state、`beginClose`；`requestCloseRef` 改调 `beginClose`；渲染处拼接 `modal-closing` 类并包 Provider。
3. `src/components/common/ConfirmDialog.tsx`：按目标代码接入 `useModalClose`。
4. 自查：`closing` 期间再触发 backdrop/Escape 应被 `if (closing) return;` 吞掉；`isDirty` 的 confirm 弹窗逻辑完全不变。

## Boundaries

- 本方案**只**改 ModalShell、global.css、ConfirmDialog 三个文件。其余 ModalShell 消费者（LoreSplitModal 等）的按钮仍直接调 `onClose`（立即关闭，无回归）。后续迁移**必须**按上面 ConfirmDialog 的嵌套形态做：钩子只在 `<ModalShell>` 的子组件里调用——直接写在渲染壳的组件体里会静默拿到 `null`、无声退化为立即关闭。
- 不迁移未走 ModalShell 的表面（ErrorBoundary、Onboarding、BatchRunModal、PromptViewer、sync 的入口层）——那是后续方案。
- 不动各模态的入场动画（fadeIn/scaleIn 保留原值）。
- 若 ModalShell 的代码与摘录不符（相对 9e16885 有漂移），停下报告。

## Verification

- **Mechanical**: `pnpm tsc --noEmit`、`pnpm build` 通过。
- **Feel check**: `pnpm dev`：
  - 触发一个 ConfirmDialog（如删除文件），点取消：整层应 160ms 淡出、面板轻微收缩，不再一帧消失。
  - 点 backdrop、按 Escape 关闭任一 lore 模态：同样有退出动画（无需改那些组件）。
  - 关闭动画进行中狂点 backdrop：不会重复触发或提前硬切。
  - 带未保存修改的模态（isDirty）按 Escape：仍先弹 confirm，取消后模态不关。
- **Done when**: ModalShell 的所有关闭路径都有 160ms 退出，ConfirmDialog 按钮接入，其余消费者行为不回归。
