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
| [architecture.md](reference/architecture.md) | `living` | Touching any subsystem: DB schema, RAG, SSE, key storage, export, IPC, CodeMirror |
| [design-system.md](reference/design-system.md) | `living` | Building or restyling **any** UI |
| [workflows.md](reference/workflows.md) | `living` | Adding an AI task type, a provider, a language, a capability pack |
| [terminology.md](reference/terminology.md) | `living` (词表) · `planned` (校准批次) | Writing **any** user-facing string, or wondering which of 条目/词条/设定 to use. Also holds the six-batch plan for the 78 一词多译 / 49 一译多词 found in the 2026-08 sweep |
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
| [workflow-cards-plan.md](feature/agent/workflow-cards-plan.md) | `shipped` | 工作流卡：内置开箱即用、项目文件可覆盖的任务套路（best-effort 提示注入，两级渐进披露）；与 B 类"流水线进工具"的分工 |
| [parallel-tools-plan.md](feature/agent/parallel-tools-plan.md) | `shipped` | 同轮工具调用并行执行：read 层（含 delegate）并发、写工具作屏障；history 顺序/配对不变量与 writeChain 的重入禁令 |
| [writer-subagent-plan.md](feature/agent/writer-subagent-plan.md) | `shipped` `unverified` | 写手子代理：收尾成文交给作者另绑的模型（`finishPolicy: "handoff"`），开关式硬委托、交接单、引用式写入；只做对话助手，roleplay/AiPanel 不在第一期 |
| [writer-subagent-ui-brief.md](feature/agent/writer-subagent-ui-brief.md) | `shipped` | 写手的 UI 任务书 + 设计稿回来之后：署名是左槽里那道**长度等于写手正文**的 1px 线；工单搬出执行日志；写手不是第七个芯片 |
| [context-meters.md](feature/agent/context-meters.md) | `living` | 三条上下文计量条（生成的分配条 / 助手+扮演的构成条 / 预估态）：哪些必须一致（颜色语汇 + 段的合计等于上限）、哪些故意不一致（控件 vs 读数），以及各自已知未做的部分 |
| [ask-author-plan.md](feature/agent/ask-author-plan.md) | `shipped` | `ask_author` 提问卡：模型出 2–4 个选项 + 恒在的自由输入，阻塞契约同 L2 审批；第五个待决队列，路由追加装载（批量/lore 弹窗拿不到工具），连批永不覆盖 |
| [lore-category-visibility-plan.md](feature/agent/lore-category-visibility-plan.md) | `shipped` | Agent 建重复分类的修复：模型从未见过分类标签、空分类在列表里隐形、`create_lore_category` 不查重、指令文案陈旧——PR-A 读侧 id↔标签对照（description + 结果文本，常驻预算随之放宽到 12,000），PR-B 写侧幂等查重 + 文案纠偏；与 lore-category-manage-plan 分片 3 互补 |

### feature/lore/ — the knowledge base

| Doc | Status | What it settles |
|---|---|---|
| [lore-facet-plan.md](feature/lore/lore-facet-plan.md) | `shipped` | Facets: sub-entity granularity so injection isn't all-or-nothing |
| [lore-entry-type-plan.md](feature/lore/lore-entry-type-plan.md) | `partial` | Entry types as a category schema. Phases 1–4 built; `subtypes` deliberately dropped (§6) |
| [lore-collection-plan.md](feature/lore/lore-collection-plan.md) | `shipped` | Collections: the second axis (which body of work an entry belongs to) + the 取材范围 fence |
| [lore-collection-ui-brief.md](feature/lore/lore-collection-ui-brief.md) | `shipped` | The Claude Design brief for the collections UI turn (screens 24–31) |
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
| [docx/00-feasibility.md](feature/docx/00-feasibility.md) | `proposal` | 为什么「难的是读 docx，不是写 docx」；RTF / HTML-塞进-.doc / pandoc sidecar / Rust `docx-rs` 四条弃用理由；严格格式规格（公文级）的实测表达力，以及「校对规格表而不是校对产出」（§7） |
| [docx/01-agent-design.md](feature/docx/01-agent-design.md) | `shipped` | agent 产出 .docx（Beta）：四条不变量（模型只写 markdown · **格式是引用不是参数** · 三级来源纯函数解析 · Beta 关=工具缺席）、`export_docx` / `read_doc_format` 的工具形状、`DocxProposal` 卡为什么要显示格式来源、预设为什么落装机级 |
| [docx/02-ui-brief.md](feature/docx/02-ui-brief.md) | `shipped` | 给 Claude Design 的 UI 任务书（自包含）。设计稿已回（TURN 1，1a–1n），实现出入记在 01 的 §11 |
| [xlsx-export-plan.md](feature/xlsx-export-plan.md) | `shipped` (Beta flag) | agent 产出 .xlsx（PR #394）：一张 markdown 表格 = 一个工作表，**数字必须是数字**（前导零 / 15 位以上 / 带单位一律留成文本，百分数存分数）；生成放 Rust 而 docx 放 TS 的同一条规则（方言不过界，D1）；工具预算 +274 与「为什么不走延迟装载」（§9） |
| [image-generation-plan.md](feature/image-generation-plan.md) | `shipped` | Generation/editing as the `imagegen` subagent |
| [import-images-plan.md](feature/import-images-plan.md) | `shipped` | 导入 PDF/docx/pptx 时抽取内嵌图片（PR #389/#390/#392）：`ConvertResult` 接缝、pdfjs opList 抽取 + y 坐标定位、落 `assets/<文档名>/`；去重/装饰过滤/扫描件三个决策，矢量图明确不做；实现出入（mammoth 双 key 输入等）在 §8，pptx 的 Rust 侧抽取在 §9 |
| [image-normalize-plan.md](feature/image-normalize-plan.md) | `partial` | 入模图片规范化：超 4096 长边的图在**发送前**降采样（已发），HEIC 转码**明确不做**（LGPL，§3.0）。为什么阈值是 4096 而不是 2048、为什么没有 per-provider 上限表，以及三个读图函数按去向分开的理由 |
| [comfyui-plan.md](feature/comfyui-plan.md) | `shipped` (Beta flag) | 本地 ComfyUI 作为第五条出图路由：一个 Model = 一张导出的 API 格式工作流，占位注入而非构图；参考图/图生图走 LoadImage 槽位，edit 能力从图推导；人设校准循环（清单 → vision 评审 → 修正重试，历史最佳兜底） |
| [html-artifact-plan.md](feature/html-artifact-plan.md) | `shipped` | AI-authored `.html` deliverables and their in-app preview |
| [library-plan.md](feature/library-plan.md) | `shipped` | 文库: book-spine ordering, per-collection resources |
| [file-panel-pin-ui-brief.md](feature/file-panel-pin-ui-brief.md) | `shipped` | 「最近打开」加固定：**固定＝换节住**（两个小节，不是行上的标记）· 「清空最近」长在它清的那一节的标题行里（于是「全部都被固定」的禁用态根本不存在）· 一行只留一个有状态的图标。含与设计稿 15 的七处出入，以及「撤销把 per-project 偏好的回收推迟到窗口关闭」那条时序 |
| [prompt-snippets-ui-brief.md](feature/prompt-snippets-ui-brief.md) | `shipped` | 提示词库（快捷片段）：右键存入、模型选择器同款的取用浮层、设置页重做，以及五件明确没做的事 |
| [path-spelling-plan.md](feature/path-spelling-plan.md) | `shipped` `unverified` | Normalise at the door, one spelling app-wide. §6 needs a real Windows machine |
| [web-access-plan.md](feature/web-access-plan.md) | `research` `stale` | 局域网 Web 访问：桌面进程里嵌 axum、前端 transport 三态、绝对路径不上网线、API key 不下发浏览器。结论仍成立，但数字基于 v1.17.0——文首有复核表 |

## issues/ — open and unconfirmed

| Doc | Status | What is open |
|---|---|---|
| [thinking-verification.md](issues/thinking-verification.md) | `open` | Thinking support is implemented and unit-tested across three families, but unit tests prove *what we sent*, not *what the endpoint did*. MiniMax-M3 cleared part of §2.6; the rest stands |
| [css-modules-global-keyframes.md](issues/css-modules-global-keyframes.md) | `fixed` | CSS Modules 哈希化 animation-name、global.css 的 keyframes 悬空 —— 40+ 处入场/spinner 动画从未播过。已切 LightningCSS（`cssModules.animation: false`）修复；待一轮真机目检 |
| [motion-enter-only-hidden-tab.md](issues/motion-enter-only-hidden-tab.md) | `clarified` | 「enter-only 的 keyed `motion.div` 在 reduced-motion 下停在 `initial`」是**测量产物**：预览面板标签页 `visibilityState === 'hidden'`，rAF 不派发。代码无缺陷，实测读数与正确的验动画方法记在文内 |
| [tiered-pricing.md](issues/tiered-pricing.md) | `open` | 千问按输入长度分档计价（顶档 3×），平价 `priceIn/Out` 表达不了；显式缓存写入价同缺。只失真成本统计，典型任务不跨 256K 门槛，故仅留档 + 设计草案 |

---

## Adding a doc

1. **Pick the folder by kind**, not by how finished it is. A plan that has shipped stays in `feature/`; it does not migrate.
2. **State the status in a blockquote under the title**, with the nuance a token cannot carry — which phases, which PRs, what is still open.
3. **Add a row here.** This file is the only place a reader can see everything at once.
4. **Link it from `CLAUDE.md`'s Detailed References only if it must be read before touching code.** `CLAUDE.md` enters context every session; a `proposal` does not earn that seat.
5. **Cite it from the code** where the reasoning matters — `see docs/feature/lore/lore-facet-plan.md`. Those citations are the reason paths here are treated as an interface, not as filing.
