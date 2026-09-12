# 053 — 标签闪线改走合成层（box-shadow 关键帧 → 伪元素 scaleY）

- **Status**: DONE（门禁已过；关键帧在 --motion-shift 1/0 下实测为 scaleY(2)/scaleY(1)。标签条目检待作者）
- **Commit**: 485de63
- **Severity**: LOW
- **Category**: 5 性能（附带 6 无障碍）
- **Estimated scope**: 1 个 CSS 文件（约 20 行）

> ⚠ **两条已定的事不要动**：
> 1. **240ms 是定论**。方案 049 E 项只改注释、明文「`:48` 的代码不动」，Boundaries 写着「**不要**改 `.tabFlash` 的 240ms」；
>    README 第十批目检结果记着「`tabFlash` **定为 240ms**（不改回设计稿的 120ms）」。本方案**沿用 240ms**。
> 2. **中途那一档 `--color-sienna-hover` 的加深是已验收的观感**，一并保留。
>
> 方案 049 处理的是时长与注释，方案 050 号称扫清「最后两处非合成层动效」但**没有点到这条关键帧**。本方案补的是属性，不是时长。

## Problem

```css
/* src/components/ai/SessionTabs.module.css:19-30 — 当前（相关部分） */
.tab {
  position: relative;
  flex: 0 1 220px;
  min-width: 120px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 12px;
  border-right: 1px solid var(--color-border-panel);
  cursor: pointer;
  user-select: none;
  transition: background var(--transition-fast);
}
```

```css
/* src/components/ai/SessionTabs.module.css:36-55 — 当前 */
.tabActive,
.tabActive:hover {
  background: var(--color-bg-base);
  box-shadow: inset 0 2px 0 var(--color-sienna);
  margin-bottom: -1px;
  border-left: 1px solid var(--color-border-panel);
}

/* 新会话 pressed while an empty tab already existed: that tab flashes its top
   line once (设计稿 02b 屏 1g), instead of a second blank tab appearing. 稿上标
   120ms，实现取 240ms——120ms 分到升、降两段各 60ms，2px 的线几乎看不出来。
   240ms 已由作者目检确认（2026-09-10，方案 049）。 */
.tabFlash { animation: tabFlash 240ms var(--ease-out); }
@keyframes tabFlash {
  0% { box-shadow: inset 0 2px 0 var(--color-sienna); }
  50% { box-shadow: inset 0 4px 0 var(--color-sienna-hover); }
  100% { box-shadow: inset 0 2px 0 var(--color-sienna); }
}
```

两个问题：

1. **`box-shadow` 关键帧逐帧重新栅格化**。它既不是 `transform` 也不是 `opacity`（AUDIT §5），
   每一帧都要重画阴影。这是全库**唯一**剩下的非合成层关键帧——方案 050 收掉 `background-position` 之后就只剩它。
2. **减动效下它照样把线从 2px 撑到 4px**。粗细变化属于「位移」那一类，按方案 047 的契约
   （`--motion-shift`：位移去掉、淡入/颜色留下）本应被压平，但 `box-shadow` 的写法没有办法乘 `--motion-shift`。

触发点：`SessionTabs.tsx:202-203`，`key={flashSeq}` 靠重挂载重启动画。

## Target

```css
/* target — src/components/ai/SessionTabs.module.css，替换 :36-55 整段 */

/* 顶线是一条独立的伪元素，不是 inset 阴影：闪一下走 transform（合成层），
   不必逐帧重栅格化阴影；而且 scaleY 能乘 --motion-shift，减动效下自然只剩
   颜色那一档（方案 047 的契约 / 方案 053）。基态 scaleY(0) = 不画。 */
.tab::after {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--color-sienna);
  transform: scaleY(0);
  transform-origin: top;
  pointer-events: none;
}

.tabActive,
.tabActive:hover {
  background: var(--color-bg-base);
  margin-bottom: -1px;
  border-left: 1px solid var(--color-border-panel);
}
.tabActive::after { transform: scaleY(1); }

/* 新会话 pressed while an empty tab already existed: that tab flashes its top
   line once (设计稿 02b 屏 1g), instead of a second blank tab appearing. 稿上标
   120ms，实现取 240ms——120ms 分到升、降两段各 60ms，2px 的线几乎看不出来。
   240ms 已由作者目检确认（2026-09-10，方案 049）。 */
.tabFlash::after { animation: tabFlash 240ms var(--ease-out); }
@keyframes tabFlash {
  0%   { transform: scaleY(1); }
  50%  { transform: scaleY(calc(1 + 1 * var(--motion-shift))); background: var(--color-sienna-hover); }
  100% { transform: scaleY(1); }
}
```

要点逐条：

- **关键帧名 `tabFlash` 一个字不改**——`src/lib/__tests__/cssKeyframeNames.test.ts`（方案 019）守着关键帧名的全局唯一性，只换帧体不换名字就不会惊动它。
- **`scaleY(2)` 起点在 `transform-origin: top`**，2px → 4px 向下长，与原 `inset 0 4px 0` 的生长方向一致。
- **`calc(1 + 1 * var(--motion-shift))`**：普通模式 `--motion-shift: 1` → `scaleY(2)`（与今天一致）；
  减动效下 `global.css` 把它置 0 → `scaleY(1)`，线不变粗，**只剩 `--color-sienna-hover` 那一下加深**。
  这是相对今天的**行为改进**，不是回归——见下面的 Feel check。
- **`pointer-events: none`** 必须有：伪元素盖在标签顶部 2px，没有它会吞掉那一条的点击。
- **`.tabActive` 去掉 `box-shadow`**，但 `background` / `margin-bottom` / `border-left` 三行原样保留——
  「吞掉下边那道发丝线」靠的是 `margin-bottom: -1px`，不是阴影，别一起删。
- 绝对定位的 `left: 0 / right: 0` 解析到**padding 盒**，与 inset 阴影绘制的范围相同，因此 `.tabActive` 上那 1px 左边框造成的偏移两种写法一致。

## Repo conventions to follow

- **范本**：方案 050 B（`AgentChat.module.css` 的扫光，`background-position` → 伪元素 `translateX`）——
  同一处方：把要动的那一层抽成 `::after`，让 `transform` 去动它。
- **`var(--motion-shift)` 的用法范本**：`src/styles/global.css:71-78` 的 `scaleIn` / `slideUp`（方案 047）。
- **已知的守卫盲区，别被它迷惑**：`cssKeyframeNames.test.ts:144` 的正则是 `/translate|scale\(/`，
  只匹配 `scale(`，**匹配不到 `scaleY(`**。也就是说这条关键帧即使不乘 `--motion-shift` 测试也会绿。
  本方案**主动**乘上它，因为契约在方案 047，不在测试里。**不要**为此去改测试正则——那会牵动其它关键帧，是另一个方案的事。

## Steps

1. `src/components/ai/SessionTabs.module.css` —— 在 `.tab` 规则块（`:19-30`）之后、`.tab:hover`（`:31`）之前或之后，插入 Target 里的 `.tab::after` 规则块。`.tab` 本体一个字不动（它已有 `position: relative`，这是伪元素定位的前提）。
2. 同文件 `:36-42` —— 从 `.tabActive, .tabActive:hover` 里**删掉** `box-shadow: inset 0 2px 0 var(--color-sienna);` 这一行，其余三行保留。
3. 同文件紧接其后 —— 新增 `.tabActive::after { transform: scaleY(1); }`。
4. 同文件 `:46-55` —— 把 `.tabFlash { ... }` 改成 `.tabFlash::after { ... }`（选择器加 `::after`，240ms 与曲线不变），并按 Target 替换 `@keyframes tabFlash` 的三帧帧体。上面那段中文注释**原样保留**。
5. `src/components/ai/SessionTabs.tsx` 一个字不改。

## Boundaries

- **不要**改 240ms、不要改 `var(--ease-out)`、不要改中途那一档的颜色 `--color-sienna-hover`。（见文首两条已定事项。）
- **不要**改关键帧的名字 `tabFlash`。
- **不要**改 `src/components/ai/SessionTabs.tsx`——`key={flashSeq}` 的重挂载对伪元素上的动画同样有效，重启机制不受影响。
- **不要**改 `.strip`、`.tab:hover`、`.label`、`.tabAsking`（`:92-99`，那条 `fadeIn 160ms` 与本方案无关）。
- **不要**给 `.tab::after` 加 `z-index`——默认层序已经正确（伪元素在背景之上、内容之下不影响这条 2px 线的可见性）。加了反而可能盖住关闭按钮的焦点环。
- **不要**修改 `src/lib/__tests__/cssKeyframeNames.test.ts`。
- 若摘录与代码对不上（自 `485de63` 起漂移），**停下并报告**。

## Verification

- **机械**：
  - `grep -n "box-shadow" src/components/ai/SessionTabs.module.css` → 不应再出现 `inset 0 2px 0` 或 `inset 0 4px 0`。
  - `grep -rn "box-shadow" src --include=*.css | grep -B0 -A0 "@keyframes" ` 之外，更直接地：`grep -rn -A6 "@keyframes" src --include=*.css | grep "box-shadow"` → **空**（全库不再有 `box-shadow` 关键帧）。
  - `grep -n "motion-shift" src/components/ai/SessionTabs.module.css` → 命中 1 处。
  - `node_modules/.bin/tsc --noEmit` 无诊断（直跑二进制，绕开 pnpm 的安装摘要）；`pnpm test` 全绿（**特别是** `cssKeyframeNames.test.ts`）；`pnpm build` 成功。
  - 产物：`grep -c "tabFlash" dist/assets/*.css` 应同时命中选择器与关键帧（与改动前同量级）。
- **Feel check**（需真对话界面：`pnpm tauri dev`，打开一个项目 → AI 面板 → 会话标签条）：
  - **静态回归优先**：先什么都不做，确认**当前**标签顶部那条 2px 赭色线还在、粗细与颜色与改动前一致。这条线现在由 `::after` 画，画错了一眼就能看出来。切换标签，线跟着当前标签走。
  - **闪一下**：在已有一个空标签的情况下按「新会话」，那个标签的顶线应闪一次（变粗 + 颜色加深 + 回落），与改动前**同样的观感**。
  - **连按**：连续按「新会话」若干次，每次都应从头闪一遍（`key={flashSeq}` 的重挂载机制）。
  - DevTools → Animations 面板把播放速度调到 **10%**，再触发一次：应看到线从 2px 平滑长到 4px 再收回，中途颜色加深；**不应**看到跳变或闪烁。
  - **性能判据**：DevTools → Rendering → 勾 **Paint flashing**，触发闪线。改动前整条标签会闪绿（阴影重绘），改动后**不应**出现持续的绿色重绘区。
  - **减动效判据**（Rendering → Emulate `prefers-reduced-motion: reduce`）：再触发一次闪线——
    线的**粗细应当完全不变**（始终 2px），只有颜色加深再回落。**这与改动前不同，是本方案有意的改进**（方案 047 的契约）。
  - **点击不被吞**：鼠标沿标签最上沿 1–2px 处点击，仍应正常切换会话（验证 `pointer-events: none`）。
- **Done when**：静态顶线与闪线观感与改动前一致、Paint flashing 不再持续闪绿、减动效下只剩颜色那一档、机械项全过。
