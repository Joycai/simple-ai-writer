# 目录说明文件（`index.md`）：读、写、入口

> **状态：`implemented`。** 2026-09-22 与本文档同一个 PR 落地。
> 上游调研是 [`okf-folder-metadata-research.md`](okf-folder-metadata-research.md)；
> 本文档只做它 §5「工作区目录说明文件」与 §6.2「分类说明」两项，§6.1 的条目 `status`
> 与 §6.3 的信任盖章不在这里。
>
> 一句话：**任何目录可以放一份 `index.md`，告诉助手这个目录装什么、该不该参考。**
> 没有它一切照旧；有它，助手在自己扫描（`list_files` / `search_text`）和被告知
> 「当前文件在哪」时会读到它。助手能替作者写这份文件；作者在文件树上右键一个目录
> 就能新建它并交给助手填。

---

## 1. 三条诉求，三块落点

| 诉求 | 落点 | 章节 |
|---|---|---|
| ② `index.md` 可有可无；有则助手扫描时读 | 三个只读处：`listWritingFiles`、`searchWritingFiles` 的文件收集、`documentBrief` 的当前文件简报 | §3 |
| ① 助手能扫描目录并创建/更新 `index.md`；知识库分类同理 | 工作区：现成的 `create_file` / `rewrite_document`，不加工具。知识库分类：`manage_category` 多一个 `describe` 操作 | §4 |
| ③ 右键目录 → 新建 `index.md` → 交给助手填 | 文件树目录菜单一项；知识库墙分类菜单一项 | §5 |

## 2. 文件格式

```markdown
---
status: deprecated
---
第一版旧稿。人物设定以 v2 为准，只在需要查早期伏笔时翻。

* [第一章.md](第一章.md) - 开场，v2 已重写
* [人物草案/](人物草案/) - 早期人设，已并入知识库
```

- **文件名固定 `index.md`**，与 OKF 同名，与知识库条目的主条目同名——调研 §3.4 的结论
  是不改条目那一侧，这里跟着用同一个词，作者只需要记一个名字。
- **`status`** 是 frontmatter 里唯一被机器读的键，三值 `draft | stable | deprecated`，
  缺席即 `stable`（写入按缺席规则，和条目的 `dict` / `cover` 一致）。未知值当 `stable`：
  消费方容忍未知，是 OKF 的要求，也是这里的。
- **摘要**是正文第一个非空、非标题、非列表的段落，工具结果只带这一段（上限见
  `FOLDER_NOTE_SUMMARY_MAX`）。没有摘要就退到 frontmatter 的 `description`，再没有就
  只报状态。
- **清单**可选，格式借 OKF 的 `* [标题](相对路径) - 说明`，助手照着写；但**应用不解析
  清单**——它是给读者看的。目录很深时，逐层的说明加上 `list_files` 的 `folder` 参数已
  经覆盖定位，调研 §6.4 不做手工维护的全局索引，理由同。
- **对 OKF 的一处有意偏离**：OKF 只在 bundle 根的 `index.md` 允许 frontmatter，这里
  任意目录都可以带 `status:`。OKF 消费方必须容忍未知键，不算破坏。

「参考度」不做数字（调研 §5.3）：细微差别写进摘要正文，机器只读三值。

## 3. 读侧：两条不变量

从取材范围围栏原样搬来（[`lore-collection-plan.md`](lore-collection-plan.md) §3）：

1. **围栏只挡自动发现，不挡显式指定。** `list_files` / `search_text` 是自动发现，
   `deprecated` 子树不展开、不搜；`read_file` 给路径、`@` 引用、`list_files` /
   `search_text` **直接以那个目录为 `folder` 参数**，都是显式指定，一律穿过。
2. **被挡掉的要报数。** 一份安静缩短过的清单读起来就是「项目只有这些」。

| 落点 | 做什么 | 为什么在这里 |
|---|---|---|
| `listWritingFiles` | 目录行下第一行挂 `(index.md: 摘要)`；`draft` 标一个词；`deprecated` 目录只留目录行与那一句，不列文件、不进子目录，并在句尾报「N 个文件未列出，read_file 给路径照样能读」。N **不算** `index.md` 自己（它被读了、引了）；只剩说明的目录报「nothing else here」；模型点名 `folder` 而完整列出时只留 `(index.md: deprecated — 摘要)`，不再劝它「传 folder」 | 规则在生效那一刻到达（`lineEcho.ts` 的先例），不进 schema、不吃每轮常驻的工具预算；工具结果不能劝模型做它刚做完的事（`tool-presence.md`） |
| `searchWritingFiles` | 收集文件时跳过 `deprecated` 子树，结尾报「另有 N 个文件在 M 个标为 deprecated 的目录里未搜」 | 实际收益最大的一处：三版废稿会吃掉一半的 40 条命中 |
| `documentBrief` | 【当前文件】块多一行：最近一层祖先的说明摘要；祖先链上任何一层 `deprecated` 时再多一句「这个文件在标为不再参考的目录里」。打开的就是某个 `index.md` 时从上一层起算，不把它引给它自己——它自己的 `status` 就在模型能读到的正文里，简报不复述 | 作者正在编辑「废稿/第三章.md」时助手应该知道这是废稿 |
| `isChapterFile` | `index.md` 不是章节 | 否则它成了书脊上的「第零章」，进续写上下文 |
| `search_text` 的可搜文件 | `index.md` **仍可搜** | 作者在说明里写的话（「人设以 v2 为准」）正是 search_text 该找到的 |
| `rowMeta.ts` | 第八种行 `note`：`index.md` 一枚说明图标，右列一个「说明」；分组行右列的篇数**不计**它 | 作者在树上要一眼认出它不是一章；一行标着「说明」却被数成一篇，两列自相矛盾 |
| 文库（`outline.ts` 的 `resources`） | `index.md` 列在卷的**资源**里，不列在章节里 | 从章节里摘掉是书脊的事（下）；从资源里也摘掉，一卷只剩说明时文库会把它当空卷给「删除」，说明跟着没了 |
| `links.ts` 的反向链接 | 说明文件**算**链接来源 | 它的清单按名字指向目录里的文件，「index.md 链接到它」正是删除卡上该说的话 |

书脊（`outline.ts` 的卷/章）**不读** `status`——调研 §7 的未决问题。理由：书脊是作者显式
排的顺序，续写是作者对着某一章的显式动作，两者都不是自动发现；把一卷从书脊上摘掉，
作者会先在文件树上找它为什么没了。一致性检查同理，它检查的是作者选定的章节。

`@` 引用的候选（`projectFilesFromTree`）不过滤 `deprecated`：`@` 是显式指定。

## 4. 写侧

### 4.1 工作区目录：不加工具

`create_file` 已能新建任意扩展名的文件，`rewrite_document` / `propose_edit` 已能改它，
都走批准卡。`create_chapter` 会拒绝 `index.md`（它不是章节文件），拒绝语已经指向
`create_file`，不必再教。

助手怎么知道要读它：`list_files` 的 description 多一句（「目录自己的 index.md 是作者
的目录说明，摘要挂在目录行下；标 deprecated 的目录不展开」），`agentToolBudget.test.ts`
的棘轮抬一次，数字与理由在测试里。没有进 `ai.instructions.agent`：那是每轮都发的
固定头，而这条规则只在真列目录时才有意义。

### 4.2 知识库分类：`manage_category` 的 `describe`

`.ai-writer/lore/<分类>/index.md`，同一套格式，只读摘要，**不读 `status`**——
`selectLore` 的不变量是「除特征 frontmatter 外什么都不读」（`lore-entry-type-plan.md`），
分类级的 deprecated 要生效就得进条目索引，那是调研 §6.1 条目 `status` 的活，不在这一步。
`title` 也押后：它要给孤儿分类当标签，得让 `scanLore` 把它带进 `IndexedCategory`，
而 description 只在一个消费点生效，先做便宜的那一半。

消费点只有一个：`formatLoreIndex` 的分类头后面（`[characters(人物)] — 摘要`），只在模型
真调 `list_lore_entities` 时读盘、只在那时计费。**不进** `create_lore_entity` 的分类枚举
说明——那是每轮都发的 schema。

写入走 `manage_category(op="describe", category, description)`：
- 任何有文件夹的分类都能写，**包括包声明的和孤儿**——说明住在文件夹里，不是声明的一部分，
  这和 rename / delete 只许作者自建分类的规矩不冲突。这也是孤儿分类第一次有了「这一类
  装什么」的落处（`lore-entry-type-plan.md` §5 说目录名是唯一诚实的答案——现在多一句）。
- 过方案门：`update` 动作、target `category`。`planLoadsOrganize` 因此把 `category/update`
  也算作装载 `lore_organize` 组的形状——不加这一条，方案批准了工具却不到场，正是
  `tool-presence.md` 记的那种「还没装」被说成「不存在」。
- 写整份文件，不做局部编辑：一份说明就一段话加一张清单，整篇重发不亏。

### 4.3 助手扫描时怎么做

不写新的工作流卡，用 §5 的入口把提示词直接发进对话：列目录（`folder` 参数）、抽读几份、
整篇重写 `index.md`。放在提示词里而不是系统提示，因为这是一次性任务，不该每轮出现。

## 5. 入口

界面稿与逐屏决定在 [`../file-tree-folder-note-brief.md`](../file-tree-folder-note-brief.md)（设计稿 TURN 2「目录说明」）；
本节只记与实现直接相关的。

### 5.1 文件树：右键目录

目录菜单「造」的那一格多一项，跟在「导入文件」后面：

- 目录里没有 `index.md`：**新建目录说明并交给助手**——写入模板（一行标题 + 一段
  HTML 注释说怎么填）、刷新树、在编辑器打开它、打开助手抽屉、把填写提示词作为一条消息
  发出去。
- 已经有：**让助手更新目录说明**——同一条提示词，不动文件。提示词末句「现有说明里仍然
  正确的话保留」正是「更新」的意义，新建时它无害。
- 说明行自己的右键也有「让助手更新目录说明」（作者盯着的就是这一行）；项目根的空白处
  右键同样能给根目录一份说明（根也是一个分组）。
- 发送之前**等编辑器真的载入了这份 `index.md`**（`openDocument.whenFocusSettles`，最多五秒，
  超时报「编辑器尚未载入」而不发；作者中途关掉、删掉或打开了别的，或这份文件载入失败，
  立刻放弃而不是等满五秒）。`setActiveFilePath` 是同步的，编辑器的载入是提交后的
  effect，中间发出的那一轮取到的「当前文件」是点击前打开的那一章——提示词里的「整篇重写」
  会把那一章的正文注入，让助手对着错的文件重写。对话输入框没有 `settled` 门（作者在那里
  打字时本来就看着编辑器），所以这一步只能由这个入口自己等。

自动发送而不是只填进输入框：菜单项的名字就是「交给助手」，作者点它就是在下这条指令；
填进输入框再让作者按一次回车，是把一次点击拆成两次。发送后是一次正常的对话轮，
写入照旧走 `rewrite_document` 的批准卡——**作者仍然要在卡上点一次**，所以没有绕过
「作者点头之前什么都不付」。

### 5.2 知识库墙：右键分类

分类头的菜单多一项**让助手写分类说明**，对包声明的、作者自建的、孤儿三种分类都在
（rename / delete 那两项的禁用规则不适用，见 §4.2）。提示词让助手先读这一类的条目，再
以 `describe` 提一份只有一步的方案。

## 6. 决策记录

| 决策 | 取 | 理由 |
|---|---|---|
| 文件名 | `index.md` | 与 OKF、与条目主条目同名；作者记一个词 |
| 作者面前的叫法 | 目录说明 / 分类说明 | `terminology.md` 的词表新增一行；不叫「索引」——清单是可选的，说明才是必有的 |
| 参考度 | 三值 `status`，不做数字 | 目录级没有驱动数字的机制，模型拿到 0.6 只能猜（调研 §5.3） |
| `deprecated` 在书脊 | 不读 | 书脊与续写都是显式动作，不是自动发现 |
| 解析器 | 不升级 | 只用扁平键；嵌套 YAML 的需求（`sources` / `verified`）押后到条目 `status` 之后 |
| 分类的 `status` / `title` | 不做 | `selectLore` 不变量；`title` 要进扫描结果，先做只有一个消费点的 description |
| 提示词入口 | 自动发送 | 菜单项本身就是指令；写入仍过卡 |
| `search_text` 搜不搜 `index.md` | 搜 | 说明里的话正是该被找到的 |
| `describe` 写盘前校验 | 说明必须有一段正文，否则拒写 | 清单只引首段正文；全是标题和列表的说明会写进去然后永远不显示，拒在模型还能改的时候（`tool-presence.md`：结果不承诺做不到的事）；分类还没有条目时结果句也说明「有条目后才显示」 |

## 7. 测试与守卫

- `lib/fs/__tests__/folderNote.test.ts`：解析（缺席即 stable、未知值容忍、摘要取法、
  `description` 兜底）、模板。
- `agentReadTools.test.ts`：`list_files` 挂摘要、`deprecated` 不展开且报数、`folder`
  直指 `deprecated` 目录时全列；`search_text` 跳过并报数、`folder` 直指时照搜。
- `outline.test.ts`：`index.md` 不是章节。`rowMeta.test.ts`：第八种行。
- `docFocus.test.ts`：简报里的说明行与 deprecated 句。
- `agentReadTools.test.ts`：`formatLoreIndex` 带分类说明。`agentOrganizeTools.test.ts`：
  `describe` 过门、写盘、拒绝没有文件夹的分类。`plan` 测试：`category/update` 装
  `lore_organize`。
- `agentToolBudget.test.ts`：两处 description 的增量记在棘轮里。

## 8. 押后与不做

任务书里标为「提案」、这一轮没做的：

- **分类头下显示说明摘要**（任务书 2e-2）：界面上分类说明目前只能靠助手读到；采纳时
  在墙筛到某分类时读一次 `lore/<id>/index.md`，缓存到 `describe` 写盘。
- **说明行固定排在分组之首**（`commands.rs` 的比较器）与**消息时间行的来源后缀**：
  各要动 Rust 排序和消息 meta，等有第二个用例再动。

- **分类说明不进知识库同步与打包**：`lorehash.rs` 的哈希与 `transfer.ts` 的打包都只走
  「分类目录 → 条目目录」，分类目录下的 `index.md` 不被哈希、不被推送、导入时丢弃。
  要带上它得给分类一级定义身份与哈希（服务器存的是条目身份），等分类 `status` / `title`
  一起做；在那之前分类说明是本机的。
- `log.md`、数字参考度、改条目主条目命名、手工全局索引——调研 §6.4。
- 应用不解析说明里的清单，也不替作者更新它：文件管理器移动文件后清单会失真，那是
  「让助手更新目录说明」这一项存在的理由。
- 不在系统提示里讲 `index.md`：规则随工具结果到达。
