# PPTX 支持计划（读取 + 生成，均已实施）

> 状态：**读取端一期 + 二期已实施**（PR #223）。**生成端已实施，作为 Settings → AI 配置 → 实验室 里的 Beta 开关**（§4）。
> 背景：作者需要 AI 助手能读演示文稿（招标材料、路演稿、培训课件常以 .pptx 交付），并且要能处理几百页的大文件。生成是另一件事，成本和风险高一个量级，所以拆开做、拆开记。

## 1. 现状盘点（规划前逐项核实）

| 环节 | 规划前的现状 |
|---|---|
| 导入 | `CONVERT_EXTENSIONS` 只有 docx / xlsx / pdf。.pptx 连文件选择器都不出现 |
| Agent 读 | `read_file` 读 .pptx 得到 zip 二进制噪声，模型多半判定"文件是空的" |
| `search_text` | 只扫 `isChapterFile ∪ isHtmlPath`，与 .pptx 无关 |
| Rust 依赖 | `zip`（deflate，lore bundle 在用）是直接依赖；`quick-xml` 已在树里（calamine 的传递依赖），提为直接依赖不增加任何构建产物 |
| 分页先例 | `read_file` 已有按行分页（4000 字符/次，尾注给出下一个 `start_line`），`lib/agent/tools.ts` |
| 大材料先例 | `longread` / `pdf` subagent：独立上下文读完，主对话只收摘要（`docs/feature/agent/subagent-lld.md`） |

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

`read_slides` 进 `longread` 的工具集。三百页的 deck 丢给它，主上下文只收回摘要 + note 路径——这条纪律 `docs/feature/agent/subagent-lld.md` 已经立好，不需要为 pptx 新发明一套。

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

**后续增补（2026-08-29）**：导入这条路（`pptx_to_markdown`）现在会抽取 deck 的光栅图片——`_[image: …]_` 占位变成指向 `assets/<文档名>/` 的真链接，字节作为 `PptxImport.assets` 随 IPC 回传。`read_slides` 的翻页路径**不受影响**（收集器传 `None`，占位符原样），D3「翻页时整份 deck 从不跨 IPC」不破。设计与取舍记在 `docs/feature/import-images-plan.md` §9。

## 4. 生成端：HTML → PPTX（已实施，Beta 开关）

### 4.1 起点：作者已经在用 HTML

规划生成端时的实际情况是：作者早就在让助手写 `.html` 交付物，而且**结果很好**——HTML 是模型真正擅长的排版语言，这个 app 又已经能预览它、审批它、让作者接着改它（`docs/feature/html-artifact-plan.md`）。

所以问题不是"怎么让模型生成 pptx"，而是"**怎么把已经很好的 HTML 变成 pptx**"。这两个问题的答案完全不同。

### D11 转换不经过模型

一度考虑过的做法是「让模型写一段 Python 把 HTML 转成 pptx」。**否掉**，三条，按严重性排：

1. **这里没有 Python 运行时。** 要么打包一个解释器（每平台 ~50MB，还要预装 python-pptx），要么赌用户机器上有 `python3` 并且 pip 装得上——Windows 上基本等于不可用。
2. **执行模型生成的代码是一个全新的信任层。** 这个 app 最危险的动作是"写一个文件，且必须过审批卡"。跑一段生成的脚本，它能读写整个磁盘、能联网，而且**审批卡审不了**——作者看两百行 Python 判断不出它会干什么。做这件事的产品有沙箱，这里没有。
3. **每次生成一个新脚本 = 不可复现。** 同一份 HTML 今天和明天转出来不一样，出了问题也无从修——能修的只有提示词。

### D12 webview 已经把版排好了，问它就行

关键一点：**转换不需要重新实现 CSS。** 页面已经在 iframe 里布局完成，`getBoundingClientRect` 会精确地说出每个盒子和每一行文字落在哪里。所以整条链路是确定性代码：

```
.html  →  沙箱 iframe 里渲染  →  量出每个盒子  →  写成 PowerPoint 形状  →  .pptx
```

- flex、grid、绝对定位、嵌套——用什么排的无所谓，只读最终结果。
- 文字仍是**真文字**，PowerPoint 里能改。这是产出 .pptx 而不是 PDF 的唯一理由。
- 同一份文件每次转出来一样，没有生成的脚本需要审。

### D13 采集脚本注入进沙箱，用 postMessage 应答

预览用的是 `blob:` + `sandbox="allow-scripts"`，**不给** `allow-same-origin`（见 `HtmlPreview`）——所以页面的脚本进不了 app，app 也读不到页面的 DOM。后半句正是要处理的：采集脚本被**注入**进去，答案靠 `postMessage` 回来。安全模型一点不动，页面自己的脚本从来没有在 app 上下文里执行过。

消息认两件独立的事：`event.source` 必须是这个 frame 自己的 `contentWindow`，且携带编译进脚本的一次性 nonce。

### D18 采集脚本靠 CSP `sha256-` 放行（**修 bug 时补的，很重要**）

一期发出去的版本**在 app 里根本跑不起来**：每次导出都是 20 秒静默超时，任何页面都一样，包括空白页。

原因是 `docs/feature/html-artifact-plan.md` D2 写错了一条事实（现已更正）：`blob:` 文档不是"opaque origin 所以不受主窗 CSP 约束"——`blob:` 是 local scheme，**继承创建它的页面的 CSP**。app 的 `script-src` 是 `'self'`，于是注进去的采集脚本一行都没执行。真浏览器对照实验（加不加 `sandbox` 各一次）两次都是 `Executing inline script violates ... 'script-src 'self''`。

修法是 CSP hash——正是它存在的理由：

```jsonc
// src-tauri/tauri.conf.json
"script-src": "'self' 'sha256-<harvester.js 的摘要>'"
```

- **只放行那一个脚本。** 页面自带的内联脚本（模型写的）照样全部拦住——实测验证过一次"我们的跑了 / 它的没跑"。比 `'unsafe-inline'` 严格得多，威胁模型不但没松反而说得更死：这个 frame 里能执行的代码，只有我们自己那份。
- **不给 `allow-same-origin`。** 曾考虑过：给了就能让 app 直接读 frame 的 DOM，采集代码变成普通 TypeScript（可测！）、不用注入、不用 postMessage。否掉的理由是它把"AI 脚本进不了 app 上下文"这条保证从 sandbox 转嫁给 CSP——今天成立，但哪天有人为了别的需求给 `script-src` 加上 `'unsafe-inline'`，这就是一个静默的洞。
- **两条施工纪律**，都由 `pptxHarvesterCsp.test.ts` 钉住：hash 覆盖 `harvester.js` 的**字节**，改文件就得改 conf（漂了的症状还是那个 20 秒静默超时，日志里什么都没有）；每轮变化的数据（nonce）只能放**属性**，塞进脚本正文会让每次的 hash 都不一样。
- **换行归一化**后再算 hash，否则 Windows 上 CRLF 检出的 clone 摘要不同，只在那台机器上坏。

### D14 分层：能不碰 DOM 决定的，都不在 DOM 里决定

| 文件 | 职责 | 可测 |
|---|---|---|
| `harvester.js` | 在沙箱里量。只测量和分类，**不做判断** | ✗（jsdom 无布局引擎，量什么都是 0） |
| `deck.ts` | 单位换算、幻灯片尺寸、颜色解析、剪枝、文本余量 | ✓ 17 个测试 |
| `write.ts` | 交给 pptxgenjs | ✓ 产出真 zip 并校验分片 |

这个切法就是为了让**有 bug 的那一层可测**。事实证明是对的：三个真 bug 全在可测层之外，靠真浏览器 + 真 pptx 回读才发现（§4.4）。

### D15 转换器用 pptxgenjs，与读取端的 Rust 不对称

读 pptx 在 Rust（对称 xlsx、零新依赖），写 pptx 在 JS 库。这个不对称是有理由的：**写一个格式比读它难一个量级**——母版、theme、rels 一处不对，PowerPoint 直接弹"需要修复"。而且写这一端本来就必须在 renderer 里（要 DOM 才能排版），Rust 侧根本够不着。

pptxgenjs 是 lazy import 的独立分片（272KB），没开 Beta 的作者一个字节都不下载。

### D16 入口两个，都在作者这边

- **AI 助手**：`export_pptx` 工具。模型先用 `create_file` 写 `.html`（原有流程，原有审批卡），再调这个工具——它出一张卡说明「从哪个页面 → 生成哪个文件」，作者批准后才真的转换。
- **作者自己**：`.html` 预览工具栏一个「导出 PPTX」按钮，外加**文件面板右键菜单**上的同一项（2026-08 补）。两处调的是同一个 `exportHtmlToPptx(path)`，也都先 flush 编辑器——它从磁盘读那份文件，导出上一次自动保存的版本是一句悄悄话式的谎。加树上那一个是因为**一份交付稿不必先在编辑器里打开才能导出**：作者对着文件列表想的是「把这份变成幻灯」，而不是「先打开它，再去右边那条工具栏」。菜单里 Beta 关着时那一项**不存在**而不是禁用，与 D17 同一条规矩。

`export_pptx` 是 `write-approval`（L2）。转换本身没有模型参与、不花钱、不破坏任何东西，但它**在作者的项目里生成一个新文件**——每一个这样的写入都要过卡，这条纪律不为"这次很安全"破例。同理它进了 `AUTO_APPROVABLE`：调版式意味着反复导出同一个文件，"本次都批准"应该覆盖它。

### D17 Beta 开关 = 工具**不存在**，而不是被拒绝

`routeTools` 在开关关闭时把 `export_pptx` 从工具列表里删掉（`lib/agent/routing.ts`），和 imagegen 未绑定时删掉画图工具是同一条规则：一个模型看得见、调了却总是回答"作者没开这个功能"的工具，在作者眼里就是助手坏了，而且白花一轮。

### D19 SVG 栅格化前必须把计算样式内联进去

发出去的第一版有个**静默错**的 bug：SVG 在 HTML 预览里完全正常，导出后整块变纯黑。

原因是序列化出来的 `<svg>` 是一份**独立文档**——页面的样式表一条都不跟着走。于是这三类全部回落到 SVG 默认的 `fill: black`：

- 靠页面 CSS 上色的（`.chart rect { fill: … }`）——AI 写的图示里最常见的一种；
- `fill="currentColor"`（靠继承拿颜色）；
- `<text>` 的字体、字号、颜色。

只有直接写在元素上的呈现属性（`fill="#f472b6"`）能活下来。

修法是导出 SVG 的标准做法：序列化前遍历原节点，把 `getComputedStyle` 的结果**内联**写到克隆节点上——一次就同时解决了样式表、继承和 `currentColor`（计算值里 `currentColor` 已经解析成具体颜色了）。四色对照实测：

```
              修前              修后
属性上色      rgb(244,114,182)  rgb(244,114,182)   ✅ 本来就对
页面 CSS      rgb(0,0,0)   ❌   rgb(56,189,248)    ✅
currentColor  rgb(0,0,0)   ❌   rgb(34,197,94)     ✅
<text>        rgb(0,0,0)   ❌   rgb(225,29,72)     ✅
```

三条附带的：

- **`transform` 故意不抄。** 属性形式本来就在克隆里，而计算形式是矩阵，CSS 和 SVG 两侧的 transform-origin 规则不同——抄过去会挪动本来没问题的东西。
- **`<svg>` 元素自己的 CSS 背景**单独发一个矩形垫在底下。它在页面里画得出来，但不属于 SVG 文档，栅格化时必然丢。
- **`<img src="…svg">`** 不再原样透传给 PowerPoint（它对 SVG 的支持不稳），一律走 canvas 转成 PNG。

**这类 bug 最坏的地方是它"成功"了**：栅格化没报错，只是画错，所以既没有异常也没有降级提示可发。唯一的防线是不制造它——所以纪律写在这里，而不是指望下次谁记得。

### 4.2 保真度：三件不同的事

| | 程度 | 为什么 |
|---|---|---|
| 看起来一样吗 | 高 | 坐标是量出来的，不是重算的 |
| 打开后能改吗 | 中 | 取决于多少东西留成了真文字/真形状 |
| 像不像一份正常的 PPT | 靠剪枝撑住 | DOM 里几百个纯布局容器直译过去就是几百个不可见矩形 |

第三条最容易被忽略也最决定客户愿不愿意接手：`pruneBlocks` 丢掉没有可见绘制（无填充、无边框、无文字）的盒子。不剪的话视觉上完美，打开一看图层面板三百层，等于交了个不能改的东西——那还不如直接给截图。

**头号风险不是冷门 CSS，是字体和文本回流**：HTML 的换行引擎不是 PowerPoint 的，同样宽度同样字号，网页里三行的段落在 PowerPoint 里可能变四行然后溢出；web font 更进不了 pptx，机器上没有就替换，一替换整版位移。三道应对：文本框按**字形**而不是容器测量（`Range.getBoundingClientRect`）、四周留 6% 余量且左右对称（居中/右对齐文字不会漂）、多行文本允许 PowerPoint 自动缩字号。剩下的靠引导——工具描述里明确要求用系统字体。

**直接映射**：位置尺寸、纯色背景、边框、圆角、透明度、旋转、`<img>`、字体/字号/粗细/斜体/颜色/对齐，段落内富文本（`<strong>` 变成一个 run 而不是第二个文本框），列表符号（marker 不是文本节点，单独测量后补进去并把框左扩相应宽度）。

**退化成图片**：内联 SVG（图示类内容基本都走这条，视觉一致但不再是可编辑形状）、`<canvas>`。SVG 栅格化前会**把计算后的样式内联进克隆节点**——见 D19，这是它看起来对不对的分水岭。

**退化成近似**：渐变背景 → 色标平均色（pptxgenjs 不给渐变填充，整块丢掉会在设计里留白洞）。

**丢掉**：CSS 滤镜、混合模式、文字阴影、动画、滚动区域。

每次导出都把降级项列给作者，`degradedSummary` 一行一条——只说"完成"会把变成平色的渐变藏起来。

### 4.3 被否掉的其它方案

- **Slides Markdown 源 + 确定性导出**：让模型写 `xxx.slides.md` 再转 pptx。它的前提是"作者需要一个可读可编辑的中间源"——而作者已经有了，就是 HTML，而且 HTML 的版式表达力高一个量级。多一种中间格式只是多一样要学的东西。
- **模型直接调一组 pptx 工具**（`add_slide` / `add_text_to_slide` …，某些桌面产品的做法）：一份 30 页 deck 是上百次工具往返，round cap 顶穿、token 贵；审批粒度崩坏（要么每次调用一张卡，要么整个二进制无审批落盘）；产物不可 diff、不可 `propose_edit`。
- **每页截图贴进 pptx**：一天就能做，永远"保真"，但文字不可编辑——那等于交一份 PDF，客户改不了。保留为将来单个元素的兜底思路，不作为整体方案。
- **结构化 JSON deck + 渲染器**：换来校验，赔掉作者的可读可编辑。

### 4.4 验证

- **单测**：`pptxDeck.test.ts`（17）单位/尺寸/颜色/剪枝/余量/圆角，`pptxWrite.test.ts`（2）产出真 zip 且分片数对，`routing.test.ts` 两条钉住 Beta 开关两个方向。
- **真浏览器**：把 `harvester.js` 注进真的 `blob:` + `sandbox="allow-scripts"` iframe（与生产完全同一条路径），对一份三页测试 deck 采集，逐块核对坐标、字号、粗斜体、富文本 run 拆分、`data-pptx-skip`、渐变平均色、SVG 栅格化、列表符号。
- **真 pptx 回读**：生成的文件用 python-pptx 读回来，核对幻灯片尺寸、每个形状的英寸坐标、字号磅值、颜色、`prstGeom`、`adj`。

这一步抓到三个真 bug，全都不在单测能覆盖的层：

1. **`requestAnimationFrame` 在隐藏 frame 里被挂起**，采集永远不返回。导出 frame 是故意离屏 + `visibility:hidden` 的，而不被绘制的 frame 动画回调会被整个暂停。改成定时器，并给 `document.fonts.ready` 加了兜底超时（它也可能永不 settle）。
2. **`LAYOUT_16x9` 不是 16:9 宽屏**。pptxgenjs 的 "16x9" 是 10×5.625in（旧宽屏），PowerPoint 2013 起默认的 13.333×7.5 在它那儿叫 `LAYOUT_WIDE`。选错了视觉上毫无异常——直到这份 deck 和别人的合并，它以四分之三的尺寸出现。
3. **`rectRadius` 的单位是英寸，不是比例**。OOXML 的 `adj` 是比例，所以传比例看起来天经地义；pptxgenjs 自己会除以短边。传错的结果是圆角明显变小，没有任何东西报错。

**验证的缺口，以及它的代价**：上面这些实验都跑在 `localhost` 上，而那个页面**没有 CSP**——于是整条链路里最关键的一环（blob 文档继承主窗 CSP）从头到尾没有被测到，功能发出去在 app 里一次都没成功过。补的办法是让探针页面挂上 `tauri.conf.json` 里**真实的** CSP 再跑一遍：现在验证的是"hash 放行的采集脚本跑了 + 页面自带脚本被拦住 + deck 正确采集"。

**仍未验证**：桌面 app 里没跑过——Settings 开关、审批卡、`export_pptx` 的完整链路只有类型检查和单测担保（这台机器上 Vite dev server 起得来但没有项目和模型，导出要读磁盘上的文件）。

### D19 `read_slides` 也读 .html——同一个工具，不是第二个（2026-08-19）

生成端让模型把 deck 写成 HTML，但**读回来**只有 `read_file`，按 4000 字符盲翻。
改第 7 页要先翻十几次才找得到它，找到之后 `propose_edit` 还需要那一页的精确源码去引用。
所以 `read_slides` 增加一条 .html 分支（`lib/pptx/htmlSlides.ts`）。

- **为什么不是新工具**（与 D5 只是表面矛盾）：D5 讲的是 `read_slides` 不该是 `read_file` 的分支——
  那两者的分页单位不同（行 vs 页），合并会让 `start_line` 的语义随扩展名漂移。
  这里恰恰相反：两种 deck 的分页单位**都是页**，`start_slide` 含义完全一致，
  模型的问题是「给我看第 7 页」，deck 存成哪种格式不属于这个问题。
- **返回逐字节的原始 HTML**，不是渲染后的文本：模型拿到它之后的下一个动作，
  就是把其中一段抄进 `propose_edit` 的 `find`。渲染过的文本抄回去对不上。
- **切分约定必须与 `harvester.js` 的 `SLIDE_SELECTORS` 一致**，否则「第 7 页」在读和导出时
  是两个东西，作者审「第 7 页的改动」会看错框。harvester.js 是以原始文本注入沙箱帧的
  （它 import 不了任何东西，而且 D18 之后它的**字节**被写进了 CSP 的 `sha256-`，更不可能长出 import），
  所以这份不变量靠测试守：`htmlSlides.test.ts` 把列表从 harvester 源码里解析回来逐条对比。
- **纯文本切分，不碰 DOM**（D14 的同一条纪律）：`harvest.ts` 那个离屏帧存在的意义是**量**页面，
  需要真实布局；切源码不需要布局。纯函数才是能承载测试的那部分——
  扫描器要跳过 `<script>`/`<style>`/注释（生成的 deck 里 `<script>` 字符串常出现 `<section>`，
  数进去就会在错误的位置收页），属性值里的 `>` 也不能提前结束标签。
- **切不开的页有硬顶**：选择器一个都没匹配上时 body 就是唯一一页，可能有 60k 字符。
  整页返回会让一次调用吃掉整轮上下文，所以按预算截断并给出 `read_file` 的 `start_line` 接力——
  和 D4「一页超预算仍整页返回」的取舍不同，因为那里的一页是真的一页，这里的一页是**切分失败**。

## 5. 不变式与风险

- **`.pptx` 不是章节**：不进 spine、不进 bookContext、不进 RAG/前情提要，`isChapterFile` 不动。导入后的 `.md` 是普通文档。
- **分页永远在页边界**：任何让 `read_slides` 返回半页的改动都会破坏"尾注给出的 `start_slide` 能续上"这个契约。
- **`.html` 的分页与导出的分页同源**：`htmlSlides.ts` 的选择器表和 `harvester.js` 的 `SLIDE_SELECTORS` 必须逐条一致——不一致的那天，作者审的「第 7 页」和导出的第 7 页不是同一页。`htmlSlides.test.ts` 把这份列表从 harvester 源码里解析回来对比，所以动 `harvester.js` 要同时看两处：D18 的 `sha256-`，和这张表。
- **截断必须发声**：单页 4000 字符顶、整份导入 500 页顶、导出的每一处降级，三处都写进输出。
- **沙箱参数不动**：导出 frame 与预览 frame 的 `sandbox` 必须保持一致（`allow-scripts`，**没有** `allow-same-origin`）。加上 same-origin 会让 app 能直接读 DOM——省掉注入和 postMessage，同时把 AI 生成的脚本放进 app 上下文。不做。
- **风险：版式复杂的 deck 提取质量**。SmartArt、组合图形里的文字、自由排版的宣传页——读取端按 XML 文档顺序取，会给出顺序古怪的列表。格式的固有限制（同 PDF 导入丢表格版式），不靠启发式去猜。
- **风险：导出端的字体**。系统字体之外的一切都是赌 PowerPoint 打开时那台机器上有。引导里写了，但引导不是保证。
