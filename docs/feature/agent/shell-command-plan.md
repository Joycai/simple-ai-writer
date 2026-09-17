# 命令行工具 · `run_command`

> 状态：`shipped`——原始实现见 [#561](https://github.com/Joycai/simple-ai-writer/pull/561) / [#563](https://github.com/Joycai/simple-ai-writer/pull/563)；2026-09-15 将审批改成当前策略：跨平台只读白名单免审，其余命令展示原文，普通写命令可按 1–5 条连批且只活到当前运行结束，危险命令永远逐条审批；2026-09-17 加**免审批命令**（作者列出的程序，卡上可「始终允许」，由它们和只读命令组成的单条或 `&&` `||` `;` `|` 串联命令免审，§3.8）。**未做**：可选流式尾行（`tauri::ipc::Channel`）。
> 一句话：给 agent 一个能跑本机命令的混合权限工具——Windows 走 PowerShell，macOS / Linux 走系统 shell；可证明只读的直接运行，其余先过审批卡。
> 前置阅读：[`../../reference/tool-presence.md`](../../reference/tool-presence.md)（工具在场性）· [`agent-tool-context-lld.md`](agent-tool-context-lld.md) §5（棘轮）· [`../asr/01-execution-plan.md`](../asr/01-execution-plan.md)（「付费之前先点头」的那张卡，本方案的样板）· [`../latex-pdf-plan.md`](../latex-pdf-plan.md) §5（为什么不装 `tauri-plugin-shell`，本方案沿用其结论）

---

## 0. 为什么要有它，以及它不是什么

助手今天能做的事被工具集圈死：读写项目里的文件、改知识库、导出三种格式、转写、生图。作者要做的很多事在这个圈外面，而且**每一件都小到不值得做成一个工具**：

- `git log --oneline -20` / `git diff 第三章.md`——看这章上周改了什么；
- `pandoc 稿.md -o 稿.epub`——作者机器上装着的转换器；
- `ls -R`、`wc -w`、`find … -newer`——统计、盘点，`list_files` / `search_text` 之外的那些问法；
- `python 脚本.py`——作者自己写的那些小工具；
- `open`/`Start-Process`——把成品交给别的应用。

每一件都做成专用工具，是一条永远走不完的清单，而且每一条都要付一份 schema 的钱（棘轮今天只剩 65 token 的余量）。一个通用的「跑一条命令」工具把这整条清单折成一个 schema。

它**不是**：

- **不是任意命令的免审口。** Rust 侧管 `cwd` 围栏、句柄表、超时和杀组，审批策略在前端。只有 `commandAccess` 的封闭白名单判为只读、或作者亲手列进「免审批命令」的程序（§3.8），才直跑；任何未知命令、带危险形状或重定向的命令、带写入/执行参数的“读取工具”都回到审批卡。
- **不是跨消息的自动化流水线。** 普通写命令最多连批 1–5 条，并绑定发起它的 run；run 结束余量清零。批量运行、扮演、一致性检查、写手、pack 子运行仍没有这个工具。
- **不是 LaTeX 方案的替代。** 那条线是固定二进制 + 固定参数表 + 不经 shell（其 I4），正因为 .tex 有一半是模型写的。这条线相反：命令是模型写的、经 shell 跑，所以它**必须**过卡，而 LaTeX 编译不必。两条互不替代。

---

## 1. 不变量

下面任何一条被破坏都算 bug，不算权衡。

1. **只有可证明只读、且只读项目内的命令——或作者亲手列进「免审批命令」的程序（§3.8）——能在作者点头前起进程。** `commandAccess` 默认返回 `write`；白名单按 PowerShell / POSIX 分开。重定向、管道、分隔、替换、变量展开、花括号、环境前缀、未知程序、**带路径或扩展名的程序名**（`./cat`、`./ls.ps1`——按 basename 命中白名单会跑项目里的同名文件），以及 `find -delete`、`rg --pre`、`tree -o`、`git grep -O`、`git diff --output`（**含缩写** `--outp`，git 接受无歧义前缀）等参数全部审批。免审的读取不出卡但输出仍送给模型，所以参数里的绝对路径、`~`、`..`、能匹配 `..` 的点号通配、PowerShell 盘符/provider（`C:` `Env:` `HKLM:`）一律回卡——否则一段注入就能让 `cat ~/.ssh/id_rsa` 静默进上下文。`ls-remote`（联网，`--upload-pack` 能起任意程序）、`locate` / `mdfind`（本意就是搜全盘）、`ps`（`ps e` 打印别的进程的环境变量）不进白名单。
2. **写命令卡上是命令原文，不是转述。** 等宽、不折行省略、不做任何「美化」；模型的 `reason` 另起一行。批准即运行，拒绝则进程不存在。
3. **正文的布尔 `autoApprove` 永不覆盖命令。** `AUTO_APPROVABLE` 里没有 `"command"`。命令只有计数授权 `commandLeft`：最多 5 条、绑定 `commandRun`、**复合命令和危险形状永不命中**，run 结束即清零。复合那一条不能省：`looksDangerous` 是改卡外观的小表，不是完整清单（`rm *.md`、`git checkout -- .`、`python -c …` 都不中），只靠它挡，批给 `pandoc a.md -o a.epub` 的连批就能盖住 `touch x; <任意命令>`。
4. **Beta 关着＝工具缺席。** `routeTools` 里 `isCliEnabled() && IS_TAURI && options.commands` 三者同时成立才追加；任何一个不成立，`allowedTools` 里没有它——不是渲染成禁用，不是调用被拒（[tool-presence](../../reference/tool-presence.md) 「关掉时是缺席还是拒绝」）。浏览器里的 `pnpm dev` 永远没有它。
5. **只有能渲染审批卡的 surface 拿得到。** 对话助手、非批量的任务面板；批量运行、扮演、一致性检查、写手、pack 子运行一律没有。路由用显式 opt-in（`RouteOptions.commands`），不从 preset 推——理由同 `askAuthor`：卡能不能显示是 surface 的属性，preset 不知道。
6. **stdin 永远是 `/dev/null`。** 任何要交互的命令立刻失败，而不是把整轮挂死在一个看不见的提示符上。配套：`NO_COLOR=1` `TERM=dumb` `PAGER=cat` `GIT_PAGER=cat` `GIT_TERMINAL_PROMPT=0`。
7. **超时与中止都真的杀得死。** Rust 侧持有子进程句柄；超时（默认 60s，模型可要到 600s，卡上写明）或作者中止（`AbortSignal` → `cmd_kill`）时杀**整个进程组**：unix 用 `process_group(0)` + `killpg`，Windows 用 `taskkill /T /F`。只杀 shell 本体会留下它起的孙进程，这是最常见的「中止了但风扇还在转」。
8. **输出有上限，且上限之外的部分不丢。** 进程输出在 Rust 侧最多留 1MB（超出后停止收集并标记）；回给模型的结果最多 ~8000 字（头 6000 + 尾 2000，中间写「……省略 N 字，完整输出见 <路径>」）；完整输出落 `.ai-writer/tmp/cmd/<runId>-<n>.log`，模型用 `read_file` 分页读。理由同 `read_file` 的 4000 字分页：一条 `git log` 就能把一轮上下文吃光。
9. **`cwd` 在项目围栏内，命令本身不在。** `cwd` 参数是项目相对路径，TS 侧 + Rust `FsScope::check` 双重判定在项目内。但 shell 能 `cd ..`、能碰 `.ai-writer/`、能碰整块磁盘——**围栏挡的是参数，闸是那张卡**。文档和卡片文案都不许暗示「命令只能动项目里的东西」。
10. **Windows 不闪黑窗。** `CREATE_NO_WINDOW`（`0x08000000`）经 `CommandExt::creation_flags` 传入；缺了它每条命令弹一个控制台窗口，作者读到的是「应用坏了」。
11. **描述里点名的 shell 就是实际跑的 shell。** 工具 description 在 `getToolDefinitions` 时按平台生成（先例：`list_lore_entities` 把分类 id 拼进 description），写明「PowerShell」或「zsh」或「sh」——一个不知道自己在 Windows 上的模型会写 `ls -la | grep`，然后把一轮花在读错误上。**系统也一起点名**（2026-09-17 补）：「macOS 15.2 · arm64」「Windows 10.0.26100 · x86_64」「Ubuntu 24.04.1 LTS (Linux) · x86_64」。只说 zsh 不够——zsh 在 macOS 上配的是 BSD userland（`sed -i ''`），在 Linux 上是 GNU；`open` / `xdg-open`、`brew` / `apt` 也只能由系统决定。系统信息和 shell 同一次探测（`ShellInfo.os / osVersion / arch`，macOS 读 `SystemVersion.plist`、Linux 读 `os-release`、Windows 在 PowerShell 探测里多打一行 `[Environment]::OSVersion`），不起新进程；只放在 `run_command` 的描述里、不进系统提示词——没有这个工具的运行用不上它，按[在场性](../../reference/tool-presence.md)也不该提。设置页的脚注用同一个 `systemLabel`，作者看到的就是模型读到的那句。代价：描述多约 10 token，棘轮从 340 上调到 360。
12. **免审批命令只信作者亲手列的程序名，且只信「这个程序本身」。** 清单（`app:cliAllowlist`）只在设置页或卡上的「始终允许」按钮里增加，模型没有任何途径改它。命中还要同时满足：整行无危险形状；按 `&&` `||` `;` `|` 换行切开后**每一段**都是只读或被清单覆盖；每一段过与只读白名单**同一个** `plainInvocation`（裸名程序、无环境前缀、无变量/花括号/PowerShell 括号、参数不出项目）；不带该程序已知的「起另一个程序」的钩子（`git -c` / `config` / `--upload-pack`、`gh alias`、`pandoc --filter` / `--pdf-engine`、`find -exec` 等）。shell、解释器、启动器、提权（`bash` `python` `node` `npx` `env` `xargs` `sudo` `iex` …）**永远不能加入**——加入它们等于任何命令都免审；手改进偏好里的也在读取时丢掉。重定向、后台 `&`、命令替换在串联里一律回卡。

---

## 2. 决定表

| # | 问题 | 决定 | 理由 |
|---|---|---|---|
| 1 | 装不装 `tauri-plugin-shell` | **不装** | 它唯一的安全机制是静态 capability 允许清单（逐个程序、逐个参数正则），而我们要跑模型现写的任意一行，只能声明 `cmd: pwsh, args: true`——清单等于关掉，剩下一个 spawn。我们要的它都没有：超时、杀进程树（它的 `kill()` 只杀 shell 本体）、输出封顶、编码检测（只能指定固定编码）、`FsScope` 的运行时 `cwd` 围栏。它给的只有 `CREATE_NO_WINDOW`（一行 flag）和流式事件（`Channel` 二十行）。项目里 fs / dialog / opener 都因同一个理由包成自定义命令；先例 `instance.rs` 自己起进程，latex-pdf-plan §5 同一结论 |
| 2 | Windows 用哪个 PowerShell | **`pwsh.exe`（7）优先，找不到退 `powershell.exe`（5.1）** | 7 默认 UTF-8、快；5.1 每台 Windows 都有。两者参数表相同：`-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <cmd>` |
| 3 | Windows 的输出编码 | **命令前加序言 `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8;`，Rust 侧再过一遍 `decode_text`** | 5.1 默认按 OEM 代码页（中文 Windows 是 GBK）输出，序言解决 PowerShell 自己的输出；外部程序（`git` 在某些配置下）仍可能吐 GBK，`commands.rs` 已有的 BOM → UTF-8 → chardetng 那条链正好兜底 |
| 4 | macOS / Linux 用哪个 shell | **`$SHELL` 若是认识的那几个且可执行则用它，否则 macOS `/bin/zsh`、Linux `/bin/bash`（没有再 `/bin/sh`）；一律 `-l -c`** | 「系统自带的即可」。**`-l`（登录 shell）是必需的**：从 Finder / Dock 起的 GUI 应用只有 `/usr/bin:/bin:/usr/sbin:/sbin`，Homebrew、pyenv、nvm 全在 `~/.zprofile` 里——不加 `-l`，作者装的每一个工具都「找不到」。Windows 的 PATH 在注册表里，不需要 profile，所以那边 `-NoProfile`。这不对称是故意的 |
| 5 | 参数形状：一条字符串还是 argv 数组 | **一条字符串** | 工具的价值就在管道、通配、重定向；argv 数组等于把 shell 关掉再让模型自己拼引号。代价是 §1.2 那张卡必须是唯一防线——它本来就是 |
| 6 | 要不要 `-NoProfile` 之外的沙箱 | **不要** | 没有可信的跨平台沙箱；假装有一个比没有更糟（作者会据此放松那张卡）。卡上的措辞：「这条命令以你的账户权限运行，能做你在终端里能做的一切」 |
| 7 | 输出怎么回 | **一次性返回，不流式**（第一期） | 今天前端没有任何 `@tauri-apps/api/event` 监听；流式（`tauri::ipc::Channel`）放 PR 3。第一期用前端计时器每秒 `onProgress({label: "运行中 · 12 秒"})`，同生图轮询 |
| 8 | 结果里报什么 | `exit code` + stdout + stderr 分开 + 耗时 + 是否超时/被杀 + 完整日志路径 | 分开报是因为 stderr 常常不是错误（`git` 的进度、`npm` 的 warn）；模型看 exit code 判成败，不看哪个流有字 |
| 9 | 日志清扫 | `.ai-writer/tmp/cmd/` 只留最近 50 份 | 同 `.ai-writer/tmp/convert/` 的做法；`tmp/` 本来就在 sync 与备份的排除清单里 |
| 10 | 进不进 preset 字面量 | **不进，`routeTools` 追加** | 同 `translate` / `ask_author`：要 Beta + Tauri + surface 三个条件，preset 处一个都不知道；顺带让原始 preset 的棘轮看不见它，成本钉在 routed-set 断言里 |
| 11 | 进不进 orchestrator 的 pack | **第一期不进**，§7 待议 | pack 子运行的审批通道是透传的，技术上能进；但「派一个子运行去跑命令」多出一层间接，先看主 preset 上的用法 |
| 12 | 作者面向的词 | 功能叫**命令行**，一条叫**命令**，卡叫**运行命令** | 不用「终端」（它暗示有个能交互的窗口，而 §1.6 说没有）、不用「脚本」（那是文件）。实施时对照 `terminology.md` |
| 13 | 哪些命令免审 | **封闭的、分平台只读白名单；程序必须是裸名；参数必须留在项目内；默认写入** | shell 无法可靠静态解析，误判只读会直接执行。常见 `ls/cat/grep/rg/find` 与 PowerShell `Get-ChildItem/Get-Content/Select-String` 覆盖主要盘点场景；有执行钩子或输出文件模式的参数单独退回审批（git 长选项按前缀判，因为 git 接受缩写）。参数围栏是 2026-09-15 复查后补的：以前每条命令都过卡，读 `~/.ssh` 作者会看到；免审之后读取的输出不经作者直接进模型上下文，围栏是替那张卡守住「作者没看过的东西不出项目」。误伤（`grep 'a:b'` 在 PowerShell 里被当成 provider 路径）只多一张卡 |
| 14 | 写命令怎么连批 | **下一批 1–5 条单条普通写命令，绑定当前 run** | 同生图的 counted grant；不跨用户下一条消息。复合命令与危险形状不提供按钮，也不消耗已有余量——危险表不完整，复合是它漏掉的那部分的兜底（§1 不变量 3） |
| 15 | 要不要作者可维护的免审程序清单（2026-09-17，作者提出） | **要，按程序名，装机级、机器本地** | §7 原把它列为待议，理由是「授权从当场点头变成一行配置，是一次信任模型的迁移」。作者明确要这次迁移，它换来的是 `git` / `gh` / `pandoc` 这类每天几十次的命令不再逐条点。迁移的边界靠不变量 12 守：清单只有作者能写（设置页 + 卡上按钮），命中条件与只读白名单共用形状检查，列不进会跑代码的程序。**按程序名而不是按子命令**（`git` 而不是 `git status`）：作者给的例子就是程序名；子命令粒度要给每个程序写一份解析器，而危险子命令已有危险表 + 钩子表兜。**装机级**而不是 §7 设想的项目级 `.ai-writer/commands.json`：作者在实验室页维护它；而项目文件会随同步、备份、他人的仓库进来，一份别人写的「免审」文件正是这里最不该信的东西。**机器本地**（`MACHINE_LOCAL_PREF_KEYS`）：信的是这台电脑上的那个程序，另一台上同名的可能是别的东西，作者也没在那台上点过头 |
| 16 | 串联命令算不算（2026-09-17，作者追加） | **算：切段后每一段都只读或被覆盖，整行才免审** | 作者的原话是「同时执行三个白名单命令，也得放行」——`git add … && git commit … && git push` 是清单最常见的用法，只认单条会让清单在最需要它的地方失效。切分只认 `&&` `||` `;` `|` 和换行，**不认**重定向（写文件）、后台 `&`（进程脱离中止）、命令替换（`$(…)` 里的东西不是任何一段）；危险表对**整行**再跑一次（`curl … \| sh` 跨段）。纯只读的串联（`git log \| head`、`ls \| wc -l`）顺带也免审——每一段单独就免审，串起来并没有多做什么。计数连批（#14）**仍**不接复合命令：它不知道每段是什么，只有清单知道 |
| 17 | 卡上的「始终允许」什么时候出现 | **只在加进去之后这一行本身就能免审时；列出这一行还缺的全部程序（`始终允许 git · gh`）；不要求 `autoApproveKey`** | 一个点完之后同样一行照旧出卡的按钮，是在对作者撒谎——所以候选（`allowlistCandidates`）在建卡时算好挂在提案上，任何一段过不了形状检查或是会跑代码的程序就整行不给。它写的是设置里的长期清单，不是这次运行的授权，所以不像连批那样绑 surface 与 run；点击＝写清单 + 批准这一张。已经排在后面的卡不回头自动批：作者正在看的卡由作者决定。按钮用赭石描边（比连批的面板灰重一档，但不是实底——实底只属于「批准并运行」），窄栏里和其它授权一起降成小字行但保留赭石色 |

---

## 3. 设计

### 3.1 Rust：`src-tauri/src/cmd.rs`

三条命令 + 一个受管状态。

```
cmd_shell_info() -> ShellInfo            { kind: "pwsh"|"powershell"|"zsh"|"bash"|"sh"|…, path, version?, os, osVersion?, arch }
cmd_run(req: CmdRequest) -> CmdResult    起进程 → 等待（带超时）→ 收集 → 杀组 → 返回
cmd_kill(run_id: String) -> ()           作者中止 / 前端超时兜底
```

```rust
struct CmdRequest { run_id: String, command: String, cwd: String, timeout_ms: u64 }
struct CmdResult  { exit_code: Option<i32>, stdout: String, stderr: String,
                    duration_ms: u64, timed_out: bool, killed: bool,
                    stdout_truncated: bool, stderr_truncated: bool, shell: ShellInfo }
```

- **`cwd` 过 `FsScope::check`**，同每一条 `fs_*` 命令；不在已登记根目录下直接 `Err`。这是 §1.9 的 Rust 那一半。
- **受管状态 `Running(Mutex<HashMap<run_id, Child>>)`**：`cmd_run` 把 `Child` 放进去再等，等完取走；`cmd_kill` 从表里取出来杀组。表里找不到 = 已经结束，返回 `Ok(())`，不算错。
- **`blocking::blocking`** 里等：`wait_with_output` 会阻塞，和 `fs_*` 一个理由（`blocking.rs` 的模块注释）。超时用一个循环 `try_wait` + 睡 50ms，而不是 `wait_timeout` crate——多一个依赖换一个 20 行的循环，不值。
- **两个平台各一段 `#[cfg]`**：
  - unix：`Command::new(shell).args(["-lc", cmd]).process_group(0)`，杀 `libc::killpg(pid, SIGKILL)`——`libc` 是 tauri 的传递依赖，直接声明它不加构建。先 `SIGTERM`，2s 后 `SIGKILL`。
  - windows：`Command::new(pwsh_or_powershell).args(["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-Command", prelude + cmd]).creation_flags(CREATE_NO_WINDOW)`；杀 `taskkill /T /F /PID <pid>`（同样 `CREATE_NO_WINDOW`）。
- **shell 解析一次，缓存在受管状态里**（`OnceLock<ShellInfo>`）：Windows 上 `where.exe pwsh` 一次；unix 读 `$SHELL` + `is_executable`。`cmd_shell_info` 就是把它读出来。
- **输出收集**：两条流各起一个线程读到 `Vec<u8>`，各自 1MB 封顶（超过停读、标 `truncated`，但**继续消费**到 EOF 以免管道堵住进程）。收完过 `decode_text`（§2.3）。
- **stdin**：`Stdio::null()`。§1.6。
- **环境**：继承 + §1.6 那五个变量。**不**清空环境——作者的 `HOMEBREW_PREFIX`、`PYENV_ROOT` 都得在。

测试（`#[cfg(test)]`，跑在 CI 的 Linux / macOS 上；本机 `cargo test` 起不来是已知的，见 memory）：
- `echo hi` 回 stdout 与 exit 0；`exit 3` 回 exit 3；`>&2 echo e` 进 stderr；
- `sleep 30` 配 500ms 超时：`timed_out=true`，且 200ms 后 `kill -0 <pid>` 失败（组真的死了）；
- `yes | head -c 2000000` 之类：`stdout_truncated=true` 且进程正常退出（没堵死）；
- `cwd` 在根外：`Err`，且 `Running` 表里没留东西。
- Windows 特有的三件（`CREATE_NO_WINDOW`、`taskkill /T`、5.1 的编码序言）CI 测不到，**真机验收项**，§6。

### 3.2 前端：`src/lib/cli/`

```
flag.ts        app:cliBeta（默认关）。isCliEnabled / setCliEnabled。同 asr/flag 的三处读者论证
shell.ts       shellInfo(): 缓存一次 invoke("cmd_shell_info")；shellLabel(info, isZh) 给卡和设置行用
command.ts     纯函数：commandAccess(cmd, syntax) → read | write；另含 compound / danger 的卡片判断
output.ts      纯函数：clipForModel(text, {head: 6000, tail: 2000}) · formatResult(res, logPath) → 回给模型的文本
run.ts         runCommand({projectPath, command, cwd, timeoutMs, signal, onProgress}):
                 生成 runId → 起计时器 → invoke("cmd_run") → 落日志 → 清扫 → 返回；signal.abort → invoke("cmd_kill")
index.ts       只导出工具与 UI 用到的名字
```

`command.ts` 是这份方案里**唯一有判断力**的纯逻辑，口径必须窄：

- `commandAccess`：先拒绝所有复合/危险形状、花括号、变量展开，再要求程序是裸名（无 `/` `\`，PowerShell 只许 `.exe`）、每个参数（含 `--opt=` 与 `-fVALUE` 里的值）不出项目，最后按真实 shell 选择 POSIX 或 PowerShell 白名单。Git 只允许明确的读取子命令，危险长选项按前缀判、`grep` 的短 `-O` 单独判；`find` / `rg` / `file` / `tree` 逐项排除能执行或落盘的参数。分词器按 shell 区分：反斜杠在 POSIX 是转义，在 PowerShell 是路径分隔。无法解析、环境变量前缀、未知参数一律 `write`。
- `isCompound`：含 `;` `&&` `||` `|` 换行 反引号 `$(` `${` 任一即为真。宁可误判，多一张卡比静默执行安全。
- `looksDangerous`：一张小表，命中改变卡的外观并禁止连批，**不拦截**单次批准；它不完整，所以连批还要求 `!compound`。

### 3.3 工具：`run_command`（`registry.ts`，handler 在 `lib/agent/cliTools.ts`）

```ts
run_command: {
  access: "write-approval",
  definition: { function: {
    name: "run_command",
    description: <按平台生成，见下>,
    parameters: {
      command: { type: "string", description: "The command line, exactly as it will be typed into the shell" },
      cwd:     { type: "string", description: "Project-relative working directory; omit for the project root" },
      timeout_seconds: { type: "integer", description: "Kill after this many seconds (default 60, max 600)" },
      reason:  { type: "string", description: "One line for the approval card: what this is for" },
    }, required: ["command", "reason"] } },
  execute: (call, ctx) => runCommandTool(call.id, parseArgs(call.arguments), ctx),
}
```

description（英文，≤ 220 token，实施时量）：

> Run one shell command on the author's machine — **{PowerShell 7 | Windows PowerShell 5.1 | zsh | bash | sh}** on this computer, so write {PowerShell | POSIX} syntax. Known read-only commands run without approval. Every other command is shown verbatim on a card first; the author may approve once or grant a small counted batch.

`{…}` 处由 `shellInfo()` 在 `getToolDefinitions` 时填——它是同步的，所以 `shellInfo` 要在应用启动时预取一次（`App.tsx` 里 `IS_TAURI && isCliEnabled()` 时 `void shellInfo()`），拿不到时退回按 `IS_WINDOWS` 猜的字样。

handler：

1. 解析 `cwd`：相对项目根拼接、`normalize`、判定仍在根内，否则返回错误文本（不建卡）。
2. `timeout_seconds` 夹到 `[1, 600]`。
3. `commandAccess(command, shellSyntax(shell)) === "read"` 时直接 `runCommand`；否则组 `CommandProposal` 并 `await ctx.requestApproval(...)`。
4. 写命令拒绝 → 返回「作者拒绝了这条命令」；批准或连批命中 → `agentStore` 的 apply 步运行并返回 `report`。
5. 结果文本尾部：`exit code` 非 0 时加一句 `The shell was {name}; if the syntax was wrong for it, fix the syntax rather than retrying the same line.`——这句只在失败时出现，不占 schema。

### 3.4 提案与卡：`CommandProposal` + `ApprovalCard` 的 `case "command"`

```ts
export interface CommandProposal extends ProposalBase {
  kind: "command";
  command: string;          // 原文
  cwd: string;              // 绝对路径；path 字段同它（ProposalBase 要求一个 path）
  cwdLabel: string;         // 项目相对拼法，给卡
  timeoutMs: number;
  shell: ShellInfo;         // 卡上写「用 zsh 运行」
  compound: boolean;        // isCompound(command)
  danger: string | null;    // looksDangerous(command)
}
```

卡的行（沿用 `transcribe` 的 `rows: {k, v, sub}` 形状）：

| 行 | 内容 |
|---|---|
| 引导句 | 「这条命令以你的账户权限运行，能做你在终端里能做的一切；批准即运行。」（`danger` 命中时前面加「⚠ 看起来会删改或推送：」+ 模式名） |
| 命令 | **等宽块**，原文，横向可滚，不省略。这是 §1.2 |
| 运行于 | `cwdLabel` · 「用 {shellLabel}」 |
| 上限 | 「{n} 秒后强制结束」 |
| 理由 | 模型的 `reason` |
| 授权行 | 见下 |

**授权行**（替代正文卡的「本次都批准」）：数量 1–5 +「批准并连批 N 条」。规则：

- 只在 `!compound && danger === null` 时渲染（`canGrantCommand`）；复合或危险命令只能单次批准。
- 落到 `AutoApproveState.commandLeft` + `commandRun`；chat 虽以会话 key 归属，run id 仍钉在当前消息，不能跨消息。
- `grantsCommand` 在每次命中时用同一个 `canGrantCommand` 重新判复合与危险，并在启动前扣 1；run 结束清掉余量。
- `isAutoApprovable("command")` 仍为 **false**；正文授权不能覆盖 shell。
- composer 芯片显示「命令连批 · 剩 N 条」，点击恢复逐条审批。

### 3.5 路由与在场

`routing.ts`：

```ts
if (options?.commands && isCliEnabled() && IS_TAURI && !tools.includes("run_command")) {
  tools.push("run_command");
}
```

opt-in 处：`agentStore`（chat，与 `askAuthor: true` 同一行）、`aiTaskStore`（`commands: canAsk`——和 `askAuthor` 同一个变量：批量运行 `canAsk` 为假，恰好也是不该拿到这个工具的那个 surface）。扮演的 `subAgentsFor` / preset 不改，一致性检查、写手、pack preset 不改——它们本来就不走这两个 opt-in。

`tool-presence.md` 先例表加一行：「`routing.ts` `run_command` — Beta 开 **且** 在 Tauri 里 **且** surface 能渲染审批卡，三者缺一即缺席」。

`agentToolBudget.test.ts`：routed-set 断言里加它（和 `translate` / `ask_author` 一起量），记录量到的数字。

### 3.6 设置：实验室 → 工作方式 → 「命令行」

一行 `Row`，同 `asr` 那行的形状：

- 标题「命令行」，说明「已知只读命令免审批；写入和无法确定的命令先给你看原文，也可以按数量连批。」
- 开着时的脚注：「这台电脑上用 {shellLabel} 运行」（`shellInfo()` 的结果；拿不到写「打开项目后检测」）。
- 关着时的脚注：「关着时助手的工具清单里没有 run_command——它不会提出一次自己做不到的运行。」（同 `asrOffHint` 的句式）
- 不放 shell 路径的自定义输入框。§2.4 的解析规则覆盖了作者能配的情况；真要自定义再加，而且那会是一个**机器本地**偏好（`MACHINE_LOCAL_PREF_KEYS`）。

### 3.7 执行日志与 ToolStep

- `argumentSummary` 已经会截参数 JSON；命令原文在卡上，不必在日志里再全文一次。
- `resultSummary` 的头部就是 `formatResult` 的前几行：`exit 0 · 1.2s` 这种，作者扫日志时能看出成败。
- 中止：`AbortSignal` 已经贯穿 `settleApproval`（`transcribe` 那个 `signal`），apply 步收到 abort 就 `cmd_kill`。

### 3.8 免审批命令（2026-09-17）

设计稿：Claude Design 画布「命令行 · 免审批命令」（实验室行 · 宽卡 · 窄栏三块画板）。

**数据**：`app:cliAllowlist`，JSON 字符串数组，存规整后的程序名（`normalizeProgramName`：去目录、去 `.exe` 等扩展名、小写——`/usr/bin/Git.exe` 与 `git` 是同一条）。`lib/cli/allowlist.ts` 读写；读的时候丢掉不合法或被拒的项，匹配时 `allowRefusal` 再查一次（旧版本写进去的、手改的都不信）。

**判定**（`lib/cli/command.ts`）：

```
commandCover(line, syntax, allowed) → string[] | null      // null＝出卡；[]＝全是只读
  looksDangerous(line)            → null                   // 整行，跨段
  splitChain(line)                → null | pieces          // && || ; | 换行；> < & ` $( ${ → null
  每段：commandAccess(piece) === "read"                     → 过
        allowlistCovers(piece, allowed) → program          → 过，记下
        否则                                                → null
allowlistCovers = plainInvocation(piece) ∧ program ∈ allowed ∧ !allowRefusal(program) ∧ !runsAnotherProgram(program, words)
allowlistCandidates(line, allowed) → 这行还缺的程序 | null   // 加进去之后本行必须能过
```

`plainInvocation` 是从 `commandAccess` 里抽出来的形状检查，两条免审路径共用同一份，谁也不能比谁宽松。`runsAnotherProgram` 是按程序的钩子表，和危险表一样**不完整**——所以形状检查先跑，会跑代码的程序整类拒收。

**工具**：`cliTools` 用 `commandCover` 代替原来的 `commandAccess === "read"`；清单非空时 description 多一句点名这些程序（空清单零成本，棘轮不动）。建卡时 `allowPrograms` 算好挂在 `CommandProposal` 上。

**设置**：实验室 → 命令行，开关开着时脚注下面一块：程序名等宽方块（× 移除）、添加框（回车或「添加」，被拒时就地说原因）、常用建议（git · gh · find · pandoc，已在清单里的不显示）、一句内置只读与不可加入的说明。关着时不画——工具缺席，清单无从生效，但保留。

**卡**：见决定 #17。

---

## 4. 分片

| PR | 目标 | 结束时能做什么 | 独立合并 |
|---|---|---|---|
| **1** | 地基：`cmd.rs` 三条命令 + 受管状态 + 测试；`lib/cli/` 全部纯逻辑 + `run.ts`；Beta 开关 + 实验室那一行 | 设置里能开关、能看到检测出的 shell；**没有工具**，助手行为零变化 | ✓ |
| **2** | 工具与卡：`run_command` + `CommandProposal` + `ApprovalCard` 分支 + `settleApproval` 分支 + 中止/超时 + 路由 opt-in + 平台化 description + i18n + tool-presence 先例 + routed-set 断言 | 对话里能提议、批准、看结果；中止杀得死 | ✓（依赖 1） |
| **3** | 授权与体验：只读免审 + 写命令计数连批 + 芯片 + 进度计时；日志清扫；`tauri::ipc::Channel` 流式尾行（可选） | 读取不打断；一批普通写命令只点一次；危险命令仍逐条看 | ✓（依赖 2） |
| **4** | 待议（§7） | — | — |

每片的门：`pnpm tsc --noEmit` + `pnpm test` + `pnpm build` + `cargo clippy`/`fmt`，加作者真机各跑一次（PR 2 起 Windows 与 macOS 都要跑，§6）。按 memory 里的工作方式：一片一个 PR，合并前停下等真机结果。

### 4.1 PR 1 交付清单

- `src-tauri/src/cmd.rs`（§3.1）+ `lib.rs` 注册三条命令与 `Running` 状态；`Cargo.toml` 加 `libc`（unix）并写一行理由。
- `src/lib/cli/{flag,shell,command,output,run,index}.ts` + `src/lib/cli/__tests__/{command,output}.test.ts`（`isCompound` 的误判表、`looksDangerous` 逐条、`clipForModel` 的边界：短于上限不动、正好上限不动、超一字截）。
- `prefs.ts` `PREF_KEYS` 加 `app:cliBeta`。
- `LabPane.tsx` 工作方式组加一行；i18n 两种语言。
- `codemap.md` `src/lib/` 根模块段加 `cli/` 一行；`architecture.md` Tauri IPC 段加 `cmd.rs` 一行。

### 4.2 PR 2 交付清单

- `registry.ts`：`CommandProposal` 进 `Proposal` 联合；`run_command` 定义（description 由 `lib/cli/shell` 的 `describeShell()` 填）；`ToolId` 联合加它。
- `lib/agent/cliTools.ts`：handler（§3.3 的五步）。
- `agentStore.settleApproval` `case "command"`；`aiTaskStore` / `agentStore` 的 `routeTools` 调用加 `commands`。
- `ApprovalCard.tsx` 三处 `case "command"`（标题、摘要、正文）；样式：等宽块复用现有的代码块样式，不新造。
- `autoApprove.ts`：`AUTO_APPROVABLE` **不**加它，加一行注释说为什么（§1.3）。
- `routing.ts` 追加分支 + 文件头注释表加一行。
- `tool-presence.md` 先例表；`agentToolBudget.test.ts` routed-set。
- `docs/README.md` 本文状态 → `partial`。

### 4.3 PR 3 交付清单

- `AutoApproveState.commandLeft` / `commandRun` + `grantsCommand` + 卡上的计数授权 + 芯片余量 + 撤销。
- `run.ts` 的秒表 `onProgress`。
- 日志清扫（保留 50）。
- 可选：`cmd_run` 改收一个 `Channel<CmdEvent>`，每 250ms 推一次最后一行 → `onProgress({label: 最后一行})`。做不做看 PR 2 真机时「一条跑 40 秒的命令看着像不像卡死」。

---

## 5. UI 任务书要点（给设计稿）

进 Claude Design 的既有项目，02 区（AI 卡片族）下一个字母；引用 `02f`（转写卡，同样是「付费/危险动作之前的那张卡」）作为最近的亲戚。三个张力交给设计：

1. **命令原文块要「像终端又不是终端」**——等宽、深底，但没有提示符、没有光标，因为它不能交互（§1.6）。
2. **`danger` 命中时的告警强度**：要让作者停一下，又不能变成每次都红（`git push` 也会命中）。建议是引导句前的一个词 + 命令块左侧一道色条，不是整卡换色。
3. **授权行**是这个卡族里第一个带**参数**的授权（「以 `git` 开头」）——程序名要嵌在句子里、等宽、不可编辑；它和 `appendPaths` 那种「对这个文件」是同一族，设计上应认得出来。

---

## 6. 真机验收（每片合并前）

| 项 | Windows | macOS | Linux |
|---|---|---|---|
| 设置行显示的 shell | `PowerShell 7 (pwsh.exe)` 或 `Windows PowerShell 5.1` | `zsh` | `bash`/`sh` |
| `git status` 中文文件名不乱码 | ✓（§2.3 序言 + `decode_text`） | ✓ | ✓ |
| 一条命令弹不弹黑窗 | **不弹**（§1.10） | — | — |
| Homebrew / pyenv 里的工具找得到 | — | ✓（`-l`） | ✓ |
| `sleep 100` 后点中止，进程组死了 | 任务管理器里 `pwsh` 和 `sleep`（若有）都没了 | `pgrep` 为空 | 同左 |
| 一条要交互的命令（`git rebase -i`、`read`）立刻失败 | ✓ | ✓ | ✓ |
| 10 万行输出 | 结果里是头尾 + 日志路径，`read_file` 能分页读 | 同 | 同 |
| Beta 关掉后 | 助手不再提到 `run_command`；`allowedTools` 里没有 | 同 | 同 |
| 浏览器 `pnpm dev` | 工具不存在 | 同 | 同 |

---

## 7. 待议（不阻塞 PR 1–3）

- ~~**项目级允许清单** `.ai-writer/commands.json`~~：2026-09-17 以**装机级、机器本地**的「免审批命令」落地（决定 #15–#17、§3.8）。项目级那一版不做：项目文件会随同步和别人的仓库进来，一份别人写的免审清单正是最不该信的东西。
- **进 orchestrator 的 pack**（`pack-shell`）：§2.11。
- **工作流卡**：「用 git 看这章的修改史」之类的套路可以做成 `workflows/` 里的卡，让小模型也知道该调它——这是 workflow-cards-plan 那条线的事，等工具本身稳定。
- **`open` / `Start-Process` 的专用工具**：把成品交给别的应用今天 `open_with_default_app` 已经能做，只是 agent 没有它。若发现作者总是让 agent 跑 `open x.pdf`，那是一个 20 token 的 read 级工具，比让它过卡便宜得多。
