# 052 — 滑杆吸附仍在动 left/width（方案 050「最后两处」的漏网）

- **Status**: DONE（门禁已过；像素等价已在浏览器实测：轨道 260px，pct 0 / 2.5 / 100 三档与旧公式逐一相等）
- **Commit**: 485de63
- **Severity**: LOW
- **Category**: 5 性能
- **Estimated scope**: 1 个 CSS 文件（约 12 行）+ 1 个 TSX 文件（2 行内联样式）

> ⚠ **先读这一段**：方案 050 的标题是「最后两处非合成层动效」，README 第八批执行记录也写着
> 「transition 里仍带 width 的规则：只剩 RecentProjects / ResizeHandle 两处 LOW 档」。
> **这个盘点漏了本方案的两条。** 漏的原因大概率是当时 `Slider.module.css:62-63` 写的是字面
> `cubic-bezier(0.2, 0.8, 0.2, 1)`（方案 049 才换成 `--ease-settle`），且规则带 `.snapping` 前缀。
> 方案 049 只换了曲线令牌、**没有**碰属性。所以这不是重新翻案，是补漏。
> 本方案落地后，050 的「最后两处」说法才真正成立。

## Problem

```css
/* src/components/common/Slider.module.css:61-63 — 当前 */
/* Only the landing on a tick animates — 70ms "clicks in"; leaving has none. */
.thumb.snapping { transition: left 70ms var(--ease-settle), background var(--transition-fast); }
.fill.snapping { transition: width 70ms var(--ease-settle); }
```

位置由 TSX 的内联样式给：

```tsx
// src/components/common/Slider.tsx:150-154 — 当前
        <div className={`${styles.fill} ${snapping ? styles.snapping : ""}`} style={{ width: `${pct}%` }} />
        <div
          ref={thumbRef}
          className={`${styles.thumb} ${snapping ? styles.snapping : ""} ${dragging ? styles.dragging : ""}`}
          style={{ left: `calc(${pct}% - 7px)` }}
```

`left` 和 `width` 都是布局属性（AUDIT §5：「`width`/`height`/`margin`/`padding`/`top`/`left` trigger layout + paint + composite」）。

**诚实的代价评估**：`.fill` 和 `.thumb` 都是 `position: absolute`（`:36`、`:44`），父级 `.track` 是 `position: relative`（`:22`）。
绝对定位元素改 `left`/`width` **不会**让兄弟或父级重排，只影响它自己的盒子 + 一次重绘。
时长又只有 70ms，且只在松手吸附到刻度那一下触发。**所以这不是掉帧问题，实测也很可能测不出差别。**

本方案的价值是**不变量完整性**：本仓把「动效只动 `transform`/`opacity`」当成一条会被 grep 检查的规则
（方案 005 → 010 → 050 一路收口），留着两条例外，下一次盘点还会被同样的写法骗过去。

## Target

### A. 轨道宽度变成一处声明、两处派生

```css
/* target — src/components/common/Slider.module.css:14-19 */
.slider {
  /* 轨道宽度 = 本体宽度 − 左右各 8px 留白（文件头 anatomy：① track 260 × 2px）。
     拇指改用 transform 定位后这个值要参与计算，所以从「两处写死」改成一处派生：
     改 --slider-w 时轨道宽度自动跟上，不会留下第二个需要同步的数字（方案 052）。 */
  --slider-w: 276px;
  --track-w: calc(var(--slider-w) - 16px);
  width: var(--slider-w);
  padding: 8px 8px 0;
  box-sizing: border-box;
  flex: none;
}
```

### B. fill 用 scaleX

```css
/* target — src/components/common/Slider.module.css:36-42 */
.fill {
  position: absolute;
  left: 0;
  top: 6px;
  width: 100%;
  height: 2px;
  background: var(--color-accent);
  transform-origin: left center;
}
```

```tsx
// target — src/components/common/Slider.tsx:150
        <div
          className={`${styles.fill} ${snapping ? styles.snapping : ""}`}
          style={{ transform: `scaleX(${pct / 100})` }}
        />
```

### C. thumb 用 translateX

```css
/* target — src/components/common/Slider.module.css:44-52 */
.thumb {
  position: absolute;
  top: 0;
  left: 0;
  width: 14px;
  height: 14px;
  background: var(--color-accent);
  outline: none;
  transition: background var(--transition-fast);
}
```

```tsx
// target — src/components/common/Slider.tsx:151-155
        <div
          ref={thumbRef}
          className={`${styles.thumb} ${snapping ? styles.snapping : ""} ${dragging ? styles.dragging : ""}`}
          style={{ transform: `translateX(calc(var(--track-w) * ${pct} / 100 - 7px))` }}
```

### D. 两条吸附过渡改属性

```css
/* target — src/components/common/Slider.module.css:61-63 */
/* Only the landing on a tick animates — 70ms "clicks in"; leaving has none.
   走 transform 而不是 left/width：本仓「动效只动 transform/opacity」的不变量
   （方案 005/010/050）——这两条是 050 盘点时漏掉的最后例外（方案 052）。 */
.thumb.snapping { transition: transform 70ms var(--ease-settle), background var(--transition-fast); }
.fill.snapping { transition: transform 70ms var(--ease-settle); }
```

### 几何等价性（执行前先自己验算一遍）

`.track` 的宽度恒为 `260px`（`--track-w` = 276 − 16）。原写法里的百分比就是对这 260px 取的。

| pct | 原 `.thumb` `left` | 新 `.thumb` `translateX` | 原 `.fill` `width` | 新 `.fill` `scaleX` 后宽度 |
| --- | --- | --- | --- | --- |
| 0 | `calc(0% - 7px)` = −7px | `calc(260px*0/100 − 7px)` = **−7px** | 0px | 260 × 0 = **0px** |
| 50 | `calc(50% - 7px)` = 123px | `calc(260px*50/100 − 7px)` = **123px** | 130px | 260 × 0.5 = **130px** |
| 100 | `calc(100% - 7px)` = 253px | `calc(260px*100/100 − 7px)` = **253px** | 260px | 260 × 1 = **260px** |

三档全等 ⇒ 这是一次**像素级等价**的重写，观感必须零变化。任何一档对不上就是写错了。

## Repo conventions to follow

- **范本**：方案 010（仪表条 `width` → `scaleX`）与方案 050 B（扫光 `background-position` → `translateX`）——
  同一处方，本方案是它的第三次应用。
- **`transform-origin: left center`** 是 `scaleX` 条形的标配，参照 `src/components/ai/AgentLog.module.css:183`（`transform-origin: left`，方案 036）。
- 内联 `transform` 里引用 CSS 变量是可行的：变量在 `.slider` 上声明，`.thumb` 是它的后代，继承可见。
- 曲线与时长**一个字不改**（`70ms var(--ease-settle)`，方案 049 定的）。

## Steps

1. `src/components/common/Slider.module.css:14-19` —— 按 Target A 替换 `.slider` 规则块（新增两个变量，`width` 改成引用）。文件头的 anatomy 注释不动。
2. `src/components/common/Slider.module.css:36-42` —— 按 Target B 替换 `.fill`（加 `width: 100%` 与 `transform-origin`）。
3. `src/components/common/Slider.module.css:44-52` —— 按 Target C 替换 `.thumb`（**加 `left: 0`**；漏了这一行，拇指会因 `left: auto` 落在静态位置上）。
4. `src/components/common/Slider.module.css:61-63` —— 按 Target D 替换注释与两条 `.snapping` 规则。
5. `src/components/common/Slider.tsx:150` —— `.fill` 的 `style` 从 `{ width: ... }` 改成 `{ transform: \`scaleX(${pct / 100})\` }`。
6. `src/components/common/Slider.tsx:154` —— `.thumb` 的 `style` 从 `{ left: ... }` 改成 Target C 的 `transform`。

## Boundaries

- **不要**改刻度 `.tick` 的 `style={{ left: ... }}`（`Slider.tsx:169`）。刻度是**静态**定位、没有任何 transition，不在「动效只动 transform」的管辖范围，改它只会增加回归面。
- **不要**改 `Slider.tsx` 里任何指针/键盘逻辑（`:73-139`）：`resolve`、`onPointerDown/Move/Up`、`onKeyDown`、`snapping` 的置位全部原样。命中判定读的是 `getBoundingClientRect()`，与本次改动无关。
- **不要**改 `.rail`、`.ticks`、`.tickMark`、`.tickLabel`、`.disabled` 及焦点环规则（`:53-58`）。
- **不要**改时长 `70ms`、曲线 `--ease-settle`，也不要给 `.snapping` 之外的状态加 transition。
- **不要**把 `--slider-w` 的 `276px` 改成别的值。
- **不要**改 `docs/reference/design-system.md`——本方案对用户是零可见变化。
- 若摘录与代码对不上（自 `485de63` 起漂移），**停下并报告**。

## Verification

- **机械**：
  - `grep -nE "transition:[^;]*\b(left|width|height|top)\b" src/components/common/Slider.module.css` → **空**。
  - `grep -rnE "transition:[^;]*\b(width|height|top|left|margin|padding)\b" src --include=*.css` → 只应剩 `RecentProjects.module.css:195`（`.pinBtn` 的 `width`，方案 050 已明文**撤回**、保留原样）与 `collections.module.css:311`（`border-left-color`，是颜色不是布局，属误命中）。**若还有第三处，说明又有漏网，报告出来。**
  - `grep -n "style={{ *left" src/components/common/Slider.tsx` → 只应命中刻度那一行（`:169`）。
  - `node_modules/.bin/tsc --noEmit` 无诊断（直跑二进制，绕开 pnpm 的安装摘要）；`pnpm test` 全绿；`pnpm build` 成功。
- **Feel check**（`pnpm dev` 浏览器即可——设置页不依赖打开项目）：进入 设置 → 上下文与记忆，那里有三个滑杆。
  - **像素等价**：改动前后各截一张 `pct = 0 / 50 / 100` 的图，放大到 800% 对比拇指左边缘与填充右边缘。按上表应**逐像素相同**。做不到就是第 3 步漏了 `left: 0`，或 calc 写错了。
  - **吸附手感**：拖到刻度附近松手，拇指与填充条一起在 70ms 内「咔」到刻度上，与改动前无差别；**离开**刻度时没有过渡（这是原设计，别把它补上）。
  - **拖拽跟手**：按住拖动时拇指必须 1:1 跟随指针、无补间拖尾（`transition` 只挂在 `.snapping` 上，拖拽中不应生效）。
  - **键盘**：聚焦拇指后按 ←/→，每一步都应有那 70ms 的吸附感。
  - **焦点环**：Tab 聚焦拇指，双层焦点环完整、不被 `transform` 裁切或错位。
  - **禁用态**：把「自动压缩」关掉让滑杆行变暗（`.sliderRowOff`），滑杆整体 45% 灰，填充条颜色正确。
  - DevTools → Animations 面板把播放速度调到 10%，再触发一次吸附：应能看到平滑的位移补间，而不是跳变。
- **Done when**：上面三档像素对比全等、吸附与拖拽手感无变化、机械项全过。届时在 `plans/README.md` 里给方案 050 补一句：其「最后两处」的说法由方案 052 补齐。
