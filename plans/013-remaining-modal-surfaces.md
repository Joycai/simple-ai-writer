# 013 — 剩余非 ModalShell 模态表面的退出动画

- **Status**: DONE (2026-08-22)
- **Commit**: 7b95145
- **Severity**: LOW
- **Category**: 可中断性 / 一致性（008 的最后一块）
- **Estimated scope**: 3 个 TSX + 0 个新 CSS（复用 `modal-closing`）

## Problem

008/#275 之后，所有走 ModalShell 的模态都有 160ms 退出动画。仍在壳外的四个表面处置各不相同：

**A. BatchRunModal**（`src/components/ai/BatchRunModal.tsx`）——手卷 overlay，关闭一帧硬切，且没有 Escape、没有 mousedown-origin 守卫（在面板里拖选文字松手到背板上会误关）：

```tsx
// BatchRunModal.tsx:78-91 — 现状
  const handleFinish = () => {
    if (outputPath) setActiveFilePath(outputPath);
    onClose();
  };
  const handleClose = () => {
    if (!running) reset();
    onClose();
  };

  return (
    <div className={styles.overlay} onClick={handleClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
```

**B. PromptViewer**（`src/components/ai/PromptViewer.tsx`）——createPortal + 手卷 overlay + **自己的捕获阶段 Escape 监听**（`:51-62`，用 `stopPropagation` 抢在背后 AI 抽屉的 Escape 之前）。关闭硬切：

```tsx
// PromptViewer.tsx:73-81 — 现状
  return createPortal(
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal
        data-ai-surface
        onMouseDown={(e) => e.stopPropagation()}
      >
```

**C. Onboarding**（`src/components/onboarding/Onboarding.tsx:306-308`）——不是可关闭模态（无背板点击、无 Escape，只有「跳过」/「开始写作」按钮走 `dismiss`），不适合迁壳。但这是首次运行的谢幕时刻，`dismiss` 后一帧硬切进主界面，配得上一次淡出——`global.css` 的 `modal-closing` 类（fadeOut + 面板 scaleOut，`.modal-closing` / `.modal-closing > *`）可直接复用。

**D. ErrorBoundary**（`src/components/common/ErrorBoundary.module.css:17/35` 的 overlay/panel）——**本方案明确不做**：这是崩溃恢复表面，出现频率趋近于零，且崩溃语境下即时关闭/重载是合理行为；为它加退出动画收益为负（多一层状态就多一处崩溃面）。

（sync 一项经核实无剩余工作：`SyncPreviewModal` 已在 #275 接入壳，`sync.module.css:21/45` 只是入场 CSS，入场本就保留。）

## Target

**A. BatchRunModal 迁入 ModalShell**（照壳头注释的迁移路径：删手卷 overlay，壳接管）：

```tsx
import { ModalShell } from "../common/ModalShell";
// 组件体内：
const shellCloseRef = useRef<(() => void) | null>(null);
const requestClose = () => (shellCloseRef.current ?? handleClose)();
// handleFinish / handleClose 内的 onClose() 改为经 requestClose 收尾：
//   handleFinish = () => { if (outputPath) setActiveFilePath(outputPath); requestClose_inner(); }
//   —— 注意:handleClose 本身是传给壳的 onClose(壳动画结束后调用,做 reset+onClose),
//   面板按钮统一改调 requestClose;handleFinish 里把「选中输出文件」的副作用留在原地、
//   把末尾 onClose() 换成 requestClose()(reset 逻辑由 handleClose 在壳回调里完成——
//   为此 handleFinish 不再自己调 onClose,让壳统一走 handleClose)。
return (
  <ModalShell overlayClassName={styles.overlay} onClose={handleClose} closeRef={shellCloseRef}>
    <div className={styles.panel}>
      ...
```

具体规则：删除 overlay div 的 `onClick={handleClose}` 与 panel 的 `stopPropagation`（壳的 mousedown-origin 守卫取代）；面板内所有关闭按钮（头部 ×、完成/关闭）改 `requestClose()`；`handleFinish` 的 `onClose()` 也改 `requestClose()`，其 `setActiveFilePath` 副作用保留在调用前。迁移后额外获得 Escape 关闭与模态栈——这是行为增强，注释里点明即可。

**B. PromptViewer 迁入 ModalShell，但保留自己的 Escape 监听**：

```tsx
import { ModalShell } from "../common/ModalShell";
// 保留 :51-62 的捕获阶段 Escape 监听（它的存在理由是抢在 AI 抽屉之前，
// 壳的监听不是捕获阶段，替换会让抽屉同时收到 Escape），但回调里的
// onClose() 改为 requestClose()；壳侧传 closeOnEscape={false} 防止双触发。
const shellCloseRef = useRef<(() => void) | null>(null);
const requestClose = () => (shellCloseRef.current ?? onClose)();
return (
  <ModalShell overlayClassName={styles.overlay} onClose={onClose} closeOnEscape={false} closeRef={shellCloseRef}>
    <div className={styles.modal} role="dialog" aria-modal data-ai-surface>
      ...
```

删除自身的 `createPortal`（壳自带）、overlay 的 `onMouseDown={onClose}`、panel 的 `stopPropagation`；头部关闭按钮改 `requestClose()`。`data-ai-surface` 与 `role="dialog"` 保留在 panel 上。

**C. Onboarding 的谢幕淡出**（不迁壳，本地 closing 状态 + 复用全局类）：

```tsx
const [closing, setClosing] = useState(false);
const beginDismiss = () => {
  if (closing) return;
  setClosing(true);
  window.setTimeout(dismiss, 160);
};
// 两个按钮（brandSkip 与 nextBtn 的「开始写作」）onClick={dismiss} → onClick={beginDismiss}
<div className={`${styles.backdrop} ${closing ? "modal-closing" : ""}`}>
```

**D. ErrorBoundary：不改。** 在方案里记录决定即可。

## Repo conventions to follow

- 壳迁移路径就写在 `ModalShell.tsx` 头注释（"migrating a modal is just: drop the hand-rolled div + createPortal and wrap the panel here"）。
- `closeRef` 接入形态照 #275 的消费者（如 `SyncPreviewModal.tsx:80-95`）。
- `modal-closing` 类与 160ms 时长在 `global.css`（008 引入）。

## Steps

1. `src/components/ai/BatchRunModal.tsx`：按 Target A 迁移（import 壳、closeRef、删手卷背板事件、关闭点改 requestClose）。逐一核对面板里的每个关闭按钮。
2. `src/components/ai/PromptViewer.tsx`：按 Target B 迁移，保留捕获 Escape 监听并改调 requestClose，壳传 `closeOnEscape={false}`。
3. `src/components/onboarding/Onboarding.tsx`：按 Target C 加 `closing` 状态与 `beginDismiss`，两个按钮改接。
4. 全局搜一遍 `createPortal` 确认 `src/components` 下不再有手卷模态 overlay（CommandPalette 除外——它走 Motion，是 014 的对象；MentionPicker/Select 的 portal 是弹出层不是模态，不动）。

## Boundaries

- ErrorBoundary 不改。
- 不动三个组件的业务逻辑（批量运行的 store 语义、PromptViewer 的复制、Onboarding 的步骤流）。
- 不动它们的入场动画 CSS。
- 若组件结构与摘录不符（相对 7b95145 有漂移），停下报告该处、其余照常。

## Verification

- **Mechanical**: `pnpm tsc --noEmit`、`pnpm build` 通过。
- **Feel check**: `pnpm dev`：
  - 批量运行模态：Escape 现在能关（新能力）；在面板里拖选文字松手到背板不再误关；点 × 或完成有 160ms 退出；运行中关闭后批量仍继续（原语义）。
  - AI 面板失败卡打开「查看完整提示」：Escape 只关它、AI 抽屉不动（原语义保住）；关闭有退出动画。
  - 完成或跳过 onboarding：整层 160ms 淡出后进入主界面，不再硬切。
- **Done when**: 三个表面接入退出动画且各自的特殊语义（批量不中断、Escape 抢占、onboarding 不可误关）全部保持。
