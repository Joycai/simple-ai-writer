# 可下载字体：鸿蒙黑体与 MiSans

- **状态**：`shipped`（v1.77.0；Windows / Linux 未实测，见 §8）
- **设计稿**：claude.ai/design「Simple AI Writer UI redesign」→ `05n 可下载字体 Font Packs`
- **代码**：`src/lib/theme/fontPacks.ts`（下载器）· `src/lib/theme/fontPackData.ts`（生成的锁定表）· `scripts/gen-font-packs.ts` · `src-tauri/src/fontproto.rs`（`ai-writer-font:`）· `stores/appStore.ts`（`fontPacks`）· `components/settings/panes/FontPackCard.tsx`

字体方案（`data-font`）新增两款：**鸿蒙黑体**（HarmonyOS Sans SC）和 **MiSans**。它们不进安装包，也不进仓库。作者第一次选中时下载到本机 `appDataDir/fonts/<id>/<version>/`，下载完之后与系统字体一样使用，离线也可用。

## 1. 字体名在构建期就定了，只有字节是运行期的

两款字体的族名是已知常量，所以它们的**字体栈**照老配方写进 `tokens.css`：族名打头，后面接 黑 的回退栈。`gen-theme-contract.ts` 会把它们冻结进 `contractData.ts`。这样一来，`exportFontCss`、`sampleDocument`、导出 HTML、打印都不必为「可下载」另开分支，都从同一份 contract 取栈。

**没下载时**浏览器找不到这个族名，自然落到黑体那一栈。「未就绪」的降级不需要一行代码。

运行期只补一件事：`@font-face` 规则，`src` 指向本机文件。

*考虑过但没采用*：把字体栈也放到运行期注入。这样导出、样张、打印各要开一条分支，`contract.fontSchemes` 也会和实际对不上，而族名本来就不需要等到运行期才知道。

## 2. 字节怎么进 webview：一个窄协议 `ai-writer-font:`

`fontproto.rs` 只做三件事：
- 只服务 `<app_data_dir>/fonts/` 下的 `.woff2`。
- 路径**先按字面判定**：绝对路径、在根下、不含 `..`。通过之后才 canonicalize 并复核，挡住符号链接。
- 响应带 `Access-Control-Allow-Origin: *` 和长缓存头。

CSP 的 `font-src` 加上这个 scheme，以及 Windows 形式 `http://ai-writer-font.localhost`。

- **为什么要 URL，而不是经 IPC 传字节**：包自带的 `@font-face` 表按 `unicode-range` 切片（MiSans 每字重 56 片，鸿蒙每字重 82 片）。浏览器只拉页面用到的那几片，装好的包启动时零成本。用 `FontFace(ArrayBuffer)` 就得每次启动把 6–15 MB 全部经 IPC 读进来，而且样张 iframe 和打印窗口还看不到这些 FontFace。
- **为什么要窄协议，而不是 `data:` 或 Tauri 内置的 `asset:`**：几 MB 的 base64 塞进每个样张 iframe 不可行。内置的 `asset:` 不能只放行 woff2，也不能加 ACAO。本仓库一贯一个用途配一个窄协议，`ai-writer-preview` 是先例。
- **为什么要字面判定在前**（review 修复）：Windows 上，网页可控的 `//host/share/x.woff2` 如果先交给 `canonicalize`，会发起 SMB 连接，泄露 NTLM 哈希，还可能卡在超时上。
- **为什么是异步协议**：一个中文页面一次会拉几十个分片，而这个应用的文件读取一律不上主线程（`blocking.rs`）。
- **为什么要 ACAO `*`**：主窗口（`tauri://`）、沙箱样张（不透明源）、打印窗口（`ai-writer-print:`）对这个 scheme 都是跨源，而字体请求走 CORS 模式。这些文件本来就是公开字体，放开给任何源不会泄露什么。

## 3. 锁定表：信任只来自这里

`scripts/gen-font-packs.ts` 在开发期从 jsDelivr 的包索引生成 `fontPackData.ts`：
- 每个包、每个字重（400 / 500 / 700）一份包自带的 sheet，加上这份 sheet 引用到的全部分片。
- 每个文件记大小和 sha256，共 420 个文件，约 21 MB。
- 加 `--verify` 时，会把全部分片真的下载一遍逐个核对。**升级版本时要跑 `--verify`**。

| 包 | 版本 | 三档体积 |
|---|---|---|
| `harmonyos-sans-sc-webfont-splitted` | 1.1.0 | 14.9 MB（249 个文件） |
| `misans` | 5.0.0 | 6.1 MB（171 个文件） |

**运行期的源只负责送字节，不参与信任判断**：
- 每个文件逐个比对大小和 sha256，对不上就换下一个源。
- 所有源都给了错的字节，才算完整性错误。
- sheet 里出现锁定表之外的文件名，直接拒绝。

源的顺序：
- **MiSans**：npmmirror → jsDelivr（cdn / fastly / gcore）→ unpkg。
- **鸿蒙**：直接从 jsDelivr 开始。npmmirror 对这个包返回 **403**，因为它不在 npmmirror 的 unpkg 白名单里（2026-09-23 实测）。

一次安装里会记住上一个成功的源，后面的文件从它开始试。每个请求带连接超时 10 s，并在 60 s 后中止，所以一个连上之后停住的源不会让下载永远挂着。

**升级字体版本**：改 `gen-font-packs.ts` 里的版本号，跑 `node scripts/gen-font-packs.ts --verify`。新版本装进新目录。旧版本的目录在装好之后会被清掉；没人再选的包，由启动时的 `pruneOtherVersions` 清掉。

## 4. 落盘与完成

- **分片、`faces.css`、完成标记都经临时名写入再改名**（`<name>.<随机>.part`）。这样「大小对」就等于「写完整了」，断点续传只比大小就够。临时名每次写入各不相同，两个窗口同时写同一个分片时，各自改名的都是一份完整的同样字节，谁也不会把对方写到一半的文件改过去。
- **`faces.css`**：只存分片名，读的时候按当前的 appData 路径拼 URL。appData 目录搬家（漫游配置、账户迁移）之后照样能用。
- **`installed.json` 最后写**。没有它就算没装，不管盘上已经有多少分片；重试时只补还缺的。
- **首个失败即停队列**，而且要等所有 worker 回来才 reject。否则失败之后后台还在写盘，会和紧接着的重试赛跑。
- **`rewriteFaces` 去掉全部 `local()`**：字节已经在本机，而鸿蒙 500 / 700 字重里只写族名的 `local("HarmonyOS Sans SC")`，会让粗体落到本机装的 Regular 上。

## 5. 「选了」与「有了」是两件事

- `app:fontScheme` 只表达选择。它是品味，随配置备份走。
- 本机有没有文件，**以磁盘为准**：看 `installed.json`，状态放在 `appStore.fontPacks`。**不新增任何偏好键**。

| 时机 | 行为 |
|---|---|
| 作者点卡片 | 即下载，没有第二个按钮。先查磁盘，状态里的「ready」不作数：另一个窗口可能已经删了。 |
| 启动 | `boot()` 在 App 挂载前预读**当前**包的 faces，首帧就是作者的字体。挂载之后 `initFontPacks` 补齐其余状态；选中了但本机没有的包（比如从备份恢复到新机器）自动下载，选中本身就是同意。 |
| 配置导入（`reloadFromPrefs()`，无 keys） | 同上，缺就下载。 |
| 另一个窗口改了选择（焦点同步，有 keys） | **只重读磁盘，不下载**。否则两个进程会往同一目录下同一个包。窗口每次获得焦点、外观页每次挂载都会重读一次磁盘，这样另一个窗口的下载和删除都能看到。 |
| 下载中切到别的方案 | 不取消，下完留着，下次选中立刻生效。 |
| 删除正在用的包 | 先切回 **黑**（两款的回退栈就是它，删完之后字形变化最小），再删。删除一开始就同步标成「缺席」；删除途中再选中，会等删完之后重新下载。 |
| 重置应用 | 删 `appDataDir/fonts`：它是本机缓存，刚装好的应用本来就没有。 |

`@font-face` 按包各注入一张 `<style id="font-pack-faces-<id>">`。主窗口注入全部已装的包，让每张卡片用自己的字体预览；**样张和 PDF 只带当前方案那一个包**，免得每个 iframe 都解析几百 KB 用不到的规则。

## 6. 各消费方

| 消费方 | 字体栈 | `@font-face` |
|---|---|---|
| 主窗口（界面、编辑器、预览） | `tokens.css` | 注入的 `<style>` |
| 外观页样张（沙箱 iframe） | `sampleDocument` 从 contract 取 | 由 `MdSample` 传入 |
| 打印 / PDF | `documentCss` 从 contract 取 | `currentFontFaces(scheme)`，从 DOM 读；**打印等字体**：页面在 `document.fonts.ready` 之后请求自己源上的 `/__fonts-ready`，`print.rs` 收到后才弹打印框，最多等 3 s。按需加载的分片在长文里可能晚到，固定延时会把它们印成回退字形。作者自己的 .html 不带这段脚本，不等。 |
| 导出 .html | 从 contract 取 | **不带**：协议 URL 在别的机器上打不开；读者装了这款字体就用，没装就落到黑体，和 宋 / 黑 / 楷 一样依赖读者的机器。把几 MB 字体塞进导出文件，另开任务。 |

## 7. 许可

两款字体都可以免费商用，按各自的许可使用（鸿蒙：华为 HarmonyOS Sans 字体许可；MiSans：小米 MiSans 字体知识产权许可）。**应用本身不分发字体文件**，只从公开的 npm 镜像下载到作者本机。设置页脚注写明版权方，并链接两份许可。

鸿蒙那个 npm 包是第三方从官方 zip 切片出来的。它标的 Unlicense 只适用于切片脚本，字体本身仍受 HarmonyOS Sans 许可约束。

## 8. 验证

- **单元测试**：
  - `fontPacks.test.ts`：校验、换源、源记忆、续传、`.part`、标记最后写、首个失败停队列、改写规则。
  - `fontPackData.test.ts`：锁定表的形状。
  - `appStoreFontPacks.test.ts`：状态机、多窗口、删除途中再选中、按包注入。
  - `themeExport.test.ts`：字体栈、样张带 faces。
  - `appReset.test.ts`。
  - Rust `fontproto` 13 条：字面判定、UNC、`..`、文件和目录符号链接、响应头、URL 层的 403 / 404。
- **CSP 只能在打包产物里验**：dev 模式下主窗口直接加载 Vite，不注入 CSP。
- **打包产物实测**（macOS，`pnpm tauri build --debug`，2026-09-23；用一段不提交的启动探针在真实 CSP 下调用下载器）：
  - **真实下载**：按源顺序装成功——MiSans 19.4 s 装完 6.1 MB，鸿蒙 51.7 s 装完 14.9 MB，两个完成标记都写上了。探针没记录每个文件实际取自哪个源。
  - **字体加载**：经 `ai-writer-font:` 加载，400 / 500 / 700 三档都成功（MiSans 18 条 face、鸿蒙 12 条都是 loaded，0 条 error）。同一串字的宽度与回退字体不同，说明画的是真字形。
  - **`fetch()` 直接取字体会失败**（`Load failed`）。推测是 `connect-src` 没列这个 scheme，没有深究：应用里没有任何代码用 fetch 取字体，字体只走 `font-src`，而那一路已经加载成功。
  - **要肉眼看的**：外观页样张 iframe（沙箱，不透明源）的字形，以及长文加粗体导出 PDF。PDF 已经改成等 `document.fonts.ready` 再打印（上表），但「确实不混排」还要在打包产物里看一眼。实测结果补在这里。
- **已知限制**：下载失败后，已经落盘的分片留在 `fonts/<id>/<version>/` 里（最多一个包的体积），卡片上只有「重试」、没有「删除」；重试会用上它们，重置应用会清掉。
- **未验证**：Windows（`http://ai-writer-font.localhost` 形式只有解析层单测）、Linux（webkitgtk 对自定义 scheme 的跨源字体请求）。
