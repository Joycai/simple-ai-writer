# 055 — 生成完成后轻淡入候选结果卡

- **Status**: IMPLEMENTED（2026-10-03；代码审查及机械检查通过，真实 Tauri 目检待验）
- **Commit**: 1e0e0d22
- **Date**: 2026-10-03
- **Severity**: LOW
- **Category**: Missed opportunities / 状态指示
- **Estimated scope**: 1 个 CSS 文件，新增 1 条声明

## Problem

`src/components/lore/LoreGenerator.tsx:318` 在生成结束后挂载结果分支；`:328` 的卡片直接出现：

```tsx
              <div className={styles.resultCard}>
                <div className={styles.resultHeader}>
```
`src/components/lore/LoreGenerator.module.css:205` 当前样式：

```css
.resultCard {
  border: 1.5px solid var(--color-sienna);
  background: var(--color-card);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
```
偶发的异步完成值得一小段状态反馈；这是结果就绪的反馈，不是按钮、快捷键或流式 token 的动画。正文马上要被阅读和编辑，因此只淡入，不移动内容。频率为场景估计，尚无运行界面手感验证。

## Target

在现有 `.resultCard` 末尾添加：

```css
  animation: fadeIn 160ms var(--ease-out);
```
精确参数：opacity 0 → 1；160ms；cubic-bezier(0.32, 0.72, 0, 1)；delay 0ms；单次；默认 fill-mode none。仅每次新结果分支挂载时播放，编辑字段/标签/分类或普通重渲染不重播。不加 hover，不屏蔽交互。减动效保留这段纯淡入。

## Repo conventions to follow

项目根目录：`/Users/caizhengxu/github/simple-ai-writer`；以下相对路径均从这里解析。
React 19 + TypeScript + CSS Modules + Tauri v2；Motion 已安装，但本方案不新增依赖。
`src/styles/tokens.css:75` 的 `--ease-out` 精确值是 `cubic-bezier(0.32, 0.72, 0, 1)`；保留该曲线，不能套用审计手册里同名 token 的另一组数字。
`src/styles/global.css:67` 已有可直接复用的范本：

```css
@keyframes fadeIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}
```
全局 reduced-motion 只将 transition-duration 归零，并通过 `--motion-shift: 0` 消除位移；这里使用纯透明度 animation，所以减动效下保留淡入，不需要修改全局规则。
阅读 `docs/reference/design-system.md` 和 `docs/reference/codemap.md` 对应组件章节；保持克制的写作工具风格。

## Steps

1. 核对上述 TSX 分支和 CSS 与基准一致，确认卡片只在结果态挂载。
2. 在 `src/components/lore/LoreGenerator.module.css` 的 `.resultCard` 增加 Target 声明。复用全局 keyframe，不创建同名局部 keyframe。
3. 依次验证生成中 → 结果、结果内编辑、重新生成 → 新结果。重新生成结束可以重新淡入；同一结果内编辑不得重播。

## Boundaries

- 不修改 TSX、模型调用、生成状态机、结果保存、计费、焦点或 aria 行为。
- 不给卡片加 key，不使编辑器/输入框重挂载。
- 不给流式文本、ThinkingPanel、RunStatusLine、整张模态或结果列表逐项加动画。
- 不加 transform、布局动画、延迟、will-change、Motion 或新的全局 token。
- 基准代码发生影响方案的漂移时停止并报告；不扩大修复范围。

## Verification

- **Mechanical**（实施后运行，计划阶段不运行）：在项目根目录执行 `pnpm exec tsc --noEmit`、`pnpm exec vitest run src/lib/__tests__/cssKeyframeNames.test.ts src/lib/__tests__/cssModuleClassRefs.test.ts`，预期全部通过。遵照仓库 CI 要求完成提交所需门禁；不为纯样式声明添加镜像测试。
- **Feel check**：在可见的真实 Tauri 窗口中验证（`pnpm tauri dev`）；涉及生成、恢复时使用隔离测试项目/配置及受控 fixture，不为验动画执行付费调用或覆盖真实配置。Vite 单独运行没有 Tauri IPC，不能当成功能验收。
- DevTools 动画面板以 10% 速度看入场，再恢复正常速度；确认只有 opacity 改变，没有尺寸、位置、缩放或双重文本叠影。验证 `document.visibilityState === 'visible'`，不要把后台标签页暂停的动画误报为缺陷。
- 开启 `prefers-reduced-motion: reduce` 重复同一流程，轻淡入仍保留且最终 opacity 为 1。观察浅色/深色主题和窄窗口。
- **Done when**：结果卡仅在就绪挂载时淡入 160ms，字段立即可操作，输入和焦点不因重渲染重置，减动效下同样可见。
