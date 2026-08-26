# 025 — 取材范围切换的墙面软化（加法项）

- **Status**: DONE (2026-08-26) — **第 1 步已落地；第 2 步（卡片错峰）已按判据撤回**，失败的是判据 2，实测见下方「第 2 步撤回记录」
- **Commit**: 93eb7de
- **Severity**: LOW（加法项：该动而没动）
- **Category**: 该动而没动 / 内聚
- **Estimated scope**: 第 1 步 1 个 TSX + 1 个 CSS，各 ~3 行；第 2 步条件性

> 本方案由审计的「该动而没动」一节合并而来：取材范围切换的墙面软化（第 1 步）
> 与卡片墙的错峰入场（第 2 步）改的是同一个容器、需要同一套「只在换范围时播、
> 不在每次搜索时播」的门控，拆成两份会互相打架。
> **第 2 步是条件性的**（照方案 018 第 3 步的体例）：先按 Steps 里的判据实测，
> 判据不成立就**如实撤回第 2 步**，只交第 1 步。不许凭感觉硬上。

## 第 2 步撤回记录（2026-08-26，实测）

**撤回依据：判据 2 不成立，且不可能成立。** 卡片是 `key={e.id}`
（`LoreWall.tsx:776`）——搜索每敲一个字符，新匹配上的卡片就是一次**单张挂载**，
而网格容器并不重挂载。任何写在 `.grid > *` 上的入场动画都会在那一刻对这张卡片
生效。

在运行中的页面里注入第 2 步的候选规则实测（用 `LoreWall.module.css` 的真实哈希
类名，不自己重写规则），模拟「墙已在屏幕上，单张卡片新挂载」：

```json
{
  "gridCls": "mDUgNa_grid",
  "freshAnims":   [{ "state": "running", "name": "fadeIn", "dur": 200 }],
  "freshOpacity": "0",          // ← 单张新卡确实从 0 淡入：判据 2 失败
  "step1CardAnims": 0,          // ← 只有第 1 步时，卡片身上零动画：判据 1 通过
  "gridOwnAnims": ["fadeIn"]    // ← 第 1 步的整墙淡入确实挂在容器上
}
```

要让第 2 步成立，就得加一个「本次是不是换幕」的状态位（换范围时置位、动画跑完
清除），再据此决定要不要发 `animation-delay`。那是为一个 LOW 加法项引入一份新的
时序状态，收益（一次错峰）配不上它。方案里写明了「不许改判据来迁就实现」，
所以按原样撤回。

**第 1 步保留**：判据 1 由 `step1CardAnims: 0` 实测坐实——打字时卡片身上根本没有
动画可放，不是「延迟够短所以看不出来」。

## Problem

切换取材范围（围栏）会整片改变知识库墙上显示哪些条目——它是这个页面上语义最重
的一次状态变化（它同时改的是 **AI 的视野**，不只是眼睛看到什么，见
`collections.module.css:304` 的注释）。而现在这次变化是**一帧硬切**：

```tsx
// src/components/lore/LoreWall.tsx:736-737 — 现状
            <div className={styles.grid}>
              {filtered.map((e, idx) => {
```
```css
/* src/components/lore/LoreWall.module.css:177-182 — 现状，无任何入场 */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
  align-items: start;
}
```

`scope` 来自 `useLoreStore`（`LoreWall.tsx:68`），改变后 `filtered` 重算，网格
就地重排。整墙的卡片在一帧内被换掉，没有任何东西说明「刚才发生了一次换幕」。
AUDIT §8 把这一类列为该动的首要情形：**防止突兀变化**。

同时，全库 `grep` 不到任何 `animation-delay` / `staggerChildren` / `transition-delay`
——卡片墙是这个应用的门面表面（设计稿 03 的索引卡墙），整格同时出现。

## 关键约束：不能在每次搜索按键时重播

这是本方案最容易做错的地方，写在最前面：

`filtered` 同时被 **搜索框、分类筛选、集合筛选、取材范围** 四样东西驱动
（`LoreWall.tsx` 的 `search` / `filter` / `colFilter` / `scope`）。而卡片是
`key={e.id}`（`LoreWall.tsx:776`）——**逐张按 id 挂载/卸载**。所以任何写在
`.card` 上的入场动画，都会在**搜索框每敲一个字**时给新匹配上的卡片重放一次。
那正是方案 003 花力气删掉的那种东西。

结论：入场动画必须挂在**容器**上，并且只在 `scope` 变化时重挂载。

## Target · 第 1 步：换范围时整墙淡入

给 `.grid` 一个只随 `scope` 变化的 `key`，让它在换范围时重挂载并播一次
`fadeIn`；搜索/筛选不改这个 key，网格不重挂载，逐张增删照旧。

```tsx
// src/components/lore/LoreWall.tsx:736 — 目标
            {/* key 只跟取材范围走：换围栏是一次换幕（它同时改的是 AI 的视野），
                值得一次淡入；而搜索/分类筛选每次按键都会改 filtered，跟着重挂载
                就会变成在打字时闪烁。 */}
            <div key={scope ?? "all"} className={styles.grid}>
```

```css
/* src/components/lore/LoreWall.module.css:177 — 目标 */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
  align-items: start;
  /* 换取材范围＝换幕：整墙淡入一次。key 只绑 scope，所以搜索时不会重放。 */
  animation: fadeIn var(--transition-base);
}
```

`fadeIn` 是 `global.css:51-54` 的共享关键帧，`--transition-base` 是 200ms
（`tokens.css:53`）。**只淡不移**：卡片自带 id 哈希出来的 `±0.4deg` 内联
`transform`（`LoreWall.tsx:780`），任何带 transform 的关键帧都会在播放期间盖掉
它，卡片会先摆正再歪回去。

## Target · 第 2 步（条件性）：卡片错峰

只有在第 1 步落地并实测通过后才考虑。同样**只能淡不能移**（理由同上），延迟按
索引给，且必须与第 1 步共用同一个 `key`——网格不重挂载时，单张卡片不许自己播。

```tsx
// 仅当判据成立才写
                    style={{ transform: `rotate(${rot}deg)`, animationDelay: `${Math.min(idx, 12) * 40}ms` }}
```
```css
.grid > * { animation: fadeIn var(--transition-base) both; }
```
`40ms` 取自 AUDIT §7 的 30–80ms 区间下沿（这是一面密集的卡片墙，取上沿会让最后
一张等太久）；`Math.min(idx, 12)` 封顶，否则第 40 张卡要等 1.6s。`both` 保证延迟
期间卡片是透明的而不是先闪一下。

**判据（三条全部成立才做，任何一条不成立就撤回第 2 步并在本文件写明是哪条）**：
1. 第 1 步落地后，在搜索框连打 10 个字符，**卡片没有任何一张单独淡入**
   （证明容器级门控真的挡住了逐张重放）。
2. 加上第 2 步后重复上一条，结论不变。
3. 一面有 40+ 张卡片的墙上换一次取材范围，最后一张卡片的出现**不迟于 700ms**，
   且期间点击任意一张已出现的卡片能立刻打开详情（错峰**不许**阻塞交互，AUDIT §7）。

## Repo conventions to follow

- 共享关键帧只用 `global.css` 已有的（design-system.md:78：reuse these, don't
  redefine per component）。本方案只用 `fadeIn`，**不新增任何关键帧**。
- 时长走令牌 `--transition-base`（`tokens.css:53`），不写 `200ms`。
- `LoreWall.tsx` 已经在用 Motion 做网格↔详情的推进
  （`LoreWall.tsx:483-510`，`AnimatePresence` + `pushForward`/`pushBackdrop`）。
  **本方案不碰那一层，也不新增 Motion**——design-system.md:251 把 Motion 限定在
  「一个表面出场同时另一个入场」，换取材范围只是同一个表面换内容，纯 CSS 就够。
- 卡片的 `±0.4deg` 微旋转与悬停回正是设计稿 03 定的语汇
  （design-system.md:95），**不许为了让动画好写而改动它**。

## Steps

1. `src/components/lore/LoreWall.module.css`：给 `.grid`（:177）追加
   `animation: fadeIn var(--transition-base);` 与 Target 里那行注释。
2. `src/components/lore/LoreWall.tsx`：给 `<div className={styles.grid}>`（:736）
   加 `key={scope ?? "all"}` 与 Target 里那段注释。
3. 跑第 2 步判据的第 1 条与第 3 条（第 3 条此时只测「点击不被阻塞」）。
   - 另外确认：换取材范围后**网格的滚动位置**行为可接受。`.grid` 重挂载会让
     滚动容器 `.gridWrap`（:714，滚动条在它身上）保持位置还是回到顶部，取决于
     内容高度变化——两种都算通过，但**必须实际看一眼并在 PR 描述里写明是哪种**。
     若滚动位置跳到一个明显错误的地方（比如内容变多却停在中间），停下报告。
4. 判据三条全过 → 按 Target 第 2 步实现错峰，再重跑三条判据。
   任何一条不过 → **删掉第 2 步的改动**，在本文件的 Status 行下面加一行
   「第 2 步已撤回：<哪条判据、实测数字>」，只交第 1 步。

## Boundaries

- **不动 `filtered` 的计算、不动任何筛选逻辑。**
- 不给 `.card` 加带 `transform` 的入场动画（会盖掉卡片的微旋转内联样式）。
- 不新增 `@keyframes`；不新增 Motion 组件；不碰 `LoreWall.tsx:483-510` 的
  `AnimatePresence` 块。
- 不给搜索框、分类栏、集合装订栏加动画——那是方案 020 的地界，且那份只加过渡
  不加入场。
- 不动 `rotationFor` / `cardRefs` / 多选逻辑。
- 第 2 步在判据未全过时**不许保留**，也不许改判据来迁就实现。

## Verification

- **机械**：`pnpm tsc --noEmit`、`pnpm build` 通过。
  `grep -rn "keyframes" src/components/lore/LoreWall.module.css` → 零输出
  （确认没有新增本地关键帧）。
- **感觉核验**（`pnpm tauri dev`，需要一个有集合、且条目数 40+ 的项目）：
  - 切换取材范围：整墙**淡入一次**，200ms，卡片的微旋转在整个过程中保持不变
    （若看到卡片先摆正再歪回去，说明动了 transform，回到 Target 的告诫）。
  - 在搜索框连打 10 个字符：**不许有任何淡入**。这是本方案第一优先的回归。
  - 切换分类、切换集合筛选：同样不许有整墙淡入（它们不该触发换幕）。
  - DevTools → Animations 面板降到 10% 速度再切一次范围，确认只有**一条** 200ms
    的 `fadeIn` 在跑（若看到 N 条，说明动画落到了卡片上而不是容器上）。
  - Rendering → Emulate `prefers-reduced-motion: reduce`：淡入被全局兜底冻结，
    墙面内容**必须仍然正常显示**（这是 `animation` 而非 `transition`，且没有
    `both`/`forwards`，终态就是元素自身状态——但仍要亲眼确认一次）。
- **Done when**：换范围有一次整墙淡入；打字/换分类零动画；减动效下内容正常；
  第 2 步要么落地并通过三条判据，要么已撤回并写明原因。
