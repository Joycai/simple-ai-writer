# 056 — 恢复配置完成回执轻淡入

- **Status**: IMPLEMENTED（2026-10-03；代码审查及机械检查通过，真实 Tauri 目检待验）
- **Commit**: 1e0e0d22
- **Date**: 2026-10-03
- **Severity**: LOW
- **Category**: Missed opportunities / 避免突兀变化
- **Estimated scope**: 2 个文件，约 8 行

## Problem

`src/components/sync/ConfigRestoreModal.tsx:181` 的完成分支直接替换预览：

```tsx
        {phase === "done" && (
          <>
            <div className={s.centered}>
              <div className={s.centeredTitle}>{t("sync.cfgRestoreDone")}</div>
              <div className={s.footNote} style={{ marginTop: 10 }}>
                {t("sync.cfgRestoreDoneNote")}
              </div>
```
`src/components/sync/sync.module.css:456` 的 `.centered` 只有 padding/text-align，没有动画。恢复是罕见异步操作；完成提示可以淡入帮助识别阶段改变，但错误和关闭动作不能跟着等待。

## Target

只给完成分支的标题和说明各增加一个共享 class，二者同时播放，无 stagger：

```tsx
<div className={`${s.centeredTitle} ${s.restoreReceiptEnter}`}>{t("sync.cfgRestoreDone")}</div>
<div className={`${s.footNote} ${s.restoreReceiptEnter}`} style={{ marginTop: 10 }}>
  {t("sync.cfgRestoreDoneNote")}
</div>
```

```css
.restoreReceiptEnter {
  animation: fadeIn 200ms var(--ease-out);
}
```
opacity 0 → 1；200ms；cubic-bezier(0.32, 0.72, 0, 1)；delay 0ms；单次；fill-mode none。减动效仍为相同纯淡入。这是异步完成反馈，不改变按键确认/关闭的时序。高度跳变仍瞬时完成，本方案不声称解决布局变化。

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

1. 在 `src/components/sync/sync.module.css` 的 Empty / progress / result 区域新增 Target 的专用 class。
2. 只修改 `ConfigRestoreModal.tsx` 的 `phase === "done"` 分支，为标题和说明加入 `s.restoreReceiptEnter`，与 Target 一致。
3. 保持外层 `.centered`、同级 `errorText`、页脚和关闭按钮无新增动画。不能把专用 class 加到公共 `.centered` 或 `.footNote` 规则中。
4. 用完成且无警告、完成且存在 `errorText` 两种 fixture 验证：警告和关闭按钮第一帧即可看见/操作。

## Boundaries

- 不修改恢复流程、store、数据库、钥匙串、主题切换、配置合并或持久化行为。
- 不改变已有 ModalShell、模态入场/退场、密码输入焦点及 Escape 规则。
- 不给警告、预览计数、执行按钮或其他同步模态加动画。
- 不加 key、延迟、transform、布局动画或依赖；不强制重挂载完成分支来重播。
- 代码漂移影响分支或样式作用域时停止并报告。

## Verification

- **Mechanical**（实施后运行，计划阶段不运行）：在项目根目录执行 `pnpm exec tsc --noEmit`、`pnpm exec vitest run src/lib/__tests__/cssKeyframeNames.test.ts src/lib/__tests__/cssModuleClassRefs.test.ts`，预期全部通过。遵照仓库 CI 要求完成提交所需门禁；不为纯样式声明添加镜像测试。
- **Feel check**：在可见的真实 Tauri 窗口中验证（`pnpm tauri dev`）；涉及生成、恢复时使用隔离测试项目/配置及受控 fixture，不为验动画执行付费调用或覆盖真实配置。Vite 单独运行没有 Tauri IPC，不能当成功能验收。
- DevTools 动画面板以 10% 速度看入场，再恢复正常速度；确认只有 opacity 改变，没有尺寸、位置、缩放或双重文本叠影。验证 `document.visibilityState === 'visible'`，不要把后台标签页暂停的动画误报为缺陷。
- 开启 `prefers-reduced-motion: reduce` 重复同一流程，轻淡入仍保留且最终 opacity 为 1。观察浅色/深色主题和窄窗口。
- **Done when**：仅完成标题和说明同时淡入 200ms，警告即时可见、关闭即时生效，减动效下无位移且文字可见；其他恢复阶段完全保持原行为。
