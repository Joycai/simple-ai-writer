# Agent 工具描述的上下文开销：现状测量与优化建议

> 状态：**审阅报告 / 提案**，尚未实施。故意不写进 `CLAUDE.md` 的索引——那份文件每次会话
> 都进上下文，一份还没定的提案不值得占那个位置。落地后再挂上去。

## 1. 先量，再说

用 `getToolDefinitions()` 拿到真正上线的 wire schema，按 `JSON.stringify` 长度统计
（`estimateToolsTokens` 用的就是这个口径：英文 ≈ 4 字符/token）：

| 预设 | 工具数 | schema 字符 | ≈ token |
| --- | --- | --- | --- |
| `AGENT_ASSIST_PRESET`（全量） | 39 | 38,331 | **~10,600** |
| 同上，默认路由后（imagegen/pptx 关、vision 关） | 36 | 33,904 | ~8,500 |
| 再加 `delegate`（开了子代理） | 37 | 35,050 | ~8,800 |
| `CONTINUE_PRESET` | 8 | 6,256 | ~1,700 |

其中 description 占 19,184 字符、parameters 占 15,776 字符——**参数 schema 和描述几乎一样贵**，
只盯着描述做减法会漏掉一半。

单个最大的十个（字符数 / 其中 description）：

```
1861 / 629  update_facet_meta      1470 / 667  propose_edit
1714 / 979  rewrite_lines          1394 / 503  propose_lore_plan
1677 /1222  export_pptx            1334 / 851  create_file
1584 / 618  generate_image         1271 / 610  update_lore_meta
1478 /1000  rewrite_document       1269 / 735  append_file
```

**但工具 schema 不是这笔开销的全部。** `ai.instructions.agent`（对话助手/Agent 模式的任务层
指令）是 3,418 个中文字符 ≈ **3,000–3,400 token**，而它的内容是**把每一个工具又用中文讲了一遍**：
「update_lore_meta 改条目的 summary/别名」「rewrite_document 一次携带整份文件，只适合短文件」
——这些话在 wire schema 里已经有了英文版本。

所以对话助手每一个请求的固定头部约为：

```
工具 schema  ~8,500
任务层 briefing ~3,400   ← 与 schema 语义重复的部分占大头
系统提示      ~400
────────────────────
             ~12,300 token / 每轮
```

`AGENT_ASSIST_PRESET.maxRounds = 40`，且 `runtime.ts:308` 只在开跑时算一次
`toolDefinitions`、之后**每一轮原样重发**。一次跑满 20 轮的整理任务，光这段不变的头部就重复
计费 ~246k input token。

## 2. 顺带查出来的两个真问题

这两条不是"优化建议"，是当前实现里工具 schema 没被算进去造成的偏差：

### 2.1 预算规划和裁剪都不知道工具 schema 存在

- `lib/context/budget.ts` 的 `fixedContextChars()` 只累加 system/task/selection/outline/
  knowledge/prevTail，**没有工具 schema 这一项**；`inputCeilingTokens` 因此按"没有工具"来分配
  lore/记忆/正文窗口。
- `runtime.ts` 的 `trimHistory(history, inputCeilingTokens)` 同样只量 messages。裁到"刚好等于
  ceiling"时，真正发出去的请求是 `ceiling + 8,500`。

后果：在窗口小的模型上（本地 32k 的 gemma4/qwen3.6 正是这个项目支持的场景），
`ceiling = 32k × 0.8 = 25.6k`，实际请求 34k，**超出窗口**——而 `streamCompletion` 的
pre-flight 闸门比的是 `contextSize` 而不是 ceiling，所以它只在彻底溢出时才拦，落在
"吃掉输出预留 → 回复被截断"这个区间里的情况完全没人管。

**修法**：给 `fixedContextChars` 加一个 `toolSchemaChars` 项，给 `trimHistory` /
`planFold` 传 `ceilingTokens - toolTokens`。改动很小，但它是下面所有"省 token"措施能被正确
兑现的前提——不然省下来的额度没人认领。

### 2.2 上下文条与压缩触发用的是两个口径

`contextBreakdown.ts` 明确把 `toolTokens` 算进 `system` 段（注释里写了"the assistant preset
carries 21 of them"——现在是 39 个，注释已过时），但 `compact.ts:239` 的触发判断
`estimateMessagesTokens(history) <= ceilingTokens * COMPACT_TRIGGER` 不含工具。于是条子已经
越过 70% 的刻度线并变黄，压缩却不会启动。两边应该统一到"含工具"的口径。

## 3. 优化建议（按性价比排序）

### A. 打开 Anthropic 族的显式 prompt caching —— 收益最大、代价最小

**现状**：全仓库搜不到一处 `cache_control`。而 `docs/api/landscape.md` 自己就写着
「④ 族的 prompt caching 是显式的，别族是自动的」——①③ 族官方端点会自动缓存足够长的前缀（OpenAI ≥1024 token、Gemini 隐式缓存），
第三方中转则未必；而 **④ 族不打断点就一定不缓存**，于是 Anthropic 官方和 MiniMax-M3 的 ④ 族端点
每一轮都在按全价重付这 12k。

更巧的是**读的那一半已经写好了**：`anthropic.ts:410` 的 `readUsage` 已经在解析
`cache_read_input_tokens` / `cache_creation_input_tokens` 并折进 `cachedTokens`，
`token_usage` 表也有 `cached_tokens` 列。缺的只有写的那一半。

**做法**：在 `streamAnthropic` 组 body 的地方（`anthropic.ts:517` 附近），给 `tools[]`
最后一项加 `cache_control: { type: "ephemeral" }`，再给 `system` 加一个断点。

**代价**：一次改动 ~10 行；缓存写入按 1.25 倍计费、TTL 5 分钟——agent 循环的相邻两轮间隔
是秒级，必然命中。已知风险两条，都可控：
- 第三方 ④ 族端点未必认这个字段。MiniMax 的文档明确写了 `system` 接受带 `cache_control`
  的数组（landscape.md §"扩展"），但 `tools[]` 上没写；保守做法是先只在 system 上打断点，
  或按 `standard` 分方言开关——这个项目已经有 `dialectFor` 这套方言机制可以挂。
- `finishPolicy: "force-text"` 的最后一轮会撤掉 tools，那一轮必然 miss。一次而已，不影响。

**收益**：④ 族上重复头部的输入成本降到约 1/10，且首 token 延迟明显下降。**注意它省的是钱和
延迟，不省上下文占用**——窗口小的模型该挤还是得挤，那是 B/D 的事。

### B. 砍掉 briefing 与 schema 的重复 —— 直接减少占用，代价中等

`ai.instructions.agent` 里逐个工具复述用法的段落，和 wire description 是同一份信息的两个语言
版本。行业惯例是**决策性信息放 tool description**（它就贴在调用点上，模型选工具时一定看得到），
**流程与策略放 system**。按这条线切：

- **留在 briefing 里**：`propose_lore_plan` 的强制流程（先只读→一次性提方案→批准后严格执行）、
  「绝不为了小改动整篇重发」这条优先级、「大文件必须分段写」的理由、被拒绝后怎么办。
  这些是跨工具的策略，任何单个 schema 都表达不了。
- **删掉、交还给 schema**：每个工具做什么、参数怎么填、A 和 B 该用哪个——`rewrite_lines`
  和 `rewrite_document` 的 description 里已经把这个取舍讲得比 briefing 更细了。

**预期**：briefing 从 ~3,400 token 降到 ~1,200–1,500，**每轮省 ~2,000 token**（对话助手场景
下这是纯占用节省，所有厂商都吃得到）。

**代价与风险**：这是**唯一一条会改变模型行为**的建议，必须实测。中文 briefing 对小模型的
指令跟随效果好于英文 schema，砍之前建议在本地 ollama（`:11434` 上有 gemma4/qwen3.6）跑一组
对照：同一个"整理知识库"任务各跑 4 次，看是否还老老实实先 `propose_lore_plan`、是否还会
为了改一个别名而 `update_lore_file` 整篇重发。**保守做法**：先只删「查阅」「配图」「调整文档
结构」三段（纯复述，无策略），保留「修改{{kb}}」和「大文件必须分段写」两段。

### C. 把工具 token 并入预算与压缩阈值

见 §2。属于修正而不是优化，但排在结构性改动之前——否则 D 省下来的额度不会变成任何人能用的
空间。代价：小。

### D. 分层装载工具（deferred / lazy tool loading）—— 收益最大的结构性改动

**行业对标**：Anthropic 的 Tool Search Tool（工具声明上打 `defer_loading`，模型先检索再装载，
官方给的数字是 token 占用降约 85%）、MCP 的 progressive disclosure、以及 Claude Code 自己的
路线（少量通用工具 + 子代理承担专门工具）。

**关键限制**：Anthropic 的服务端 tool search 只在 Anthropic API 上有；这个应用要跑
OpenAI-compatible / Gemini / 各种中转，**必须自己在客户端实现等价物**。好在客户端版本更简单——
你本来就掌握着 tools 数组。

**这个仓库的现成切入点**：`routeTools()`（`agent/routing.ts`）已经在做"按条件删工具"了
（vision 开就删 read_image、imagegen 关就删画图工具、pptx Beta 关就删 export_pptx），
而且它的注释已经把理由写对了：**关掉 = 不存在，而不是调用后报错**。分层装载就是把这套机制
从"开关驱动"扩展到"进度驱动"。

最自然的第一刀，因为它的门本来就存在：**知识库写工具已经被 `propose_lore_plan` 在执行侧拦住了**
（`plan.ts`：方案外的实体/动作一律拒绝）。既然没批准方案之前它们一个都不能用，那就**没批准
之前根本不必发**：

| 分组 | 工具 | 字符 | 装载时机 |
| --- | --- | --- | --- |
| 常驻核心 | 只读 7 + propose_edit / rewrite_lines / append_file / create_file / propose_lore_plan / scratchpad 5 | 15,163 | 始终 |
| `lore_write` | create/update/append/edit/delete_lore_file、update_lore_meta、update_facet_meta、move/delete_lore_entity | 10,160 | **方案批准后** |
| `file_ops` | create_chapter/create_directory/move_chapter/copy_file/delete_chapter/delete_directory | 4,979 | 模型显式索取 |
| `whole_file` | rewrite_document | 1,478 | 模型显式索取 |

常驻 15.2k 字符（~3.8k token）vs 现在的 33.9k（~8.5k token）——**默认场景省掉约 55%**。

**实现**：`runtime.ts:308` 那行 `const toolDefinitions = getToolDefinitions(preset.tools)` 移进
循环，改成读一个随运行推进的 `activeTools` 集合；registry 每个工具加一个 `group?: ToolGroup`
字段；再加一个 `load_tools({ groups })` 元工具，description 里带一份**分组目录**（每组一行
不超过 15 词，总共 ~300 字符）。批准 lore 方案时由 `plan.ts` 侧自动装载 `lore_write`——那一组
不需要模型自己去要。

**代价**：中等。要动 runtime 的循环、registry 的元数据、以及 `AgentChat.tsx` 里那个用
`routePlannedTools` 估算的上下文条（它得改成估"常驻集"）。还有两个必须一起处理的点：
- **`executeRegisteredTool` 的 `allowed` 列表**必须跟着 `activeTools` 走，否则要么装载了却
  不让调，要么没装载也能调（后者更糟：等于工具门形同虚设）。
- **和缓存的相互作用**：中途加工具会让 prefix 变化，A 的缓存断点被打断。把断点打在**常驻核心
  的最后一项**上，装载进来的分组排在它后面作为未缓存的尾巴——这样常驻部分始终命中。

**建议**：先做 `lore_write` 一组验证机制（它的门已经存在，风险最低），跑通了再推广。

### E. 描述与参数的字面压缩 —— 收益有限，别高估

我统计了完全重复的句子（≥20 字符、出现 ≥2 次）：

```
10x  "One-line justification shown to the user on the review card"
 8x  "Entity name exactly as returned by list_lore_entities"
 5x  "Absolute path of the document, as returned by list_files"
 5x  "NOTHING is written until the user approves the card;"
 5x  "the call blocks until they decide."
```

**去掉冗余副本一共只省 1,790 字符（~450 token）**。把「批准前不写入」这句提炼进 briefing 一次
是对的（顺手做），但**不要指望字面去重解决问题**——真正贵的是 `rewrite_lines`、`export_pptx`
这类描述里的**决策性长文**，而那些恰恰是最不该删的：`rewrite_lines` 那 979 个字符里讲的
"长文件用它、rewrite_document 会被输出上限截断、批准后行号会移动"，每一条都是踩过的坑
（见 `docs/feature/pptx-plan.md` §4 里的同类记录）。删掉省 200 token，换回来一次截断重跑就亏了。

**唯一值得做的字面工作**：参数层的 `description` 可以更狠地砍。`update_facet_meta` 的
parameters 有 1,142 字符，比它的 description 还长——枚举值的解释（`mode` auto/always/manual）
在 description 里已经讲过一遍了。

### F. 合并 CRUD 家族 —— 不建议现在做

把 `delete_chapter` + `delete_directory` 合成 `delete_path(kind)`、四个 lore 写工具合成
`lore_file(action)`，每合并一次省掉一份 name/reason/path 样板（~200–400 字符）。但：

- 收益 ≈ 1,500 字符（~375 token），比 D 小一个数量级；
- 有实证代价：带 `action` 枚举的重载工具在选择准确率上通常不如一组语义清晰的独立工具，
  而这里每一个错选都直通一张写盘审批卡；
- `plan.ts` 按 `LORE_PLAN_ACTIONS` 授权、审批卡按 proposal kind 路由，合并会让"方案只授权
  这一个文件"这条不变量更难检查。

D 做完之后这些工具本来就不常驻了，合并的动机基本消失。

### G. 明确不要做的

- **把 description 翻成中文**。中文在真实分词器下约 0.6–1.5 token/字，英文 JSON 约
  4 字符/token——英文 schema 在 token 上是更省的那一边。§1 里 3,418 字的中文 briefing 抵得上
  13k 字符的英文，正是这个道理。
- **仅仅为了省 token 把工具搬进子代理**。`subagent.ts` 的分工理由是"辅助工作别污染主上下文"，
  不是"schema 太大"。为省 token 造一个子代理，换来的是一整条委派链路和一次额外的模型往返。

## 4. 建议顺序

| # | 动作 | 代价 | 每轮省占用 | 省成本 |
| --- | --- | --- | --- | --- |
| 1 | C：工具 token 计入 `fixedContextChars` / `trimHistory` / `planFold` | 小 | — | —（修正） |
| 2 | A：④ 族 `cache_control` 断点 | 小 | — | ④ 族重复头部 ≈ -90% |
| 3 | E 的参数层压缩 + 样板句提炼 | 小 | ~600 token | 同比例 |
| 4 | B：briefing 去重（先删三段，本地实测） | 中 | ~2,000 token | 同比例 |
| 5 | D：分层装载，先 `lore_write` 一组 | 中偏大 | ~2,500 token | 同比例 |

1–3 合计一天以内，且互不冲突；4 需要一组对照实测；5 建议单独一个 PR，并把 §3.D 里
"`allowed` 必须跟着 `activeTools` 走"写成回归测试。

## 5. 可观测性（做任何一条之前）

`round-start` 事件目前只报 `estInputTokens`（仅 messages）。加一个 `toolTokens` 字段，让执行
日志和 Settings→用量能直接看到这笔开销随轮次的累积——否则上面每一条的收益都只能靠估。
