# 「文件」面板 · 全部折叠（collapse all）—— 设计

> 状态：`shipped`。纯逻辑与 store action 先落（PR #432），界面随设计稿
> [`17 文件面板 Files Panel`](file-panel-redesign-brief.md) 一起落。
>
> **设计稿推翻了本文的两处判断，都对**：① §3 说不做「折叠 ↔ 展开」切换态，理由是纯图标
> 按钮里一图两义、作者按下去前不知道会发生什么 —— 设计稿让按钮**按下后留在实底赭石
> 态**，那个持续存在的态本身就是「现在点会展开」的说明；② §7 说不加快捷键，设计稿给了
> ⌥⌘←（实现时从设计稿写的 ⇧⌘L 挪开的是「定位当前文档」，见那份文档的出入清单）。
> §2 的三条实现约束不受影响，全部照旧成立。
> 代码实况截止 2026-08-31（`main` @ 998e7e8）。
>
> 后续：整块面板的重做任务书在 [file-panel-redesign-brief.md](file-panel-redesign-brief.md)，「全部折叠」作为其中一屏（§2c）交给设计稿一并回答。本文的三条实现约束（§2）与那份设计无关，无论按钮最后长什么样都成立。

## 1. 现状（代码实况）

| 面 | 落点 |
|---|---|
| 工具栏 | [`FileTree.tsx:1048`](../../src/components/layout/FileTree.tsx:1048) —— 项目名（已 `display:none`）+ 右侧 7 个 22×22 图标按钮：切换项目 · 新窗口 · 关闭项目 · 新建文件 · 新建文件夹 · 导入 · 刷新 |
| 按钮样式 | [`FileTree.module.css:39`](../../src/components/layout/FileTree.module.css:39) `.toolbarBtn`（22×22、透明底、hover 上色描边） |
| 展开状态 | `projectStore.expandedDirs: Record<string, boolean>`（[`projectStore.ts:165`](../../src/stores/projectStore.ts:165)），写入口只有 `setDirExpanded(path, open)`（[:698](../../src/stores/projectStore.ts:698)） |
| 默认值 | [`lib/fs/selection.ts:37`](../../src/lib/fs/selection.ts:37) `isDirOpen(stored, depth) = stored ?? depth === 0` —— **顶层目录默认展开，深层默认折叠** |
| 渲染 | `TreeNode` 每行订阅 `s.expandedDirs[node.path]` 单键（[:252](../../src/components/layout/FileTree.tsx:252)）；`FileTree` 顶层订阅整个 `expandedDirs`（[:380](../../src/components/layout/FileTree.tsx:380)） |
| 选区 | `selected` / `anchor` 是 `FileTree` 的本地 state（[:404](../../src/components/layout/FileTree.tsx:404)、[:408](../../src/components/layout/FileTree.tsx:408)）；`visibleRows = flattenVisible(fileTree, expandedDirs)` 是 shift 范围走的行 |
| 根右键菜单 | [`FileTree.tsx:890`](../../src/components/layout/FileTree.tsx:890)（右键树的空白处）：新建文件 / 新建文件夹 / 导入 / 粘贴 —— 分隔线 —— 在文件浏览器中显示 / 刷新 |
| 侧栏宽度 | 160–500，默认 240（`SIDEBAR_MIN`/`MAX`，[`appStore.ts:119`](../../src/stores/appStore.ts:119)） |

`expandedDirs` 是**会话内状态**：不进 `prefs`，`openProject`/`closeProject` 时整个清空。
折叠状态本来就不跨重启保留，本需求不改这条。

## 2. 三条约束（实现时会先撞上的）

### 2.1 「全部折叠」不能靠清空 `expandedDirs`

默认值是 `stored ?? depth === 0`。清空这张表，顶层目录会**回弹成展开**——
清空是「回到默认」，而默认恰好不是全折叠。所以按钮必须把树里**每一个目录**
显式写成 `false`，包括当前已经折叠的深层目录（它们只是没有键）。

反过来也成立，顺带记下：将来若做「全部展开」，同样不能靠清空。

### 2.2 必须是一次 set，不能循环调 `setDirExpanded`

`setDirExpanded` 每次都 `{...s.expandedDirs, [path]: open}` 造一个新对象。
对 N 个目录调 N 次 = N 次 store 通知，而顶层 `FileTree` 订阅的是整个
`expandedDirs`，每次通知都重算 `visibleRows` 并重渲整棵树。一个 200 目录的项目
按一下按钮就是 200 次全树重渲。

→ 新增一个批量 action，**一次 set**。

### 2.3 折叠会把选中的行藏起来，而选区不会自己收敛

`pruneSelection` 只按「路径还在不在树里」过滤（`everyRow`），**不按可见性**。
折叠之后，深层的选中项仍在 `selected` 里，作者却看不见它们。这正是
`openMenu` 那条注释已经在防的事（[:799](../../src/components/layout/FileTree.tsx:799)）：

> Right-clicking outside the selection retargets it, the way every file manager
> does — otherwise 删除 5 项 could appear over a row that is not one of the five.

全部折叠会**从另一头**造出同一个局面：作者右键一个仍然可见、且确实在选区里的
顶层文件夹，菜单弹出「删除 5 项」，而屏幕上只有 1 项。删除还带 `pruneNested`
和备份，不至于丢数据，但那句提示与作者看到的东西不符，就是这个按钮唯一真实的风险。

→ 折叠之后把 `selected` 收敛到**折叠后仍可见的行**（也就是顶层行）。
`anchor` 不用动：`rangeBetween` 已经为「锚点所在文件夹被折叠掉」降级过
（[`selection.ts:63`](../../src/lib/fs/selection.ts:63) 的注释就写着这条）。

## 3. 决策与被否掉的方案

| 决策 | 理由 / 否掉的替代 |
|---|---|
| **单向按钮，不做「折叠 ↔ 展开」切换** | 工具栏是纯图标、没有文字，一个图标两种语义时作者按下去前不知道会发生什么；而「全部展开」在深树上一次铺出几百行，是个比折叠危险得多的动作，需求也没要。将来要的话是**第二个按钮**，不是同一个 |
| **全部折叠 = 折到顶层行仍可见**（顶层目录也折叠，其行本身当然还在） | 树的根没有自己的行（`readDirRecursive` 返回的是项目的子项），所以「折叠到只剩根」不存在。折完屏幕上是每个顶层条目一行 |
| **当前打开的文档也一起折叠掉，不留链路** | 留下「当前文档所在的那条链路展开」会把按钮变成「折叠除了…之外的全部」——一个作者无法预测的按钮。折叠不丢任何东西，点一下文件夹就回来了。VS Code 也是这样，并把「定位当前文件」做成**另一个**命令（见 §7 非目标） |
| **禁用态，而不是隐藏** | 树里没有目录、或所有目录都已折叠时禁用。隐藏会让相邻按钮左右横跳，作者的肌肉记忆按到「刷新」上 |
| **按钮 + 根右键菜单，两个入口** | 工具栏给发现性，右键菜单给「树很长、鼠标已经在下面」的时候。菜单项放在「刷新」上方那一组（视图动作），与「新建 / 导入 / 粘贴」用分隔线隔开 |
| **零动画** | 树的展开/折叠现在**没有任何过渡**（子节点直接挂载/卸载）；全部折叠是一次卸载上百行，是全场最贵的一次布局，加高度动画只会让它卡。只保留按钮自身的 `:active { scale(0.94) }`（design-system「组件模式 · Icon/tab/control press」），符合「不要把 Motion 铺到元素级」 |
| **不引入「已全部折叠」的粘性标志** | 见 §6 的边界情形：折叠之后新出现的顶层目录仍会默认展开。用一个粘性标志压住它，等于让默认值有两个来源（`isDirOpen` 和标志），而 `isDirOpen` 是渲染树与 `flattenVisible` 唯一共用的定义——那正是它存在的理由 |

## 4. 交互规格

### 4.1 位置与图标

```
┌ 侧栏「文件」 ────────────────────────────────────┐
│  [切换] [新窗口] [关闭]  [新建文件] [新建夹] [导入] [⌃⌄全部折叠] [刷新] │
├──────────────────────────────────────────────────┤
│  ▸ 第一卷                                     12 │
│  ▸ 第二卷                                      8 │
│  ▸ 素材                                          │
│    大纲.md                                       │
└──────────────────────────────────────────────────┘
```

- 落在**「刷新」左边**：刷新是这一排的末位（重读磁盘，与视图无关），全部折叠
  和它同属「对树本身的操作」，紧邻成一组。
- 图标 `ChevronsDownUp`（lucide，已是项目图标库），`size={13}`——与 `RotateCw`
  同为 13 而非 14：这两个图形本身画得满，14 会比相邻的加号系列显得大一号。
- `title` / `aria-label` = `t("fileTree.collapseAll")`。焦点环由 `global.css` 的
  `:focus-visible:focus-visible` 提供，`.toolbarBtn` 没有 `all: unset`，不必额外处理。

### 4.2 拥挤（一个已经存在的问题，本需求会加剧）

7 个按钮 × 22px + 6 × 2px gap = **166px**；工具栏可用宽度 = `sidebarWidth − 44`
（`padding: 0 22px`），侧栏拉到最小 160px 时只有 **116px**。也就是说现在窄档下
按钮已经被 flex 压扁了。加到 8 个需要 190px，默认 240px 侧栏（可用 196px）仍然
放得下，最小档更挤。

处理方式，按推荐顺序：

1. **本需求只做**：给 `.toolbarBtn` 加 `flex-shrink: 0`，让工具栏在窄档下**溢出裁切**
   而不是把每个图标压成椭圆——压扁是八个都变形，裁切是最后一个先不可见，而两个入口
   里还有右键菜单那一个。
2. **可选、不阻塞**：按 design-system 的「Density tiers inside a resizable panel」用
   **容器查询**（`container-type: inline-size`，不是 `appStore` 里的宽度——拖动时
   store 里是拖动前的值）给工具栏分档：窄档 `padding: 0 12px`（多出 20px），
   仍不够时收起项目级三连（切换 / 新窗口 / 关闭）。这是既有问题，另开一条。

### 4.3 文案

`fileTree.collapseAll` —— zh-CN「全部折叠」/ en `Collapse All`。

「折叠」在本项目另有一处用法（对话历史压缩），但那是 AI 面板的语境，目录树里
「全部折叠」没有歧义。写法跟随 `FileTree.tsx` 既有的纯 `t(key)`（本文件不用
`defaultValue` 兜底），两份 locale 同时加。

## 5. 实现落点

### 5.1 `src/lib/fs/selection.ts`（纯函数，与 `isDirOpen` 同住）—— 已实现

```ts
/** 把每个目录显式写成 false —— 理由见 §2.1。 */
export function collapseAllMap(nodes: readonly TreeNodeLike[]): Record<string, boolean>

/** 作者**看得见的**目录里还有没有展开着的 —— 按钮的禁用态。 */
export function hasOpenDir(
  nodes: readonly TreeNodeLike[],
  expandedDirs: Record<string, boolean>,
): boolean
```

`hasOpenDir` 必须走 `isDirOpen`（而不是直接读表），否则「没有键的顶层目录」
会被判成已折叠，按钮在刚打开项目时就是禁用的。

**实现时定下的一条（本文原稿没写）：`hasOpenDir` 只看顶层，且不递归。**
一个目录能被看见，等价于它的每一级祖先都展开着 —— 所以「存在一个可见的展开目录」
和「存在一个展开着的顶层目录」是同一个问题的两种问法，只看顶层不是抄近路。
往下走会**多**数出一种东西：折叠着的祖先里那个仍标着 `true` 的子目录。它不在屏幕上，
数它就等于让按钮亮着、而按下去作者什么变化也看不到 —— 两种错法里更糟的那个。
那个残留的 `true` 无害：祖先一被重新展开，它就重新可见、也重新被数到。
（原稿的签名带一个 `depth` 参数，按这条它不再需要。）

### 5.2 `src/stores/projectStore.ts` —— 已实现

```ts
/** 一次 set —— 见 §2.2：逐个调 `setDirExpanded` 是 N 次全树重渲。 */
collapseAllDirs: () => void;
```

自己从 `get().fileTree` 算路径，调用点不必再遍历一次树。命名取
`collapseAllDirs` 而不是通用的 `setDirsExpanded(paths, open)`：今天只有折叠一个
方向，通用签名的第二个参数会立刻变成一个没人传 `true` 的死参数。

### 5.3 `src/components/layout/FileTree.tsx` —— **未做**（等设计稿）

```tsx
const collapseAll = () => {
  useProjectStore.getState().collapseAllDirs();
  // 折叠把选中的深层行藏了起来，而 `pruneSelection` 只按存在性过滤 —— 见 §2.3。
  // 收敛到顶层行，`anchor` 不动（`rangeBetween` 已为失效锚点降级）。
  const top = new Set(fileTree.map((n) => n.path));
  setSelected((prev) => new Set([...prev].filter((p) => top.has(p))));
};
```

- 工具栏按钮：`disabled={!canCollapse}`，`canCollapse = useMemo(() => hasOpenDir(fileTree, expandedDirs), [fileTree, expandedDirs])`。
- 根右键菜单：在 `buildMenuItems` 的 `if (!node)` 分支里，「在文件浏览器中显示」
  之前插一项，同样带 `disabled: !canCollapse`（`ContextMenuEntry` 已支持 `disabled`）。
- `.toolbarBtn { flex-shrink: 0 }`（§4.2 第 1 条）。

### 5.4 i18n —— **未做**（文案随设计稿一起定）

`src/i18n/locales/{zh-CN,en}.json` 的 `fileTree.collapseAll`。

### 5.5 测试（`src/lib/__tests__/selection.test.ts`，已存在）—— 已实现

要钉住的四条，全是纯函数层：

1. `collapseAllMap` 对**顶层**目录也写出 `false`——这条正是最容易回归的（清空表看起来"更干净"）。
2. `collapseAllMap` 覆盖任意深度，且不给文件写键。
3. 折叠后 `flattenVisible(tree, map)` 只剩顶层行。
4. `hasOpenDir`：刚打开的项目（空表 + 有顶层目录）为 `true`；`collapseAllMap` 之后为 `false`；只有文件的树为 `false`；**折叠着的祖先里那个仍标 `true` 的子目录不算数**（上面那条）。

## 6. 边界情形

| 情形 | 行为 | 说明 |
|---|---|---|
| 折叠后**新建**一个顶层文件夹 | 它是展开的 | `expandedDirs` 里没有它的键 → `depth === 0` 默认展开。接受：新出现的东西展开是合理的（而且新建会走 `creatingIn` 的自动展开）。压住它需要一个粘性标志，见 §3 最后一行 |
| 折叠后点「刷新」 | 已有目录保持折叠 | 键是按路径存的，`refreshFileTree` 不动 `expandedDirs`；只有**新出现**的顶层目录展开，同上一行 |
| 折叠时正拖着一个条目 | 不冲突 | 拖拽的 spring-open（悬停 `SPRING_OPEN_MS` 自动展开，[:484](../../src/components/layout/FileTree.tsx:484)）之后照常生效，只是它展开的那一个又是"作者显式开的" |
| 折叠期间有内联新建输入框（`creatingIn`） | 该文件夹立刻重新展开 | `TreeNode` 的 `useEffect`（[:263](../../src/components/layout/FileTree.tsx:263)）在 `creatingIn === node.path` 时写 `true`。正确：输入框不能被藏起来。按钮禁用态随即变回可用 |
| 当前打开的文档在深层 | 行被藏起，编辑区不受影响 | `activeFilePath` 的选区同步 effect 只在 `activeFilePath` **变化时**跑（[:454](../../src/components/layout/FileTree.tsx:454)），不会因折叠而把选区又拉回来 |
| 切换到「大纲」标签页再切回 | 仍是全折叠 | `expandedDirs` 在 store 不在组件——这正是它当初住进 store 的理由 |
| 关闭项目再打开 | 回到默认（顶层展开） | `openProject` 清空 `expandedDirs`；折叠状态本就不跨会话 |

## 7. 明确不做

- **「全部展开」**——见 §3 第一行。
- **快捷键**——VS Code 是 `⌘K ⌘0` 这类和弦，本应用还没有和弦体系，单键位又容易
  和编辑器抢；要加应当连同一张完整的侧栏快捷键表一起设计。
- **「定位当前文档」**（折叠后展开到活动文件并滚到它）——是个真需求，但那是**另一个**
  按钮；把它塞进折叠按钮里会让折叠自相矛盾（折完又展开一条链）。
- **折叠状态持久化到 `prefs`**——`expandedDirs` 是会话内状态，本需求不改这条契约。
- **知识库墙 / 大纲面板的同款按钮**——它们不是这棵树，各有各的层级模型。
