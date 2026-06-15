# Simple AI Writer — V1 实施计划 (Implementation Plan)

> 依据 [`SEPC_OVERVIEW.md`](./SEPC_OVERVIEW.md) 与 [`PRD.md`](./PRD.md) 制定。
> 目标：用一个**可运行的纵向切片 (vertical slice)** 验证产品的核心差异点 —— *Lore-friendly AI（设定契合的 AI 写作）*，同时把工程地基打牢，便于后续迭代。

---

## 1. V1 范围裁剪 (MVP Scope)

PRD 覆盖面非常大。直接做全集会让首版周期过长、风险过高。下面把需求拆成 **三档**：

### ✅ V1 必做（核心价值闭环）
能完成一次完整的「打开项目 → 写作 → 建设定 → AI 按设定续写」体验。

| 模块 | V1 范围 |
|---|---|
| 工程管理 | 打开文件夹、空目录自动脚手架 (`writing/` `output/` `.ai-writer/`)、SQLite 初始化、文件树 |
| 编辑器 | CodeMirror 6 + GFM 语法高亮、**分栏预览**（左源码 / 右渲染）、源码模式 |
| 渲染 | markdown-it (GFM) + KaTeX + Mermaid、章节大纲导航 |
| 资源库 | 目录式实体浏览/创建/编辑、`index.md` frontmatter 解析、补充 `*.md`、本地图片预览（自定义协议） |
| AI 配置 | Provider/Model 管理（OpenAI 标准 + OpenAI 兼容 + Gemini）、Key 安全存储、计费单价配置 |
| AI 助手 | 续写 / 润色 / 改写 / 摘要；流式输出；**别名精准匹配 + 实体级向量召回 (RAG)** |
| 上下文记忆 | 四层组装（全局/Lore/滑动窗口/历史摘要）、Token 预算仪表盘与费用预估、记忆深度三档 |
| 基础设施 | 亮/暗/跟随系统主题、中/英 i18n、三栏响应式布局、底部状态栏 |

### 🟡 V1.1 延后（高价值但成本高）
- WYSIWYG（Typora 式）实时渲染模式 —— 技术风险高，先用分栏预览顶上
- 一致性校验 / OOC 冲突诊断面板
- 文稿快照与回滚（30 天历史）、设定变更历史 Diff 回滚
- Gemini Context Caching 深度适配 + 缓存抖动优化（确定性排序、懒轮换缓冲池）
- 离线本地嵌入（ONNX/WASM Bert）—— V1 先用在线 Embeddings + Ollama

### 🔴 V2+ 延后（独立大模块）
- AI 插图生成（Image2 / Nano banana）
- PDF 多模板导出（学术/小说/极简）
- iPadOS / Apple Pencil 适配
- 写作专注模式（打字机滚动、段落聚焦、全屏）
- 标签跨文档批量管理、语义去重缓存

> **建议**：若希望首版更快出可演示版本，可把「上下文记忆四层组装」在 V1 简化为「全局 + Lore 召回 + 滑动窗口」三层，历史摘要链放 V1.1。下文按完整四层规划，标注了可裁剪点。

---

## 2. 技术栈与关键依赖

| 层 | 选型 | 说明 |
|---|---|---|
| 应用框架 | **Tauri v2** | 体积小、内存低、v2 原生支持移动端编译 |
| 前端 | React 18 + Vite + TypeScript | PRD 指定 |
| 状态管理 | **Zustand** | 轻量，适合编辑器高频局部更新 |
| 样式 | Vanilla CSS Variables + CSS Modules | PRD 指定；主题靠 CSS 变量切换 |
| 编辑器内核 | **CodeMirror 6** | INP <8ms、百万字大文件、增量解析；优于 Monaco/ProseMirror 之于纯 MD |
| MD 渲染 | markdown-it + `markdown-it-katex` + Mermaid | GFM + 公式 + 图表 |
| 数据库 | SQLite via **`tauri-plugin-sql`** | `project.db` |
| 向量检索 | **`sqlite-vec`** 扩展 | 实体级向量，本地检索 |
| Key 存储 | **`tauri-plugin-stronghold`** 或 keyring | Keychain / Credential Manager |
| i18n | `i18next` + `react-i18next` | zh-CN / en |
| Rust 侧 | `reqwest`(可选), `notify`(文件监听), `serde` | AI 请求建议走前端 fetch，便于流式 |

**目录建议**
```
src/                     # React 前端
  components/            # 布局、编辑器、面板
  features/              # editor / lore / ai / project / settings
  stores/                # zustand
  lib/                   # markdown, rag, cmm(context memory), api clients
  i18n/
src-tauri/               # Rust 后端
  src/                   # 命令、自定义协议、fs、db、watcher
```

---

## 3. 分阶段实施 (Phased Plan)

每个 Phase 结束都应是**可运行、可演示**的。

### Phase 0 — 工程地基
1. `pnpm create tauri-app` (React+TS+Vite)，确认桌面三平台可构建。
2. CSS 变量主题系统：定义 design tokens（暗：`#0D0F12`/`#E2E8F0`/蓝紫渐变；亮：`#FAF9F6`/`#1F2937`），亮/暗/跟随系统切换。
3. i18next 接入，抽 zh/en 资源文件，搭好切换。
4. 三栏布局骨架（左可收起 / 中编辑区 800px 黄金宽度 / 右面板）+ 底部状态栏 + 侧边 tab。
5. Zustand store 骨架。
- **产出**：空壳应用，能切主题/语言，布局成型。

### Phase 1 — 工程管理 (Local-first 核心)
1. Tauri dialog「打开文件夹」+ fs 权限配置 (capabilities)。
2. 空目录检测 → 脚手架：`writing/` `output/` `.ai-writer/lore/{characters,world,factions,items,skills,custom}`。
3. `tauri-plugin-sql` 初始化 `project.db`，建表（见 §4 数据模型）。
4. 文件树组件，渲染 `writing/`，支持新建/重命名/删除文件与文件夹。
5. **自定义安全协议** `ai-writer-asset://` 注册（Rust 侧），把请求映射到工程目录物理文件，用于本地图片渲染（规避 CSP/`file://`）。
- **产出**：能打开/初始化项目，看到并管理文稿文件。

### Phase 2 — Markdown 编辑器
1. CodeMirror 6 集成：GFM 高亮、行号关闭、软换行、大文件性能验证。
2. 分栏预览：markdown-it 渲染管线 + KaTeX + Mermaid（懒加载）。
3. 章节大纲：解析 `#`~`######`，右侧树形导航，点击平滑滚动。
4. Frontmatter 解析（`gray-matter`）→ 提取 `tags`，文件读写。
5. 自动保存（debounce）写回磁盘。
- **产出**：可写作、可预览、有大纲导航的编辑器。

### Phase 3 — 写作资源库 (Lore)
1. 扫描 `.ai-writer/lore/` 目录树，按 6 大分类 + custom 组织实体列表。
2. 实体 = 文件夹；解析 `index.md` frontmatter（`name/aliases/category/summary`）。
3. 实体详情面板：编辑 `index.md` 与补充 `*.md`、展示 `avatar/concept_art`（走自定义协议）。
4. 新建实体（建文件夹 + 模板 `index.md`）、新建补充文件、自定义分类。
5. 实体元数据入 `lore_entities` 表（含向量化状态），文件监听 (`notify`) 触发重扫。
- **产出**：完整的设定库 CRUD 与浏览。

### Phase 4 — AI 配置
1. Provider 管理：名称、API URL、Key、API 标准（openai / openai-compatible / gemini）。
2. Key 用 `tauri-plugin-stronghold`/keyring 加密存储，**不入明文 DB**。
3. Model 管理：`id/name/type(text|multimodal|image|video)` + 计费（输入/缓存输入/输出，单位 /1M token）。
4. 「拉取可用模型列表」：按标准调 `/models`（OpenAI）或 Gemini list 接口。
5. 预置 prompt 管理与实时切换。
- **产出**：可配置多模型来源并切换。

### Phase 5 — RAG + 上下文记忆管理器 (CMM) — 核心
1. **Embeddings 抽象层**：在线（OpenAI/Gemini Embeddings）；Ollama (`nomic-embed-text`) 作为离线选项。(本地 ONNX 兜底 → V1.1)
2. **实体级向量化**：对每个实体（name + aliases + `index.md`）整体生成单一向量，存入 `sqlite-vec`；颗粒度到**词条级**，不做细碎 chunking。
3. **别名精准匹配**：扫描当前编辑区文本，命中别名即召回对应实体。
4. **向量相似度召回**：按记忆深度取 Top-N 实体的 `index.md`。
5. **CMM 四层组装**（按优先级拼接）：
   - L1 全局核心：System Prompt + 总大纲
   - L2 Lore 检索：别名命中 + 向量召回（默认只读 `index.md`）
   - L3 滑动窗口：光标前最近 N 字原文
   - L4 历史章节摘要链（*可裁剪到 V1.1*）
   - **确定性排序**：送入上下文的实体/摘要按名称字典序拼接（为后续缓存命中铺路）。
6. **AI 任务**：续写 / 润色 / 改写 / 摘要；右侧聊天面板；**流式**输出（前端 fetch + SSE/stream 解析）。
7. **Token 预算仪表盘**：发送前估算上下文 token、预计消耗、按单价折算费用；记忆深度三档（极简/标准/深邃）。统计入 `token_usage` 表，状态栏展示。
- **产出**：选中段落/光标处触发，AI 按设定续写并实时显示成本 —— **核心价值闭环达成**。

### Phase 6 — 导出（精简版）
1. HTML：自包含单文件（内联 CSS + 图片转 base64/内联）。
2. Markdown：剥离本地资源链接的打包导出。
3. PDF：单一默认模板（用打印渲染或 `typst`/headless）。多模板 → V2。
- **产出**：可导出成果。

---

## 4. 数据模型 (project.db 草案)

```sql
-- 设定实体索引（文件夹为真源，DB 为缓存/索引）
lore_entities(id, category, dir_path, name, aliases_json, summary,
              embedding_status, updated_at)
-- 实体向量（sqlite-vec 虚拟表）
lore_vectors(entity_id, embedding /* vec */)
-- AI 配置
providers(id, name, base_url, api_standard /* openai|openai_compat|gemini */)
models(id, provider_id, model_id, name, type,
       price_in, price_cached_in, price_out /* per 1M */)
prompts(id, name, content, scene)
-- 用量统计
token_usage(id, model_id, task, prompt_tokens, cached_tokens,
            completion_tokens, cost, created_at)
settings(key, value)   -- 主题/语言/记忆深度等
-- （V1.1）快照与历史
snapshots(id, file_path, diff_json, created_at)
```
> Key **不入此库**，走系统 Keychain。

---

## 5. 风险与决策点

| 风险 | 影响 | 对策 |
|---|---|---|
| WYSIWYG 实时渲染复杂度高 | 可能拖垮编辑器 | V1 用分栏预览，WYSIWYG 列 V1.1 |
| `sqlite-vec` 在 Tauri 打包/多平台加载 | 阻塞 RAG | Phase 0 末先做技术验证 (spike) |
| 流式 + 三家 API 标准差异 | 联调成本 | 抽 `AiClient` 接口，三个实现适配 |
| 百万字大文件 INP<8ms | 性能验收 | CodeMirror 6 + 虚拟化，Phase 2 做压测 |
| Context Caching 抖动优化 | 省钱核心但复杂 | V1 只做确定性排序打底，缓冲池/前缀缓存 V1.1 |

**首个技术验证 (spike, 建议 Phase 0 内完成)**：Tauri v2 中跑通 `sqlite-vec` 加载 + 一次 embedding 写入/检索；确认自定义协议渲染本地图片。这两点是后续模块的地基。

---

## 6. 建议里程碑顺序

```
P0 地基 → P1 工程管理 → P2 编辑器 → P3 资源库 → P4 AI配置 → P5 RAG+CMM → P6 导出
                                                         ▲
                                              （核心价值在 P5 达成，可先内部演示）
```

最小可演示节点：**P2 完成**（能写作）即可对外展示编辑体验；**P5 完成**即达成产品差异化卖点。
</content>
</invoke>
