# 028 — 生成图落位时淡入显影，不再硬弹

- **Status**: DONE (2026-08-26) — `pnpm exec tsc --noEmit` / `pnpm test`(190 文件·2563 用例) / `pnpm build` 全绿，构建产物已核验动画名未作用域化；**作者已在真 Tauri 窗口目检通过**。
- **Commit**: 1a72e2e
- **Severity**: LOW
- **Category**: Missed opportunities（delight budget —— 稀有、高情绪时刻）
- **Estimated scope**: 1 file（1 个 .module.css），约 6 行。**无 TSX 改动。**

## Problem

作者点下生成后要等 20–60 秒。图片经 `useImageDataUrl` 异步读成 base64 data URL，读完的那一刻 `<img>` 直接出现，零过渡。

```tsx
// src/components/ai/ImageGenModal.tsx:700-709 — 现状
                    {currentTurn.candidates.map((path, i) => (
                      <button
                        key={path}
                        className={`${gen.thumb} ${i === currentTurn.chosen ? gen.thumbActive : ""}`}
                        onClick={() => choose(currentTurn.id, i)}
                        disabled={saving || generating}
                      >
                        {candidateUrls[path] && <img src={candidateUrls[path]} alt="" />}
                      </button>
                    ))}
```

```css
/* src/components/ai/ImageGenModal.module.css:368-386 — 现状：img 无任何入场 */
.thumb {
  width: 132px;
  height: 132px;
  padding: 0;
  background: var(--color-bg-inset);
  border: 1px solid var(--color-border-panel);
  overflow: hidden;
  cursor: pointer;
  transition: border-color var(--transition-fast), transform var(--transition-fast);
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.thumb:hover:not(:disabled) { transform: translateY(-1px); }
.thumbActive { border-color: var(--color-sienna); box-shadow: inset 0 0 0 1px var(--color-sienna); }
.thumb:disabled { cursor: not-allowed; }
```

`useImageDataUrl`（`src/components/lore/useImageDataUrl.ts:14-26`）加载期间返回 `null`，所以 `{candidateUrls[path] && …}` 为假，`<img>` 根本不在 DOM 里；data URL 一到，`<img>` 挂载并立即以完全不透明呈现。

**为什么重要**：这是全 app 最稀有、情绪最高的一个瞬间 —— 等了近一分钟的一张画到了。它现在的表现和一个报错弹窗没有区别。delight budget 就该花在这种地方（稀有 + 高情绪），而不是花在每天点几十次的按钮上。

## Target

一次纯 opacity 的显影，320ms。

```css
/* target — src/components/ai/ImageGenModal.module.css，改写 .thumb img */
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  animation: fadeIn 320ms var(--ease-out);
}
```

**只做 opacity，不加 scale/位移。** `.thumb` 自身已经有 `transition: transform` 和 `:hover { transform: translateY(-1px) }`；给 `<img>` 加 transform 关键帧会与父级的 hover transform 叠加，在悬停中途落图时抖动。

用 `--transition-slow` 那一档的时长（320ms）而非 `--transition-base`（200ms）：这是稀有时刻，慢一点读作「显影」；200ms 只读作「加载完了」。仍在 UI 动效 300ms 预算的边界上，且这条路径本身是一次几十秒的等待，不存在拖慢操作的问题。

## Repo conventions to follow

- `fadeIn` 是 `src/styles/global.css:51-54` 里已有的全局关键帧，**不要重新定义**：
  ```css
  @keyframes fadeIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  ```
- 缓动 token：`src/styles/tokens.css:47` 的 `--ease-out: cubic-bezier(0.32, 0.72, 0, 1)`。只用 token 名。
- 时长档位在 `src/styles/tokens.css:52-54`：`--transition-fast: 120ms` / `--transition-base: 200ms` / `--transition-slow: 320ms`。本处取 320ms 这一档，但因为 `animation` 简写里要的是裸时长而不是 `<time> <easing>` 的组合 token，直接写 `320ms var(--ease-out)`。
- **样板**：`src/components/lore/LoreWall.module.css:185` 的 `animation: fadeIn var(--transition-base);` —— 同样是「内容到位时淡一次，不做位移」的写法，且注释里写明了为什么不叠 transform（卡片自带内联 transform，关键帧会盖掉它）。本处不叠 transform 的理由同源。
- **模块 CSS 引用 global.css 的 keyframes 是可行的**：这条曾经静默失效（`docs/issues/css-modules-global-keyframes.md`），已于 2026-08-23 随 `vite.config.ts` 切 LightningCSS 修复并复核生效。**不要**因为担心作用域而把关键帧复制进本模块 —— 模块内的 `@keyframes` 现在与 global.css 共用一个全局命名空间，重名会互相覆盖，这正是方案 019 要守的不变量。
- 注意 `ImageGenModal.tsx:51-52` 把同一个 CSS module 同时 import 成了 `styles` 和 `gen` 两个别名 —— 它们是同一个文件，改 `ImageGenModal.module.css` 两边都生效。
- 全局 `prefers-reduced-motion`（`src/styles/global.css:122-129`）会把这个动画压到 `0.001ms`，即图片瞬间出现。对一个纯 opacity 淡入来说，这是正确的降级，**不要**新增媒体查询去对抗它。

## Steps

1. **`src/components/ai/ImageGenModal.module.css:378-383`** — 给 `.thumb img` 追加一行 `animation`，其余四行原样保留：
   ```css
   /* 等了几十秒的一张画到了。只淡不缩——.thumb 自身带 hover 的 translateY(-1px)，
      给 img 叠 transform 关键帧会在悬停中途落图时打架。320ms 而不是 200ms：
      这是稀有时刻，慢一档读作显影，快了只读作加载完毕。 */
   .thumb img {
     width: 100%;
     height: 100%;
     object-fit: contain;
     display: block;
     animation: fadeIn 320ms var(--ease-out);
   }
   ```

就这一步。

## Boundaries

- **不要修改 `src/components/ai/ImageGenModal.tsx`** —— 本计划零 TSX 改动。
- 不要修改 `.thumb`、`.thumbActive`、`.thumb:hover`、`.thumb:disabled`、`.grid` 的任何现有声明。
- 不要给 `<img>` 加任何 `transform`、`scale` 或位移（理由见 Target）。
- 不要把这个淡入推广到全 app 的 `<img>`：头像与图库缩略图走的是同一个 `useImageDataUrl`，但它们每次访问知识库都会出现，频次完全不同；而且知识库墙已有整墙 `fadeIn`（`LoreWall.module.css:185`），再叠一层会双重淡入。**本次只改生成结果的候选图。**
- 不要碰 `src/components/lore/useImageDataUrl.ts`。
- 不要新增 `@keyframes`，`fadeIn` 已存在。不要新增依赖。
- 若代码与上面的摘录对不上（自 1a72e2e 起有漂移），**停下来报告**。

## Verification

- **Mechanical**：
  - `pnpm tsc --noEmit` —— 无报错。
  - `pnpm test` —— 全绿。
  - `git diff --stat` 应只显示 `src/components/ai/ImageGenModal.module.css` 一个文件，且只有一行新增。
- **Feel check**：需要开启 设置 → 通用 → 实验功能 里的生图开关，并配好一个图像模型（ComfyUI 本地工作流或已配置的图像 provider）。
  - 在知识库条目上发起一次配图生成，等结果。确认候选图是**淡入**的，约 1/3 秒，而不是硬弹。
  - 生成多张（张数 > 1）时，各张按各自 data URL 读完的先后**独立**淡入 —— 这是 `useImageThumbnails` 逐张填充的预期行为，不是 bug，不要试图同步它们。
  - **悬停中落图**：把鼠标停在某个候选位上等它出图。确认淡入期间缩略图**没有**上下抖动（这验证了「不叠 transform」这条）。
  - 点击切换选中的候选图，确认 `.thumbActive` 的赭石描边照常切换，**且图片不重新淡入**（`key={path}` 未变，`<img>` 不重挂载）。
  - DevTools → Animations 面板，播放速度 10%，确认全程只有 opacity 在变，`transform` 保持不动。
  - DevTools → Rendering → 勾选 `prefers-reduced-motion: reduce`，确认图片瞬间出现且**完全不透明**（不残留半透明）。
- **Done when**：生成结果淡入显影、悬停时不抖、切换选中不重播、且未改动任何 .tsx 文件。
