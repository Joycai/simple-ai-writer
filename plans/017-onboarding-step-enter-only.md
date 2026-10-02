# 017 — 首次运行向导换步：鼠标触发的纯淡入

- **Status**: IMPLEMENTED（2026-10-03；代码审查及机械检查通过，真实 Tauri 目检待验）
- **Commit**: 1e0e0d22
- **Severity**: LOW
- **Category**: Missed opportunities / 状态指示
- **Estimated scope**: 1 个 TSX 文件，约 60 行；无新依赖

## Problem

项目根目录：`/Users/caizhengxu/github/simple-ai-writer`。以下相对路径从这里解析。
`src/components/onboarding/Onboarding.tsx:362`：

```tsx
          <div className={styles.form}>
            {renderStep()}
          </div>
```

内部步骤直接替换，外框已经有 scaleIn 220ms 入场和 160ms 谢幕。换步是罕见的首次使用动作，适合轻量状态桥接。键盘推进必须即时，按钮与导航不应随内容淡入。

历史：017 曾因后台标签页时间轴暂停而误报阻断；`docs/issues/motion-enter-only-hidden-tab.md` 已澄清，保持该结论，不重新调查。本次更新沿用 enter-only、无串行等待的决定。旧稿的 keyed Motion 容器、6px 位移及「根 MotionConfig 自动处理 raw transform」说明不再作为实施依据：本次用户选中的是纯透明度、键盘即时的方案。

## Target

新步骤立即挂载，只有鼠标/触摸点击引发的换步给内容播放 opacity 0 → 1，200ms，`cubic-bezier(0.32, 0.72, 0, 1)`，delay 0，单次，fill none。键盘、辅助技术/程序化 click（detail 为 0）不动画。异步保存和文件选择必须在调用开始时捕获该布尔值，不能在 await 后读取事件或全局输入模态。

只动画 `.form` 的直接内容元素，排除 `.spacer`、`.stepNav`；末步 `.final` 不整块动画，而是动画它的直接内容元素，排除 `.nextBtn`。不重挂载 `.form`，不改变 flex 子元素关系，不强行移动焦点。当前 React 分支本身造成的焦点行为保持原状；不承诺跨步骤保留一个已删除控件的焦点。

使用浏览器 WAAPI 给已有内容节点播放一次透明度动画，原因是这样可在不引入包装层、不加 key 重置输入子树的情况下重播同一节点；不扩展到按钮、hover 或列表。每次步骤改变和组件卸载取消该次动画，避免旧动画残留。不是需要 springs/AnimatePresence 的进退场。

## Repo conventions to follow

React 19 + TypeScript + CSS Modules；`src/styles/tokens.css:75` 的 `--ease-out` 是 `cubic-bezier(0.32, 0.72, 0, 1)`，`--transition-base` 为 200ms。读取该 token，不重定义曲线。
`src/styles/global.css:67` 的范本 `fadeIn` 也是 opacity 0 → 1。这里用相同参数的 WAAPI，以保留 DOM 和导航稳定性。
全局 reduced-motion 会压缩 CSS transition，但不会处理 WAAPI；本方案从一开始就只动 opacity，所以正常和 reduced-motion 均为 200ms 淡入，无 transform。不要添加令动画归零的媒体查询或修改 `src/lib/motion.ts`。
先读 `docs/reference/design-system.md`、`docs/reference/codemap.md` 的 onboarding 章节，以及上述后台标签页澄清文档。

## Steps

1. `Onboarding.tsx` 从 React 增加 `useRef`、`useLayoutEffect` imports。在已有 `step` state 后添加以下状态和函数。所有 hooks 必须在 `if (!showOnboarding) return null` 之前调用：

```tsx
const formRef = useRef<HTMLDivElement>(null);
const animateStep = useRef(false);
const goToStep = (next: number, animate: boolean) => {
  animateStep.current = animate;
  setStep(next);
};

useLayoutEffect(() => {
  const form = formRef.current;
  const shouldAnimate = animateStep.current;
  animateStep.current = false;
  if (!form || !shouldAnimate) return;
  const easing = getComputedStyle(form).getPropertyValue("--ease-out").trim();
  const targets = Array.from(form.children).flatMap((child) =>
    child.classList.contains(styles.final) ? Array.from(child.children) : [child],
  ).filter((child) =>
    !child.classList.contains(styles.spacer) &&
    !child.classList.contains(styles.stepNav) &&
    !child.classList.contains(styles.nextBtn) &&
    !child.classList.contains(styles.backBtn),
  );
  const animations = targets.map((child) => child.animate(
    [{ opacity: 0 }, { opacity: 1 }],
    { duration: 200, easing, fill: "none" },
  ));
  return () => animations.forEach((animation) => animation.cancel());
}, [step, showOnboarding]);
```

2. 给上述现有 `.form` 元素加 `ref={formRef}`，不要加 key 或包装层。初次显示向导不调用 goToStep，所以不叠加新的内容淡入。
3. 将 `handleSaveProvider` 和 `handlePickFolder` 签名改为 `(animate: boolean)`。各自内部成功时的 `setStep(2)` / `setStep(3)`，以及保存前已有的空 key 分支，分别换成 `goToStep(2, animate)` / `goToStep(3, animate)`。其余异步业务、try/catch/finally 与取消分支逐字保留。
4. 保存按钮改为 `onClick={(event) => void handleSaveProvider(event.detail > 0)}`；目录卡片改为 `onClick={(event) => void handlePickFolder(event.detail > 0)}`。布尔参数在 await 前已求值，保证键盘启动后鼠标移动不改变这次结果。
5. `stepNav` 的 onNext 参数类型改为 `(animate: boolean) => void`。后退按钮改为 `onClick={(event) => goToStep(back, event.detail > 0)}`；下一步按钮改为 `onClick={(event) => onNext(event.detail > 0)}`。调用点改为 `stepNav(1, (animate) => goToStep(3, animate))` 和 `stepNav(2, (animate) => goToStep(4, animate))`。
6. 「稍后」卡片的直接 `setStep(3)` 改成 `onClick={(event) => goToStep(3, event.detail > 0)}`。核对 `rg -n 'setStep|goToStep|handleSaveProvider|handlePickFolder' src/components/onboarding/Onboarding.tsx`：直接 setStep 只留在 helper；所有动作明确传入 animate；`beginDismiss` 保持原样。

## Boundaries

- 不用 AnimatePresence、exit、mode="wait"、setTimeout 或 rAF 调度入场；不引入额外组件库。
- 不修改 CSS 布局、现有外框动画/谢幕、步骤文案、目录选择、能力包写入或供应商保存语义。
- 不修改键盘语义或修复既有 div 卡片的可访问性；这是独立工作。
- 不添加 transform、stagger、will-change；不动画宽度/高度。第 4 步移除欢迎栏后的布局仍瞬时变化，本方案不尝试用布局动画掩盖它。
- 不重挂载输入、强制 focus 或清空表单。相同步骤内输入/勾选不触发 effect。
- 基准漂移影响上述选择器、步骤结构或异步语义时停止并报告，不扩大范围。

## Verification

- **Mechanical**：实施后在项目根目录运行 `pnpm exec tsc --noEmit` 和 `pnpm exec vitest run src/lib/__tests__/cssModuleClassRefs.test.ts src/lib/__tests__/cssKeyframeNames.test.ts`，均须通过。完成仓库要求的提交门禁。无需新增只重复动画常量的测试。
- **Feel check**：在可见的真实 Tauri 窗口用隔离测试配置触发 onboarding（`pnpm tauri dev`）；不得删除真实 prefs/配置，不用付费调用验动画。不以 Vite 单独运行的 IPC 失败结果当验收。
- 鼠标依次前进、后退：新内容立即进入，只淡入 200ms，按钮/导航不淡入；快速返回应取消旧动画而非叠加或排队。初次打开只有原有外框入场。
- Tab + Enter/Space 前进后退：本次换步无新增 opacity 动画；程序化 detail=0 也即时。尤其检验键盘启动异步保存后移动鼠标，完成仍即时；鼠标启动异步步骤则完成后淡入。
- 输入 API key、切换步骤再返回，值保留；同一步输入与能力包勾选不重播。文件对话框取消保持原步骤。保存失败停留原步骤，不触发换步动画。
- 在 DevTools Animations 以 10% 播放，确认只有内容 opacity，没有按钮、导航、几何或 transform 动画。真实浏览器/WebView 检查 `document.visibilityState === 'visible'`，避免后台时间轴误判。
- 开启 `prefers-reduced-motion: reduce`：鼠标触发仍是轻淡入，键盘仍即时。完成后各目标 opacity 为 1；组件关闭/卸载不留运行的动画。
- 第 4 步开始写作的原有 160ms 谢幕不变；浅/深色、窄窗口均无布局回归。
- **Done when**：3 个步骤边界的鼠标纯淡入、键盘即时、异步模态捕获和取消均符合以上条件，且表单值和现有焦点行为未因新增重挂载而变化。
