# 039 — 最近项目行补按压反馈（本面板最重的动作却没有确认）

- **Status**: DONE（门禁已过，目检待作者）
- **Commit**: 43b52e9
- **Severity**: MEDIUM
- **Category**: 3 物理性 / 7 内聚
- **Estimated scope**: 1 个 CSS 文件，2 行

## Problem

`src/components/layout/RecentProjects.module.css:129-141` —— 当前代码：

```css
.open {
  all: unset;
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 12px;
  cursor: pointer;
}
.open:disabled { opacity: 0.5; cursor: wait; }
```

`.open` 是整行的点击区，触发**打开一个项目**：

```tsx
/* src/components/layout/RecentProjects.tsx:207 — 当前 */
              onClick={() => openProject(path)}
```

这是本面板上**最重、最慢**的动作——打开项目要扫文件树、开数据库、扫知识库。
它有行悬停背景（`:127`）和禁用态（`:140` `cursor: wait`），
但**全文件搜不到 `.open:active`**：

```
$ grep -n ":active" src/components/layout/RecentProjects.module.css
44:.openBtn:active { transform: scale(0.98); }
205:.pinBtn:active {
209:.pinBtn:active svg { stroke-width: 1.7; }
```

即：同一个文件里，**次要**的「打开其它文件夹」按钮（`.openBtn`）和**更次要**的
钉选按钮（`.pinBtn`）都有按压反馈，而**最重要**的那个目标没有。用户点下去之后，
在整个项目载入完成之前，界面没有任何东西确认这次点击被收到了。

AUDIT §3 正是这一条：pressable elements with no press feedback。

## Target

```css
/* target — src/components/layout/RecentProjects.module.css */
.open {
  all: unset;
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 12px;
  cursor: pointer;
  /* 打开项目是本面板最重最慢的动作（扫文件树 + 开库 + 扫知识库），点下去到
     载入完成之间界面本来毫无回执。同文件的 .openBtn:44 / .pinBtn:205 都有按压，
     偏偏最重要的这个没有。 */
  transition: transform var(--transition-fast);
}
.open:active:not(:disabled) { transform: scale(0.98); }
.open:disabled { opacity: 0.5; cursor: wait; }
```

## Repo conventions to follow

- 按压反馈就在同一个文件里，**逐字照抄它的幅度**：
  ```css
  /* src/components/layout/RecentProjects.module.css:44 — 已有，正确 */
  .openBtn:active { transform: scale(0.98); }
  ```
- `--transition-fast` = `120ms var(--ease-out)`（`tokens.css:52`），落在 AUDIT §3
  的 100–160ms 区间；幅度 0.98 落在 0.95–0.98 区间。仓库现有 70+ 处 `:active`
  都是这个量级。
- `:not(:disabled)` 是必需的：`.open` 在打开过程中会被禁用（`:140` 有
  `cursor: wait`），禁用期间不该再响应按压。

## Steps

1. `src/components/layout/RecentProjects.module.css` —— 在 `.open` 规则块内
   `cursor: pointer;` 之后追加 `transition: transform var(--transition-fast);`，
   连同 Target 里的注释。
2. 同文件 —— 在 `.open` 之后、`.open:disabled` **之前**，新增一行
   `.open:active:not(:disabled) { transform: scale(0.98); }`。
3. 不要动 `.open:disabled`、`.row:hover`、`.openBtn`、`.pinBtn` 的任何规则。

## Boundaries

- **不要**顺手改 `:190` 那条过渡 `width` / `margin-right` 的 `.pinBtn` 规则——
  那是审计里的 LOW 档发现，本批未立案。
- **不要**给 `.row` 而不是 `.open` 加按压：`.row` 是 `<li>` 容器，里面还含着
  钉选按钮，整行缩放会把钉选按钮一起缩掉。
- **不要**加 `:hover` 位移。行悬停已有背景变化（`:127`），再加位移会与
  钉选按钮的宽度展开叠在一起。
- **不要**新增关键帧或 Motion 预设。
- 若代码与摘录对不上（自 43b52e9 起漂移），**停下并报告**。

## Verification

- **机械**：
  - `grep -n ":active" src/components/layout/RecentProjects.module.css` —— 应新增
    `.open:active:not(:disabled)` 一条，共 4 处。
  - `pnpm exec tsc --noEmit` 无诊断；`pnpm test` 全绿；`pnpm build` 成功。
- **目检**（`pnpm tauri dev`，**不要**打开任何项目——最近项目面板只在无项目态出现）：
  - 在最近列表里按住某一行：整行文字块应轻微缩到 0.98，松开回弹。
  - 与同屏「打开其它文件夹」按钮（`.openBtn`）交替按一次：两者手感应一致。
  - 点下去真的打开一个项目：按压反馈应在**点击的瞬间**出现，而不是等载入结束。
    **这正是本方案的意义**——载入期间的空窗由按压填上。
  - 载入进行中（行被禁用、`cursor: wait`）再按一次：**不应**有缩放反应。
  - 按住行内的钉选按钮：只有钉选按钮反应，整行**不应**跟着缩（验证第 2 步选择器落对了）。
  - 开系统「减弱动态效果」：按压被全局规则压成瞬时——可接受（幅度极小、不承载信息）。
- **Done when**：整行有按压反馈、禁用态不响应、钉选按钮不连带整行缩放。
