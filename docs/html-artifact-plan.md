# AI 生成 HTML 工件（图示 / 架构图 / 宣传页）计划

> 状态：规划中，未实施。
> 背景：作者需要图示、架构图、宣传页这类**版式精确**的交付物。生图模型精度低且不可控，而 HTML+SVG 是模型最擅长的"作图语言"——像 code agent 一样让 AI 助手产出 `.html` 文件，再在 app 内用系统浏览器内核预览。

## 1. 现状盘点

规划前对代码逐项核实过，结论是：**生成端今天就是通的，断的只有预览端和审批端的呈现**。

| 环节 | 现状 |
|---|---|
| 生成 | `create_file`（L2 审批，`writeTools.ts` 要求显式扩展名）可以写任意类型文件，`.html` 已包含；`propose_edit`/`rewrite_document` 可迭代修改。无需新写文件通道 |
| 文件树 | `.html` 正常出现在 FileTree（无扩展名过滤，通用 `File` 图标），点击可打开 |
| 打开后 | `EditorArea` 的类型分派只有两支：图片 → `ImagePreview`，其余 → CodeMirror + `renderMarkdown` 预览。markdown-it 配置 `html:false`，HTML 全部被转义——预览面等于乱码 |
| 审批卡 | `ApprovalCard` 的 `CreateBody`/`RewriteBody` 用 `renderMarkdown` 展示提案内容——作者审 HTML 提案时看到的是转义后的源码墙，不是页面 |
| 主 webview CSP | `script-src 'self'`（无 `unsafe-inline`）→ 生成的 HTML **不能**直接挂进主 DOM 执行；但 `frame-src 'self' about: blob: data:` 已放行，且 PDF 导出（非 macOS 路径，`export.ts`）已在用隐藏 iframe + `document.write` 渲染生成的 HTML——先例存在 |
| 独立窗口 | `ai-writer-print://` + `WebviewWindowBuilder`（`print.rs`）是"生成 HTML 喂给独立 webview"的端到端先例；注意 `capabilities/default.json` 只覆盖 `"windows": ["main"]` |
| 系统浏览器 | `tauri-plugin-opener` 已装（`revealItemInDir`/`openUrl` 在用），`openPath` 未用——"在浏览器打开"是一行调用 + capability scope 的事 |
| 搜索 | `search_text` 只扫 `isChapterFile`（md/markdown/txt），`.html` 对全文搜索不可见 |

## 2. 关键决策（含弃用理由）

### D1 生成端复用现有写工具，不新增 `write_html`

文件写入、审批阻塞、备份、路径围栏这一整套 `create_file`/`rewrite_document`/`propose_edit` 已经有了；HTML 特有的问题是"**怎么审、怎么看**"，那属于卡片和预览层，不属于工具层。

- 弃用【专用 `write_html` 工具 + 新 proposal kind】：唯一收益是能在 schema 里塞引导文字，而引导文字放进 `create_file` 的 description 和系统提示即可，代价却是整套 proposal/卡片/apply 分支的重复。

### D2 预览 = 沙箱 iframe（blob URL，`sandbox="allow-scripts"`），嵌进 EditorArea 现有三态

- **"系统浏览器内核"就是它**：Tauri 主 webview 本身即 WKWebView / WebView2，iframe 同内核渲染，满足需求原意，零新依赖。
- **安全模型**：`blob:` iframe 是 opaque origin——主窗口 CSP 的 `script-src` 不约束其内部（inline `<script>`/`<style>` 能跑），同时**不给** `allow-same-origin`，页面脚本摸不到 app 的 `window`、IPC、任何 Tauri API。不给 `allow-top-navigation`/`allow-popups`。这与 `Preview.tsx` 里 mermaid 坚持 `securityLevel:"strict"` 的注释是同一个威胁模型：AI 生成的脚本永远不进 app 上下文。
- 弃用【直接挂主 DOM】：CSP 禁 inline script，放宽等于把 AI 生成脚本放进 app 上下文，不做。
- 弃用【独立 WebviewWindow 作为唯一预览】：新窗口没有 capability、要管导航和生命周期，成本高；iframe 覆盖日常迭代场景。独立窗口作为三期可选增强（见 §3 三期）。

### D3 自包含优先，相对图片预览时内联

blob iframe 没有文档基址，解析不了项目相对路径。两头解决：

- **预览侧**：喂给 iframe 前，把相对 `<img src>` 重写为 data URL——`export.ts` 的 `inlineImages`/`imageToDataUrl` 就是干这个的，直接复用同一条路。
- **生成侧**：引导（D7）要求产出**单文件自包含** HTML——inline CSS/JS、图示用 inline SVG、不依赖外链 CDN（离线也要能看；iframe 内的网络请求不受主 CSP 限制，有网时外链能通，但不作为依赖）。图片资源如需外置，沿用文档插图既有约定（`assets/<文档名>/` + 相对链接，`lib/image/assets.ts`）。

### D4 审批卡就是预览

`CreateBody`/`RewriteBody` 按目标路径扩展名分支：`.html` → 渲染同一个沙箱 iframe（限高 + 可展开），作者审的是**页面**，不是源码墙。`rewrite` 卡保留原有的字数差 meta（防截断的那个数字）。`propose_edit` 的 find/replace 维持文本展示——局部改动看源码是合理的。

### D5 在系统浏览器打开 = `openPath`

HTML 预览工具栏加「在浏览器打开」按钮，走 opener 插件 `openPath(文件路径)`；capability 增加 `open-path` 权限，scope 限定项目文件（与 `FsScope` 语义一致，不开任意路径）。

### D6 `.html` 是一等文本文件，不是章节

- 编辑：CodeMirror 打开、2s autosave——现状已通，不动。
- 预览：blob 随编辑内容 debounce 重建，节奏与 markdown 预览一致；编辑/分屏/预览三态复用 `viewMode`。
- FileTree 给 `.html`/`.htm` 专属图标（如 `FileCode`）。
- **不变式**：`.html` 不进 spine、不进 bookContext、不进 RAG/前情记忆——它是交付物，不是章节。`isChapterFile` 不动。

### D7 引导面是数据，不是新机制

- `create_file`/`rewrite_document` 的 description 补一句：图示/页面类交付物用自包含 HTML（inline CSS/JS、SVG 作图、无外链依赖）。
- AGENT_ASSIST 系统提示补一小节：什么时候选 HTML 交付、命名与存放约定、自包含规范。
- **不**新增 pack task：agent 模式和自定义任务已能触发；将来若要任务菜单一键入口，任务在 packs 机制里只是一条数据，随时可加（三期）。

### D8 非目标：agent 看不到渲染结果

没有截图回路，agent 迭代靠作者看预览后给反馈。这与生图工具的现状一致（模型只知道图的文字描述）。future：独立预览窗口 + 截图回传，需求出现再论。

## 3. 分期

### 第一期：预览基建（`.html` 成为一等文件类型）

1. `isHtmlPath`（`.html`/`.htm`）谓词，与 `isImagePath` 并列。
2. `EditorArea` 第三分支：html → CodeMirror + 新组件 `components/editor/HtmlPreview.tsx`（沙箱 iframe、blob URL 生命周期、相对图片内联、工具栏：刷新 / 在浏览器打开）。三态 `viewMode` 复用。
3. FileTree 图标分支 + i18n（en/zh 同步，locale parity 测试把关）。
4. opener `openPath` 接线 + capability scope。
5. 测试：`isHtmlPath`；内联复用已测路径。

### 第二期：审批卡渲染预览 + 生成引导

1. `ApprovalCard` 的 Create/Rewrite body 按扩展名分支 → 复用 `HtmlPreview` 内核（同一实现，避免两套沙箱参数漂移）。
2. `create_file`/`rewrite_document` description 与 agent 系统提示的 HTML 交付引导（D7）。
3. i18n。

### 第三期（可选，按需触发）

1. **独立预览窗口**：generalize `print.rs` 为 `ai-writer-preview://`（`FsScope` 围栏 + `text/html` MIME，改造 `ai-writer-asset://` 的 403 逻辑或新协议）+ `WebviewWindow` + capability entry；预览工具栏加「新窗口打开」。宣传页需要真实视口尺寸时的方案。
2. **搜索覆盖**：`search_text` 加 `.html`——用独立谓词，别动 `isChapterFile`（避免把 html 卷进 outline/spine）。
3. **任务菜单入口**：packs 数据项，一键「生成图示/页面」。

## 4. 不变式与风险

- 沙箱底线：预览 iframe **永不** `allow-same-origin`；审批卡与编辑区预览共用同一组件，安全参数只存在一份。
- CSP 的 `script-src` 不放宽，主 webview 永远不执行生成的脚本。
- `.html` 不进任何写作上下文管线（spine / RAG / memory / bookContext）。
- capability 变更点两处，都要最小化：`open-path` scope 限项目路径；三期新窗口必须显式加 capability entry（默认 capability 只覆盖 `main`，忘了就是静默无权限）。
- autosave 与预览 debounce 互不阻塞（与 markdown 分屏同构，无新增状态）。
