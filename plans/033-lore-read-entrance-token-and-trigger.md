# 033 — 阅读模式入场：令牌回归 + 关键帧去重 + 挂到正确的触发器

- **Status**: DONE（门禁已过，目检待作者）
- **Commit**: 43b52e9
- **Severity**: HIGH
- **Category**: 7 内聚与令牌 / 2 缓动 / 1 频次 / 8 该动而没动
- **Estimated scope**: 1 个 CSS 文件（约 8 行）+ 1 个 TSX 文件（1 行）

> 本方案合并了审计里的两条发现。它们**改的是同一段三行 CSS**，拆成两份会互相
> 推翻：一份把 `readIn` 换成 `slideInRight`，另一份又要把整个滑入换掉。

## Problem

### 一、令牌与关键帧的双重回归

`src/components/lore/LoreReadView.module.css:14-24` —— 当前代码：

```css
  container-type: inline-size;
  animation: readIn 200ms cubic-bezier(0.32, 0.72, 0, 1);
}
@keyframes readIn {
  from { opacity: 0; transform: translateX(24px); }
  to   { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .wall { animation: fadeIn 120ms var(--ease-out); }
}
```

两处都是对既有不变量的**回归**，且都发生在 `5f9d25a` 之后的新文件里：

1. `cubic-bezier(0.32, 0.72, 0, 1)` 与 `src/styles/tokens.css:47` 的
   `--ease-out` **逐字节相同**。方案 022 曾把「tokens.css 之外的手写
   cubic-bezier」扫到零，这一行让它回到 1。它不是一条「相近但不同」的曲线，
   就是那个令牌被重打了一遍——于是以后重调令牌会**静默跳过**这一个表面。
   讽刺的是同文件 `:22` 与 `:165` 都正确地用了 `var(--ease-out)`，
   不一致发生在**一个文件之内**。

2. `readIn` 与 `src/styles/global.css:79-82` 的 `slideInRight` 是**同一个动画**：

   ```css
   /* src/styles/global.css:79-82 — 已有 */
   @keyframes slideInRight {
     from { opacity: 0; transform: translateX(24px); }
     to   { opacity: 1; transform: translateX(0); }
   }
   ```
   同样的位移、同样的属性、同样的终态（`transform: none` 与 `translateX(0)`
   在这里是同一个恒等变换，渲染无差别）。因为 `vite.config.ts` 关掉了关键帧
   哈希，`readIn` 是一个**全局**名字——于是共享命名空间里多了一个条目，
   渲染结果与既有条目完全相同。它能通过 `cssKeyframeNames.test.ts`
   （名字不重复），但正是该测试**守不住的那一半**：重复定义，而非重名覆盖。

### 二、这个入场挂在了错误的触发器上

`readIn` 是**挂载时**播放的 CSS 动画，而 `LoreReadView` 的挂载由**模式**决定，
不由**条目**决定：

```tsx
/* src/components/lore/LoreDetail.tsx:1163-1165 — 当前，注意没有 key */
      ) : detailMode === "read" ? (
        <LoreReadView
          entity={entity}
```

于是两件事同时错了：

**(a) 按 `R` 键切模式会重放一整张纸的滑入。** 触发器是一颗无修饰键的单字母：

```tsx
/* src/components/lore/LoreDetail.tsx:224-228 — 当前 */
      if (ev.key !== "r" && ev.key !== "R") return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.isComposing) return;
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      setDetailMode(useLoreStore.getState().detailMode === "read" ? "manage" : "read");
```

纸宽 820px（文件头注释 `:2`）。反复按 `R` 对照两个视图，每次都从右侧滑入一整张纸。
按 AUDIT §1 的频次表，这属于「Remove or drastically reduce」那一档。
方向还是**不对称**的：`read → manage` 瞬移（管理台分支没有任何入场），
`manage → read` 滑入——两半行为不同的切换读起来像 bug，不像空间信息。

**(b) 真正的内容替换反而零动效。** 页脚「下一条」换条目：

```tsx
/* src/components/lore/LoreReadView.tsx:632 — 当前 */
              <button className={s.nextName} onClick={next.open}>
```

因为没有 `key`，`entity` prop 变了但组件**不重新挂载**，`readIn` 不会重播：
名字、头像、封面、每一条特征正文、图库——整张纸在一帧内换掉，零动效。
同一个视觉变化，从管理台来有 200ms 滑入，从上一条来什么都没有。

**(c) 换条目后滚动位置不重置。** `.wall`（`:5`）自己就是滚动容器
（`overflow-y: auto`），而 `LoreReadView.tsx:169-207` 里 `scrollTop` 只被
`scrollToAnchor` 写过，换条目时无人重置。从条目 A 翻到 B，落点是 A 的滚动
偏移、文档中段——**这才是 (b) 那次瞬移真正让人失去方位的原因**。

## Target

```css
/* target — src/components/lore/LoreReadView.module.css:14-24 */
  container-type: inline-size;
  /* 入场只是一次淡入，不是位移：这块 .wall 由「进入阅读态」和「换条目」两件事
     挂载，而前者的触发器是无修饰键的 R（LoreDetail.tsx:224），一整张 820px 的
     纸每次都从右边滑进来属 AUDIT §1「大幅减弱」那一档。换成纯 opacity 之后，
     两个方向也终于对称了——管理台那半本来就没有入场。 */
  animation: fadeIn 120ms var(--ease-out);
}
@media (prefers-reduced-motion: reduce) {
  /* 全局 global.css:138 会用 !important 把 animation-duration 压到 0.001ms，
     一条不带 !important 的本地规则压不过它。这里的动效是纯 opacity、不承载
     信息，瞬时呈现是可接受的降级，所以**不**做本地豁免——写一条压不过去的
     规则只会让读者以为此处已经温和降级了。 */
}
```

即：
- `readIn` 的**定义整块删除**（4 行）；
- `.wall` 的 `animation` 改为 `fadeIn 120ms var(--ease-out)`（`fadeIn` 已在
  `global.css:67` 存在）；
- 那个 `@media (prefers-reduced-motion: reduce) { .wall { … } }` 块**整块删除**，
  换成 Target 里那段注释（它当前是死代码——见 Boundaries）。

```tsx
/* target — src/components/lore/LoreDetail.tsx:1163-1166 */
      ) : detailMode === "read" ? (
        <LoreReadView
          // 换条目＝重新挂载：这既让入场淡入落在真正的内容替换上（不换 key 的话
          // entity prop 变了但组件不重挂，整张纸一帧硬切），也顺带把 .wall 的
          // scrollTop 归零——它自己就是滚动容器，否则翻到下一条会落在上一条的
          // 滚动偏移上、正文中段。
          key={entity.dirPath}
          entity={entity}
```

## Repo conventions to follow

- 缓动一律走令牌：`src/styles/tokens.css:47` `--ease-out`。
  **tokens.css 之外不允许出现手写 `cubic-bezier`**——这是方案 022 确立的不变量，
  判据就是 `grep -rn "cubic-bezier" src --include='*.css' | grep -v tokens.css` 为空。
- 复用全局关键帧，**不新增**。`fadeIn` 在 `src/styles/global.css:67`：
  ```css
  @keyframes fadeIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  ```
  同款用法的范本：`src/components/lore/LoreDetail.module.css:790`
  （`animation: fadeIn 120ms var(--ease-out);`）——同一个 120ms、同一个令牌。
- 高频/键盘触发表面「删掉或大幅减弱动效」是既有处方：方案 003、014、024。
- `entity.dirPath` 是条目的稳定身份（`src/lib/lore/model.ts:101`，条目文件夹的
  绝对路径），适合做 `key`；不要用 `entity.id`（`:99` 只是目录名，跨分类可能重名）。

## Steps

1. `src/components/lore/LoreReadView.module.css` —— 把 `:15` 那行
   `animation: readIn 200ms cubic-bezier(0.32, 0.72, 0, 1);`
   改成 `animation: fadeIn 120ms var(--ease-out);`，并写入 Target 里的注释。
2. 同文件 —— **删掉** `:17-20` 的 `@keyframes readIn { … }` 整块。
3. 同文件 —— **删掉** `:21-23` 的
   `@media (prefers-reduced-motion: reduce) { .wall { animation: fadeIn 120ms var(--ease-out); } }`
   整块，换成 Target 里那段解释「为什么这里不做本地豁免」的注释。
4. `src/components/lore/LoreDetail.tsx` —— 在 `:1164` 的 `<LoreReadView` 上增加
   `key={entity.dirPath}`，连同 Target 里的注释。**放在 `entity={entity}` 之前**。
5. 不要动同文件 `:165` 的 `.flash`（`sectFlash 320ms var(--ease-out) 160ms backwards`），
   它已经用对了令牌。

## Boundaries

- **不要**保留 `readIn` 这个名字「以防万一」。它一旦没有引用，
  `cssKeyframeNames.test.ts` 的第二条断言（悬空引用）不会报它，但它就是死代码。
- **不要**给这次淡入补 `@media (prefers-reduced-motion: reduce)` 本地豁免。
  第 3 步删掉的那块**当前就是死代码**：`global.css:138` 的
  `animation-duration: 0.001ms !important` 作用于 `*, *::before, *::after`，
  一条不带 `!important` 的简写声明无论特异性多高都压不过它。
  （对比：`src/components/ai/AgentLog.module.css:377` 那种**带 `!important`** 的
  豁免是有效的，但那是给 spinner 用的——静止的残环与卡死无法区分，
  而这里是一次淡入，不承载信息。）
- **不要**改 `R` 键的处理逻辑（`LoreDetail.tsx:222-232`）。本方案不碰快捷键行为，
  只碰它引发的动效。
- **不要**给管理台分支补入场来「凑对称」。两边都不做位移就已经对称了。
- **不要**新增关键帧或 Motion 预设。
- **不要**顺手修 `LoreReadView.tsx:530-546` 引用的十个不存在的 CSS 类
  （`dictTable` / `dictColSrc` / `dictRest` 等）——那是审计路过发现的**非动效**缺陷，
  已单独记录，不在本方案范围内。
- 若代码与摘录对不上（自 43b52e9 起漂移），**停下并报告**。

## Verification

- **机械**：
  - `grep -rn "cubic-bezier" src --include='*.css' | grep -v tokens.css` —— **必须为空**。
    这是方案 022 的不变量，本方案让它回到零。
  - `grep -rn "readIn" src` —— **必须为空**（定义与引用都没了）。
  - `pnpm exec tsc --noEmit` 无诊断。
  - `pnpm test` 全绿，**含 `src/lib/__tests__/cssKeyframeNames.test.ts`**——
    删关键帧正是它的回归网（方案 019 就是为 022/024 这类删除而立的）。
  - `pnpm build` 成功。
  - 产物核对：`grep -ohE "@keyframes [a-zA-Z_]+" dist/assets/*.css | sort -u | grep -c readIn`
    → 0；`grep -ohE "animation:[^;}]+" dist/assets/*.css | grep -c "fadeIn .12s\|fadeIn 120ms"`
    → 比改动前多 1。带作用域后缀的引用必须是 0 处。
- **目检**（`pnpm tauri dev`，打开项目 → 知识库 → 任一条目 → 按 `R` 进阅读模式）：
  - **反复按 `R`** 在阅读/管理之间切换：不应再有整张纸从右边滑进来，
    只剩一次极短的淡入，两个方向观感对称。
  - 滚到某条目正文**中段**，点页脚「下一条」：新条目应**从顶部**开始
    （不再停在上一条的滚动偏移上），并伴一次淡入。**这两点是本方案的核心，
    务必连着验。**
  - 再点「下一条」若干次：每次都应重播淡入（证明 `key` 生效）。
  - DevTools Animations 面板 10% 速度看一次换条目：应只有 opacity 在变，
    **不应**有任何 X 方向位移。
  - 开系统「减弱动态效果」：换条目应瞬时完成且内容完整（可接受的降级）。
- **Done when**：两条 grep 判据（`cubic-bezier` 为空、`readIn` 为空）成立，
  `R` 键不再触发位移，换条目既淡入又回到顶部。
