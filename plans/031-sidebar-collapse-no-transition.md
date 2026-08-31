# 031 — 侧栏折叠不再过渡 width（编辑器整列每帧回流）

- **Status**: DONE（门禁已过，目检待作者）
- **Commit**: 43b52e9
- **Severity**: HIGH
- **Category**: 5 性能 / 1 频次
- **Estimated scope**: 1 个 CSS 文件（约 3 行）+ 1 处文档同步

> ⚠ **这份方案改的是产品决策，不只是代码**，体例同方案 014（⌘K 去动画）。
> 它删掉一个用户看得见的动效，因此带一步 design-system.md 同步。请单独审阅。

## Problem

`src/components/layout/Sidebar.module.css:1-16` — 当前代码：

```css
.sidebar {
  width: var(--sidebar-width);
  height: 100%;
  background: var(--color-bg-surface);
  border-right: 1px solid var(--color-border-soft);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
  transition: width var(--transition-slow), border-right-width var(--transition-slow);
}

.sidebar.collapsed {
  width: 0;
  border-right-width: 0;
}
```

`--transition-slow` 是 `320ms var(--ease-out)`，即约 **19 帧**。`width` 与
`border-right-width` **都是布局属性**，而侧栏是布局行的 flex 子元素且**折叠时从不卸载**：

```tsx
/* src/App.tsx:151-152 — 当前 */
        <IconRail onOpenSettings={() => openSettings()} />
        {view === "editor" && <Sidebar />}
```

```tsx
/* src/components/layout/Sidebar.tsx:87 — 当前，只换类名 */
    <div className={`${styles.sidebar} ${sidebarCollapsed ? styles.collapsed : ""}`}>
```

于是这 19 帧里，每一帧都要：侧栏自己的子树（FileTree / OutlineTab 的 N 行带
省略号文本）对着不断变窄的宽度重排；**并且** `flex: 1` 的内容列拿到新宽度，
**CodeMirror 因此重新测量折行并重渲视口**。一次折叠 ≈ 19 次全文档列的强制回流，
全部在主线程。

触发器不是罕见操作：

```tsx
/* src/components/layout/IconRail.tsx:98-103 — 当前 */
    if (activeSideTab === id && !sidebarCollapsed) {
      setSidebarCollapsed(true);
    } else {
      setActiveSideTab(id);
      setSidebarCollapsed(false);
    }
```

即**再点一次已激活的标签**就折叠——与 100+/天的切标签是同一颗按钮。
AUDIT §1 的频次表对这一档的裁决是「No animation. Ever.」。

注意拖拽路径**早已**被保护，只有折叠路径没有：

```css
/* src/components/layout/Sidebar.module.css:18-20 — 当前，方案 001 留下的 */
:global([data-resizing]) .sidebar {
  transition: none;
}
```

## Target

```css
/* target — src/components/layout/Sidebar.module.css */
.sidebar {
  width: var(--sidebar-width);
  height: 100%;
  background: var(--color-bg-surface);
  border-right: 1px solid var(--color-border-soft);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
  /* 折叠/展开不过渡：width 是布局属性，而侧栏是布局行里从不卸载的 flex 子元素
     （App.tsx:152 只换类名），过渡期间每一帧都会让 flex:1 的内容列换宽度、
     CodeMirror 重新测量折行并重渲视口——320ms 约 19 次全文档列回流。且触发器
     是 IconRail 再点一次已激活标签（与 100+/天的切标签同一颗按钮），属 AUDIT
     §1「永不动画」那一档。拖拽路径的 [data-resizing] 规则因此也不再是特例，
     但保留它：它挡的是拖拽期间的 --sidebar-width 写入，与折叠是两回事。 */
}

.sidebar.collapsed {
  width: 0;
  border-right-width: 0;
}
```

即：**删掉 `.sidebar` 的整行 `transition`**，其余一字不动。

## Repo conventions to follow

- 高频/键盘触发表面「删掉动画」是本仓库反复确立的处方，不是新发明：
  方案 003（`InlineAiBubble` 删 `scaleIn`）、方案 014（⌘K 面板去动画）、
  方案 024（「回到最新」气泡删入场）。**处方一致，不要重新论证。**
- 删动效同时要同步设计文档 —— 体例见方案 014，它同步的是
  `docs/reference/design-system.md`。
- 保留 `:global([data-resizing]) .sidebar { transition: none; }`（`:18-20`）。
  删掉 `.sidebar` 的 `transition` 之后它确实变成空操作，但它表达的是另一条
  不变量（拖拽期间不过渡），方案 001 的 Verification 还在引用它。**留着。**

## Steps

1. `src/components/layout/Sidebar.module.css` — 删除 `:10` 整行：
   ```css
   transition: width var(--transition-slow), border-right-width var(--transition-slow);
   ```
   在 `.sidebar` 规则块的末尾（`}` 之前或之后紧邻处）写入 Target 里那段注释，
   说明为什么这里**故意**没有过渡。没有注释的话下一个人会「顺手补上」。
2. `src/components/layout/Sidebar.module.css` — 不要动 `.sidebar.collapsed`
   （`:13-16`），也不要动 `:global([data-resizing])` 块（`:18-20`）。
3. `docs/reference/design-system.md` — 找到动效小节（`--transition-slow` 被描述为
   「320ms, panels/drawers」的那一行附近，约 `:26`）。**不要改令牌的描述**——
   `--transition-slow` 仍被抽屉等其它表面使用。在动效小节里补一条例外说明：
   侧栏折叠不使用过渡，理由是布局属性 + 高频触发器，并指回本方案编号。
   措辞与方案 014 在该文档留下的那条例外保持同一体例。

## Boundaries

- **不要**改 `src/App.tsx`、`src/components/layout/Sidebar.tsx`、
  `src/components/layout/IconRail.tsx` —— 本方案不碰折叠的**触发**逻辑，只碰它的表现。
- **不要**试图把折叠改成 `transform` 动画。侧栏是 flex 子元素，把它 translate 走
  之后仍需用 `margin`/`width` 收回它占的位——那还是布局属性。**没有**合成层版本的
  「折叠一个 flex 兄弟元素」，这正是本方案选择删除而不是改写的原因。
- **不要**只是把 320ms 缩短到 120ms。那把回流从 ~19 帧降到 ~7 帧，量级没变，
  在大文档上仍然可见掉帧；而频次规则要求的是零，不是更少。
- **不要**新增关键帧或 Motion 预设。
- 若你找到的代码与上面的摘录对不上（自 43b52e9 起漂移），**停下并报告**，不要即兴发挥。

## Verification

- **机械**：
  - `grep -n "transition" src/components/layout/Sidebar.module.css` —— 结果里
    **不应**再有 `width` 或 `border-right-width`；`:global([data-resizing])` 那条
    `transition: none` 应仍在。
  - `pnpm exec tsc --noEmit` —— 无诊断。
  - `pnpm test` —— 全绿（本改动不应触碰任何测试；`cssKeyframeNames.test.ts` 尤其应仍通过）。
  - `pnpm build` —— 成功。
  - 构建产物核对：`grep -ohE "transition:[^;}]*width[^;}]*" dist/assets/*.css | grep -c "var(--transition-slow)"`
    —— 侧栏那条应已消失（其它文件若有同款声明会计入，逐条看一眼来源即可）。
- **目检**（需要真窗口：`pnpm tauri dev`，打开一个**长文档**，最好开分屏预览）：
  - 反复点击 IconRail 上已激活的标签折叠/展开侧栏。折叠**立即**发生，没有 320ms 的推挤。
  - 折叠瞬间观察正文列：文字**一次到位**，不应看到文字在 ~1/3 秒里连续重排折行。
  - 打开 DevTools Performance，录制一次折叠：改动前该区间有约 19 次
    Layout；改动后应是 1–2 次。**这是本方案唯一能量化的判据，务必跑一次。**
  - 拖拽侧栏边缘调宽度仍然跟手、无过渡拖尾（方案 001/021 的既有行为不应回归）。
- **Done when**：`.sidebar` 不再声明任何 `transition`，原位留有解释性注释，
  design-system.md 有对应例外说明，且上面的 Layout 计数从 ~19 降到个位数。
