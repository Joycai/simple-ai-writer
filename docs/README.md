# Docs

Two axes, encoded differently on purpose.

**Type is the folder.** A doc's kind does not change, so it is safe to put in the path:

| Folder | What lives here |
|---|---|
| [`reference/`](reference/) | Living truth about today's system. Read the relevant one **before** working in that area. |
| [`api/`](api/) | The LLM wire-protocol domain — protocol facts that would hold in any project, plus this project's provider decisions. |
| [`feature/`](feature/) | Per-subsystem dossiers: the design record for one part of the app, whatever stage it is at. |
| [`issues/`](issues/) | Open, unverified, or known-broken. Something here is a claim we have **not** confirmed. |
| `legacy/` | Superseded docs that no longer describe the system. Created when the first one earns it — an outdated file is worse than a missing one. |

**Status is a field, not a folder.** Status changes; paths cited from ~90 source comments should not. Each doc states its own status in the blockquote under its title, and the tables below are the scannable roll-up. A plan landing is a one-line edit here, not a move.

| Token | Means |
|---|---|
| `living` | Kept current. If it disagrees with the code, the doc is the bug. |
| `shipped` | Built. Kept as the design record — the "why not the other way" that is not in the code. |
| `partial` | Some phases built, some deliberately not. The doc says which. |
| `planned` | Decided, not built. |
| `proposal` | Not decided. Deliberately not linked from `CLAUDE.md`. |
| `research` | An investigation, not a commitment. |
| `unverified` | Modifier: built, but never confirmed against a real endpoint or a real machine. |

---

## reference/ — read before working

| Doc | Status | Read when |
|---|---|---|
| [codemap.md](reference/codemap.md) | `living` | Changing **any** directory: one section per `src/components/*`, `src/lib/*` and `server/` — module split, invariants, why-not-the-other-way, and each subsystem's design-doc pointer. Moved out of `CLAUDE.md` on 2026-09-07 (it had grown to 73KB); `CLAUDE.md` keeps one line per directory plus the hard rules |
| [architecture.md](reference/architecture.md) | `living` | Touching any subsystem: DB schema, RAG, SSE, key storage, export, IPC, CodeMirror |
| [design-system.md](reference/design-system.md) | `living` | Building or restyling **any** UI |
| [workflows.md](reference/workflows.md) | `living` | Adding an AI task type, a provider, a language, a capability pack |
| [terminology.md](reference/terminology.md) | `living` (词表) · `planned` (校准批次) | Writing **any** user-facing string, or wondering which of 条目/词条/设定 to use. Also holds the six-batch plan for the 78 一词多译 / 49 一译多词 found in the 2026-08 sweep |
| [tool-presence.md](reference/tool-presence.md) | `living` | 改 preset、往 `routeTools` 加分支、加一种子代理，或写任何工具的 description / 结果文本。一次运行说的话必须和它能做的事一致——三种失败形状、判据取哪个变量、九条先例 |
| [ci.md](reference/ci.md) | `living` | Changing the build, or wondering what the merge gate runs |
| [macos-signing.md](reference/macos-signing.md) | `planned` | Cutting a macOS release, or the Keychain starts asking for the login password again |

## api/ — the wire-protocol domain

Facts first, then our choices. [`README.md`](api/README.md) is the entry point.

| Doc | Status | What it settles |
|---|---|---|
| [README.md](api/README.md) · [landscape.md](api/landscape.md) | `living` | The four protocol families, deployment variants, the "OpenAI-compatible" gaps |
| [streaming.md](api/streaming.md) · [reasoning.md](api/reasoning.md) · [tools.md](api/tools.md) · [structured.md](api/structured.md) · [usage.md](api/usage.md) | `living` | Per-topic protocol facts |
| [provider-layering.md](api/provider-layering.md) | `living` | **Which layer a new field belongs to.** The arbitration rule for adding a provider, family, or capability |
| [provider-standards.md](api/provider-standards.md) | `shipped` | 3 protocols × official/compat (PR #119–#122) |
| [anthropic-plan.md](api/anthropic-plan.md) | `shipped` `unverified` | The Anthropic family, incl. MiniMax-M3's dialect (§10). §7 needs live requests |
| [gemini-plan.md](api/gemini-plan.md) | `shipped` `unverified` | The Gemini family. §5 needs live requests |
| [reasoning-plan.md](api/reasoning-plan.md) | `partial` | Reasoning effort + chain-of-thought. OpenAI family done; Gemini/Anthropic mapping and the display UI are not |
| [structured-output-plan.md](api/structured-output-plan.md) | `shipped` `unverified` | Per-model 结构化输出 declaration (自动 / 关闭 / JSON 模式 / JSON Schema). §1 audits what the lore features used before (`json_object` + forced tools, never `json_schema`); §5 the auto tier (family default → id table → learn from the 400, remembered per endpoint+model for the session). All three slices built — the model-drawer row, the lore-entity schema, skipping the forced-tool attempt where the downgrade is predictable and strict schema is available, and Gemini's `responseJsonSchema`; the five live checks in §11 are not run |

## feature/ — per-subsystem dossiers

### feature/agent/ — the unified runtime

| Doc | Status | What it settles |
|---|---|---|
| [unified-agent-plan.md](feature/agent/unified-agent-plan.md) | `shipped` | One tool loop under every AI feature; the two-stage evolution to a chat assistant |
| [subagent-plan.md](feature/agent/subagent-plan.md) | `shipped` | High-level design. Kept for the feasibility reasoning; the LLD supersedes its detail |
| [subagent-lld.md](feature/agent/subagent-lld.md) | `shipped` | Task workspaces + per-kind subagents (PR-A…PR-E) |
| [chat-memory-plan.md](feature/agent/chat-memory-plan.md) | `shipped` | Layered chat memory: stable prefix → summary → verbatim turns → per-turn injection |
| [agent-tool-context.md](feature/agent/agent-tool-context.md) | `proposal` | Measurement of what tool schemas + briefing actually cost per round |
| [agent-tool-context-lld.md](feature/agent/agent-tool-context-lld.md) | `planned` | The PR-by-PR execution plan for the above |
| [measurements/briefing-ab-2026-08.md](feature/agent/measurements/briefing-ab-2026-08.md) | `research` | briefing A/B on gemma4:12b-mlx, 2026-08-21 |
| [measurements/read-cost-2026-09.md](feature/agent/measurements/read-cost-2026-09.md) | `research` | search_text 与分页读的代价，2026-09-07：搜索 304 文件 / 2.32MB 只要 17ms（`fs_grep` 不写，押错的先验记在文里），分页读今天便宜但**是二次的**（200KB→10MB、1MB→256MB），拐点是「工作区出现 ≥500KB 的单文件」，真到那天修法也是 `fileio` 里一个读合并器而不是 Rust。harness `scripts/read-cost.ts`，永不进 CI |
| [workflow-cards-plan.md](feature/agent/workflow-cards-plan.md) | `shipped` | 工作流卡：内置开箱即用、项目文件可覆盖的任务套路（best-effort 提示注入，两级渐进披露）；与 B 类"流水线进工具"的分工 |
| [parallel-tools-plan.md](feature/agent/parallel-tools-plan.md) | `shipped` | 同轮工具调用并行执行：read 层（含 delegate）并发、写工具作屏障；history 顺序/配对不变量与 writeChain 的重入禁令 |
| [edit-loop-plan.md](feature/agent/edit-loop-plan.md) | `partial` | agent 的编辑回路，尺子是「省一轮 ≈ 15.1k token」：①行号契约（read_file 逐行行号、read_slides 行区间、写入回执带回位移与应用后片段）②结构读（read_file 的标题索引、search_text 的命中上下文）③验证回路（`inspect_html` 把页面真渲染出来报溢出/空白页/坏图，三条导出线的提案时预检拉齐）④`write` 档（按任务收窄工具集：15,337 → 4,017，两份 roster 改成跟着工具走）|
| [html-read-edit-plan.md](feature/agent/html-read-edit-plan.md) | `shipped` | agent 侧 `.html` 的读写效率，尺子是「改某一部分时会不会退化成 read-all」：写的一侧与 `read_slides` 那一半本来就对，断的是①走 `read_file` 进来时没人把模型引到那份幻灯片目录上（edit-loop-plan §5.1 当初就假设有人引）②`inspect_html` 的发现只有页序号没有行区间，而切分结果就在调用方手里③超长单行读不全——`cutMidLine` 不给续读坐标，单行文件读不到第 4000 字符之后，这是正确性问题④非幻灯片页面没有结构坐标，且超大单页的续读提示指回自己的起始行⑤IPC 量级先量后改。贯穿全篇的约束是 schema 棘轮实测只剩 135 / **28**（续写档，最容易被漏掉的那个）/ 86 token，所以四片一律走结果文本、schema 成本全是 0——连片 3 的续读坐标也塞进已有的 `start_line`（小数游标：整数部分是行号，四位小数是这一行的第几页），弃掉了 `start_char` 参数 |
| [tool-pack-plan.md](feature/agent/tool-pack-plan.md) | `implemented` | 工具包：chat 主控只带读查 + 分发（常驻实测 ≈10k → ≈3.7k），写类工作经 `run_pack` 派给只带对应 pack 的子运行（跑主模型，审批通道透传）；台架过闸（gemma 级 30/30，qwen 级的失败与 pack 无关）；「助手工具包模式」Beta 默认关——分发可靠性按模型分档，默认开会让派不动的模型在 chat 里写不了任何东西 |
| [writer-subagent-plan.md](feature/agent/writer-subagent-plan.md) | `shipped` `unverified` | 写手子代理：收尾成文交给作者另绑的模型（`finishPolicy: "handoff"`），开关式硬委托、交接单、引用式写入；只做对话助手，roleplay/AiPanel 不在第一期 |
| [writer-subagent-ui-brief.md](feature/agent/writer-subagent-ui-brief.md) | `shipped` | 写手的 UI 任务书 + 设计稿回来之后：署名是左槽里那道**长度等于写手正文**的 1px 线；工单搬出执行日志；写手不是第七个芯片 |
| [approval-card-ui-brief.md](feature/agent/approval-card-ui-brief.md) | `shipped` `unverified` | 设计稿 02h 已按切片 A–F 落地（改动窗、重写 / 删除 / 插入卡、方案账本与破坏性步骤暂停、撤回、自动批准后的「本轮写入」、窄栏）；「最后改于」与撤回拒绝里的时间由后补的 `fs_stat` 补上。原任务书：编辑类的卡今天说得出「少了 812 字」却说不出少的是哪 812 字，知识库那一侧连一个字的将写入内容都不在卡上（L1 调用即落盘，方案卡只有模型自己写的一句承诺）。含发稿前查到的底稿（数据都已在手、待批准提案不落盘、仓库里没有 diff 算法）与要稿子回答的五个问题 |
| [skill-state-memory-plan.md](feature/agent/skill-state-memory-plan.md) | `shipped` `unverified` | 状态记忆：把 SKILL.state（arXiv:2608.26263）做成对话助手**按对话开启**的 Beta 记忆模式——每次发送前把上一轮之前的对话折进一份有 schema 的执行状态（目标 / 决定 / 事实 / 进展 / 文件 / 待决 / 上一轮结果），只留上一轮原文，每轮上下文 O(1)；状态由模型全量重写、由运行时校验（形状拒、长度裁），不合格退回普通归纳。复用归纳的折叠机器（`planFold` 只多一个 `keepTurns`），两种模式经 `summaryText` 互相接手。论文只读到摘要与二手摘录，§1 写明 |
| [compact-threshold-plan.md](feature/agent/compact-threshold-plan.md) | `shipped` | 归纳阈值：「上下文与记忆」页加「自动归纳」开关 + 两条滑块（8k–512k 对数刻度 · 50–80% 窗口比例，先到者生效）。给 Claude Design 的任务书（应用的第一个滑块，请求新开 `19 归纳阈值`）+ 三片 PR 的计划。要点：第三条线（0.7 × 消息上限）保留且默认赢，比例滑块在默认窗口占用 50% 下整段不生效，必须靠读数说清；折叠目标随触发线同比缩放；扮演页今天**没有**手动归纳按钮，要补 |
| [tool-progress-plan.md](feature/agent/tool-progress-plan.md) | `shipped` | 长任务的进度：等待按**发生在谁手里**分三类，各配一条缝——工具自己在循环（`ToolContext.onProgress`：translate 的块/行/字、`search_text` 的 N/M）、根本还没有工具（适配器的 `{toolArgs}` + 轮次秒表：模型把一章正文流进工具参数的那一两分钟）、工具卡在别人手里（审批把工具自己的回调递给 apply：生图轮询的「已等 / 上限」）。三条节流都是**时钟从构造那一刻起走**，所以快的那次一个字都不报。附带修掉「子运行卡按工具名判定」——`run_pack` 的整段子运行曾经在日志里不存在 |
| [context-meters.md](feature/agent/context-meters.md) | `living` | 三条上下文计量条（生成的分配条 / 助手+扮演的构成条 / 预估态）：哪些必须一致（颜色语汇 + 段的合计等于上限）、哪些故意不一致（控件 vs 读数），以及各自已知未做的部分 |
| [ask-author-plan.md](feature/agent/ask-author-plan.md) | `shipped` | `ask_author` 提问卡：模型出 2–4 个选项 + 恒在的自由输入，阻塞契约同 L2 审批；第五个待决队列，路由追加装载（批量/lore 弹窗拿不到工具），连批永不覆盖 |
| [lore-category-visibility-plan.md](feature/agent/lore-category-visibility-plan.md) | `shipped` | Agent 建重复分类的修复：模型从未见过分类标签、空分类在列表里隐形、`create_lore_category` 不查重、指令文案陈旧——PR-A 读侧 id↔标签对照（description + 结果文本，常驻预算随之放宽到 12,000），PR-B 写侧幂等查重 + 文案纠偏；与 lore-category-manage-plan 分片 3 互补 |
| [large-doc-formatting-plan.md](feature/agent/large-doc-formatting-plan.md) | `partial` | 大文档格式化（给无标题的巨型 md 加标题/区分段落）：现状轮数 O(文件)、正文两次过模型且有 paraphrase 风险——①`insert_lines` 插入清单（正文由运行时拼装，一轮一卡）②无标题文件的段落地图（零 schema，与标题索引同构）③指令层「分页读一轮多发」④确定性段落规范化做作者侧命令⑤实测复核 |
| [document-read-plan.md](feature/agent/document-read-plan.md) | `implemented` | Agent 直读 .docx / .xlsx / .pdf：新只读工具 `read_document`（与 `read_file` / `read_slides` 两两改口，不扩 `read_file`），转换结果按内容哈希缓存在 `.ai-writer/tmp/convert/` 而不落工作区，PDF 默认本地 pdfjs、扫描件由结果指向 pdf 子代理；写的一半 `convert_document`（§10）：提卡时就转好、批准后从缓存搬出、照导入器命名 |
| [chat-sessions-plan.md](feature/agent/chat-sessions-plan.md) | `shipped` | 对话助手的会话：①作者起的**标题**（`title` 与 `preview` 两列两种寿命，命名的行不被自动清、配带确认的删除）②**多个活会话并发**——就是 `roleplayStore` 当年没做的那次 `agentStore` 重构：`chats: Record<key, LiveChat>` + `activeChatKey` 与 `running`/`queue` 两轴正交、`scheduler` 搬到 `lib/agent/` 两边共用、对话助手的卡片改打 `surface: chat:<key>`、自动批准 key 改 controller、`unread` 在「卡在等」时也置位；PR A→D 切片，B 是零行为变化的收敛写点。A–D 全部落地（§10 记 store 侧出入：自动批准 key 是 `chat:<key>` 而非 controller、resumeTask 开新会话、composer 草稿按 key；§11 记界面：横向标签条 / 三家记号 / 两种字 / 历史下拉三节 / 头部即会话名 / 换项目确认） |
| [chat-sessions-ui-brief.md](feature/agent/chat-sessions-ui-brief.md) | `shipped` | 上面那份的 UI 任务书（请求新开 `23 会话`）：没有身份的会话怎么并排（标签条 / 侧栏 / 升级下拉）、五个态的记号只靠实心/空心/动/静、打开-历史-固定-命名四词分清、改名的两个入口 |
| [window-edge-plan.md](feature/agent/window-edge-plan.md) | `partial`（PR-1 · PR-2 ✅） | 本地小模型「卡死 / 死循环 / 突然中断」的实测与方案（2026-09-11，qwen3.8-27b @ LM Studio 32k，DeepSeek 压到 32k 做对照）：六个机制里五个**跟窗口走不跟模型走**——`trimHistory` 会裁掉本轮刚到的结果（重读循环）、检查点提示每次裁剪后重新布防（轮次花在记账上）、只思考没正文的截断被报成 `completed`、流没有看门狗、小窗口上每次发送都先归纳；第六个是思考打转。同一 qwen 同一任务占用 50%→90%：223 秒零产出 → 49 秒改成。六片 PR，PR-4 上限保底要作者定。台架 `scripts/local-model-probe.ts`，永不进 CI |
| [shell-command-plan.md](feature/agent/shell-command-plan.md) | `shipped` (#561 · #563 · PR 3 窄授权；可选流式未做) | `run_command`：agent 跑本机命令的 L2 工具——Windows 走 PowerShell（pwsh 优先，退 5.1 + UTF-8 序言），macOS / Linux 走 `$SHELL` 或系统 shell 且必须 `-l`（GUI 应用的 PATH 没有 Homebrew）。十一条不变量（卡在起进程之前、卡上是命令原文、stdin 关死、杀整个进程组、输出头尾截断 + 日志落 `tmp/cmd/`、`cwd` 有围栏而命令没有）；**不装** `tauri-plugin-shell`，自己写 `cmd.rs`；布尔连批永不覆盖，只有按程序名且不覆盖复合命令的窄授权；Beta + Tauri + 能渲染卡的 surface 三者缺一即缺席。三片 PR |

### feature/lore/ — the knowledge base

| Doc | Status | What it settles |
|---|---|---|
| [lore-facet-plan.md](feature/lore/lore-facet-plan.md) | `shipped` | Facets: sub-entity granularity so injection isn't all-or-nothing |
| [lore-entry-type-plan.md](feature/lore/lore-entry-type-plan.md) | `partial` | Entry types as a category schema. Phases 1–4 built; `subtypes` deliberately dropped (§6) |
| [lore-collection-plan.md](feature/lore/lore-collection-plan.md) | `shipped` | Collections: the second axis (which body of work an entry belongs to) + the 取材范围 fence |
| [lore-collection-ui-brief.md](feature/lore/lore-collection-ui-brief.md) | `shipped` | The Claude Design brief for the collections UI turn (screens 24–31) |
| [lore-browse-mode-ui-brief.md](feature/lore/lore-browse-mode-ui-brief.md) | `shipped` | 条目**阅读模式**（设计稿 03c → `LoreReadView`）：墙上摊开的一张纸把主条目 + 特征全文 + 配图一次排开，注入语义退成节头短线与 mono 边注（三种线靠粗细与断续区分，手动不降透明；互斥组是骑缝组边不是盒子）；只读不催。含任务书原文与八处设计稿出入 |
| [lore-category-dict-ui-brief.md](feature/lore/lore-category-dict-ui-brief.md) | `shipped` | 补稿任务书（设计稿 `03f 设定集 · 分类操作与词典 Lore C`，已回并对齐）：三个已实装、没有设计稿的面——删除分类（两张并列出口卡 / 空分类·orphan·无处可搬三种降级 / 「不可逆」不用红）、移到分类（影响面先于动作、点一下就搬、与归集清单并排却要分得开）、词典标准化（模型只搬运格式由代码渲染这句要被看见 / 结果是词表还是文本 / 「N 条逐字找不到」不是错误）+ 条目 AI 中心的第五格；含数据边界与不要做 |
| [lore-retrieval-plan.md](feature/lore/lore-retrieval-plan.md) | `shipped` | 取材准确度第 0–2 级：作者意图进匹配靶、`[[lore:…]]` 引用图扩展、查询扩展喂回子串匹配器。三条不变量（子串通道优先 · 每条命中都要可解释可动手 · 无静默截断）；向量通道为什么推迟，以及重启条件（§6.1）。实现出入在 §9——尤其 §9.1：引用带入的条目**不能**挂 L0 保底层，那一层不受预算限制 |
| [lore-granularity-research.md](feature/lore/lore-granularity-research.md) | `research` | Six directions surveyed. 1+3 became the facet plan; 2, 4, 6 are still open |
| [lore-category-manage-plan.md](feature/lore/lore-category-manage-plan.md) | `shipped` | 分类的管理面三片：墙上多选批量改分类（含置顶重指）·「删除分类」的两出口确认（两扇门共用一次，orphan 拿到搬空这条出路）· agent 方案卡的分类 target 轴（一行替十二行，含「哪种步骤装哪组延迟工具」那条踩过的坑）。为什么分类和集合的管理面天生不对称 |

### feature/knowledge-base/ — the sync server

| Doc | Status | What it settles |
|---|---|---|
| [remote-knowledge-base-feasibility.md](feature/knowledge-base/remote-knowledge-base-feasibility.md) | `research` | Can it be done, what blocks it, in what order. **§13–§19 have since shipped as `server/`** — the file's own status line predates that |
| [kb-admin-console.md](feature/knowledge-base/kb-admin-console.md) | `shipped` | Why the `/admin` console looks the way it does; TOML config, two separate credentials |
| [config-backup-plan.md](feature/knowledge-base/config-backup-plan.md) | `shipped` | 应用配置（供应商 / 模型 / Prompt / 偏好 + API Key）备份到服务端：信封格式、带 Key 必须加密、服务端为什么不解析它 |
| [sync-lore-ui-brief.md](feature/knowledge-base/sync-lore-ui-brief.md) | `shipped` | 同步与备份设置页重整（锚点卡 + 两张纸、唯一的连接入口）+ 知识库墙同步状态件：任务书与实现出入 |
| [kb-server-tray.md](feature/knowledge-base/kb-server-tray.md) | `shipped` | Windows 托盘启动器 `aiw-kb-tray`：为什么是同 crate 第二个 bin、进程内跑 axum、首启凭据弹窗、HKCU Run 键自启 |

### feature/ — single-doc subsystems

| Doc | Status | What it settles |
|---|---|---|
| [roleplay/](feature/roleplay/README.md) | `shipped` (Beta flag) | Interactive roleplay: transcript as asset, context layering, character memory, the narrator's isolation. 绑定粒度的返工（[11-lore-binding-lld.md](feature/roleplay/11-lore-binding-lld.md)）：主角正文常驻、勾中的特征常驻、其余照常自动注入；取材事实与首轮预估（[12-context-trace-plan.md](feature/roleplay/12-context-trace-plan.md)）：这一轮命中了什么、为什么，四种来源用**四种装订**而不是四种颜色分开 |
| [translate/00-sakura-feasibility.html](feature/translate/00-sakura-feasibility.html) | `research` | Can SakuraLLM (日→中) be integrated, and where it lands. Twelve live tests against a local LM Studio — chunk sizes, degeneration, the glossary's real behaviour |
| [translate/01-execution-plan.md](feature/translate/01-execution-plan.md) | `shipped` (Beta flag) | The four PR slices, the six invariants, and why `top_p`/`frequency_penalty` belong to `StreamOptions` rather than `ConnOptions` |
| [pptx-plan.md](feature/pptx-plan.md) | `shipped` (write side Beta) | Reading .pptx in Rust; HTML → PPTX without a model in the loop |
| [consistency-review-plan.md](feature/consistency-review-plan.md) | `shipped` | 一致性检查重设计：核对搬到统一运行时（助手的循环减写工具 + 两个收集器，子代理照装）、范围三档（全部 / 集合 / 条目）、核对重点经检索子代理展开、按预算切段并行（切段归代码）、引文在工具里校验、分配条而不是构成条；§15 记实现与方案的出入 |
| [consistency-review-ui-brief.md](feature/consistency-review-ui-brief.md) | `shipped` | 上面那份的 UI 任务书（设计稿 `22 一致性检查`）：四条张力——设置区在点开始那一刻折成一行、段条不画（段是日志里的工具行，结束后变成报告头的覆盖条）、停止住底栏、五张报告头靠统计行写法和覆盖条区分；文末记设计稿怎么答的与实现出入 |
| [docx/00-feasibility.md](feature/docx/00-feasibility.md) | `proposal` | 为什么「难的是读 docx，不是写 docx」；RTF / HTML-塞进-.doc / pandoc sidecar / Rust `docx-rs` 四条弃用理由；严格格式规格（公文级）的实测表达力，以及「校对规格表而不是校对产出」（§7） |
| [docx/01-agent-design.md](feature/docx/01-agent-design.md) | `shipped` | agent 产出 .docx（Beta）：四条不变量（模型只写 markdown · **格式是引用不是参数** · 三级来源纯函数解析 · Beta 关=工具缺席）、`export_docx` / `read_doc_format` 的工具形状、`DocxProposal` 卡为什么要显示格式来源、预设为什么落装机级 |
| [docx/02-ui-brief.md](feature/docx/02-ui-brief.md) | `shipped` | 给 Claude Design 的 UI 任务书（自包含）。设计稿已回（TURN 1，1a–1n），实现出入记在 01 的 §11 |
| [docx/03-header-numbering-ui-brief.md](feature/docx/03-header-numbering-ui-brief.md) | `shipped` | 补稿任务书（设计稿 `05h Word 排版格式（三）Word Format C`，已回并对齐）：三期做进抽屉、稿上还是「三期」占位卡的两组——标题自动编号（是 H1–H4 表的第七列还是自己一组 / 「不要手写序号」的分量）与页眉页脚（依赖行是出现还是虚线 / 「留空就一行都不发」住在哪 / 纸样画不画页码 / 奇偶页是规则不是字段），加上抽屉之外三处看不见它们的地方（列表与审批卡摘要 / 读取模态不读这两组 / 助手改不动）；含数据边界与不要做 |
| [xlsx-export-plan.md](feature/xlsx-export-plan.md) | `shipped` (Beta flag) | agent 产出 .xlsx（PR #394）：一张 markdown 表格 = 一个工作表，**数字必须是数字**（前导零 / 15 位以上 / 带单位一律留成文本，百分数存分数）；生成放 Rust 而 docx 放 TS 的同一条规则（方言不过界，D1）；工具预算 +274 与「为什么不走延迟装载」（§9） |
| [latex-pdf-plan.md](feature/latex-pdf-plan.md) | `proposal` | 用 LaTeX 排版出 PDF：为什么中间产物是**确定性转录**而不是「复制 md 再让模型改标记」（`%` 会静默吃掉半行中文）；正文/版式分家成两个文件，因此重转录不丢版式；**文字流不变式**把「不走形」变成纯函数判定；`compile_latex` 作为验而不写的工具（Missing character 必报）；为什么它不该是一个 `SubAgentKind`；pandoc / Typst / WASM-TeX 三条弃案 |
| [image-generation-plan.md](feature/image-generation-plan.md) | `shipped` | Generation/editing as the `imagegen` subagent |
| [import-images-plan.md](feature/import-images-plan.md) | `shipped` | 导入 PDF/docx/pptx 时抽取内嵌图片（PR #389/#390/#392）：`ConvertResult` 接缝、pdfjs opList 抽取 + y 坐标定位、落 `assets/<文档名>/`；去重/装饰过滤/扫描件三个决策，矢量图明确不做；实现出入（mammoth 双 key 输入等）在 §8，pptx 的 Rust 侧抽取在 §9，pdfjs 为什么改走 legacy 构建（WebView2 < 140 的 `toHex`）在 §10，pdfjs 为什么改走 legacy 构建（WebView2 < 140 的 `toHex`）在 §10 |
| [image-normalize-plan.md](feature/image-normalize-plan.md) | `partial` | 入模图片规范化：超 4096 长边的图在**发送前**降采样（已发），HEIC 转码**明确不做**（LGPL，§3.0）。为什么阈值是 4096 而不是 2048、为什么没有 per-provider 上限表，以及三个读图函数按去向分开的理由 |
| [asr/00-research.md](feature/asr/00-research.md) | `research` | 音频转写（千问 / DashScope 录音文件识别）：临时上传 → 异步任务 → 轮询 → 结果 JSON 四步实测走通；两代 filetrans 模型请求 / 结果形状的差异表；落点照翻译 Beta（专用模型不进对话候选、`asr` 子代理档位、右键 + L2 工具两个入口）；探测脚本在同目录，真实结果夹具在 `src/lib/asr/__tests__/fixtures/` |
| [asr/01-execution-plan.md](feature/asr/01-execution-plan.md) | `shipped` (Beta flag, PR #514) | 五个开放问题的默认落定（只做异步、右键先确认、热词先测、默认 qwen-audio-3.0、时间戳开 / 分离关）、六条不变量、四片分片（PR 4 热词未做）；为什么**不**从 `image.ts` 抽轮询循环 |
| [asr/02-ui-brief.md](feature/asr/02-ui-brief.md) | `shipped` (设计稿 `02f`) | 任务书原文 + 设计稿的答复（五个张力、货币开放问题）+ 实现出入：确认条就地长在行下而不是浮卡、busy 走面板级条、审批卡批准后不在卡内变进度 |
| [comfyui-plan.md](feature/comfyui-plan.md) | `shipped` (Beta flag) | 本地 ComfyUI 作为第五条出图路由：一个 Model = 一张导出的 API 格式工作流，占位注入而非构图；参考图/图生图走 LoadImage 槽位，edit 能力从图推导；人设校准循环（清单 → vision 评审 → 修正重试，历史最佳兜底） |
| [html-artifact-plan.md](feature/html-artifact-plan.md) | `shipped` | AI-authored `.html` deliverables and their in-app preview |
| [library-plan.md](feature/library-plan.md) | `shipped` | 文库: book-spine ordering, per-collection resources |
| [file-panel-pin-ui-brief.md](feature/file-panel-pin-ui-brief.md) | `shipped` | 「最近打开」加固定：**固定＝换节住**（两个小节，不是行上的标记）· 「清空最近」长在它清的那一节的标题行里（于是「全部都被固定」的禁用态根本不存在）· 一行只留一个有状态的图标。含与设计稿 01a 的七处出入，以及「撤销把 per-project 偏好的回收推迟到窗口关闭」那条时序 |
| [file-panel-redesign-brief.md](feature/file-panel-redesign-brief.md) | `shipped` | 「文件」面板重做 —— 给 Claude Design 的任务书（请求新开 `17 文件面板 Files Panel`）：顶部四层吃掉 216px · 工具栏 7 个图标在最窄档只有 116px 可用 · 悬停/多选/当前打开三态同底 · 一行 28px 里五样东西互相打架（章数一 hover 就消失）· 拖拽与剪贴板九种记号各自为政 · 「全部折叠」落在哪。含**数据边界**清单（节点只有 `{名字,路径,是否目录,子节点}`），防止设计出画不出来的东西。**文末是实现记录**：设计稿的主干决定（选中＝左槽 3px 赭石，赭石淡底只给「当前打开」）、落点表、与设计稿的十处出入，以及「容器查询不改变特异性，密度档必须写在文件末尾」那条实测 |
| [global-search-ui-brief.md](feature/global-search-ui-brief.md) | `shipped` | ⌘K 升级成全局搜索（文档 / 条目 / 当前文档正文，↵ 直达并让文件树自动定位；条目改去知识库墙而不是在编辑器里开 index.md；假前缀要么真做要么删）+ 文件树工具栏常驻「定位当前文档」按钮（动作已有三个入口，缺的是常驻按钮）。含需求梳理、数据边界（跨文档全文搜索本期不做）与给 Claude Design 的任务书（请求新开 `21 全局搜索`） |
| [file-tree-collapse-all-brief.md](feature/file-tree-collapse-all-brief.md) | `shipped` | 文件树工具栏加「全部折叠」：为什么**不能靠清空 `expandedDirs`**（默认值是 `stored ?? depth === 0`，清空会让顶层回弹成展开）· 为什么必须是一次 set · 折叠后选区要收敛到可见行（否则「删除 5 项」会出现在屏幕上只剩 1 项的时候）· 不做切换态 / 不做「全部展开」的理由。设计稿推翻了「不做切换态 / 不加快捷键」两条，都对（记在文首） |
| [file-tree-picture-folder-brief.md](feature/file-tree-picture-folder-brief.md) | `shipped` | 文件树认出「图片目录」（`images/` `截图/` …）：**不能复用 `assets` 种类**——它背后挂着失配判定与「重新关联」，会给作者自建的目录改名并改写无关文档的正文；改为新增只管外观的第七种 `pictures`。判据是**内容优先、名字兜底**（名单永远不全，而一个叫 `images` 却装章节的目录错标比漏标更糟），并写明「宁可漏标不可错标」那一处让步 |
| [prompt-snippets-ui-brief.md](feature/prompt-snippets-ui-brief.md) | `shipped` | 提示词库（快捷片段）：右键存入、模型选择器同款的取用浮层、设置页重做，以及五件明确没做的事 |
| [model-drawer-redesign-brief.md](feature/model-drawer-redesign-brief.md) | `shipped` | 「模型」编辑抽屉重做（设计稿 05c → `ModelDrawer.tsx` + `ModelDrawerBits.tsx`）：按「有没有值」折叠 · **虚线 ＝ 什么都不发** · 实测值 vs 手填值（新增 `probedContextSize` / `probedMaxOutput`）· 两级提示 · 「将发送」用适配器自己的 body 函数算 · 列表行的声明标记。含任务书原文（24 个参数的数据边界表）与七处出入——最要紧的一处：结构化输出「自动」在未识别的模型上是 JSON 模式而不是设计稿写的「关闭」，摘要按真实解析显示 |
| [settings-ai-tabs-ui-brief.md](feature/settings-ai-tabs-ui-brief.md) | `shipped` | 设置页「AI 配置」分组新增「实验室」（七个 Beta 开关从通用搬来）与「上下文与记忆」（图片最大长边搬来，且是将来知识库预算 / 默认最大输出 / 前情提要模型的家）：给 Claude Design 的任务书（请求新开 `18 设置 · AI 配置`）+ 两片 PR 的实施计划，含「Word 开关翻动时导航里的排版格式要即时出现」那条现有漏洞 |
| [theme-system-plan.md](feature/theme-system-plan.md) | `shipped` (S1–S4) | 主题系统：令牌分三层（刻度 / 核心契约 37 个 / 其余 176 个**默认从核心推导**，内置两套的 139 个手调值原样保留），`@layer` 五层写死级联，`data-scheme` 承载明暗、`data-theme` 只是钥匙；外观主题 = 只声明令牌的 CSS 文件、排版主题 = 只作用于 `.md-body` 的 CSS 文件（Typora 的 `theme.css` + 同名文件夹约定，元数据是 `--theme-*` 自定义属性）；校验用浏览器自己的 `CSSStyleSheet` 遍历、越界规则丢弃并计数；导出改从注册表生成调色板。S1 已落地并附「`var(--x)` 必须解析到清单」的悬空引用守卫（首次运行就抓到三处）；S2 已落地：`appDataDir/themes/*.css` 扫描 / 校验 / 安装、`app:themeLight/Dark`、设置页两条带 + 三种坏卡 + 作者三动作、导出调色板改生成；S3 已落地：`--theme-kind: markdown` 的 `.md-body` 围栏校验、项目级 `.ai-writer/themes/`、沙箱 iframe 样张、资产内联成 `data:`（不走 `ai-writer-asset:`）、导出带文件自己的 CSS；S4 已落地：设置页开着时监听主题文件夹、坏主题的理由改成代码 + 中英句子、简写回收、样张与导出跟字体方案 |
| [theme-system-ui-brief.md](feature/theme-system-ui-brief.md) | `shipped` (设计稿 `05i 主题 Themes` 已回；S2–S4 实现落点记在文首) | 上面那份的 UI 任务书：五条张力——「跟随系统」是一对主题、三种来源并排不分组、坏主题不弹窗（三种坏法三种卡）、两种卡两种样张（令牌画的迷你窗口 / 隔离小窗里的一页文档）、「导出当前主题为文件」是唯一的上手路径。文首记设计稿的十二条决策与对方案的两处改动 |
| [theme-second-set-ui-brief.md](feature/theme-second-set-ui-brief.md) | `shipped` (设计稿 `05j 第二套主题 Second Theme` 已回，TURN 1；实现＝方案 §13 的 S5) | 第二套外观主题 **石 / 墨**（设计稿的「石墨 Graphite」：冷灰中性 + 青黛强调）的任务书与落地记录。它同时是推导层的验收——两张卡只写 37 个核心令牌、一个手调都没有，所以设置页、知识库分类点、同步风险条全部由 `tokens.derive` 算出来；实测六色分类比手调的纸 / 夜分得更开（ΔE 石 0.069 / 墨 0.047 vs 纸 0.073 / 夜 0.025）。`tokens.theme` 因此长出第二种块：**不是基底的内置主题在这一层写核心**，`contract.ts` 把核心从 `derived` 里减掉 |
| [path-spelling-plan.md](feature/path-spelling-plan.md) | `shipped` `unverified` | Normalise at the door, one spelling app-wide. §6 needs a real Windows machine |
| [web-access-plan.md](feature/web-access-plan.md) | `research` `stale` | 局域网 Web 访问：桌面进程里嵌 axum、前端 transport 三态、绝对路径不上网线、API key 不下发浏览器。结论仍成立，但数字基于 v1.17.0——文首有复核表 |

## issues/ — open and unconfirmed

| Doc | Status | What is open |
|---|---|---|
| [thinking-verification.md](issues/thinking-verification.md) | `open` | Thinking support is implemented and unit-tested across three families, but unit tests prove *what we sent*, not *what the endpoint did*. MiniMax-M3 cleared part of §2.6; the rest stands |
| [css-modules-global-keyframes.md](issues/css-modules-global-keyframes.md) | `fixed` | CSS Modules 哈希化 animation-name、global.css 的 keyframes 悬空 —— 40+ 处入场/spinner 动画从未播过。已切 LightningCSS（`cssModules.animation: false`）修复；待一轮真机目检 |
| [motion-enter-only-hidden-tab.md](issues/motion-enter-only-hidden-tab.md) | `clarified` | 「enter-only 的 keyed `motion.div` 在 reduced-motion 下停在 `initial`」是**测量产物**：预览面板标签页 `visibilityState === 'hidden'`，rAF 不派发。代码无缺陷，实测读数与正确的验动画方法记在文内 |
| [asr-currency.md](issues/asr-currency.md) | `open` | 转写按人民币计费，却写进了 `cost_usd` 列：用量页合计是两种货币的和。两条出路（用量表记货币 / 设置里定汇率），作者定为不急的待办 |
| [tiered-pricing.md](issues/tiered-pricing.md) | `open` | 千问按输入长度分档计价（顶档 3×），平价 `priceIn/Out` 表达不了；显式缓存写入价同缺。只失真成本统计，典型任务不跨 256K 门槛，故仅留档 + 设计草案 |

---

## Adding a doc

1. **Pick the folder by kind**, not by how finished it is. A plan that has shipped stays in `feature/`; it does not migrate.
2. **State the status in a blockquote under the title**, with the nuance a token cannot carry — which phases, which PRs, what is still open.
3. **Add a row here.** This file is the only place a reader can see everything at once.
4. **Link it from `CLAUDE.md`'s Detailed References only if it must be read before touching code.** `CLAUDE.md` enters context every session; a `proposal` does not earn that seat.
5. **Cite it from the code** where the reasoning matters — `see docs/feature/lore/lore-facet-plan.md`. Those citations are the reason paths here are treated as an interface, not as filing.
