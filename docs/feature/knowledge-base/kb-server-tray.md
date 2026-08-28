# Windows 托盘启动器（`aiw-kb-tray`）

`server/` 的部署故事在 Linux/NAS 一侧是完整的——`DEPLOY.md` 写了 systemd 和
Docker，开机自启、后台常驻、日志都有归宿。Windows 一侧不是：双击
`aiw-kb-server.exe` 得到一个黑色控制台窗口，关掉窗口服务器就停了，而首次启动
自动生成的管理密码和同步 token 恰好打印在这个没人盯着看的窗口里。给自己家里
那台「当服务器用」的 Windows 机器，这个体验是断的。

这份文档记录托盘启动器的选型、结构和边界。

- 服务端是什么、API 长什么样：[`server/README.md`](../../../server/README.md)
- 部署运维（Linux 一侧）：[`server/DEPLOY.md`](../../../server/DEPLOY.md)
- 管理后台（托盘把一切复杂操作都指向它）：[`kb-admin-console.md`](kb-admin-console.md)

---

## 1. 选型：为什么是同 crate 里的第二个二进制

关键观察是**管理界面已经存在了**。`/admin` 后台能改配置、管 token、看活动日志、
做磁盘维护——启动器如果再长一套界面，那套界面只会是 `/admin` 的劣化重复。
所以启动器的职责清单收得很小：

1. 常驻托盘，不弹控制台窗口；
2. 启动 / 停止服务器；
3. 开机自启（跟随 Windows 登录）;
4. 首次启动时把自动生成的凭据**弹在人眼前**（而不是打在控制台里）；
5. 打开管理后台、弹一个状态框——其余一切跳转到 `/admin`。

对比过的方案：

| 方案 | 为什么不是它 |
| --- | --- |
| Tauri 小启动器 | 为五个菜单项背一个 webview；它长出来的界面必然和 `/admin` 重复 |
| 集成进写作软件（sidecar） | 服务器的价值恰恰是写作软件关着的时候别的机器还能同步，生命周期绑错了宿主 |
| WinSW/NSSM 包成 Windows 服务 | 零开发量，但首启凭据展示和托盘状态都没有解决，对非运维用户不友好 |
| **同 crate 第二个 bin（选定）** | 服务器**作为库在进程内跑**——没有子进程管理，不用探测「它还活着吗」；单 exe 双击即用；无 webview，体积几 MB |

「进程内跑」顺带解决了最烦人的一类问题：启动失败（端口被占、配置文件损坏）
是一个**同步拿到的 `Err`**，直接弹对话框，而不是「子进程起了又立刻退，去日志里
考古」。

## 2. 结构：lib 化 + 双 bin

`main.rs` 原本只有两百行胶水（CLI → `Config::load` → tracing → `Store`/`AppState`
→ `axum::serve`），领域逻辑全在模块里。重构是机械的：

- `src/lib.rs` —— 声明全部模块（原 `main.rs` 顶部的 `mod` 列表），并暴露启动
  骨架的两步：`bind(config) -> Result<BoundServer>`（建 Store / AuditLog /
  AppState / router，**绑定端口**）和 `BoundServer::run(shutdown)`（serve +
  优雅停机）。拆成两步不是洁癖：**绑定失败必须是启动方立刻拿到的错误**——
  headless 版打给 stderr，托盘版弹对话框，两边都不接受「spawn 出去之后再从
  JoinHandle 里捞」。
- `src/main.rs`（`aiw-kb-server`，不变的 headless 入口）—— CLI 解析、tracing
  到 stderr、首启凭据打印、警告，然后 `bind` + `run(ctrl-c)`。行为与重构前
  完全一致。
- `src/bin/tray.rs`（`aiw-kb-tray`，Windows 专属）—— 见下节。非 Windows 平台
  编译一个打印说明并退出的桩，这样 ubuntu 上的 CI（`clippy --all-targets`）
  照常把它编译过一遍。

## 3. 托盘的行为

- **启动即服务**：托盘进程起来就加载配置并启动服务器（那是它存在的目的），
  图标进托盘。启动失败（端口占用、配置解析错误）→ 错误对话框，托盘留着，
  菜单里可以「启动服务器」重试。
- **菜单**：`启动服务器`/`停止服务器`（一项，label 随状态换）· `打开管理后台`
  （仅运行时可用）· `服务器状态…`（对话框：运行状态 / 监听地址 / 数据目录 /
  配置文件路径 / 版本）· `开机自启`（勾选项）· `退出`（先优雅停机再退出）。
- **每次启动都重读配置文件**：`/admin` 会改配置，「停止再启动」必须拿到新值，
  所以 `Config::load` 发生在每次 start，而不是进程起点一次。
- **首启凭据**：`config.file_created` 为真（这次运行刚生成了配置文件）→
  信息对话框展示管理后台地址、用户名、密码、同步 token，并提示这些值也躺在
  配置文件里；确认按钮直接打开管理后台。headless 版的 stdout 打印保持不动——
  同一事实的两种呈现，各自面向自己的观众。
- **图标即状态**：图标是代码里过程式画出来的 RGBA（实心 = 运行中，空心 =
  已停止），不引入图片解码依赖，也不需要 build script。exe 文件图标暂缺，
  以后补 `.ico` 时再加 `embed-resource`。
- **运行中崩溃**：serve 任务意外返回 → 通过事件循环的 proxy 通知主线程，
  图标翻成停止态并弹错误框。不做自动重启——一个反复崩的服务器需要人看一眼，
  而不是被安静地拉起第 41 次。
- **日志**：GUI 子系统没有 stderr，tracing 改写到数据目录旁的
  `tray.log`（追加）。审计日志（`audit.log`）照旧。

## 4. 开机自启 = HKCU Run 键

`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 写一个指向托盘 exe 的值。
选它而不是 Windows 服务：不需要管理员权限、跟随用户登录、删除即撤销，而
「无人登录也要跑」的场景 DEPLOY.md 的服务方案（WinSW）仍然可用。勾选状态每次
打开菜单时从注册表现读，所以在别处删了这个键，菜单不会说谎。

## 5. 边界（不做的事）

- **不做全局互斥**。两个实例抢同一个端口，后来者 bind 失败弹框——端口本身
  就是锁，语义还更准（占端口的可能是任何进程，不只是另一个自己）。
- **不做配置编辑、token 管理、日志查看**——全部指向 `/admin`。
- **不做自动重启**（见上）。
- **不做 macOS/Linux 托盘**。那两边的部署故事是 systemd/launchd 的，硬造一个
  托盘是给没有的问题发明解法。桩只为 CI 编译存在。

## 6. 依赖（全部 `cfg(windows)` 门控）

| crate | 用途 |
| --- | --- |
| `tray-icon` | 托盘图标 + 菜单（muda 经由它 re-export） |
| `tao` | Win32 消息循环（托盘事件需要一个泵） |
| `rfd` | 原生对话框（凭据 / 状态 / 错误） |
| `winreg` | Run 键读写 |
| `open` | 用默认浏览器打开 `/admin` |
| `tracing-appender` | tracing 落文件 |

ubuntu CI 一个都不会编译到；`Cargo.lock` 照常提交（CI 用 `--locked`）。

## 7. 实现记录

2026-08-28 实现（lib 化 + `src/bin/tray.rs`，一片）。与方案的出入：

- **多了一条方案没写的硬规则：托盘启动第一件事把 CWD 定到 exe 目录。**
  实现时发现 `data_dir = "./data"` 是运行时 CWD 相对的，而 Run 键拉起的进程
  CWD 是系统目录——不定 CWD，开机自启的那次启动会把数据写进 System32（然后
  因权限失败）。定了之后，双击和自启看到同一个世界：exe 旁边的 `aiw-kb.toml`
  + `data\`。headless 版不动，systemd/Docker 部署依赖 CWD 语义。
- 状态对话框顺带承担了 headless 版两条 tracing 警告的呈现：配置文件解析失败
  （运行在默认值上）和 `allow_anonymous` 开着，都以 ⚠ 行出现在状态里。
  托盘没有别的地方能安置「非致命但该知道」的事。
- 「每次打开菜单时现读 Run 键」实现为响应 `TrayIconEvent`（右键弹菜单前
  必有一次图标交互事件），不是真正的 menu-about-to-open 钩子——muda 没有。
- 崩溃报告走 generation 计数：serve 任务只在 `Err` 时上报，优雅停机在事件
  可能到达前就取走了 `running`，两层保证「服务器意外退出」对话框不会在
  作者自己点了停止之后冒出来。
- 意外收获：`bind`/`run` 拆开后，headless 版启动失败的报错时机也变准了
  （原实现绑定失败同样是立刻报，这里只是把这个性质固定进了类型）。
