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

**头号风险不是冷门 CSS，是字体和文本回流**：HTML 的换行引擎不是 PowerPoint 的，同样宽度同样字号，网页里三行的段落在 PowerPoint 里可能变四行然后溢出；web font 更进不了 pptx，机器上没有就替换，一替换整版位移。三道应对：文本框按**字形**而不是容器测量（`Range.getBoundingClientRect`）、四周留 6% 余量且左右对称（居中/右对齐文字不会漂）、多行文本允许 PowerPoint 自动缩字号。剩下的靠引导——工具描述里明确要求用系统字体，`inspect_html` 的源码预检（§7）把非系统字体点名到行。

**直接映射**：位置尺寸、纯色背景、边框、圆角、透明度、旋转、行高、字距、`<img>`（含 `object-fit` 裁剪与自身圆角）、字体/字号/粗细/斜体/颜色/对齐，段落内富文本（`<strong>` 变成一个 run 而不是第二个文本框），列表符号（marker 不是文本节点，单独测量后补进去并把框左扩相应宽度）。

**退化成图片**：内联 SVG（图示类内容基本都走这条，视觉一致但不再是可编辑形状）、`<canvas>`。SVG 栅格化前会**把计算后的样式内联进克隆节点**——见 D19，这是它看起来对不对的分水岭。

**退化成近似**：径向/圆锥/重复/多层渐变 → 色标平均色（保留 alpha）。**线性渐变已不在此列**：它被栅格化成图片，视觉上一致，代价是不再是可改的填充色（见 6.7）。

**丢掉**：CSS 滤镜、混合模式、文字阴影（盒阴影已支持）、动画、`<video>` / `<iframe>`。

**看不见的**（采集端原理上读不到，只能在生成端拦，见 §7）：伪元素 `::before` / `::after`（没有盒子可量）、入场动画初始态 `opacity: 0`（被判为隐藏）。

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

第四个是作者在真机上报的（2026-09-02）：**五页的 deck 导出后只有第一页有内容**。模型很爱把 deck 写成**幻灯片放映**而不是一叠——只有当前那张 `<section>` 可见，其余 `display: none`（或 `opacity: 0` / `visibility: hidden` / 高度收成 0），由一段翻页脚本切 `.active` 类或直接改内联 `style.display`。采集器照实测量：隐藏的 root 没有盒子、`isHidden` 直接返回，于是第 2–5 页各是一张空幻灯片。修法在 `harvester.js` 的 `revealSlides`：**导出的是页面的内容，不是脚本把页面留在的那个状态**，所以量之前把每一张都摆进「页面给当前页的那个状态」。两条机制，因为页面藏页有两种办法：优先用**页面自己的标记类**——把可见页有、隐藏页没有的类**逐个单独**试加到第一张隐藏页上，只留下真能让它显出来的那一个（所以首页顺带带着的 `cover` 不会被抄到每一页）——因为加类会连带跑**子孙**规则（`.slide:not(.active) h2 { opacity: 0 }` 这种入场效果），强行改 root 的 `display` 修不到那些；剩下仍隐藏或没盒子的再上内联覆盖（脚本写的 `style.display = "none"` 没有类可抄；`display` 的值抄可见页算出来的那个，`flex` 居中才不丢；收成 0 高的页照可见页的尺寸给盒子）。加类之前先把 root 下所有元素的 `transition-duration` / `animation-duration` 钉成 0——切类瞬间量到的是过渡的**起点**，opacity 仍是 0，刚显出来的页会再次被判成隐藏；这一步顺带修了另一件事：可见页上 1 秒的入场动画原本在 32ms 处被量到（标题还在终点下方 20px、opacity≈0 直接被丢），现在量到的是终态。`data-pptx-skip` 的页不碰——作者故意藏的和放映脚本藏的是两回事。用真 `blob:` + `sandbox` 沙箱对五种写法（类切换 + 子孙过渡、内联 display、绝对定位叠放 + opacity/visibility、高度收 0、普通一叠 + 入场动画）各跑了一遍：旧脚本四种放映写法都只出第一页，新脚本五页齐、首页专有的 `cover` 底色没串到别页、动画标题落在终点。`inspect_html` 报空页的提示语同步改了：`display: none` 已不是原因。jsdom 里 `getBoundingClientRect` 全是 0，这段照旧不进单测。

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

## 6. 保真度缺陷清单（2026-09-07 实测）

> 状态：**A / B / C 三段均已修（6.5 / 6.6 / 6.7）**。作者报「各种错位和元素丢失」。下面每一条都是在真浏览器里拿一份典型的
> AI 生成 deck（渐变底、装饰圆、玻璃卡片、渐变标题、统计块、列表、旋转徽章、`object-fit` 图片、
> 内联 SVG）跑 `harvester.js` 采下来的实测结果，不是推测——每条都注明了它在采集输出里长什么样。

复现用的探针：把 `harvester.js` 作为内联脚本拼进一份 deck，用真浏览器打开、读 `window.__deck`。
沙箱与 CSP 那条路径不参与（那是 D18 已经验过的），这里要看的只有**量出来的东西对不对**。

### 6.1 会画错的（视觉上直接崩，且不报错）——**A 段，已修**

| # | 现象 | 采集输出 | 根因 |
|---|---|---|---|
| F1 | 渐变标题变成一条大色条压在版面上 | `<h1>` 除了文字还多出 `rect [96,115 1088x141] fill=rgb(112,164,249)` | `-webkit-background-clip: text` 没被认出来。页面里渐变被裁进字形，采集器当成普通背景发了个整块矩形。计算样式里 `background-clip: "text"` 直接可读 |
| F2 | 半透明玻璃卡变成**纯白实心块**，上面的浅灰字等于消失 | `.card` 的 `linear-gradient(rgba(255,255,255,.10), …)` → `fill=rgb(255,255,255)` | `averageColor` 只平均 RGB，**把 alpha 丢了**。深色底上的 10% 白 = 几乎看不见；输出成 100% 白 = 盖住一切。这一条最像作者说的「元素丢失」 |
| F3 | 圆形变成圆角方块 | `.blob{border-radius:50%}` → `radiusPx=50` | `parseFloat("50%")` = 50，被当成 50px。百分比要按盒子短边解析 |
| F4 | 图片/SVG 盖住文字 | 第 3 页两个 `image` 块排在所有文字**之后** | `rasterizeImg/rasterizeSvg` 是异步的，`push` 发生在 walk 结束之后 → 所有图片一律最后进列表 = PowerPoint 里一律最上层。整屏背景图会把整页文字埋了 |
| F5 | 图片被拉伸变形 | `.hero` 源图 200×600，框 420×260，`object-fit: cover` | `drawImage(img,0,0,w,h)` 无条件铺满，不看 `object-fit`。圆头像的 `border-radius` 也一起丢 |

### 6.2 会错位的（版面对不上，但认得出是什么）——**B 段，已修**

| # | 现象 | 采集输出 | 根因 |
|---|---|---|---|
| F6 | 段落行距被压扁约 30%，与旁边的元素错开一行多 | `.sub` 三行、CSS `line-height: 37.4px`（1.7 倍） | `lineSpacing` 从来没设过，PowerPoint 用自己的约 1.2 倍。22px 字三行：浏览器 112px、PPT 79px。因为 `valign: middle`，误差往两头摊 |
| F7 | 字距标签（`letter-spacing: .28em` 这类）比框窄一截 | `.kicker` 量到 125px 宽（含 3.92px 字距） | `charSpacing` 没传。框是按含字距的宽度量的，文字按不含字距的宽度画 |
| F8 | `<br>` 消失，两行挤成一行 | `<h1>把 HTML 变成<br>能改的幻灯片</h1>` → `"把 HTML 变成 \| 能改的幻灯片"` | `collectRuns` 把 `<br>` 换成空格。pptxgenjs 的 run 有 `breakLine` |
| F9 | 数字和它的标签糊成一行、字号混在一个框里 | `.stat` → 一个 `text [96,403 347x82] sz=44,18,13 "92\|%\|位置误差 < 2px"` | 容器自己带文本节点（"92"）就吃掉整棵子树，块级后代不产生换行。与 F8 同一个修法 |
| F10 | 列表第一项没有圆点，且比同级右移 14px | `"一期：接入行情"` x=580，另两项 `"• 二期…"` x=566 | `<li><span>…</span></li>`：文字在 inline 子元素上，`markerFor` 在那个 span 上问 `display` 得到 `inline` → 不是 list-item → 不补符号。要从最近的 list-item 祖先取 |
| F11 | 旋转元素回正，且盒子被撑大 | `.badge{transform:rotate(-8deg)}` → 轴对齐的 `rect [1120,609 83x52]` | 完全没读 `transform`。`getBoundingClientRect` 给的是旋转后的外接矩形。pptxgenjs 的 shape/text/image 都有 `rotate`；未旋转的盒子就是 `offsetWidth/offsetHeight`，中心与外接矩形同心 |

### 6.3 次要的 —— **C 段，已修**

- **`box-shadow` 全丢**：pptxgenjs 有 `shadow`，映射一次就有。
- **元素 `opacity` 介于 0 和 1 之间被当成不透明**：只有 0 会被判成隐藏；0.5 的卡片画成实心。
- **`overflow: hidden` 的裁剪没有传递**：装饰性大圆按完整尺寸导出。挂在幻灯片根上时 PowerPoint 会在页边裁掉、看不出来；挂在内部卡片上就会溢出来。
- **渐变仍然只有平均色**：修好 F2 之后它至少是对的颜色和对的透明度，但仍是平色。真要保住渐变只能在采集端用 canvas 画一遍再当图片发——留作后续。

### 6.4 建议的切分

- ~~**A 段（画错的）**：F1 F2 F3 F4 F5~~ —— 已修，见 6.5。
- ~~**B 段（错位的）**：F6 F7 F8 F9 F10 F11~~ —— 已修，见 6.6。
- ~~**C 段（次要的）**：阴影、部分透明、裁剪、渐变栅格化~~ —— 已修，见 6.7。

三段都要动 `harvester.js`，所以每段都要**同时**改 `tauri.conf.json` 的 `sha256-`（`pptxHarvesterCsp.test.ts` 会拦），选择器表没动则 `htmlSlides.ts` 不用改。

### 6.5 A 段的修法与验证（2026-09-07）

五条全在 `harvester.js`，`deck.ts` / `write.ts` 一行没动——它们本来就对，只是收到的数是错的。

| # | 修法 | 依据的计算属性 |
|---|---|---|
| F1 | `clipsBackgroundToText()` 认出 `background-clip: text`：**不发那个矩形**；`paintedColor()` 让文字改用渐变均色 | `background-clip`、`-webkit-text-fill-color` |
| F2 | `averageColor()` 同时平均 alpha，返回 `rgba(…)`。全透明色标只贡献不透明度、不贡献色相（否则「淡出到透明」会被拉向黑） | 无 |
| F3 | `resolveRadius()` 按盒子解析百分比；椭圆角取较紧的那条轴（OOXML 一个形状只有一个半径） | `border-*-radius` |
| F4 | `reserve()` 在 walk 里按 DOM 顺序**先占位**，图片字节到了再 `place()` 回填 | 无 |
| F5 | `fitMapping()` 按 `object-fit` 算源矩形（cover/contain/none/scale-down，`object-position` 只认百分比）；`clipRoundRect()` 把图自身的圆角画进 PNG 的 alpha | `object-fit`、`object-position`、`border-*-radius` |

**F1 的两半都要修才有意义**：只删矩形，标题会退回继承来的颜色（深色底上常常是浅灰）；只改文字颜色，那条色条还压在版面上。

**F5 顺带收紧了一条捷径**：`data:` 图原本直接透传给 PowerPoint。现在只有「页面就是把整张图拉满这个框、且没有圆角」时才走那条路——裁过或圆过的图透传出去，等于交一张页面从没显示过的图。

**验证**（真浏览器，同 §4.4 的做法；jsdom 没有布局引擎，这一层照旧不进单测）：
把 `harvester.js` 内联进一份典型 AI deck（渐变底、装饰圆、玻璃卡、渐变标题、统计块、列表、旋转徽章、`object-fit: cover` 图、内联 SVG），修前修后各采一次：

| | 修前 | 修后 |
|---|---|---|
| 渐变标题 | 多一个 `rect [96,115 1088×141] fill=rgb(112,164,249)`，文字 `rgb(226,232,240)` | 无矩形，文字 `rgba(112,164,249,1)` |
| 玻璃卡 | `fill=rgb(255,255,255)` | `fill=rgba(255,255,255,0.065)` |
| `border-radius:50%` 的 520px 圆 | `radiusPx=50` | `radiusPx=260` |
| 第 3 页图片顺序 | 两个 image 排在所有文字**之后** | 按 DOM 顺序夹在文字之间 |
| 200×600 的图铺进 420×260 | 24942 字节，整张拉伸 | 16330 字节；回读像素：四角 alpha=0（16px 圆角生效）、画面只剩源图中段的蓝色（cover 裁剪生效，`cy=100` 的黄圆已被裁掉） |

`src/lib/__tests__/pptxHarvester.test.ts` 用源码扫描把这五条钉住——不是能不能跑的问题，是**它们全都静默**：导出成功，只是画错，没有异常也没有降级提示可发。

### 6.6 B 段的修法与验证（2026-09-07）

六条的共同点是**数已经量到了，只是没往下传**，所以这一段三层都动：采集器多量几个属性，
`deck.ts` 决定这些数怎么用，`write.ts` 只负责交给 pptxgenjs。

| # | 修法 | 落到 OOXML 的什么 |
|---|---|---|
| F6 | 文本块带上 `lineHeightPx`（`line-height` 是 `normal` 时用浏览器实际用掉的行高兜底）；`lineSpacingPt()` 决定用不用 | `<a:lnSpc><a:spcPts>` |
| F7 | run 带上 `spacingPx` | `<a:rPr spc="…">` |
| F8 / F9 | `<br>` 与块级子元素调用 `breakLine()`，在前一个 run 上打 `breakAfter` | 拆成两个 `<a:p>` |
| F10 | `listItemFor()` 从最近的 list-item **祖先**取符号，每项只认领一次 | run 文本里的 `• ` / `1. ` |
| F11 | `pureRotation()` 认出纯旋转 → 把 `transform` 临时关掉量出布局盒 → `applyRotations()` 把每个块的中心绕页面自己的 `transform-origin` 转回去 | `<a:xfrm rot="…">` |

**F6 是一个判断而不是透传**（`lineSpacingPt`，`deck.ts`，可测）：

- 单行无所谓——`valign: middle` 两边都居中，钉死行距只会多出裁切风险；
- **run 字号不一致时不给**。「大数字 + 小标签」是一个块（容器自己带文本节点，吃掉整棵子树），
  一个精确行距会把两行等距排开，比 PowerPoint 自己的逐行默认值更远。

**F11 为什么是「关掉 transform 再量」**：`getBoundingClientRect` 给的是旋转元素的**外接**
轴对齐矩形——比元素本身大，角度还没了。而 transform 从不影响布局，所以关掉它量到的就是元素
真正的盒子。只认**纯旋转**：`translate(-50%,-50%)` 关掉就会把元素挪到页面从没画过的地方，
缩放和斜切同理，那些仍走旧的外接矩形（错，但错得至少盖住了正确的面积）。
PowerPoint 绕形状自己的中心转，所以「把每个块的中心搬到旋转后的位置 + 各自原地转同一个角度」
与「整组一起转」是同一张图。

**验证**：

- **真浏览器**（同 §6.5 的探针，加了一页：span 包住的有序列表项、同一个 `<li>` 里两个 `<p>`、
  旋转 12° 的卡片、行高 2.0 + 字距 1.5px 的段落）：
  - 有序列表 `1. / 2. / 3.` 三项都有号，同一项的第二段**没有**多出一个号；
  - 旋转卡片量出 260×136（未旋转的盒子）而不是外接矩形，标题块旋转后的中心
    **(986.9, 230.2)** 与页面上实际渲染的中心逐点相同；正文块差 1.6px（多行块的外接矩形中心
    与旋转后中心的固有差异，1280 宽上是 0.1%）；
  - `<br>` 出现 `/BR/`、`.stat` 在 `%` 之后断行、`lineHeightPx` 38/36/24 与 CSS 一致、
    字距 3.92 与 1.5 都带上了。
- **真 pptx 回读**（把生成的包解出 `ppt/slides/slide1.xml`）：
  `<a:xfrm rot="720000">` = 12°、`<a:lnSpc><a:spcPts val="2700"/>` = 27pt、
  `spc="113"` = 1.13pt、`adj val 8821` 的圆角、断行确实拆成了两个 `<a:p>`（33pt / 9.75pt），
  而混字号的那个块**没有** `<a:lnSpc>`。

**已知代价**：`lnSpc` 是精确行距，页面若把 `line-height` 压得比字体自然行高还紧，
PowerPoint 里同样会挤——那是页面自己的选择，照抄才是保真。

### 6.7 C 段的修法与验证（2026-09-07）

四件，其中渐变那件是这三段里唯一一个**把已知的降级取消掉**的改动。

| 项 | 修法 | 落到 OOXML 的什么 |
|---|---|---|
| 盒阴影 | `shadowOf()` 把 CSS 的偏移向量换成 OOXML 的「距离 + 方向」。只取一叠里的第一条（CSS 可以叠，PowerPoint 只有一个），`spread` 没有对应物，丢 | `<a:outerShdw dist dir blurRad>` |
| 部分透明 | `opacity` 顺着 walk 逐级相乘（它是合成而不是继承），`fade()` 把它折进颜色自己的 alpha，文字与图片则用整形状的 `transparency` | 填充/文字的 `<a:alpha>`、图片的 `<a:alphaModFix>` |
| `overflow` 裁剪 | `clipFor()` 逐级求交，`push()` 把矩形切到可见部分，完全在外的块直接不发 | 更小的 `<a:off>/<a:ext>`，或没有这个形状 |
| 线性渐变 | `parseLinearGradient()` + `rasterizeGradient()` 画成 PNG（圆角也一起裁进 alpha） | 一张图片 |

**三条边界，都是故意的**：

1. **只有幻灯片根之外的 `overflow` 才裁**。根上裁反而更差：PowerPoint 本来就在页边裁，而我们裁完会把「探进角落的一个圆」变成「摆在角落里的一个圆角矩形」。
2. **只有纯线性渐变走栅格化**。径向、圆锥、重复、多层、px 定位的色标、`to bottom right` 这种角度取决于盒子长宽比的写法——全部退回平均色，并且**照旧报降级**。这条 fallback 是它敢做的前提。
3. **旋转子树里不裁**。裁剪矩形是页面坐标系的，而旋转子树是摊平了量的，两者对不上（见 6.6 的 F11）。

**渐变栅格的尺寸是量出来的，不是拍的**：一开始按长边 640px 画，整屏渐变的 base64 是 **301KB**——30 页就是 9MB。压到 192px 后同一张是 **27KB**，而像素对照没有任何变化（下表），连硬色标（`#ef4444 50%, #22c55e 50%`）过渡带也只有约 1px。渐变本身没有细节，放大是线性插值。

**验证**：

- **真浏览器像素对照**（把生成的 PNG 读回 canvas 逐点取样，期望值由 CSS 独立算出）：

  | 渐变 | 取样点 | 期望 | 实测 |
  |---|---|---|---|
  | `135deg, #0f172a→#1e3a8a`（整屏） | 左上 / 右下 / 中心 | 15,23,42 / 30,58,138 / 23,41,90 | 15,23,42 / 30,58,138 / 22,40,90 |
  | `to right, #38bdf8→#a78bfa` | 左 / 右 / 中 | 56,189,248 / 167,139,250 / 112,164,249 | 56,188,248 / 167,139,250 / 111,163,249 |
  | `0deg, #0f172a, #38bdf8 40%, #f8fafc` | 底 / 40% / 顶 | 15,23,42 / 56,189,248 / 248,250,252 | 15,24,43 / 56,188,247 / 247,249,251 |
  | 卡片 `rgba(255,255,255,.18→.02)` | 起点 alpha / 圆角外 | ≈46 / 0 | 44 / 0 |

  差 ±1 是 Chrome 画渐变时的抖动。

- **裁剪**：300×300 的装饰圆挂在 420×260 的卡片上（`right:-140; top:-120`），页面裁成 160×180——采集出来正是 `[323,141 160×180]`。
- **真 pptx 回读**：`<a:outerShdw blurRad="380987" dist="171450" dir="5400000">` = 30pt 模糊 / 13.5pt 距离 / 90°，阴影色 `<a:alpha val="45000"/>`；`opacity: .4` 的绿块与它的文字都拿到 `<a:alpha val="40000"/>`；`opacity: .5` 的图片拿到 `<a:alphaModFix amt="50000"/>`。

**代价**：渐变面板不再是可改的填充色，而是一张图片。这是 pptxgenjs 不给渐变填充下的二选一——
要么颜色对但不可改，要么可改但整块变平色。选了前者，因为交出去的第一眼是给客户看的。

### 6.8 代码审查抓到的四条（2026-09-07，A/B/C 合并后）

三条的成因是同一件事：**探针 deck 恰好没覆盖那个组合**。写探针时按"每个特性一个例子"排的，
而这三条都出在**两个特性相遇的地方**。

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| R1 | 渐变卡片的 `box-shadow` 被静默丢掉 | 阴影只搭在 rect 上，而渐变栅格化后 `fill = null`；无边框的渐变卡走到 `if (fill \|\| paint.borderWidth)` 就是假，rect 根本不发。有边框时 rect 还在，但填充全透明，PowerPoint 只从描边投影 = 一条细线 | 阴影移到 `BoxPx`，跟着**真正被填充的那一层**走——渐变卡就是那张图片 |
| R2 | 渐变底下的 `background-color` 被丢，卡片几乎看不见 | 栅格化后 `fill = null`，而 CSS 里底色画在渐变**下面** | 有渐变时发三层：底色 rect → 渐变图 → 边框 rect。**没有渐变时仍然是一个形状**（不为了这条把所有卡都拆开） |
| R3 | 绕角旋转的元素落点偏出约半个对角线 | `parseFloat(pivot[0]) \|\| flat.width / 2`——`transform-origin: left top` 的计算值就是 `0px 0px`，0 是 falsy，被当成"没设" | `originLength()` 判 `isFinite` |
| R4 | 渐变装饰圆探出裁剪容器时整块画出来（纯色的会被裁） | `push` 只对 `kind === "rect"` 求交 | `rasterizeGradient` 收一个 `visible` 参数：几何和圆角仍按**完整盒子**算，画布只覆盖可见窗口。理由是这张位图是我们自己画的，不像照片那样"裁了就压扁" |

**R1 + R2 是同一处的两半**：只修 R2（补回底色）而不动 R1，阴影仍然搭在只有边框的那层上；
只修 R1 而不动 R2，卡片有阴影但没有底。所以顺序也是修法的一部分——底色必须在图之前发，边框必须在图之后。

**验证**（真浏览器，一份专门覆盖这四种组合的探针）：

- R1：无边框渐变卡 → `image [64,100 300x160] SHADOW{a=90 d=18 blur=40}`；
- R2：`background-color:#1e293b` + 半透明白渐变 + 边框 → 三块，顺序为 `rect fill=rgb(30,41,59)` → `image +SHADOW` → `rect line-only`；对照的纯色卡仍是**一个** `rect fill=… line=… SHADOW{…}`；
- R3：`rotate(-90deg); transform-origin: left top` 的侧标签，采集出的块中心 **(922, 20)** 与页面实际渲染的中心逐点相同；
- R4：300×300 的渐变圆探出 420×260 的卡片 → `image [324,340 160x180]`（裁后尺寸），像素回读：左下角在圆外 alpha=0、右上与中部按 CSS 独立算出的期望值是 108,166,249 / 110,165,249，实测 107,165,249 / 110,165,249。

**同时复核并撤回的一条**：曾怀疑 `<a:spcPts>` 与 `fit: "shrink"` 打架——autofit 缩字号但不缩磅值行距，
所以多出来的那一行仍会溢出。**不成立**：缩字号会让文字重新排回**更少的行**，行距不变也就不再溢出，
box 本来就是按页面的行数和行距量的。留下的只是"行距相对缩小后的字看起来偏松"这个观感差异，不是缺陷。

## 7. 生成端契约（2026-09-08；三个切片均已实施，见 7.7 / 7.8 / 7.9）

§6 把采集端补到了"计算属性能读到什么，就画对什么"的边界。剩下的丢失与错位，
来源换了一边：**模型写了采集端原理上读不到、或 pptx 原理上装不下的东西**。
业界走 HTML 中间层的产品（Claude 的 pptx skill、Manus、Genspark 等）在这一步做的都是同一件事——
给生成端一份"导出友好的 HTML 子集"契约，让模型先不要写出转不了的东西。这一节规划我们的版本。

### 7.1 为什么现在轮到生成端

三类典型写法会造成作者报的那种"元素丢失"，且**三类都不是采集端能修的**：

1. **伪元素 `::before` / `::after`**。DOM 遍历看不见它们，`Range` 也选不中伪元素，所以**没有盒子可量**——
   `getComputedStyle(el, "::before")` 能给颜色和 `content`，给不了位置。AI 写的 deck 里自定义列表圆点、
   标题下的装饰横线、编号徽章、图标字体（Font Awesome 就是伪元素 + web font）全走这条路，导出后整个消失。
2. **入场动画的初始态**。`opacity: 0` + `animation: fadeIn …` 在页面上看得见（动画跑完了），
   但采集端的 `isHidden` 把 `opacity === 0` 判为隐藏（harvester.js `isHidden`），整块不发。
   采集端改成"忽略 opacity 0"又会把真正隐藏的元素画出来，两边都不对——只有生成端知道哪种意图。
3. **web font**。进不了 .pptx，PowerPoint 替换后回流，换行数一变就溢出。§4.2 已经把它列为头号风险，
   但应对只是"工具描述里要求用系统字体"。

再加上已知只能近似的：径向/圆锥/`url()` 背景平均色，`text-shadow` / `filter` / `backdrop-filter` /
`mix-blend-mode` 丢，SVG 内的文字变成图的一部分，`writing-mode` 竖排变横排，复合 `transform` 只剩外接矩形。

### 7.2 现状：契约只活在一处，而且过期了

- `export_pptx` 的 description（`registry.ts`）是**唯一**的契约。它仍写着"渐变变平均色、阴影丢"——
  C 段之后都不成立；伪元素与 `opacity: 0` 一字未提。话和能力已经对不上（`tool-presence.md` 的头条）。
- 这段描述每轮都计费。`agent-tool-context.md` 的表里它是最贵的描述之一（1677 tok），
  再往里堆失败清单是往 fixed header 里堆散文。
- 反馈回路 `inspect_html` 只报**量到的**：溢出、空页、采集端记下的 `degraded`。
  量不到的（伪元素、被判隐藏的动画元素）永远不出现在报告里——这正是它们最危险的原因：
  模型跑了检查、报告说干净、导出来还是缺。

### D20 契约分三层，按"模型什么时候需要它"放

| 层 | 放哪 | 内容 | 成本 |
|---|---|---|---|
| 规则 | `export_pptx` description | 五条"怎么写才对"，不列失败清单 | 每轮；目标比现在**短** |
| 失败清单 | 静态预检 `lib/pptx/lint.ts`，挂在 `inspect_html` 报告与导出审批卡 | 违规处的选择器/行号 + 替代写法 | 干净的页零成本 |
| 完整契约 + 骨架 | 模型**开始写 deck** 的入口（一张内置工作流卡，可被项目覆盖） | 1280×720 `<section class="slide">` 骨架、系统字体栈、`data-pptx-skip`、上面的规则全文 | 只在写 deck 时进上下文 |

理由是三条已有的原则：`tool-presence.md`（话要和能力一致）、`agent-tool-context.md`（不在 fixed header 里堆散文）、
`inspect.ts` 头注释的信条——**准确性来自模型自己能跑的廉价确定性检查器，不来自模型更聪明**。
第三层做不做，等前两层在真机上跑过再定。

### D21 预检是文本级，不是 DOM 级

- 和 `splitHtmlDeck` 同一层：一次读文件、不渲染、在 proposal 时就知道（`exportPreflight.test.ts` 钉住的模式）。
  纯函数，可测，**不碰 `harvester.js`**，CSP hash 不动。
- 代价：不解析选择器匹配到哪些元素，所以报的是"`.card::after` 画了导不出的内容（第 41 行）"，
  而不是"第 3 页的卡片"。对模型够用——它写的 CSS 它认得；`<style>` 块内能给行号，
  内联 `style=""` 能给所在幻灯片的行段（splitter 已经有）。
- 假阳性接受：注释里的、`display: none` 分支里的 `::before` 也会报，误报的代价是一行提示。
- 不做的：不猜 `font-family` 回退链够不够安全，只报 `@font-face`、外链字体、首选字体不在系统清单。

### 7.3 规则表

每条对应采集端一个**已知且验证过**的缺口。级别：丢失 > 错位 > 近似，报告按级别排。

| # | 触发（文本模式） | 后果 | 建议改法 | 级别 |
|---|---|---|---|---|
| P1 | `::before` / `::after` 规则块里 `content:` 不是 `none` | 整个伪元素消失，没有盒子可量 | 换成真元素（`<span class="dot">`、`<i>`）；列表圆点用原生 `list-style` | 丢失 |
| P2 | 同一规则块里 `opacity: 0` 与 `animation` / `transition` 同现，或有 `@keyframes` 且某规则 `opacity: 0` | 被判为隐藏，整块不发 | 去掉入场动画或初始态改 1；动画本来就不进 pptx | 丢失 |
| P3 | `<video>` / `<iframe>` / `<audio>` | 丢 | 截一帧成 `<img>` | 丢失 |
| P4 | `@font-face`、`fonts.googleapis.com` / `fonts.gstatic.com`、`font-family` 首选不在系统清单 | 替换 + 回流，换行数变、溢出 | PingFang SC / Microsoft YaHei / Arial / Helvetica / Georgia 栈 | 错位 |
| P5 | `transform:` 含 `skew` / `matrix`，或 `rotate` 与 `translate` / `scale` 并用 | 只认纯旋转（§6.6 F11）；复合的按外接矩形、角度丢 | 只用 `rotate()`，位移用 `left` / `top` | 错位 |
| P6 | `writing-mode: vertical-*` | 盒子对、文字横排 | 横排文字 + 纯 `rotate(90deg)` | 错位 |
| P7 | `text-shadow:` | 丢 | 去掉，改粗字或对比色 | 近似 |
| P8 | `filter:`、`backdrop-filter:`、`mix-blend-mode:` | 丢；玻璃卡变成平的半透明块 | 半透明底色 + 1px 边框表达玻璃感（这条已保真，§6.5 F2） | 近似 |
| P9 | `radial-gradient` / `conic-gradient` / `repeating-*` / 多层背景 / `background(-image): url(` | 平均色 | 线性渐变（已栅格化，§6.7）或 `<img>` | 近似 |
| P10 | `<svg>` 内有 `<text>` | 随 SVG 变成图片，文字不可编辑 | 文字放 HTML，SVG 只留图形 | 近似 |

排序靠数据：这张表按采集端缺口列，**哪条在作者的真实 deck 里最常见**要拿作者手头出过问题的那几份跑一遍才知道。
切片 1 落地后第一件事是拿真 deck 校正措辞与顺序。

### 7.4 接入点

- **`inspect_html`**：报告末尾加一段 `Will not carry across:`，按级别一条一行，超过上限计数；
  空则**一个字不加**（干净的 30 页 deck 仍是一句话，`formatDeckReport` 的原则）。
- **`export_pptx`**：proposal 时跑同一份预检，结果进 `PptxProposal`，审批卡显示
  "这份有 N 处导出会丢"再让作者点批准；工具返回值里与运行时 `degraded` **并列**——
  `degraded` 是"量到的"，预检是"没量到但知道会丢的"，两份合起来才是完整清单。**不阻断**：作者可能就是要那份不完美的。
- **description 改写**：五条规则 + "先跑 `inspect_html`，它会指出导不出的写法"，删掉过期的失败清单。
  字数目标：比现在短，`agentToolBudget.test.ts` 的 cap 相应下调。

### 7.5 守卫

- `lint.test.ts`：每条规则一正一反例（P1 `content: none` 不报；P2 `opacity: .9` 不报；P4 系统字体栈不报）。
- 源码守卫：description 与预检规则集一致——描述里不再出现"平均色 / 阴影丢"这类过期话，
  描述提到的每个限制预检都认得（`tool-presence.md` 第 5 条）。
- `pptxHarvesterCsp.test.ts` 不受影响：本节不改 `harvester.js`。

### 7.6 切分

- **切片 1**：`lib/pptx/lint.ts` + 测试；接入 `inspect_html`；改写 `export_pptx` description；§4.2 的"丢掉"清单同步。全在可测层。
- **切片 2**：接入审批卡与工具返回值（动 `PptxProposal` 与卡片组件）。
- **切片 3（可选）**：入口引导——内置工作流卡或 pack 任务携带完整契约与 1280×720 骨架。

### 7.7 切片 1 的落地（2026-09-08）

- **`lib/pptx/lint.ts`**：`lintDeckSource(html)` 返回 `{rule, level, line, what, fix}[]`，`formatLintFindings` 把它排成模型读的段落，空则返回 `""`。
  实现上按 D21：`<style>` 块与内联 `style=""` 各成一段并记住在页面里的偏移，行号由偏移反算；
  HTML 注释与 CSS 注释先用等长空白抹掉，偏移不变；规则块用"最内层 `{…}`"的正则切，`@media` 外壳自然落空。
  P1/P2 只看规则块（要知道选择器对伪元素/动画做了什么），P4–P9 扫所有声明，P3/P4（外链字体）/P10 扫标记。
  同一 (规则, 措辞) 只报一次、按级别再按行号排、最多列 12 条其余计数。
- **正则里的一个坑**：`text-shadow\s*:\s*(?!none)` 会被回溯绕过——`\s*` 少吃一个空格，前瞻看到的是 `" none"`，
  于是 `text-shadow: none` 被报了。写法必须是 `:(?!\s*none\b)`。`pptxLint.test.ts` 的反例钉住了它。
- **`inspect_html`**：预检段落**追加**在量测报告之后，不替代它；页面渲染失败的分支也带上——那些发现本来就不需要布局。
- **`export_pptx` 描述**：改成五条"怎么写才对"，删掉过期的失败清单（"渐变变平均色、阴影丢"）。
  量过：原 307 tok，第一稿 324，压到 **299**。`agentToolBudget.test.ts` 的 export pack cap 不用动。
- **守卫**：`pptxLint.test.ts` 每条规则一正一反例；最后一组是对描述的源码守卫——必须提 `::before/::after`、`opacity 0`、`SYSTEM fonts`、`inspect_html`，不得再出现 `average solid colour` / `shadows … dropped`。
- **没动**：`harvester.js`（CSP hash 不变）、`SLIDE_SELECTORS`、审批卡（切片 2）。
- **待校正**：规则表的顺序与措辞要拿作者真实出过问题的 deck 跑一遍预检再定（§7.3 末段）。

### 7.8 切片 2 的落地（2026-09-08）

- **`PptxProposal.lint: LintFinding[]`**：`export_pptx` 在 proposal 时跑同一份预检（和页数一样，同一次读、不需要渲染），
  结果随卡片走。**不阻断**：卡片照样给批准键。
- **审批卡**（`ApprovalCard.tsx` `PptxBody`）：`groupLint` 把发现按规则折成一行一条，行号跟在后面等宽小字（最多列 4 个，其余计数）。
  「会丢」的行用和「整页压成一张」同一块底色——同一种性质：不拦着，但作者得知道；「走样」的只是 hint 色。
  每条规则的句子在 locale 里，中英各一份（`ai.approval.pptxLint.P1`…`P10`），预检本身只产规则号。
- **工具回执**（`agentStore` 的 pptx 分支）：`formatLintFindings(proposal.lint)` 追加在运行时 `degraded` 之后——
  前者是"量到的"，后者是"没量到但知道会丢的"，两份合起来才是完整清单。用的是 proposal 时的结果：
  批准与落盘之间文件若被改过，回执说的是作者批准时看到的那份。
- **顺手改的**：预检的去重键从 (规则, 措辞) 改成 (规则, 措辞, 行)，卡片才能列出每一行；
  给模型的 `formatLintFindings` 再按 (规则, 措辞) 折回去，一条事实带全部行号（`SHIFTED line 4, 5: font "Inter"`）。
  `pptxNote` / 实验室里的 `pptxHint` 两处过期文案（"渐变会降级"）一并改掉。
- **守卫**：`exportPreflight.test.ts` 钉住 proposal 上的 lint（有发现 / 干净两种）；`pptxLint.test.ts` 补 `groupLint` 与折行。
- **没验的**：审批卡是项目内才有的界面，这台机器上看不到；行号列表在窄卡上会不会挤，要真机看一眼。

### 7.9 切片 3 的落地（2026-09-08）

- **形态：一张内置工作流卡** `pptx-deck`「幻灯片 deck（可导出 PPTX）」（`lib/workflow/builtins.ts`），不是 pack 任务、不是 `htmlArtifact` 指令里再加一段。
  理由是 D20 的第三层：完整契约只该在**开始写 deck**时进上下文，而工作流卡正是两级披露——清单一行每轮付费、正文 `read_workflow` 按需取。
  `htmlArtifact` 的指令服务所有页面（图示、宣传页），deck 的规矩塞进去是让不导出的页面也背着束缚。
- **随 Beta 开关出现**：`BuiltinWorkflow.available?: () => boolean`，`mergeWorkflows` 对 `available()` 为假的内置卡直接跳过——不进合并视图、不进清单、`read_workflow` 找不到、管理界面也不显示。
  这是工具在场性契约的"关掉时是缺席"：卡里指名 `export_pptx`，那个工具不在的时候卡也不该在；且没开导出时这些规矩本来就是无谓的束缚（`::before` 的圆点在网页里好好的）。
  判据读的是和 `routeTools` 同一个开关 `isPptxExportEnabled()`。**作者自己写的同 id 文件不受开关影响**——那是他们的卡。
- **正文**：骨架（`<section class="slide">`、1280×720、`overflow:hidden`、系统字体栈）+ §7.3 全部十条规则的"怎么写"版 + 边距与行数的经验值 + `inspect_html` → `export_pptx` 的顺序；
  编排模式下（工具里没有 `export_pptx` 而有 `run_pack`）交给导出 pack，这一句是为了不留死指针。
  正文不走 i18n（读者是模型）。
- **接线零改动**：三处注入点（chat 的 briefing、AiPanel 任务尾部按 `read_workflow` 在场、编排层）都已经在用 `scanWorkflows` → `mergeWorkflows`，卡加进列表就到位。
  `write` 档带 `read_workflow` 与 `export_pptx`，所以 htmlArtifact 任务里模型能看到清单行、读到正文、走完导出。
- **守卫**：`cards.test.ts` 钉住"开关关着卡缺席、开着卡在、作者的覆盖文件不受影响"。
- **没验的**：模型在真机上会不会因为那一行描述去读这张卡——这是工作流卡机制本身的老问题（workflow-cards-plan §8 的触发统计），不是这张卡的。
