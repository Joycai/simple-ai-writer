# `@` 引用选择器 · 作用域档位与排序 —— 任务书、设计稿回执与实装记录

> 状态：`shipped` · 2026-09-26 起草，同日设计稿回（`02i @引用作用域 Mention Scope.dc.html`），同日落地。

## 起因

作者原话：「工程目录里文件和条目太多，用 @ 引用时找不到我想要的条目。通过名称准确搜索可以解决，但很不方便。希望在 @ 时能限定是知识库条目还是文件，缩小范围。」

调研（2026-09-26）发现「找不到」其实是四件事叠在一起，`components/common/MentionPicker.tsx` 旧的 `filterMentions`：

| 现象 | 原因 |
|---|---|
| 不打字时只见条目 | 候选 = 条目 + 文件，条目在前；空查询 `slice(0, 10)` |
| 打了字还是一堆 | 只做 `includes`，无排序，仍取前 10 |
| 记得别名 / 分组也没用 | 只匹配名字；条目别名、文档所在分组都不参与（⌘K 两者都参与） |
| 想只看文件也做不到 | `AgentChat` / `RoleplayChat` 各有一份 `PickKind` + `matchesKind`，但自 02g 合并「+ 引用」以来 `openMentionFor` 只以 `null` 调用——过滤路径是死的 |

02g 的说明里写过「@ 选择器里本来就分组，没有信息丢失」；实现里从来只是右端一枚徽标。这一稿是把那句话兑现。

## 决定（设计稿 02i · 1z 决策注记）

1. **作用域是一行 chip，不是前缀。** 全部 / 条目 / 文档，候选里有图才多一档「图片」。语法照 ⌘K 的档位组（`design-system.md` → 全局搜索），同一条既有规矩「作用域是 chip，不是前缀」：⌘K 画过 `/` `#` 前缀，落地时删了——作用域藏在首字符里，输入一长就滚出视野，而且 `@` 自己已经是个前缀。
2. **不恢复三个「+」。** 02g 屏 1c 否掉它们的理由是「过滤该住在选择器里」，现在过滤真的住进去了，「+ 引用」不动。
3. **Tab 改义。** 选择器里 Tab 从前等于 Enter（选中当前项）。改为 Tab / Shift+Tab 切档、只有 Enter 选中，与 ⌘K 一致。这是键位上唯一的改义（行为上还多了几处：空档吞 Enter、空列表上 ↑↓ / Tab 被接管、运行中 Esc 先关选择器再谈停运行、弹窗与扮演里 Shift+Enter 不再选中——都在决定 6 与实装记录里）。↑↓ / Esc 不动；IME 组字期间 Tab / Enter / ↑↓ 不接管，Esc 照旧关选择器。
4. **每次打开回到「全部」，不跨次记忆。** ⌘K 记上次的档，因为它一次只开一回、chip 常在视野里；`@` 一句话里要开几十次，粘住的窄档是静默陷阱——作者要附图时会以为图不见了。同一次里改 query 不重置；「同一次」以 `@` 的位置为准——提名开着时另起一个 `@`（`@潮@`，或点到正文里另一个 `@` 后面打字）也是新开（第三轮 review：第一版只看开没开，新 `@` 会把旧档位带过去）。
5. **空查询按类交错，不按类分段。** 只有十行，分三段每段三行等于没分；交错让作者一眼看到两类都在，想只看一类就 Tab。打了字之后按分数排，交错退场。
6. **空档留下来。** 0 命中从前 = 选择器消失、键盘分支随之放手，作者不知道自己在哪一档、Tab 也失效。现在 chip 行常在，下面一行 mono 事实报别处的数（「条目里没有「夜航」· 文档里有 1 篇 · Tab 切过去」）；全为 0 写「没有匹配」。Enter 在空档吞掉——既不选中也不发送——**但只在别的档有命中时**：哪个档都没有命中，这个 `@` 多半只是个 `@`（「发给@某人」），Enter 照常发送，和选择器学会留下来之前一样。
7. **录音 / 视频归「文档」档。** 档位说的是「文件 vs 条目」；图片单列只因为它在列表里长得不一样、且能否出现取决于模型看不看得见图。徽标照旧写 音频 / 视频。
8. **排序复用 ⌘K。** `matchText`：子串 > 词首 > 子序列；权重 名字 ×1 / 别名 ×0.9（`searchLore`）/ 分组路径 ×0.6 / 整条相对路径 ×0.5（后两档都是 `searchFiles` 的）。库层照 ⌘K 逐词、每个词可落在不同字段（测试保留，为的是和 ⌘K 一致），**但宿主永远只送一个词**：空格结束提名（`findMention`），`@潮汐门篇 归途` 敲下空格那一刻选择器就关了——第二轮 review 才发现文档把库层的多词例子当成了可达功能。作者能打出来的「同时用分组和名字定位」是一个词跨过 `/`：`@潮汐门篇/第五` 走整条路径那一档；`@潮汐门篇/归途` 也找得到——带 `/` 的词还按最后一个 `/` 拆开，左半严格对分组、右半像任何查询一样对名字（含子序列），记得分组和标题里随便一个词就够，不必是标题开头（第三轮 review 指出只认路径子串时这一句搜不到，与 ⌘K 不一致）。两条路都把区间拆回名字与副行两处高亮。分组路径与整条路径**只认子串和词首、不认子序列**：目录上的子序列是噪音，而这里的命中有牙——Enter 会把作者的字替换成 `@[名字]` 并附上文件，`问下@小李` 按 Enter 不该落到 `正文/小镇/李家.md`；名字与别名保留子序列（`@chth` 找 `Chapter Three.md`，同 `searchLore`）。每个词取最优字段，不照 `searchLore` 名字优先短路——短路会让名字上的弱子序列压过别名上的整词。靠别名命中的条目，副行显示那个别名并高亮——否则名字上没有任何高亮，作者会当它是错的答案。
9. **没动的**：`@[名字]` 落字、材料行芯片、附件构造、候选集合（哪些文件 / 图进候选仍由宿主按模型能力决定）、扮演的「已常驻」、选择器的位置（对话 / 扮演在输入框上方，知识库弹窗在下方）。零新存储、零新偏好。

### 被否的方案

| 方案 | 为什么不 |
|---|---|
| 前缀 `@/` `@#` | ⌘K 走过一遍被删；两套作用域语法比一套差 |
| 恢复三个 `+` 按钮 | 02g 已否：三个入口换来的只是过滤，而过滤该在选择器里 |
| 只改排序不加档 | 排序解决「打了字找不到」，解决不了「我就想浏览一下有哪些文档」 |
| 分组标题 | 十行分三段等于没分；chip 把十行整个交给一类 |
| 记忆上次的档 | 见决定 4 |
| chip 放在材料行 | 材料行是「这条消息带什么」，chip 是「现在在挑什么」，混进去正是 02g 消灭的混排 |

## 实装记录（2026-09-26）

分支 `feat/mention-scope`，三片：

- **纯逻辑** `lib/search/mentionSearch.ts`：`scopeOf` · `availableScopes`（chip 行的**唯一**来源，三个宿主都只调它）· `cycleScope` · `mentionSub`（文档的分组路径副行，根目录为空）· `searchMentions(items, query, scope, projectPath, limit)` → `{ items, hits }`（`hits` 按下标给名字 / 副行的高亮区间和命中的别名）· `countByScope`。结构化的 `MentionLike` 而不是组件的 `MentionItem`：`lib` 不 import `components`（`layering.test.ts`）。`mergeRanges` 从 `globalSearch` 导出供合并跨词区间。
- **选择器** `components/common/MentionPicker.tsx`：`useMentionState` 增 `scope` / `setScope` / `cycleScope`；状态收成一个对象，`sync` 是纯函数 `syncMention(prev, value, caret)` 在函数式 `setState` 里跑——从提交过的状态出发分辨「新开还是继续」：新开回「全部」**与第 0 行**（第一版只重置档位不重置高亮，Tab 到条目、↓↓、打「，」再退格，高亮会落在全部档另一项上），继续保留档位、改 query 回第 0 行；`close` 用 `useCallback` 稳住，点外关闭的监听不再随对话助手每次流式刷新重挂。空档那一行是独立的 `EmptyLine` 组件（测试不用绕 portal）；英文下 chip 是首字母大写的复数（Entries / Documents），句子里是小写复数——`appTerms` 的单数「entry」放进「3 in entry」读不通；从空档按 Tab 跳过同样空的档，「Tab 切过去」才是一下。`accept` 的落字位置来自一个**只在打开时更新**的 ref，关掉不抹——选文件是先读完文件再落字，读的这段里提名可能已被关掉（打了「，」、Esc、点到外面、切了会话），第二轮把位置搬进状态对象后关掉即清零，`@[名字]` 落到草稿开头还吃掉首字（第三轮 review 抓到）；落字本身是纯函数 `spliceMention`，`start` 处已不是 `@query`（读文件期间作者改过那段字）就不动正文，附件照常。chip 行固定在顶上、行列表在它下面单独滚动（第一版把 chip 行 sticky 在滚动区里，`scrollIntoView({block:"nearest"})` 不认 sticky 头，↑↓ 绕回第 0 行时它藏在 chip 下面）；空档渲染 chip 行 + 一行事实；名字与副行按区间高亮，用的是和 ⌘K 同一个 `common/Highlighted`（`--color-mention-bg` 底 + `--color-sienna` 字；第一版各抄一份，两份的色 token 已经不一样了，review 时合并）。chip 走 `onMouseDown` + `preventDefault`，和行项一样不让 textarea 失焦。同文件还出两样给宿主共用：`useMentionSearch(candidates, mention, projectPath)` 跑作用域 / 打分 / 计数（选择器不在屏上时不算——候选每次条目写入、文件树刷新都在变，为没人看的列表重打分是纯浪费），`mentionKeyDown(e, mention, search, composing, onPick)` 是键盘协议的**唯一**一份，返回「这一键是不是选择器的」。
- **三个宿主** `AgentChat` / `RoleplayChat` / `lore/ai/AttachmentTextarea`：删私有 `PickKind` / `matchesKind`；各调一次 `useMentionSearch` 与 `mentionKeyDown`，只在「选中之后做什么」上不同。协议本身：Esc 在 IME 组字期间也关选择器（从前如此，否则对话助手运行中的 Esc 会去停运行），其余键组字期间不接管；Tab → `cycleScope`；Enter 在空档只在别处有命中时吞掉（`hasHits`）。门是 `search.open` = `mention.open && candidates.length > 0`：空档也开着（chip 行留着，作者才能 Tab 出去），但**一个候选都没有**（新项目、或只有图而模型看不见图）时没什么可分档——选择器不出来、键照旧放过，和它学会留在空档之前一样；第一版在这种项目里打一个 `@` 会弹出只有一枚「全部」chip 的空框，吃 Tab 和方向键直到终止符。组字判断三处都走 `useImeGuard().isComposing(e)`：扮演面板原来拿它自己那个裸 `composing` 状态当门，那个只为镜像层服务，Windows 上 `compositionend` 先于同一下 Enter 的 keydown 到，它已经翻回 false（`lib/ime.ts`），提交拼音的那一下 Enter 会选中一行或把话发出去。`AttachmentTextarea.module.css` 里抽出 `MentionPicker` 之前留下的死 `.picker*` 规则一并清掉。
- **文案** `ai.mention.scopeAll` / `scopeImage` / `tabHint` / `switchOver` / `emptyIn` / `emptyScope` / `emptyAll` / `countLore` / `countText` / `countImage`；「条目」「文档」两个词走 `appTerms`，不进 locale。

**验证**：`lib/search/__tests__/mentionSearch.test.ts` 钉住别名命中、路径命中且排在名字命中后、一个词跨 `/` 走整条路径档且高亮拆回两行、`分组/标题中间一个词` 按最后一个 `/` 拆开也能命中而左半不认子序列、分组与路径不认子序列（`小李` 不落 `小镇/李家.md`）、库层多词跨字段（⌘K 一致性）、取最优字段、空查询交错、作用域硬过滤、media 归文档、计数、limit、`cycleScope` 环绕与空档跳过空档。选择器在 vite 预览里用假候选独立渲染核过四态：全部档交错列表（含「已常驻」与已附带的暗行）、文档档 + 命中高亮（名字与副行）、条目档空档的事实行、纸面浅色（第一版还核过「跨字段查询 `潮汐门篇 归途`」，那是绕过 `findMention` 直接喂 query 的结果，宿主打不出来——见决定 8）。状态迁移与键盘协议抽成纯函数之后有了单测（`lib/agent/__tests__/chatMentions.test.ts` → `syncMention`：新开回全部与第 0 行、继续保留档位、改 query 回第 0 行、关掉再重开也回第 0 行、开着时另起一个 `@` 算新开；`spliceMention`：原位落字、`@query` 已不在原位则不动；`mentionKeyDown`：不在屏上不接管、Esc 组字期间也关、组字期间其余键放过、Tab / Shift+Tab 切档、空列表上 Tab 带计数跳过空档、Enter 选中高亮行、越界退回第 0 行、Shift+Enter 放过、空档 Enter 只在别处有命中时吞掉、没算计数时放行；`EmptyLine` 与 `Highlighted` 用 `renderToString` 核输出（三种情形、哨兵拆分、只点在册的档、英文复数）；`useMentionSearch` 同法：零候选不开、关着不算、开着给可用档与计数）。宿主里从 keydown 到这两个函数的那几行，以及真实输入法下的时序，仍只有代码路径与手动核——预览里对话助手要有模型、扮演与弹窗要有项目。

### 未做、可做

- `searchLore` 仍是名字优先短路（决定 8 的差异只改在 `mentionSearch`），⌘K 那边同样的例子会排低——不在本任务范围。
- 空查询时条目不再天然靠前，扮演面板里作者多半 `@` 条目：打一个字或一个 Tab 就到了，先不为扮演单独设默认档。
