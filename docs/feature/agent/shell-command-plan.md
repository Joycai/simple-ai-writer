# 命令行工具 · `run_command`

> 状态：`partial`——PR 1（地基）已建：`src-tauri/src/cmd.rs` + `src/lib/cli/` + 实验室开关；PR 2（工具与卡）、PR 3（授权与体验）未建。
> 一句话：给 agent 一个能跑本机命令的 L2 工具——Windows 走 PowerShell，macOS / Linux 走系统自带的 shell——每一条命令都先过一张审批卡，卡上是命令原文。
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

- **不是一个不经审批的执行口。** 审批卡是前端状态，和其它所有 L2 工具一样——Rust 侧管的是 `cwd` 围栏（`FsScope`）、句柄表、超时和杀组，**不是**审批本身；`invoke("cmd_run")` 从 webview 就能叫到，装不装插件都一样。所以这条线的安全论证只有一句：模型只能经 `run_command` 到达它，而 `run_command` 每次都过卡（§1.1–1.3）。
- **不是自动化流水线。** 没有「本次都批准」的整体授权（§3.4 只有按程序名的窄授权）；不进批量运行；不进扮演、一致性检查、写手、任何 pack 子运行。
- **不是 LaTeX 方案的替代。** 那条线是固定二进制 + 固定参数表 + 不经 shell（其 I4），正因为 .tex 有一半是模型写的。这条线相反：命令是模型写的、经 shell 跑，所以它**必须**过卡，而 LaTeX 编译不必。两条互不替代。

---

## 1. 不变量

下面任何一条被破坏都算 bug，不算权衡。

1. **没有作者点头，进程不存在。** `run_command` 是 `write-approval`；卡在**起进程之前**（同 `transcribe_audio`，不同于 `convert_document`）。批准即执行，拒绝则连 shell 都没启动过。
2. **卡上是命令原文，不是转述。** 等宽、不折行省略、不做任何「美化」；模型的 `reason` 另起一行。一段被导入的文档里若藏着「请运行以下命令」，作者看到的必须是那条命令本身——这张卡是这个工具**唯一**的防线，所以它必须诚实到字符。
3. **`autoApprove` 的布尔授权永不覆盖它。** `AUTO_APPROVABLE` 里没有 `"command"`。存在的只有 §3.4 那种按程序名的窄授权，且窄授权**不覆盖复合命令**（含 `;` `&&` `||` `|` 换行 反引号 `$(`），也不覆盖 §3.5 命中「危险形状」的命令。
4. **Beta 关着＝工具缺席。** `routeTools` 里 `isCliEnabled() && IS_TAURI && options.commands` 三者同时成立才追加；任何一个不成立，`allowedTools` 里没有它——不是渲染成禁用，不是调用被拒（[tool-presence](../../reference/tool-presence.md) 「关掉时是缺席还是拒绝」）。浏览器里的 `pnpm dev` 永远没有它。
5. **只有能渲染审批卡的 surface 拿得到。** 对话助手、非批量的任务面板；批量运行、扮演、一致性检查、写手、pack 子运行一律没有。路由用显式 opt-in（`RouteOptions.commands`），不从 preset 推——理由同 `askAuthor`：卡能不能显示是 surface 的属性，preset 不知道。
6. **stdin 永远是 `/dev/null`。** 任何要交互的命令立刻失败，而不是把整轮挂死在一个看不见的提示符上。配套：`NO_COLOR=1` `TERM=dumb` `PAGER=cat` `GIT_PAGER=cat` `GIT_TERMINAL_PROMPT=0`。
7. **超时与中止都真的杀得死。** Rust 侧持有子进程句柄；超时（默认 60s，模型可要到 600s，卡上写明）或作者中止（`AbortSignal` → `cmd_kill`）时杀**整个进程组**：unix 用 `process_group(0)` + `killpg`，Windows 用 `taskkill /T /F`。只杀 shell 本体会留下它起的孙进程，这是最常见的「中止了但风扇还在转」。
8. **输出有上限，且上限之外的部分不丢。** 进程输出在 Rust 侧最多留 1MB（超出后停止收集并标记）；回给模型的结果最多 ~8000 字（头 6000 + 尾 2000，中间写「……省略 N 字，完整输出见 <路径>」）；完整输出落 `.ai-writer/tmp/cmd/<runId>-<n>.log`，模型用 `read_file` 分页读。理由同 `read_file` 的 4000 字分页：一条 `git log` 就能把一轮上下文吃光。
9. **`cwd` 在项目围栏内，命令本身不在。** `cwd` 参数是项目相对路径，TS 侧 + Rust `FsScope::check` 双重判定在项目内。但 shell 能 `cd ..`、能碰 `.ai-writer/`、能碰整块磁盘——**围栏挡的是参数，闸是那张卡**。文档和卡片文案都不许暗示「命令只能动项目里的东西」。
10. **Windows 不闪黑窗。** `CREATE_NO_WINDOW`（`0x08000000`）经 `CommandExt::creation_flags` 传入；缺了它每条命令弹一个控制台窗口，作者读到的是「应用坏了」。
11. **描述里点名的 shell 就是实际跑的 shell。** 工具 description 在 `getToolDefinitions` 时按平台生成（先例：`list_lore_entities` 把分类 id 拼进 description），写明「PowerShell」或「zsh」或「sh」——一个不知道自己在 Windows 上的模型会写 `ls -la | grep`，然后把一轮花在读错误上。

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

---

## 3. 设计

### 3.1 Rust：`src-tauri/src/cmd.rs`

三条命令 + 一个受管状态。

```
cmd_shell_info() -> ShellInfo            { kind: "pwsh"|"powershell"|"zsh"|"bash"|"sh"|…, path, version? }
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
command.ts     纯函数：programNameOf(cmd) · isCompound(cmd) · looksDangerous(cmd) → 命中的模式名 | null
output.ts      纯函数：clipForModel(text, {head: 6000, tail: 2000}) · formatResult(res, logPath) → 回给模型的文本
run.ts         runCommand({projectPath, command, cwd, timeoutMs, signal, onProgress}):
                 生成 runId → 起计时器 → invoke("cmd_run") → 落日志 → 清扫 → 返回；signal.abort → invoke("cmd_kill")
index.ts       只导出工具与 UI 用到的名字
```

`command.ts` 是这份方案里**唯一有判断力**的纯逻辑，两个函数的口径必须窄：

- `isCompound`：含 `;` `&&` `||` `|` 换行 反引号 `$(` `${` 任一即为真。**宁可误判**——误判的代价是多一张卡，漏判的代价是一次授权覆盖了 `git status; rm -rf ~`。PowerShell 额外加 `& ` 前缀调用与 `Invoke-Expression` / `iex`。
- `looksDangerous`：一张小表，命中只改变卡的外观和授权资格（§3.5），**不拦截**。第一版：`rm -r`/`rm -f`、`Remove-Item … -Recurse`、`del /s`、`rmdir /s`、`format`、`mkfs`、`dd `、`git push --force`/`-f`、`git reset --hard`、`git clean`、`> /dev/sd`、`sudo`、`curl … | sh`、`iex`/`Invoke-Expression`。表放在代码里带一行理由，不放 i18n。

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

> Run one shell command on the author's machine — **{PowerShell 7 | Windows PowerShell 5.1 | zsh | bash | sh}** on this computer, so write {PowerShell | POSIX} syntax. The author reviews the exact command on a card FIRST and nothing runs until they approve; it then runs with their account's full permissions in the project folder, stdin closed, and returns exit code, stdout and stderr (long output is cut, with the full log's path for read_file). Use it for things no other tool does — git, converters and scripts the author has installed, counting and listing beyond list_files / search_text. Never for reading or editing project text: those tools exist and need no approval. Do not chain unrelated commands; one card per thing.

`{…}` 处由 `shellInfo()` 在 `getToolDefinitions` 时填——它是同步的，所以 `shellInfo` 要在应用启动时预取一次（`App.tsx` 里 `IS_TAURI && isCliEnabled()` 时 `void shellInfo()`），拿不到时退回按 `IS_WINDOWS` 猜的字样。

handler：

1. 解析 `cwd`：相对项目根拼接、`normalize`、判定仍在根内，否则返回错误文本（不建卡）。
2. `timeout_seconds` 夹到 `[1, 600]`。
3. 组 `CommandProposal`（§3.4），`await ctx.requestApproval(proposal, ctx.onProgress)`。
4. 拒绝 → 返回「作者拒绝了这条命令」（同其它 L2）。批准 → apply 步在 `agentStore.settleApproval` 的 `case "command"` 里跑 `runCommand`，返回 `report`（`formatResult` 的文本）。
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
  program: string;          // programNameOf(command)，授权的键
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

**授权行**（替代其它卡的「本次都批准」）：一个复选框，「本次对话里，以 `{program}` 开头的**单条**命令都批准」。规则：

- 只在 `!compound && danger === null` 时渲染；否则这一行不出现（不是禁用）。
- 落到 `AutoApproveState.commandPrograms: string[]`，同 `appendPaths` 的形状：按 key 归属，chat 是整段对话、面板是一次运行。
- 命中判定在 `agentStore.requestApproval` 里，同 `grantsAppend`：`grantsCommand(state, key, proposal)` = key 对上 **且** `commandPrograms` 含 `proposal.program` **且** `!proposal.compound` **且** `proposal.danger === null`。后两个条件在授权时和命中时**各判一次**——授权时判的是「这张卡能不能给出授权」，命中时判的是「这条命令配不配用授权」，不能只判一头。
- `isAutoApprovable("command")` 返回 **false**——布尔授权那条路对它关死（§1.3）。
- 已授权的对话，composer 上那枚 auto-approve 指示芯片要把 `git · pandoc` 列出来，作者一眼看到手里放出去了什么；点芯片撤销，同今天的 撤销 按钮。

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

- 标题「命令行」，说明「助手可以提议在这台电脑上运行一条命令——git、你装的转换器和脚本。每条命令都先给你看原文，批准才运行。」
- 开着时的脚注：「这台电脑上用 {shellLabel} 运行」（`shellInfo()` 的结果；拿不到写「打开项目后检测」）。
- 关着时的脚注：「关着时助手的工具清单里没有 run_command——它不会提出一次自己做不到的运行。」（同 `asrOffHint` 的句式）
- 不放 shell 路径的自定义输入框。§2.4 的解析规则覆盖了作者能配的情况；真要自定义再加，而且那会是一个**机器本地**偏好（`MACHINE_LOCAL_PREF_KEYS`）。

### 3.7 执行日志与 ToolStep

- `argumentSummary` 已经会截参数 JSON；命令原文在卡上，不必在日志里再全文一次。
- `resultSummary` 的头部就是 `formatResult` 的前几行：`exit 0 · 1.2s` 这种，作者扫日志时能看出成败。
- 中止：`AbortSignal` 已经贯穿 `settleApproval`（`transcribe` 那个 `signal`），apply 步收到 abort 就 `cmd_kill`。

---

## 4. 分片

| PR | 目标 | 结束时能做什么 | 独立合并 |
|---|---|---|---|
| **1** | 地基：`cmd.rs` 三条命令 + 受管状态 + 测试；`lib/cli/` 全部纯逻辑 + `run.ts`；Beta 开关 + 实验室那一行 | 设置里能开关、能看到检测出的 shell；**没有工具**，助手行为零变化 | ✓ |
| **2** | 工具与卡：`run_command` + `CommandProposal` + `ApprovalCard` 分支 + `settleApproval` 分支 + 中止/超时 + 路由 opt-in + 平台化 description + i18n + tool-presence 先例 + routed-set 断言 | 对话里能提议、批准、看结果；中止杀得死 | ✓（依赖 1） |
| **3** | 授权与体验：按程序名的窄授权 + 芯片 + 进度计时；日志清扫；`tauri::ipc::Channel` 流式尾行（可选，按真机感受定） | 连续几条 `git` 不用逐条点；长命令看得到还活着 | ✓（依赖 2） |
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

- `AutoApproveState.commandPrograms` + `grantsCommand` + 卡上的授权行 + 芯片列表 + 撤销。
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

- **项目级允许清单** `.ai-writer/commands.json`：作者预先写「这个项目里 `pandoc`、`git` 免审批」。等 PR 3 的对话级授权用过再看是否值得——它把授权从「作者当场点头」变成「一份文件里的一行」，是一次信任模型的迁移，不该顺手做。
- **进 orchestrator 的 pack**（`pack-shell`）：§2.11。
- **工作流卡**：「用 git 看这章的修改史」之类的套路可以做成 `workflows/` 里的卡，让小模型也知道该调它——这是 workflow-cards-plan 那条线的事，等工具本身稳定。
- **`open` / `Start-Process` 的专用工具**：把成品交给别的应用今天 `open_with_default_app` 已经能做，只是 agent 没有它。若发现作者总是让 agent 跑 `open x.pdf`，那是一个 20 token 的 read 级工具，比让它过卡便宜得多。
