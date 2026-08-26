# 020 — 集合/装订子系统补齐悬停过渡

- **Status**: TODO
- **Commit**: 93eb7de
- **Severity**: MEDIUM
- **Category**: 内聚与令牌
- **Estimated scope**: 2 个 CSS 文件，~12 处 +1 行

## Problem

集合/装订（设计稿屏 24–31）是本仓库最新落地的一整套 UI，它**完全没有接上全库的
过渡约定**：

```
$ grep -c "transition:" src/components/lore/collections/collections.module.css
0        # 文件 724 行，17 处 :hover / Active / On 状态
$ grep -c "transition:" src/components/lore/collections/manage.module.css
0
```

全应用其余每一处行悬停、按钮悬停、选中态都走 `var(--transition-fast)`
（120ms），唯独这两个文件里每一次悬停、每一次选中都是**硬切**。同一个知识库
页面上，分类栏的行会淡入底色，紧挨着的集合装订栏的行则瞬间跳变——不是风格
差异，是漏接。

现状清单（全部已逐行核对）：

```css
/* src/components/lore/collections/collections.module.css */
.bandReset:hover { color: var(--color-accent); }                     /* :63  */
.scopeButtonActive { border: 1px solid …; background: …; }           /* :77  */
.row:hover { background: var(--lore-sub-bg); }                       /* :144 */
.rowActive { background: var(--color-bg-base); …}                    /* :145 */
.railRow:hover { background: var(--lore-sub-bg); }                   /* :274 */
.railRowOn { border-left-color: var(--color-accent); background: …; }/* :276 */
.edgeHost:hover .edgeCheck { opacity: 1; }                           /* :418 */
.flip:hover { border-color: var(--color-border-accent); }            /* :441 */
.assignRow:hover { background: var(--lore-sub-bg); }                 /* :515 */
.dotOn { background: …; border-color: …; }                           /* :155 */
.checkOn { background: …; border-color: …; }                         /* :530 */

/* src/components/lore/collections/manage.module.css */
.row:hover { background: var(--lore-sub-bg); }                       /* :43  */
.rowEditing { border-top-color: …; border-bottom-color: …; }         /* :44  */
.rowAction:hover:not(:disabled) { color: var(--color-accent); }      /* :63  */
.rowDanger:hover:not(:disabled) { color: var(--color-error); }       /* :64  */
```

## Target

在**基态选择器**上逐属性列出过渡（不是在 `:hover` 上，也**永远不用 `all`**）。
全部用 `var(--transition-fast)`。

三条各自的判断，执行时按这个来，不要自己发挥：

1. **`.railRowOn` 的 `padding-left` 不进过渡**，并且**它本身就该删掉**。
   > ⚠ **本条最初的理由是错的，已于 2026-08-26 实测更正。** 原文写的是
   > 「3 + 15 = 18，内容位置完全不变」——只算对了 ON 那一半。基态
   > `.railRow` 是 `padding: 9px 18px` **加** `border-left: 3px solid transparent`，
   > 那 3px 已经被透明边占住了，所以未筛选时内容左沿是 3+18 = **21px**；
   > `.railRowOn` 再补 `padding-left: 15px` 是**重复补偿**，把内容拉到
   > 3+15 = 18px。实测（CDP 量 `.railRowName` 的 `getBoundingClientRect().left`）：
   >
   > ```
   > 未筛选 21px   筛选中 18px   → 行内文字每次筛选都横跳 3px
   > ```
   >
   > 这是改动前就存在的，本方案没有引入它；但加了颜色过渡之后反而更显眼——
   > 颜色 120ms 渐变，文字瞬间位移。**修法是删掉 `.railRowOn` 的
   > `padding-left: 15px`**（透明边已经占好位），修完实测 21 → 21，零位移。
   > 过渡仍然只走 `border-left-color` 和 `background`：padding 是布局属性，
   > 不进过渡这条结论不变，变的只是它背后的理由。
2. **`.scopeButton` 的 `border-style` 不可插值。** 虚线（「全部」）→ 实线（生效）
   是硬切，CSS 做不到别的。过渡 `border-color` 和 `background`，接受线型那一跳。
   **不要**为了让它能过渡而把虚线改成别的画法——虚线是设计稿定的语义
   （「没立起来的围栏」）。
3. **`.row` / `.rowActive` 的边框不进过渡。** `.row`（collections）基态没有
   border，`.rowActive` 加 `border-top/bottom: 1px solid` —— 这会改变行高。
   只过渡 `background`。（`manage.module.css` 的 `.row` 不同：它基态就有
   `1px solid transparent`，只变颜色、不变布局，所以那边**可以**过渡
   `border-color`。）

```css
/* collections.module.css — 目标 */
.bandReset { …; transition: color var(--transition-fast); }
.scopeButton { …; transition: border-color var(--transition-fast), background var(--transition-fast); }
.scopeButtonLabel { …; transition: color var(--transition-fast); }
.scopeButtonCaret { …; transition: color var(--transition-fast); }
.row { …; transition: background var(--transition-fast); }
.railRow { …; transition: background var(--transition-fast), border-left-color var(--transition-fast); }
.edgeCheck { …; transition: opacity var(--transition-fast); }
.flip { …; transition: border-color var(--transition-fast); }
.assignRow { …; transition: background var(--transition-fast); }
.dot { …; transition: background var(--transition-fast), border-color var(--transition-fast); }
.check { …; transition: background var(--transition-fast), border-color var(--transition-fast); }
```

```css
/* manage.module.css — 目标 */
.row { …; transition: background var(--transition-fast), border-color var(--transition-fast); }
.rowAction { …; transition: color var(--transition-fast); }
```

## Repo conventions to follow

- 令牌：`src/styles/tokens.css:52` — `--transition-fast: 120ms var(--ease-out);`。
  **不要**手写 `120ms` 或 `cubic-bezier(...)`（tokens.css 首行：All UI reads from
  these vars, never raw values）。
- 正确写法的样板：`src/components/lore/LoreDetail.module.css:996`（方案 005 修好
  的那一行——逐属性列出、全走令牌），以及
  `src/components/settings/settingsUi.module.css:143-144`。
- 过渡写在**基态**类上，这样进入和离开悬停对称。全库无一例外。

## Steps

1. `src/components/lore/collections/collections.module.css`，按 Target 给这 11 个
   **基态**选择器各追加一行 `transition:`（追加到该规则块已有声明之后，不动其他
   声明）：`.bandReset`(:56) · `.scopeButton`(:66) · `.scopeButtonLabel`(:81) ·
   `.scopeButtonCaret`(:89) · `.row`(:133) · `.railRow`(:262) ·
   `.edgeCheck`(:405) · `.flip`(:430) · `.assignRow`(:504) ·
   `.dot`(:154) · `.check`(:520)。
   > 行号是 93eb7de 的近似锚点，**以选择器名为准**——这个文件里选择器名唯一。
2. `src/components/lore/collections/manage.module.css`：`.row`(:35) 与
   `.rowAction`(:53) 各追加一行。`.rowDanger` 只是 `.rowAction` 的颜色变体、
   共用同一个基态，**不要**给它单独加。
3. 自查：新加的每一行都在**基态**块里、都用 `var(--transition-fast)`、都逐属性
   列出、没有一处 `all`、没有一处 `padding` / `border-width` / `width` / `height`。

## Boundaries

- **只加 `transition:` 声明。** 不改任何颜色、边框、间距、字号的值。
- 不动 `.railRowWrap:hover .railSetScope { display: block; }`（:310）——`display`
  不可过渡，要让它淡入得改结构（换成 `opacity` + `visibility` 或高度动画），
  **那不在本方案范围内**，也不确定是否该做（悬停才出现的「设为取材范围」刻意
  「不该随手可点」，见该处注释）。原样留着。
- 不动 `.scopeButton` 的 `border-style`，
  不给 collections 的 `.rowActive` 边框加过渡——三条理由见 Target。
- 不加入场动画、不加关键帧、不碰 `global.css`。
- 不引入新令牌。
- 若某个选择器与摘录不符（相对 93eb7de 有漂移），停下报告该处，其余照常。

## Verification

- **机械**：`pnpm tsc --noEmit` 与 `pnpm build` 通过（CSS 改动不会被 tsc 抓到，
  build 是为了确认 LightningCSS 能解析）。
  `grep -c "transition: all" src/components/lore/collections/*.css` → 两个都是 0。
- **感觉核验**：起 `pnpm dev`，打开知识库墙：
  - 装订栏（右侧 rail）里上下移动鼠标：底色应当**淡入淡出**，不再是跳变；
    筛选中的那一行（`.railRowOn`）左侧赭石边应当渐显，**而行内文字一像素都不许
    动**——若文字有横向抖动，说明误加了 `padding` 过渡，回到 Target 第 1 条。
  - 悬停一张卡片的装订边：勾选框（`.edgeCheck`）应当在 120ms 内淡入，而不是
    瞬间出现。
  - 切换取材范围：按钮底色与文字颜色渐变，**线型（虚线→实线）会硬切，这是预期**。
  - 在 DevTools → Animations 面板把播放速度调到 10%，重复上面几步，确认每条过渡
    都是 120ms 且曲线一致（不该有任何一处比别处慢或快）。
  - 打开 Rendering → Emulate `prefers-reduced-motion: reduce`，重复一遍：所有过渡
    应当变成即时（由 `global.css:122-129` 的全局兜底接管），**颜色与底色的最终态
    必须仍然正确**——若某个悬停态在减动效下彻底不显示了，说明改错了地方。
- **Done when**：上述两个文件里每一处悬停/选中都有 120ms 过渡；文字无位移；
  `transition: all` 零处；减动效下终态正确。
