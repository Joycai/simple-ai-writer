# PPTX 支持计划（读取端已实施，生成端待定）

> 状态：**读取端一期 + 二期已实施**（本 PR）。生成端**未做**，四个候选方案与推荐记录在 §4，等作者拍板。
> 背景：作者需要 AI 助手能读演示文稿（招标材料、路演稿、培训课件常以 .pptx 交付），并且要能处理几百页的大文件；生成 pptx 是另一件事，成本和风险都高一个量级，所以拆开。

## 1. 现状盘点（规划前逐项核实）

| 环节 | 规划前的现状 |
|---|---|
| 导入 | `CONVERT_EXTENSIONS` 只有 docx / xlsx / pdf。.pptx 连文件选择器都不出现 |
| Agent 读 | `read_file` 读 .pptx 得到 zip 二进制噪声，模型多半判定"文件是空的" |
| `search_text` | 只扫 `isChapterFile ∪ isHtmlPath`，与 .pptx 无关 |
| Rust 依赖 | `zip`（deflate，lore bundle 在用）是直接依赖；`quick-xml` 已在树里（calamine 的传递依赖），提为直接依赖不增加任何构建产物 |
| 分页先例 | `read_file` 已有按行分页（4000 字符/次，尾注给出下一个 `start_line`），`lib/agent/tools.ts` |
| 大材料先例 | `longread` / `pdf` subagent：独立上下文读完，主对话只收摘要（`docs/subagent-lld.md`） |

结论：**读取端缺的只是一个解析器和一个工具**，分页协议和大文件兜底都是现成的。

## 2. 关键决策（含弃用理由）

### D1 解析在 Rust，不在 webview

与 `xlsx.rs` 同一条理由：zip 读取器已经在 Rust 里，`quick-xml` 也在。放前端要引一个 JS zip 库（项目里没有），还要把整份 deck 读进 webview 内存。

- 弃用【前端 JSZip + DOMParser】：新依赖，且把大文件的内存压力放在 UI 线程上。

### D2 顺序来自 `<p:sldIdLst>`，不是文件名

`ppt/slides/slide10.xml` 按字典序排在 `slide2.xml` 前面，而且文件名本就不权威——真实放映顺序是 `presentation.xml` 的 `<p:sldIdLst>` 经关系 id 解析出来的。按目录读会**静默**打乱整份演示，这是那种测试不写就永远发现不了的错。

对应测试：`slides_come_back_in_running_order_not_file_name_order`（十页，按名排序会把第 10 页排到第 2 位）。

### D3 两个入口，一个转换函数；Agent 那个走**路径**而不是字节

- 导入器（`pptx_to_markdown`）拿字节：文件在项目外，是作者从原生对话框选的，`FsScope` 管不到它。
- Agent 的 `read_slides`（`pptx_read_slides`）拿路径：文件已经在工作区里，`FsScope::check` 能担保它，和其他 `fs_*` 命令同一条纪律；而且**翻页时整份 deck 从不跨 IPC**——把字节送过去再切，等于每翻一页搬一次整个文件，分页也就白做了。

字节那一路用 **base64** 而不是 `xlsx_to_markdown` 的数字数组：JSON IPC 两种都行，但数字数组把文件撑大约四倍且要在 UI 线程上逐元素序列化，而 deck 里大部分体积是转换器根本不要的图片。与 `fs_write_binary_file` 同一种编码。

### D4 分段单位是**页**，不是行；协议照抄 `read_file`

`read_slides` 渲染整页直到 4000 字符预算花完，然后在页边界停下，尾注写：

```
[... slides 8-24 of 30 shown; call read_slides again with start_slide=25 to continue ...]
```

- **为什么是页**：页是演示文稿自己的坐标，模型手里也只有这个坐标（没有"第几行"可言）。
- **为什么形状要和 `read_file` 一样**：两个工具翻的是不同的东西，但学会了一个的模型不该再学一遍另一个。
- **一页超预算仍整页返回**：同 `read_file` 对超长行的规则——一个可能返回空的预算等于没给出路。单页另有 4000 字符硬顶，超出显式声明截断（`xlsx.rs` 的既有纪律：静默截断和"这页本来就短"长得一模一样）。
- **只解析范围内的页**：顺序表和 zip 条目都按名取，翻一页的成本是一页而不是整份。

### D5 `read_slides` 是独立工具，不是 `read_file` 的一个分支

- .pptx 不是磁盘上的文本，`read_file` 对它只能返回噪声；
- 两者的分页参数含义不同（行 vs 页），塞进一个工具意味着 `start_line` 的语义随扩展名漂移；
- `read_file` 遇到 .pptx 直接改口指向 `read_slides`——否则模型要花一整轮读二进制，然后得出"文件是空的"这个错误结论。

### D6 `search_text` 不扫 .pptx

全文搜索要遍历整个项目，解 zip + 解 XML 比读文本贵一个数量级，而这条路径每次搜索都会走。导入后的 markdown 本来就在搜索面里；没导入的 deck 由 `read_slides` 的工具描述引导模型去读。

### D7 超大文件的最后一道防线是 subagent，不是更大的预算

`read_slides` 进 `longread` 的工具集。三百页的 deck 丢给它，主上下文只收回摘要 + note 路径——这条纪律 `docs/subagent-lld.md` 已经立好，不需要为 pptx 新发明一套。

### D8 `.ppt`（PowerPoint 97-2003）不支持

OLE 复合二进制，不是 zip，Rust 生态没有可靠解析器。与导入器排除 `.doc`/`.xls` 是同一条判断：**半乱码的导入结果和成功的长得一模一样**。导入器不收它；`read_slides` 明说要先另存为 .pptx，而不是让解析在中途炸掉。

### D9 转换出来的 markdown 长什么样

```markdown
<!-- slide 3 -->

## Slide 3 · 实施路径

- 一期：接入行情
  - 延迟 < 5ms
- 二期：策略上线

| 项目 | 金额 |
| --- | --- |
| 服务器 | 12000 |

_[image: image7.png]_

> **Notes:** 这里讲慢一点，重点是延迟指标
```

- `<!-- slide N -->` 与 PDF 导入的 `<!-- page N -->` 对齐：预览里不可见，但给了答案一个可引用的位置，也能活到 RAG 上下文里。
- **正文段落一律渲染成按 `lvl` 缩进的列表项**。演示文稿的正文压倒性地是要点式的，层级才是值得保留的信息；一个纯散文文本框被渲染成一条 bullet 是更便宜的那种错。
- **演讲者备注只取 body 占位符**：备注页里还有一份幻灯片自身文字的缩略图副本，全取会把每页内容重复一遍。
- 标签用英文（`## Slide`、`> **Notes:**`、`_(no text on this slide)_`）：与 `xlsx.rs` 的 `**Formulas**` / `_(empty sheet)_` 保持一致，Rust 侧没有 i18n。

### D10 `lib/fs/pptx.ts`，不是 `lib/import/pptx.ts`

docx/xlsx/pdf 的转换器都在 `lib/import/`，因为它们只有导入这一个消费者。pptx 有两个：导入器和 agent 的 `read_slides`。让 `lib/agent/tools.ts` 去 import 一个叫 "import" 的模块是错的分层。

## 3. 已实施（读取端一期 + 二期）

| 文件 | 内容 |
|---|---|
| `src-tauri/src/pptx.rs` | 解析 + 渲染 + 分页；15 个单测（顺序、标题/层级、备注、表格、图片、空页、分页边界、超长页、越界、坏字节） |
| `src-tauri/Cargo.toml` | `quick-xml` 提为直接依赖（已在树里，版本对齐 0.41） |
| `src-tauri/src/lib.rs` | 注册 `pptx_to_markdown` / `pptx_read_slides` |
| `src-tauri/src/xlsx.rs` | `escape_cell` 提为 `pub(crate)`——表格单元格里的竖线会提前结束单元格，与产出它的是哪种文件无关，两份实现只会漂移 |
| `src/lib/fs/pptx.ts` | 两个 IPC 跳；`isPptxPath`；32MB 上限 |
| `src/lib/fs/fileio.ts` | `toBase64` 导出（原本私有） |
| `src/lib/import/index.ts` | `CONVERT_EXTENSIONS` 加 `pptx` |
| `src/lib/agent/tools.ts` | `readSlidesFile` + 纯函数 `formatSlideRange`；`read_file` 对 .pptx 改口 |
| `src/lib/agent/registry.ts` | `read_slides` 工具定义 |
| `src/lib/agent/presets.ts`、`subagent.ts` | 进 `CONTINUE` / `AGENT_ASSIST` / `longread` |
| i18n | 工具标签 `read_slides`；agent 系统提示里的工具清单补上它（清单不补就是错的） |

**验证**：15 个 Rust 单测 + 8 个前端测试（分页尾注、续读、末页、非 pptx、`.ppt`、`.ai-writer` 围栏、`read_file` 改口）。另外拿 python-pptx 生成的**真实** pptx 跑过转换（标题占位符、三级缩进、`&`/`<` 实体、备注去重、表格转义、图片、空页全部正确），和一份 30 页的真实 deck 跑过分页与续读；一份微软自带的空白模板验证了 zip/rels/sldIdLst 这条路径。

**未做**：`.pptx` 在编辑器里没有预览（点开仍是二进制），FileTree 没有专属图标，`@` 选择器不收 .pptx。这些是三期，取决于二期用下来是否真需要。

## 4. 生成端：四个候选（**未实施**）

### 方案 A —— Slides Markdown 源文件 + 确定性导出（**推荐**）

模型用现有的 `create_file` 写 `xxx.slides.md`（`---` 分页），作者审、改、迭代，再一键导出 pptx。

- 生成端零新机制：`create_file` / `propose_edit` / `rewrite_document` 原样可用（同 `docs/html-artifact-plan.md` D1）。
- 审批卡看到的是**内容**不是二进制；能 diff、能改单页、能回滚；`@` 和 `search_text` 天然覆盖。
- 代价：版式表达力受模板限制。

### 方案 B —— 模型直接调一组 pptx 工具（Claude Desktop 的做法）

`create_presentation` / `add_slide` / `add_text_to_slide` / `insert_image` / `save_presentation`。

**不建议**：一份 30 页 deck 是上百次工具往返（round cap 顶穿、token 贵）；审批模型崩坏（要么每次调用一张卡，要么整个二进制无审批落盘）；产物不可 diff、不可 `propose_edit`。Claude Desktop 能这么做，是因为它没有本 app 的 L2 审批纪律。

### 方案 C —— HTML 幻灯片（**今天就能用**）

模型写单文件 HTML（reveal 式分页），沙箱 iframe 预览已通，导出走 `print.rs` 得 PDF。要 pptx 只能每页截图贴成图片版——文字不可编辑。定位是"要炫版式"时的补充，不是可编辑 pptx 的答案。

### 方案 D —— 结构化 JSON deck + 渲染器

`structured.ts` 的 forced tool_choice 让模型吐 deck JSON，确定性渲染。本质是 A 把 markdown 换成 JSON：换来校验，赔掉作者的可读可编辑。

### 子选择：转换器放哪

| | pptxgenjs（前端 lazy import） | Rust 手写 OOXML |
|---|---|---|
| 依赖 | 新增 ~1MB npm 包 | 零新依赖（`zip` 已在） |
| 风险 | 维护良好、MIT | **写比读难一个量级**：母版 / theme / rels 一处不对，PowerPoint 直接弹"需要修复" |
| 图片 / 表格 / 备注 | 开箱即有 | 每样都要自己写 |

倾向 pptxgenjs。读用 Rust（对称 xlsx、零依赖）、写用 JS 库，这个不对称是有理由的：**读一个格式和写一个格式的难度不在一个量级上**。

## 5. 不变式与风险

- **`.pptx` 不是章节**：不进 spine、不进 bookContext、不进 RAG/前情记忆，`isChapterFile` 不动。导入后的 `.md` 是普通文档，按普通文档待遇走。
- **分页永远在页边界**：任何让 `read_slides` 返回半页的改动都会破坏"尾注给出的 `start_slide` 能续上"这个契约。
- **截断必须发声**：单页 4000 字符顶、整份导入 500 页顶，两处都在输出里写明。
- **风险：版式复杂的 deck 提取质量**。SmartArt、组合图形里的文字、文本框的绝对定位顺序——当前实现按 XML 文档顺序取，遇到自由排版的宣传页会给出一个顺序古怪的列表。这是格式的固有限制（同 PDF 导入丢表格版式），不打算靠启发式去猜。
