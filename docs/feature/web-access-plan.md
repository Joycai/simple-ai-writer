# 局域网 Web 访问 — 可行性调研

> 状态：**调研**（未实施）。写于 2026-08-16，基于 **v1.17.0** 的代码盘点。
> 问题：桌面 App 增加一个可选的 Web 服务 —— 设置里打开开关、指定端口、对局域网暴露，用浏览器访问同一套 UI 进行操作。
> 本文给出结论、架构建议、安全模型和分期路线。
>
> ---
>
> ### ⚠ 数字已漂移（2026-08-26 复核，v1.34.2）
>
> 结论（「可行，但不是完全复用，需要三块新东西」）与两个安全决策点（§3 文件边界、
> §4 API key 不下发）**仍然成立**；下面几个具体数字不再准，动手前按现状重数：
>
> | 文中说法 | 2026-08-26 实测 |
> |---|---|
> | 26 个 `invoke()` 调用点 | **26** —— 未变 |
> | `Database.load` 全项目 2 个调用点（`project.ts:64/93`） | **22** 处（`lib/ai/configDb.ts` 15 · `lib/project.ts` 7）—— SQL 接触面显著变宽，§2.2 的 RPC 清单要重算 |
> | Rust 侧 24 个 command | **39** 个 `#[command]`（`generate_handler!` 注册 43 项） |
> | 「Rust 侧没有任何 HTTP server / 端口监听代码，桥接层是纯新增」 | **不再成立**。`src-tauri/src/instance.rs:96` 已有 `TcpListener::bind("127.0.0.1:0")`（多开的 loopback focus 通道），而 `server/` 下已经有一个独立的 axum 服务（知识库同步 + 配置备份 + `/admin` 控制台，自带鉴权与 TOML 配置）。**§2.1「不做独立 server 二进制」这个取舍应当重新评估** —— 当初「工作量翻倍」的理由，有一半已经被 `server/` 付掉了 |
> | `useImageDataUrl.ts` 走 base64 data URL | 仍在（`src/components/lore/useImageDataUrl.ts`）；§6「图片通道顺便变优」的前提未变 |
>
> 此外全文未涉及 v1.17.0 之后新增的几大块（角色扮演、翻译子代理、ComfyUI 出图、
> 配置备份、PPTX/DOCX 导出），其中带本地端口或本地进程依赖的部分需要单独盘。

---

## 1. 总体结论

**可行。** 前端是纯 H5（React + Vite 构建出静态 `dist/`），且代码库对"无 Tauri 环境"的准备程度相当高：

- `http.ts`、`prefs.ts`、`keyStore.ts`、`TitleBar` 都已内建 `IS_TAURI` 为假时的浏览器分支；
- 26 个 `invoke()` 调用点里 21 个已收口在 4 个封装模块（`fs/fileio.ts`、`fs/transfer.ts`、`project.ts`、`keyStore.ts`）；
- SQLite 的接口面只有 `execute` / `select` 两个方法，`Database.load` 全项目只有 2 个调用点（`project.ts:64` 项目库、`project.ts:93` 全局库）；
- 图片渲染早已放弃 `ai-writer-asset://` 自定义协议改走 base64 data URL（`useImageDataUrl.ts`），没有 `convertFileSrc` 依赖。

但**"完全复用"不成立**，需要三块新东西：

1. **Rust 侧嵌一个 HTTP + SSE/WebSocket 服务**（axum），托管 `dist/` 静态文件 + 把现有 24 个 command 的语义暴露为 RPC。目前 Rust 侧没有任何 HTTP server / 端口监听代码，桥接层是纯新增（也意味着没有架构包袱）。
2. **前端一个可插拔的 transport 层**：`platform.ts` 从两态（Tauri / 浏览器）变三态（Tauri / **bridge** / 纯浏览器），封装模块的底层实现按运行环境切换。
3. **一组 Web 语义的降级/替代**：原生对话框、`revealItemInDir`、打印、关窗 flush 等（见 §5）。

最大的两个设计决策点不是工程量，而是安全：**文件访问边界**（§3）和 **API key 绝不下发浏览器**（§4）。

---

## 2. 架构建议

### 2.1 形态：嵌在桌面进程里，不做独立 server 二进制

用户描述的形态是"这个 app 监听一个端口"——即桌面 App 必须开着，Web 端是它的远程遥控器。这也是实现上最简单的形态：

```
┌────────────────── Tauri 进程 ──────────────────┐
│  WebView (桌面 UI)     axum server (可选启动)   │
│      │ invoke              │ HTTP/SSE          │
│      ▼                     ▼                   │
│  ┌──────────── 共享核心状态 ────────────────┐   │
│  │ FsScope（授权根） · sqlx 池 · keyring    │   │
│  │ commands.rs 的文件操作逻辑（复用）       │   │
│  └─────────────────────────────────────────┘   │
└────────────────────────────────────────────────┘
         ▲ LAN                      ▲ 本机
   浏览器（手机/平板/另一台电脑）    桌面窗口
```

- axum 与 Tauri 共存很成熟（都跑在 tokio 上，`tauri::async_runtime::spawn` 里起 `axum::serve` 即可，开关切换 = 持有一个 shutdown handle）。
- **备选方案**（独立 headless server 二进制，把 `src-tauri` 核心剥成 lib crate 共享）更干净、可部署到 NAS，但工作量翻倍且不符合当前诉求，仅作为远期选项记录。

### 2.2 服务端暴露什么

| 端点 | 内容 |
|---|---|
| `GET /` 及静态资源 | 同一份 `dist/`（`frontendDist` 产物），同源托管 ⇒ 天然无 CORS 问题 |
| `POST /api/rpc/<command>` | 现有 command 语义的 JSON RPC（fs_\*、sql、prefs、transfer…） |
| `GET /api/asset?path=<项目内相对路径>` | 图片/附件直出（带缓存头）——**比现状的 base64 更优**，省 33% 体积且浏览器可缓存 |
| `POST /api/ai/stream` | AI 请求的 SSE 代理（§4，必须） |
| `POST /api/upload` | 浏览器端文件导入（替代原生打开对话框） |
| `GET /api/download?...` | zip 导出 / 文本导出（浏览器下载语义天然合适） |

### 2.3 前端 transport 层

盘点结论（详见 §7 工作量表）：改造能否靠"替换封装实现"而不是全局搜索替换完成，取决于两件**现在就该做**的事：

1. 把 6 处重复的 `"__TAURI_INTERNALS__" in window` 探测（`http.ts:33`、`prefs.ts:79`、`keyStore.ts:22`、`useWindowCloseFlush.ts:17`、`aiStore.ts:20`）收敛到 `platform.ts:13` 单一出口；
2. 修掉 `fs/images.ts:7` 绕过 `fileio.ts` 直接 import `plugin-fs` 的漏点（`fileio.ts:22` 已导出同名 `readBinaryFile`）。

之后 bridge 模式 = 给 `fileio.ts` / `project.ts`（DB 句柄）/ `keyStore.ts` / `prefs.ts` 各换一个 fetch 实现，UI 层零改动。

---

## 3. 文件权限模型（核心关切）

### 3.1 现状是什么

现有安全模型的锚是 `scope.rs` 的 `FsScope`：**运行时授权根**。静态 capability 里 fs scope 为空，用户通过原生对话框选中项目文件夹的那一刻（`project_open_dialog`）该绝对路径才被注册为允许根，之后所有 `fs_*` command 都做前缀校验（`scope.rs:56 is_allowed`）。agent 工具层（`lib/agent/tools.ts`）在前端还有一层路径 containment。

### 3.2 Web 模式的原则：**绝对路径不上网线**

浏览器端没有"绝对路径"概念的入口（拿不到、也不该拿到），这恰好可以变成安全设计的优势而不是障碍：

1. **Web 会话只能看到"当前已打开的项目"**。桌面端开了哪个项目，Web 端就操作哪个项目；wire 协议里全部使用**项目内相对路径**。
2. 服务端对每个 fs RPC 做：`项目根.join(相对路径)` → `canonicalize` → **前缀校验必须仍在项目根内**（防 `../` 穿越、防 symlink 逃逸）。这是 `FsScope::is_allowed` 的既有逻辑，直接复用。
3. **Web 端不提供"打开任意文件夹"**。项目切换降级为：列出最近项目（`app:recentProjects` 偏好，服务端持有），点选其一 → 服务端在本地校验 `.ai-writer` 标记后切换（复用 `project_register_root` 的校验）。原生对话框那条路只留给桌面端。
4. 文件导入（docx/xlsx/图片）走浏览器上传：`<input type="file">` → `POST /api/upload` → 服务端落到项目内目标路径。**上传天然不需要读取客户端文件系统权限**，反而比桌面语义更干净。
5. 全局库（`config.db`）和日志目录**不暴露任何路径型访问**，只暴露语义化 RPC（读写 prefs、查询用量），杜绝用 sql `Database.load` 打开任意路径的现有能力被搬到网上（capabilities 里 `sql:allow-load` 在桌面端是全放行的——Web 端绝不能等价复制这一点，DB 句柄必须服务端固定，只转发 `execute`/`select` 且只对已知的两个库）。

结论：**文件权限是这个方案里最可控的部分**，因为项目已经有"运行时授权根 + 前缀校验"的模型，Web 化只是把边界收得更窄（仅当前项目、仅相对路径），不需要发明新机制。

### 3.3 需要额外防的两个网络层攻击

- **DNS rebinding**：LAN HTTP 服务的经典打法——恶意网页把自己的域名 rebind 到 `192.168.x.x`，绕过浏览器同源限制直接打这个端口。防法：服务端**校验 `Host` 头**只接受 IP:端口 / 配置的主机名，加上 token 认证（§3.4）后此路基本堵死。
- **CSRF / 未认证访问**：所有 `/api/*` 要求 token（header 或 cookie `SameSite=Strict`），静态页面可以匿名拿（页面本身不含秘密），但任何 RPC 无 token 一律 401。

### 3.4 认证与传输

- 开关打开时生成一个**随机 token**，桌面端设置页显示为二维码 + 可复制链接（`http://192.168.x.x:port/#token=…`），首访写入浏览器 `localStorage`，之后随每个请求带上。
- 绑定地址做成选项：默认 `127.0.0.1`（仅本机，配合用户自己的反代/隧道），显式选择才绑 `0.0.0.0`（局域网）。
- **明文 HTTP 的现实**：LAN 内自签 TLS 的证书信任体验很差，第一期建议 HTTP + token，并在设置页明示"局域网内流量未加密，请勿在不可信网络启用"。远期可选自签证书 + 引导安装。
- 注意副作用：非 `https://` 且非 `localhost` 的页面是 **non-secure context**，浏览器会禁用 `navigator.clipboard`、`crypto.subtle` 等 API——复制按钮需要 `document.execCommand` 兜底（需盘点现有复制功能的实现）。

---

## 4. 比文件权限更要命的点：API key 与 AI 请求通道

现状：AI 请求由**前端直连供应商**（`http.ts` → `tauri-plugin-http`，key 从 OS keyring 取出后进请求头）。这个模式照搬到 Web 端意味着把 keyring 里的 key 发给浏览器——**不可接受**（key 会进浏览器内存/开发者工具/可能的 XSS 面）。

且就算接受，技术上也走不通：

- 浏览器直连 OpenAI/Gemini/多数兼容端点会被 **CORS** 拦（Anthropic 需要 `anthropic-dangerous-direct-browser-access` 头，名字已说明态度）；
- `tauri-plugin-http` 开着 `unsafe-headers`（Windows 下 Ollama 403 的唯一修法），浏览器 fetch 没有等价能力。

**所以 Web 模式下 AI 请求必须由服务端代理**：浏览器 `POST /api/ai/stream`（带 providerId + 消息体，不带 key）→ Rust 侧从 keyring 取 key、发起请求、SSE 转发回浏览器。`http.ts` 已是唯一 fetch 出口，bridge 模式下换成这个端点即可；SSE 解析逻辑（`lib/ai/*` 各协议 adapter）在前端不动——服务端只做字节转发，不解析协议。

`keyStore.ts` 在 Web 端则退化为"只写不读"：设置页仍可录入/更换 key（`POST /api/rpc/secret_save` 直达 keyring），但**没有任何端点把 key 读回给浏览器**——`secret_load` 不进 RPC 白名单，供应商列表接口只返回"已配置/未配置"布尔。

---

## 5. 无法复用的功能点与降级方案

| 功能 | 现状 | Web 端方案 |
|---|---|---|
| 项目根选择（原生文件夹对话框） | `scope.rs:140`，同时是授权模型的锚 | 不提供；只能在"最近项目"里切换（§3.2） |
| 文件导入对话框（docx/xlsx/图片，4 处组件散点） | `plugin-dialog` | `<input type="file">` 上传 |
| zip 导入/导出、文本导出对话框 | `transfer.rs` 4 个 command | HTTP 上传/下载，语义天然匹配 |
| `revealItemInDir`（文件管理器中显示，5 处） | `plugin-opener` | 隐藏按钮，或降级为"复制相对路径" |
| 打印 / PDF 导出 | `print.rs` 独立预览窗口 + macOS objc2 边距修正 | `window.print()` 新标签页，边距体验有差异；接受降级 |
| 关窗前 flush 自动保存 | `onCloseRequested` 可 await | `beforeunload` 不能 await —— 靠现有 `scheduleSave` 缩短去抖 + `visibilitychange` 时同步 flush + `navigator.sendBeacon` 兜底 |
| 窗口控制 / 自绘标题栏 | `useWindowControls.ts` | 已有 fallback（`TitleBar.tsx:71` 装饰性圆点），无需改动 |
| `getVersion()`（3 处，写导出 manifest） | `api/app` | 构建期注入常量（顺手把桌面端也统一） |
| xlsx 解析 | Rust command | 上传后服务端跑同一段 calamine 代码，无损 |

另一个必须处理的运行时问题：**双端并发编辑**。桌面窗口和浏览器各持一份 `editorStore`，同时打开同一文件会互相覆盖。第一期最小方案：保存前服务端比对 mtime，不一致则拒绝并提示"文件已在另一端被修改"；编辑器加载时订阅一个"文件已变更"SSE 事件做提示条。实时协同（OT/CRDT)明确不做。

## 6. 图片通道顺便变优

现状所有头像/图库/插图都通过读文件 → base64 data URL 渲染（单图上限 12MB）。Web 化时加 `GET /api/asset` 直出后，`useImageDataUrl` 在 bridge 模式下可以直接返回该 URL，省内存、省 33% 体积、可被浏览器缓存——这一块 Web 端体验反而好于照搬 base64。

---

## 7. 工作量与分期

### 第 0 期 — 不需要桥接层、现在就值得做的收口（半天）

1. `IS_TAURI` 探测收敛到 `platform.ts` 单一出口（6 处重复）；
2. `fs/images.ts:7` 改走 `fileio.ts` 的 `readBinaryFile`；
3. `getVersion()` 改构建期注入。

### 第 1 期 — 最小可用（核心工作量，估 1~2 周）

- Rust：axum 依赖 + 静态托管 `dist/` + token 认证 + Host 校验 + fs/sql/prefs RPC（复用 `commands.rs` 逻辑与 `FsScope`）+ AI SSE 代理 + asset 直出；设置页开关（端口、绑定地址、token 二维码）。
- 前端：`platform.ts` 三态；`fileio.ts` / `project.ts` / `keyStore.ts` / `http.ts` 的 bridge 实现；上传/下载替代对话框的最小版（先只做文档导入）；`revealItemInDir` 等按钮在 bridge 模式隐藏。
- 并发：mtime 冲突检测。

### 第 2 期 — 补全

zip 导入导出 Web 化、lore 图库上传、打印降级、`beforeunload` 保存兜底、文件变更 SSE 提示、移动端布局适配（AiRail/Sidebar 在手机屏幕上的折叠策略——现有布局是三栏桌面布局，手机可用性需要单独一轮设计）。

---

## 8. 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| API key 泄漏到浏览器 | 高 | §4：key 永不出服务端，`secret_load` 不进 RPC 白名单 |
| 路径穿越 / symlink 逃逸 | 高 | §3.2：canonicalize + 项目根前缀校验，复用 FsScope |
| DNS rebinding / CSRF | 中 | Host 校验 + token |
| LAN 明文流量被嗅探 | 中 | 默认仅 127.0.0.1；启用局域网时明示告警 |
| 双端并发编辑丢内容 | 中 | mtime 冲突检测 + 变更提示 |
| 浏览器关页丢最后一次编辑 | 中 | 去抖保存 + visibilitychange flush |
| non-secure context API 缺失（clipboard 等） | 低 | execCommand 兜底 |
| 手机屏幕可用性 | 低（分期） | 第 2 期单独设计 |
