# 037 — 删除分类确认框补入场，危险按钮补按压反馈

- **Status**: DONE（门禁已过，目检待作者）
- **Commit**: 43b52e9
- **Severity**: MEDIUM
- **Category**: 4 可中断/非对称时序 / 7 内聚 / 3 物理性
- **Estimated scope**: 1 个 CSS 文件，约 10 行

## Problem

`src/components/lore/CategoryDeleteModal.module.css:12-30` —— 当前代码：

```css
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(42, 37, 32, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.modal {
  background: var(--color-card);
  border: 1px solid var(--color-border);
  box-shadow: var(--lore-shadow-modal);
  min-width: 440px;
  max-width: 520px;
  padding: 24px 28px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
```

`grep -n "animation" src/components/lore/CategoryDeleteModal.module.css` → **无**。

但它走 `ModalShell`（`CategoryDeleteModal.tsx:84`），关闭时会被打上
`modal-closing`，于是拿到了退场：

```css
/* src/styles/global.css:119-125 — 已有 */
.modal-closing {
  animation: fadeOut 160ms var(--ease-out) forwards;
  pointer-events: none;
}
.modal-closing > * {
  animation: scaleOut 160ms var(--ease-out) forwards;
}
```

结果是：这个对话框**瞬间弹出、优雅消散**。非对称方向正好反了——AUDIT §4 要求
慎重的那一相（此处是"要不要删掉一个分类"）**慢**、系统的响应**快**。
而它是全应用**唯一**的红色不可逆确认（`.btnDanger`，`:113`，注释自陈
"全应用只有这一类动作用它"）。

其余 13 个 ModalShell 对话框全部带着入场对：
`ConfirmDialog.module.css:15,27`、`LoreSplitModal.module.css:16,30`、
`FacetEditModal.module.css:16,29`、`LoreImproveModal.module.css:17,32`、
`ImageGenModal.module.css:18,31`、`ResetAppDialog.module.css:16,28` …
**这一个是异类。**

另外，两颗按钮都没有任何指针反馈：

```css
/* src/components/lore/CategoryDeleteModal.module.css:104-120 — 当前 */
.btnSecondary {
  padding: 8px 14px;
  background: var(--color-card);
  border: 1px solid var(--color-border-strong);
  color: var(--color-sienna);
  font: 500 12px/1 var(--font-sans);
  cursor: pointer;
}
/* 删除是不可逆那一侧，所以按钮不是 sienna 而是红——全应用只有这一类动作用它。 */
.btnDanger {
  padding: 8px 14px;
  background: var(--color-red, #b91c1c);
  color: var(--color-card);
  border: none;
  font: 500 12px/1 var(--font-sans);
  cursor: pointer;
}
```

无 `transition`、无 `:hover`、无 `:active`。**红色不可逆按钮正是按压反馈最该
存在的地方**——而应用里另一个破坏性对话框已经做对了。

## Target

```css
/* target — src/components/lore/CategoryDeleteModal.module.css */
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(42, 37, 32, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  animation: fadeIn 200ms var(--ease-out);
}
.modal {
  background: var(--color-card);
  border: 1px solid var(--color-border);
  box-shadow: var(--lore-shadow-modal);
  min-width: 440px;
  max-width: 520px;
  padding: 24px 28px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  animation: scaleIn 240ms var(--ease-out);
}
```

```css
/* target — 两颗按钮 */
.btnSecondary {
  /* …既有声明不变… */
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast),
    transform var(--transition-fast);
}
.btnSecondary:hover { background: var(--color-bg-hover); }
.btnSecondary:active { transform: scale(0.98); }

.btnDanger {
  /* …既有声明不变… */
  cursor: pointer;
  transition: filter var(--transition-fast), transform var(--transition-fast),
    box-shadow var(--transition-fast);
}
.btnDanger:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); box-shadow: var(--shadow-sm); }
.btnDanger:active:not(:disabled) { transform: translateY(0) scale(0.98); box-shadow: none; }
```

## Repo conventions to follow

- 模态入场对是固定组合，**逐字照抄**：
  ```css
  /* src/components/common/ConfirmDialog.module.css:15,27 — 已有 */
    animation: fadeIn 200ms var(--ease-out);   /* .backdrop */
    animation: scaleIn 240ms var(--ease-out);  /* .modal */
  ```
  `fadeIn`（`global.css:67`）与 `scaleIn`（`global.css:71`）都已存在。
  退场由 `ModalShell` 的 `modal-closing` 统一提供（240ms 进 / 160ms 出，
  非对称方向正确），**不要在本文件里写退场**。
- 破坏性按钮的反馈**逐字照抄**应用里的另一个：
  ```css
  /* src/components/settings/ResetAppDialog.module.css:134-135 — 已有，正确 */
  .confirmBtn:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); box-shadow: var(--shadow-sm); }
  .confirmBtn:active:not(:disabled) { transform: translateY(0) scale(0.98); box-shadow: none; }
  ```
- 按压幅度 `scale(0.98)`，时长 `--transition-fast`（120ms），落在 AUDIT §3 的
  0.95–0.98 / 100–160ms 区间内。仓库现有 70+ 处 `:active` 都是这个量级。

## Steps

1. `src/components/lore/CategoryDeleteModal.module.css` —— `.backdrop` 末尾加
   `animation: fadeIn 200ms var(--ease-out);`。
2. 同文件 —— `.modal` 末尾加 `animation: scaleIn 240ms var(--ease-out);`。
3. 同文件 —— 按 Target 给 `.btnSecondary` 加 `transition` + `:hover` + `:active`。
4. 同文件 —— 按 Target 给 `.btnDanger` 加 `transition` + `:hover:not(:disabled)`
   + `:active:not(:disabled)`。
5. 保留 `:121` 的 `.btnDanger:disabled, .btnSecondary:disabled { … }` 不动，
   并确认新加的 `:hover`/`:active` 都带了 `:not(:disabled)`（`.btnSecondary`
   的按压可不带，与 `ResetAppDialog` 的 `.cancelBtn:active` 一致）。

## Boundaries

- **不要**在本文件写任何退场动画。退场是 `ModalShell` 的职责
  （`global.css:119-125`），本地再写一份会与它叠加。
- **不要**改 `CategoryDeleteModal.tsx`——它已经正确接入 `ModalShell`。
- **不要**把这个确认改成长按确认或加二次确认。方案体例已有裁决：
  `ConfirmDialog` 改长按曾被明确否掉（已是模态 + 焦点默认落在取消键，
  再加摩擦有害）。
- **不要**新增关键帧（`fadeIn`/`scaleIn` 都已存在，新增会撞
  `cssKeyframeNames.test.ts`）。
- **不要**顺手去修 `LoreWall.module.css:397,406` 那块同样没有入场的「新建分类」
  板子——本文件头注释提到它，但它是另一个表面，本方案不扩围。
- 若代码与摘录对不上（自 43b52e9 起漂移），**停下并报告**。

## Verification

- **机械**：
  - `pnpm exec tsc --noEmit` 无诊断；`pnpm test` 全绿（含 `cssKeyframeNames.test.ts`
    ——它会证明你没新增关键帧、且 `fadeIn`/`scaleIn` 引用不悬空）；`pnpm build` 成功。
  - 产物核对：`grep -ohE "animation:[^;}]+" dist/assets/*.css | grep -c "scaleIn"`
    应比改动前多 1；`fadeIn 200ms|fadeIn .2s` 同理多 1。带作用域后缀的引用 0 处。
- **目检**（`pnpm tauri dev` → 知识库墙 → 某个自定义分类 → 删除分类）：
  - 对话框应**淡入 + 轻微放大**出现，而不是硬切；关闭时仍是既有的 160ms 收缩淡出。
    **进比出慢**（240 vs 160）——这正是本方案要恢复的非对称方向。
  - 悬停「删除」红键：轻微上浮 + 提亮；**按下**：回落并缩到 0.98。松开回弹。
  - 悬停/按下「取消」：背景变化 + 按压缩放。
  - 与 `ConfirmDialog`（任意一处普通确认）并排开一次做对比，两者观感应同族。
  - 禁用态（删除进行中）下 `:hover`/`:active` **不应**有任何反应。
  - 开系统「减弱动态效果」：对话框瞬时出现但完整可用（可接受降级）。
- **Done when**：入场对到位、方向恢复为进慢出快，两颗按钮都有 hover 与 active，
  且禁用态不响应。
