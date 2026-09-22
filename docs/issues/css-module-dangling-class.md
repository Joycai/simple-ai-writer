# `styles.foo` 指向不存在的类 —— 元素一点样式都没有，三道门禁全绿

> **状态：已修复（2026-09-22）+ 已上门禁。** 本文记录的是第二个**全应用范围**的
> 静默 CSS 缺陷（第一个是 [`css-modules-global-keyframes.md`](css-modules-global-keyframes.md)）：
> `import styles from "./X.module.css"` 得到的是一张普通对象映射，取不存在的键
> 返回 `undefined`，而 `className={`${styles.a} ${styles.b}`}` 会把它拼成**字面量
> 字符串 `"undefined"`** 当类名用。元素因此一点样式都没有。
>
> `pnpm exec tsc --noEmit`、`pnpm test`、`pnpm build` 三道门禁一声不吭：映射的类型
> 是 `Record<string, string>`，字符串拼接合法，产物里多一个匹配不到任何规则的类名
> 也不是错误。**唯一的证据是肉眼，而肉眼看的是「这里本来长什么样」——没人记得。**
>
> 发现于计费组那期：`FeeGroupDrawer.tsx` 引用了 `ProvidersModels.module.css` 里
> 并不存在的 `.input` / `.unset`，整个抽屉的输入框退回浏览器原生样式。

## 全库扫描的结果（2026-09-22）

十一处 className（十个类名），分在七个文件里。逐个查下来，**没有一处是「样式漏写了」**——每个元素需要
的排版，早就由它的父级或兄弟规则给全了；类名只是写下来当结构注释，规则一天也没
存在过。所以九处一律删类名（元素本身都还留着，它们各自还有分组、keyed、flex item
的职责），另外两处属于别的分支：

| 位置 | 判定 | 元素的样式其实从哪来 |
| --- | --- | --- |
| `AgentLog.tsx` `styles.detailBlock` | 死代码 | 纯包壳。子元素在默认块流里就叠得对——实测 label 与 `<pre>` 之间 0px、两块之间 6px（`.detail` 的 `gap`），分组读起来是对的 |
| `LoreRunProgress.tsx` `styles.stepBlock` | 死代码 | 同上。连接线靠 `margin-left: 8px` 对准 16px 标记的中线，壳上不需要任何规则 |
| `TurnTrace.tsx` `styles.resident` / `.hits` / `.refs` | 死代码 | `position: relative` 与 `padding-left` 来自 `.body section` 这条**元素选择器**（四条装订线是绝对定位，靠的就是它）。同为 `section` 的 `.area` 与 `.drops` 才有各自要覆盖的东西，这三段没有 |
| `FileTree.tsx` `styles.creating` | 死代码 | 设计稿 17 给内联新建的只有「26px 行 + 赭石 1px 边框」；图标该是什么样由 `.filled` 和图标组件本身决定，没有第三件事要说 |
| `AppearanceThemes.tsx` `s.cardMd` | 死代码 | 排版主题卡窄一档，已经由容器上的 `.gridMd` 和样张上的 `.slotMd` 做掉了，卡片这一层没有剩下的差别 |
| `DocFormatDrawer.tsx` `styles.onBlockExText`（两处） | 死代码 | mono 字体、字号、颜色全从 `.onBlockExample` 继承，这两个 `<span>` 只需要是 flex item |
| `FeeGroupDrawer.tsx` `hub.input` / `hub.unset` | **真缺陷**（唯一一处） | 无 —— 抽屉里全部输入框退回浏览器原生样式。见下一节 |

九处的观感用 Vite dev server 逐个核过：动态 `import()` 真实的 `.module.css` 拿哈希
类名 → 按组件真实的 DOM 结构挂一份 → 量几何、截图对照（`css-modules-global-keyframes.md`
记的同一手法）。删类名对渲染是**可证明的无操作**——`"undefined"` 本来就匹配不到规则。

## 门禁：`src/lib/__tests__/cssModuleClassRefs.test.ts`

### 为什么朴素的文本扫描不能用

一开始的判断是「这条守卫做不出来」，理由成立：在源码层面判断 `x.foo` 里的 `x`
是不是 CSS Module 的导入名不可靠，本仓库两类误报都真实存在——

1. **字符串里的同形文本。** `ProvidersModelsPane.tsx` 里 `t("aiConfig.hub.unknownProvider")`
   长得就是 `hub.unknownProvider`，而 `hub` 确实是 `ProvidersModels.module.css` 的
   导入名。这一类在该文件里有 30 多处。
2. **被局部绑定遮住的同名标识符。** 同一个文件里 `r` 既是 `Routes.module.css` 的
   导入名，又是 `rows.filter((r) => r.visible)` 的形参，那里的 `r.top` / `r.visible`
   跟 CSS 毫无关系。

实测：一份朴素的正则扫描在修复前报出 **75 行**，其中真缺陷 11 行，误报 64 行。
**会误报的守卫比没有守卫更糟**——它会被很快地加进忽略列表，然后一起烂掉。

### 让它变成零误报的两件事

**一、扫 AST，不扫文本。** `vite` 导出 `parseAst`（rolldown 里的 oxc，认 TS 与
JSX，同步、全库 865 个 .ts/.tsx 不到 1 秒）。第 1 类误报**天然消失**：字符串字面量的
内容不是 `MemberExpression`，走不到检查点。TypeScript 自己的 compiler API 在这里
用不上——本仓库是 `typescript@7`（Go 版），`ts.createSourceFile` 一类已经不再导出，
`import ts from "typescript"` 只拿得到 `{ version, versionMajorMinor }`。

**二、对第 2 类，用一条保守到可以证明的规矩弃检。** 一个导入名，只有当它在整个
文件里**除了 import 那一次之外，每一次出现都是 `名字.属性` 或 `名字["属性"]`**
时才检查。局部重新绑定同一个名字（形参、`const`、解构、函数名……）必然在某处留下
一个不是属性访问的裸标识符，于是整个名字直接弃检。这不是启发式：凡绑定必有声明位
，凡声明位必是裸标识符。

判据只往**漏报**一侧倒，另有两处同理：模板串下标（`styles[`marker_${state}`]`，全库
21 处）拿不到静态名字，跳过；CSS 侧的类名用正则收，`:global(.foo)` 里的名字其实不
在导出映射里，这里当它存在。都是「放过去」，不会冤枉谁。

### 代价与现值

全库 **172 个** CSS Module 导入名（144 个文件）里，弃检的只有 **1 个**——就是上面那个 `r`。
第二条断言把这张弃检名单**钉死成精确相等**，因为它不是不变量，是覆盖率的账：涨了
要有人看见。新增一行之前先想想能不能把导入改个不重名的名字，那比弃检划算。

`PENDING` 那张表装的是「还没修的」，不是豁免清单。它开张时装着 `FeeGroupDrawer`
那两行，两天后随那处修复清空，**此后一直是空的**。

### 为什么不是别的做法

- **给每份 `.module.css` 生成 `.d.ts`**（`typed-css-modules` 一类）本来最正统：
  作用域解析交给编译器，零误报是构造出来的，还白送编辑器补全。没选它是因为要往仓
  库里放 **109 个**生成文件，外加一个生成步骤和一条「生成物没跟上」的门禁（仿
  `gen-agents-md.ts` + `agentsMdSync.test.ts`）——而生成物一旦过期就是**误报**，
  正好是这条守卫最要避免的失败模式。收益（补全）与这次要解决的问题也不是一回事。
- **构建期插件**能拿到 CSS Modules 转换后的真实导出映射（比正则准），但它拿不到
  「这个成员访问指向哪个导入」——作用域那一半问题原样还在，而它只在 `vite build`
  时跑，`pnpm test` 看不见。

## 那一处真缺陷：`FeeGroupDrawer` 的 `.input` / `.unset`（2026-09-22 修）

九处死类名之外，只有这一处元素**本该有样式而没有**：抽屉里每一个输入框——组名、
三个单价、档位表里的五个格、输入图的两格——都没有边框、没有底色、没有内边距，
是浏览器原生控件贴在深色抽屉上。

**它不是「漏写了 CSS」，是「写错了模块」。** `NumInput` 的 className 一眼就能看出
出处：

```
`${hub.input} ${s.cell} ${hub.mono} ${unset ? hub.unset : ""} …`
```

它是 `ModelDrawer.tsx` 那个 `inputCls` 的复制件——

```ts
const inputCls = (unset: boolean, extra = "") => `${s.input} ${unset ? s.unset : ""} ${extra}`;
```

——而 `ModelDrawer` 的 `s` 是它自己的 `ModelDrawer.module.css`（`.input` 与 `.unset`
都定义在那里），复制过来时前缀跟着抄成了 `hub`，指向 `ProvidersModels.module.css`。
那个模块只有 `.mono`（所以 `hub.mono` 一直是好的，四个类里唯一没坏的那个），
`.input` / `.unset` 从来不在里面。

**该有的样子是有据可查的，不用猜。** 三处各自独立地写着同一条规则：
`design-system.md` 的 **Dashed = nothing sent**（「an empty input (`.unset`)」）、
`FeeGroups.module.css` 自己的头注第 1 条（「实心 ＝ 配了价，虚线 ＝ 什么也不收……
空着的输入框……」）、以及 `FeeGroupDrawer.tsx` 里 `numField` 上那句「空着的格画虚线：
它说的是「没填」，而填了 0 的格是实线——0 是一个决定」。

**修法：把这一对定义在 `FeeGroups.module.css`，调用点改 `s.input` / `s.unset`。**
不借 `settingsCommon.module.css` 的 `.input`（它在那儿，而且长得一样），理由是
**抢同一个 `border-color` 的三条规则必须待在同一个文件里**：

| 规则 | 特异性 | 靠什么赢 |
| --- | --- | --- |
| `.input` 起底 `1px solid var(--color-border)` | `0,1,0` | — |
| `.unset` 改 `dashed` + `--stg-border-menu` | `0,1,0` | 源码顺序（在 `.input` 后） |
| `.badPrice` 改 `--color-accent` | `0,1,0` | 源码顺序（**必须在 `.unset` 后**） |
| `.rateGrid .cell` 收紧 padding / 字号 | `0,2,0` | 特异性，与顺序无关 |

前三条特异性相同，胜负只由源码顺序决定，而**跨文件的顺序是打包器按模块图排的、
不由调用方做主**——这正是 `docs/feature/file-panel-redesign-brief.md` 记过的那个坑
（「容器查询不改变特异性……由源码顺序决定胜负」）。`ModelDrawer` 明明也 import 了
`settingsCommon`，却仍旧自备一份 `.input`，是同一个理由。

**为什么 `.badPrice` 必须排在 `.unset` 后面**：`badRate` 判的是 `num(price) <= 0`，
空串正好落进去，所以档位表里没填价的那一格**两个类同时在身上**。作者要先看见
「这是错的」（赭石），虚线只负责说「这格是空的」。

**实测（Vite dev server，两套主题）**：组名 `1px solid rgb(46,40,32)`（`--color-border`）；
空着的单价格 `1px dashed rgb(74,66,56)`（`--stg-border-menu`）；档位表里没填价的那格
`1px dashed rgb(217,146,91)`——虚线来自 `.unset`、赭石来自 `.badPrice`，两条都生效且
各归其位；档位格 `6px/8px · 12px` 来自 `.rateGrid .cell`，格外的输入图两格 `8px/12px · 13px`
来自 `.input`。把这两个类名换回 `undefined` 就能看见修复前的样子：一排亮灰圆角的
浏览器原生控件。
