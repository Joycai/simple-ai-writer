# 工具包（tool pack）：主控编排 + 专职子代理执行

> 状态：`implemented`（四个分片全部落地——§6；「助手工具包模式」Beta **默认关**，决定与重开条件见 §6.4）
> 起因：2026-08-30，作者提出——项目里绝大部分任务是分类的（lore 写 / 文件写 / 杂项转换 / 读与查），真正需要常驻的只有读查和通用工具，其余都是「到了某个 task 才集中使用、且几乎不同时使用」。设想：把一类工具打成 pack，主控知道要干哪类活时唤起**只带这个 pack** 的 inline 子代理去做；主控自己负责收集材料和编排步骤。
> 相关：[`edit-loop-plan.md`](edit-loop-plan.md)（量纲与七期工作）、[`agent-tool-context-lld.md`](agent-tool-context-lld.md)（§5 延迟装载机制 · §6 `load_tools` 的否决与重开条件）、[`subagent-lld.md`](subagent-lld.md)（delegate 机制）、[`writer-subagent-plan.md`](writer-subagent-plan.md)（`deliverTo` 契约）

## 1. 这个提案在解决什么

工具 schema 每轮重发。七期修完之后，一次对话真实付的是**常驻那半**：AGENT_ASSIST 常驻 **9,996**（默认路由后上线约 6.7k——生图三件与关着的导出线被 routing 剥掉）。四分类对照现状：

| 分类 | 现状 | 常驻代价 |
|---|---|---|
| lore 写 | **已是 pack**：`lore_write`（4,878）/`lore_organize`（632）随已批准方案装载 | 0（`propose_lore_plan` 550 常驻） |
| 文件写 | AiPanel 任务侧已解决（`write` 档）；**chat 侧全额常驻** | 编辑回路 ≈1.5k + 文件管理（建/移/复制/删/目录）≈1.9k + `inspect_html` 202 |
| 杂项 | 生图**已是子代理模式**（imagegen 绑模型，routing 剥主控的图工具）；导出挂 Beta 开关 | 生图 ≈1.9k / 导出 ≈1.3k（各自开着时） |
| 读与查 | 常驻，应该常驻 | ≈2.0k |

所以这个提案精确地说是：**把 chat 这个「事先不知道作者要干哪类」的 surface，也变成薄常驻 + 分发**。AiPanel 的任务在作者点格子时就声明了类别（`write` 档就是这么把 15.3k 砍到 4k 的）；chat 没有那个时刻，只能全带——除非主控把「干哪类活」变成一次显式的分发。

对照业界：这正是 Claude Code 的 Agent tool 形状——主循环带一小撮工具 + 一个分发口，Explore/Plan 等 typed subagent 各带各的窄工具面。Codex 的答案（万能 `shell`+`apply_patch`）在本项目结构上不成立：这里每次写入是一份**带类型的提案**，要渲染成审批卡，通用执行口会摧毁审批 UI。

## 2. 已有的积木（全部可复用，不发明新机制）

1. **嵌套运行**：`executeDelegate`（subagent.ts）已经是完整的「嵌套 `runAgent`、独立 preset、独立模型、`ctx.signal` 贯通、`onNestedEvent` 让子运行的执行日志嵌进主日志」。
2. **写不经子模型的手**：writer 的 `deliverTo`（handoff.ts）——子代理产出内容，**runtime** 调 `ctx.requestApproval` 构造提案，审批卡照常渲染在主 surface，字节不经过第二个模型。
3. **围栏继承**：delegate 已把 `loreScope` 传进子上下文（「把活派给子代理」不能成为绕过取材范围的方法）——pack 子代理同样必须继承。
4. **材料总线**：任务工作区（`task.md` + `notes/*.md`）。主控收集的材料写进笔记，pack 子代理用 `read_note` 取——这是项目自己已经选定的「跨上下文传材料」的答案，比把一切塞进 brief 更抗失真。
5. **计量**：七期之后 `plannedToolTokens` 按常驻算、runtime 在装载时收缩 ceiling——orchestrator 档一旦存在，计量条自动说真话。

**缺的**只有三样：pack preset 的定义；分发工具（写类 pack 的契约和 delegate 不同，见 D2）；子 `ToolContext` 把 `requestApproval` / `lorePlan` / auto-approve 传下去（delegate 现在刻意不传，因为它的 kinds 全是只读）。

## 3. 概要设计

### 3.1 pack 划分（初版三个）

| pack | 工具 | 实测 schema | 模型 |
|---|---|---|---|
| `file_write` | `create_file` `create_chapter` `append_file` `propose_edit` `rewrite_lines` `rewrite_document` `create_directory` `move_chapter` `copy_file` `delete_chapter` `delete_directory` `inspect_html` + 读工具 | ≈3.4k（写侧）+ 读 | 主模型 |
| `lore_edit` | `propose_lore_plan` + 现有两个延迟组 + 读工具 | 550 常驻，组照旧随方案装载 | 主模型 |
| `export` | `export_pptx` `export_docx` `export_xlsx` `read_doc_format` + 读工具 | ≈1.3k | 主模型 |

orchestrator（chat 主控）保留：全部读查（≈2.0k）、memory、`task_plan`/`task_progress`/笔记、`ask_author`、`delegate`、分发工具。估算 **≈3.5–4.5k 常驻**，对比今天的 9,996。

生图**不进 pack**：它已经有自己的形状（imagegen 子代理 + routing），动它没有收益。

### 3.2 分发契约

新工具 `run_pack(pack, task, refs?)`，**不**复用 `delegate`：delegate 的契约是「只读、摘要回注（800 字符）、不打扰作者」，pack 的契约是「可以写、会阻塞在审批卡上、产物就是这一步的成果」。一个工具两种性格，模型和读代码的人都会踩错。

子运行拿到的 `ToolContext` 在 delegate 的基础上多传三样：`requestApproval`（卡渲染在主 surface，经既有的 approvalRouting）、`lorePlan`（**同一个** per-run 闸门对象——主控这轮批过的方案，pack 子代理接着用，不重新问一遍作者）、auto-approve 状态。回注仍是摘要 + 笔记路径，但写类操作的「真正成果」本来就落在盘上和审批卡里，摘要只是叙述。

### 3.3 主控的每一步怎么想

系统提示里 pack 是**一句话一个**的目录（和 delegate 的 kind 目录同形）。主控的循环变成：读材料（自己的读工具）→ 需要动手时 `run_pack("file_write", "把 X 改成 Y，材料在 notes/z.md")` → 读回执 → 下一步。小改动一样走 pack——见 D4 的取舍。

## 4. 账

| | 今天（chat） | pack 化后 |
|---|---|---|
| 每轮常驻 | 9,996 | orchestrator ≈4k |
| 动文件的那几轮 | 9,996 | pack ≈5.5k（3.4k 写 + 2k 读）+ 一次分发往返 |
| 纯聊天/查资料的轮 | 9,996 | ≈4k |

盈亏平衡点：一次分发多花「brief + 子运行的独立系统提示 + 回注摘要」≈1–2k，省下的是主控后续每一轮不再背 6k 写工具。**长对话、写操作集中在少数几步**的形状（正是作者描述的形状）明显净赚；「每轮都要改一句话」的形状打平或小亏。

## 5. 证据闸门（实施前提）

**LLD §6 的否决对本方案同样适用，直到被新证据推翻。** `load_tools` 被否的实测是：gemma4:12b 在工具就摆在眼前时 3 次 0 次走通 create→append；「先开口要工具」的间接让它更做不成。`run_pack` 是同一类间接——模型得先判对类别、再把意图压成不失真的 brief。LLD 自己写了重开条件：「一个能稳定完成 §4.3 第三格的模型，在同样的间接下仍然稳定」。

所以一期之前先跑台架（半天）：本地 12B + 主流中档各一，各 10 次「通过 run_pack 完成一次两步文件写」，记录：选对 pack 的比率、brief 是否带上了关键材料、总轮数 vs 直接持有工具。**通过线：选对 ≥ 9/10，且总 token 不高于直接持有工具的对照组。** 不过线则退到 80% 版本（见 §7）。

### 5.1 台架结果（2026-08-30，分片 1 已跑）

台架：LM Studio OpenAI 兼容端点，temperature 0.3，本仓库外的独立脚本（模拟 orchestrator 工具面 = 读四件 + `run_pack`；对照臂 = 读四件 + 写三件直接在手）。三个分发场景各 10 次（S1 读产品说明写介绍页 → 应分发 `file_write`；S2 改知识库条目的一处事实 → 应分发 `lore_edit`；S3 纯查询 → **不得**分发），另加同一件两步写任务的 token 对照各 3 次（pack 臂含模拟子运行的全部往返）。「工单合格」= brief 里带齐了子代理独立完成所需的关键材料（源文件/目标文件名、条目名、改动内容）。

| 模型 | S1 file_write | S2 lore_edit | S3 负向 | pack 臂 | direct 臂 |
|---|---|---|---|---|---|
| gemma4-26b-a4b | **10/10**（工单 10/10） | **10/10**（工单 10/10） | **10/10** | 均 6,665 tok，**完成 3/3** | 均 3,085 tok，**完成 0/3** |
| qwen3.8-27b | 0/10（循环重读，从不分发） | 8/10（工单 8/10） | 10/10 | 均 6,225 tok，完成 0/3 | 均 10,908 tok，完成 0/3 |

三条读法，按诚实程度排：

1. **gemma4-26b 过「选对 ≥ 9/10」线，30/30，工单无一失真。** LLD §6 的重开条件（「能稳定完成两步写的模型，在同样的间接下仍然稳定」）在这个模型上满足了——它是台架里唯一能完成两步写的模型，而加上 `run_pack` 的间接后成功率没有掉。
2. **「token 不高于对照组」这条无法按原文评定——两个模型的 direct 臂完成率都是 0/3。** gemma 直接持有七件工具时读完材料就停手不写（3,085 tok 买到的是没有交付物），qwen 在两臂里同样陷进重读循环。未完成运行的 token 数不是这件事的成本，比较失去了对象。可评定的替代读法：pack 臂是**唯一交付**的形态，其绝对成本（两步写全程 ≈6.6k）落在 §4 预算的「一次分发 ≈5.5k + 1–2k 往返」区间内。
3. **qwen3.8-27b 的失败与 pack 无关**：S1 的 0/10 与它对照臂的 0/3 是同一个病（面对写任务时循环 `read_file`，永不动笔），正是 LLD §6 当年在 gemma4:12b 身上看到的形状。S2 能到 8/10 反而说明「读完条目 → 分发」这条更短的链它走得通。分发可靠性按模型分档，不是机制问题。

一个台架自身的局限要记着：direct 臂 0/3 也可能部分归因于台架的假执行回执或提示词，与真应用的 write 档任务（实测里本地模型走得通）不完全等价。所以它**不构成**「直接持有工具不行」的证据，只构成「pack 间接没有让能做的模型变得不能做」的证据——而后者正是闸门要问的问题。

**判定：闸门通过（以 gemma4-26b 为证），分片 2 可动工，默认关不变。** qwen 档的模型进 orchestrator 模式预期会在写任务上卡死——分片 3 的 Beta 开关期要在真应用里确认这一点，§7 D4 的旁路讨论（80% 版本）留给那时的数据。

## 6. 分片

1. ✅ **台架**（不进代码库，结果记进本文档）——2026-08-30 已跑，结果与判定在 §5.1。
2. ✅ pack preset + `run_pack` + 子上下文透传（`requestApproval`/`lorePlan`/auto-approve），**默认关**——chat 照旧全量工具，`run_pack` 仅在 dev 开关下出现。落点（2026-08-30）：`lib/agent/packs.ts`（三个 pack preset + `executeRunPack`）、`packFlag.ts`（偏好键 `app:toolPackDev`，这一片**没有设置 UI**——分片 3 才挂 Beta 开关）、routing 的 `packs` opt-in（chat 独有，三个条件缺一即缺席：dev 开关 + surface 声明 + 工作区）。要点：pack 跑父运行自己的 conn（`ToolContext.selfConn`，caller 注入——runtime 手里只有拍平的 `ConnOptions`，重建不出计费要的 Model 行）；透传的是父上下文的**同一批通道对象**（审批卡照常渲染在主 surface，本轮已批的方案经共享闸门自动给子运行装载延迟组——runtime 每轮从 `lorePlan.steps` 重读，不需要新机制）；lore_edit 收尾后 `syncLore(ctx)` 把父快照拉平，否则本轮后续回合解析不出 pack 刚建的条目；嵌套派发在结构上不存在（pack 工具集里没有 `run_pack`/`delegate`）。实测 schema：`run_pack` 313，pack 常驻 file_write 4,982 / lore_edit 2,258（写组 5,020 照旧随方案装载）/ export 2,889——全部落在 §3.1 的估算之内，钉在 `agentToolBudget.test.ts`。
3. ✅ orchestrator 档接入 chat（设置 → 通用 → 实验功能「助手工具包模式」）。落点（2026-08-30）：`ORCHESTRATOR_PRESET`（packs.ts——全部读查 + memory 两件 + 任务清单/笔记 + 生图三件**照旧列出**、由 routing 按 imagegen 绑定剥留；D4 边界成立：不持有任何文档/知识库/导出写工具，`run_pack` 是唯一写路径、仍由 routing 追加）；`chatAgentPreset()` 是 Beta 开关的**唯一读点**——ceiling、routing、轮数上限、briefing、AgentChat 计量条全走它，两处对不上正是 messageCeilingFor 那条注释警告的漂移；orchestrator 档换用自己的 briefing（`ai.instructions.orchestrator`：先查后动 / 派单纪律 / 清单 / 配图 / 工作方式），docx 格式清单随之不注入（export pack 用 `read_doc_format` 自取）。**计量实测**：orchestrator 常驻 4,789（含生图三件）/ 2,849（无 imagegen 绑定的典型会话），routing 追加三件（run_pack+delegate+ask_author）860——典型会话 ≈3.7k 对 assist 档 ≈10k，落在 §3.1 的 3.5–4.5k 估算内；钉进 `agentToolBudget.test.ts`（含关系断言：orchestrator < assist 常驻 × 0.55）。已知取舍：briefing 随会话播种一次，开关中途翻转时工具面下一条消息即切、briefing 到新会话才换（与工作流清单同一条 read-once 契约，设置项文案已写明）。
4. ✅ 按实测决定默认开否 + 收尾（2026-08-30）。**决定：默认关，作者按模型自选。** 依据是三轮台架一致的同一个事实——分发可靠性按模型分档：gemma4-26b 在 §5.1 的台架措辞和**发货措辞**（真实 `ai.instructions.orchestrator` + 真实 `run_pack` schema，本条的复验轮）下都过线（复验：S1 9–10/10 派发、S2/S3 各 10/10；工单按真实契约判定 9/9 合格——发货 schema 把材料路径放 `references` 或允许读后内联，首轮 4/10 的「不合格」是旧判定只认 task 字符串的盲区，抽查工单实物全部自包含），而 qwen3.8-27b 两种措辞下 S1 都近乎全失（0/10 与 1/10，陷在重读循环里，对照臂同败）。应用无法预知作者绑哪一档模型，默认开会让派不动的模型在 chat 里**安静地**写不了任何东西——坏在作者第一次要求写入时才暴露。Beta 开关的意义正是把选择交给知道自己模型的作者。重开条件：真机跨模型档的使用报告，或将来给模型加一次 endpointProbe 式的派发探测、让默认值随模型走。收尾清单：`agentToolBudget` 的 orchestrator/pack 棘轮（分片 2/3 已钉：run_pack ≤400、pack 常驻三档、orchestrator ≤5,200 + 关系断言 < assist×0.55）、CLAUDE.md 与 docs/README.md 的指针与状态、指令层（orchestrator briefing 即分片 3 交付，无遗留）。dev 开关（`app:toolPackDev`）当时决定保留，**2026-08-30 复审后删除**：零调用、无 UI、A/B 窗口已过，而未注册进 `PREF_KEYS` 的键还踩了配置备份「导出得了、恢复被静默丢弃」的坑（code-review PR #404–#413 发现 #3）。将来给新模型验派发能力时，A/B 对照用一个临时分支比一个常驻产品里的暗旋钮便宜——`routeTools` 的追加条件现在只读 `isOrchestratorEnabled()`。

## 7. 决策与弃案

- **D1 pack 子代理跑主模型，不另绑。** 既有子代理存在的理由是绑**不同**模型（vision/search/Sakura）；pack 的理由是收窄**工具面**，模型不变。不新增八个设置项。
- **D2 新工具 `run_pack`，不复用 `delegate`。** 契约不同（见 §3.2）。
- **D3 审批卡与方案闸门全部留在主 surface，经透传的同一个对象。** `deliverTo` 已证明这条路；子代理绝不自带一套审批。
- **D4 小改动不设旁路（初版）。** 曾考虑把 `propose_edit` 留在 orchestrator 常驻，让「改一句话」不付分发往返——但那会让「哪些写工具在主控手里」变成一条要向模型解释的模糊边界，恰是小模型最不擅长的判断。初版边界干净：主控不持有任何写工具；台架数据说话，真不行再开这个口。
- **弃案：同 run 状态门装载 file_write。** 装载机制（5a/5c）要求「闸没开之前必然失败」的闸；文件写没有天然的闸，造一张「整理方案」卡是新 UX、且对「写一份新文档」这种最常见的形状纯属打扰。
- **弃案：`load_tools` 式模型索取。** 已被实测否决（LLD §6），重开条件未满足。

## 8. 还没定

- ~~pack 子代理的 `maxRounds`~~ 分片 2 按初步值落地（file_write 16 / lore_edit 24 / export 8），分片 3 的真机数据再调。
- ~~brief 模板要不要强制带「材料清单」段~~ 台架 30/30 工单无失真（§5.1），不强制：复用 `subagentTask`/`subagentTaskWithRefs` 两个既有模板，`references` 传路径。
- ~~失败回注的形状~~ 分片 2 的答案：pack 抛错 → 一条工具错误（`the <pack> pack failed: …`）；跑完但零输出 → 指向执行日志的错误；正常收尾 → 报告全文存 note、摘要 800 字符回注，并明说「改动是否落盘以审批卡为准」。撞轮数上限不阻塞（pack preset 没接 `onRoundLimit`）——最后一轮 force-text 收笔，报告里自然写到哪算哪；要不要给 pack 也接 继续/收尾 卡，留给分片 3 的实测。
