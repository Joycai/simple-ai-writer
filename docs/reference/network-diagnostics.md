# HTTP 网络诊断

> 状态：`living`。

## 为什么保留插件补丁

Tauri HTTP 2.6.0 将 `reqwest::Error` 以 `Display` 序列化到 IPC，丢失 `source()`
原因链。日志中的 `error sending request for url (...)` 因而不能区分超时、DNS、TLS、
连接重置和 HTTP/2 流错误。应用在 `src-tauri/vendor/tauri-plugin-http/` 保存原版插件
及一个诊断补丁，Cargo 通过路径依赖固定 2.6.0。保留许可证和权限构建文件。

补丁增加错误上下文，并在共用 `client_builder()` 清空三项 TCP 保活参数。
保留请求协议选择、代理、重试、超时、取消、cookie、请求头和 URL 权限围栏。
完整保留原插件比另造网络命令更容易避免这些行为漂移。
升级插件时，对照上游重新应用 `error.rs`、`commands.rs`、`lib.rs` 与测试依赖补丁，更新依赖版本，
同时确认前端插件版本和 IPC 契约仍兼容；不要直接覆盖补丁。

## 日志契约

IPC 仍拒绝一个字符串，原错误文字之后追加一行 `[network-details]` JSON。
`lib/networkDiagnostics.ts` 提取该 JSON，`lib/ai/apiLog.ts` 在图片和聊天的错误行中
增加 `network` 对象。普通错误与取消错误没有此字段。

- `phase`：`build`（构建客户端/请求）、`send`（发送到收到响应头）、`body`（读响应体）。
- `phaseElapsedMs`：失败操作的等待时间；`body` 是本次读块时间，不是整段下载时间；
  构建阶段没有计时，记 0。已有 `durationMs` 仍是整次 API 调用时间。
- `timeout`、`connect`、`request`、`body`、`decode`：reqwest 的分类标记。
- `causes`：按外层至内层排列的 `source()` 消息，最多 16 层。
- `ioErrors`：原因链中标准 I/O 错误的 `kind` 和操作系统错误码 `osCode`；
  `osCode` 可为空，用于区分系统错误和程序构造的 I/O 错误。

顶层文字及原因链中的 HTTP URL 均移除用户名、密码、查询参数和 fragment；不记录
请求头、请求体、代理凭据或环境变量值。诊断没有自动重放或重试，尤其不能为了日志
静默再发一次计费请求。

## 2026-10-12 的约一分钟断开调查

现有应用日志中，同一 `ai.zhisales.com` 线路的四次图片失败集中在 61–62 秒，
两次成功为 51–52 秒。最近两次失败均指定 `2160x1440`；Toolkit 的两次相关成功
请求未传 size，返回 `1536x1024`，所以仅 prompt 相同不构成请求相同。
Toolkit 最后一次虽请求 high，返回质量却是 medium；不能从调用参数推断上游实际执行档位。

已确认应用图片 deadline 是 180 秒，插件的 reqwest ClientBuilder 没有默认总超时。
显式运行 `http_diagnostics::tests::default_transport_waits_past_one_minute`：
本地服务器延迟 65 秒才发响应头，客户端成功收到 HTTP 200 和正文。
这是排除客户端固定 60 秒总超时的证据，不能排除远端 HTTP/2、代理或网关的空闲限制。

无凭据 GET `/v1/models` 在相同 Rust 客户端上分别以 HTTP/2 与 HTTP/1.1 返回 401，
响应头等待约 0.8 秒；服务响应头包含 `via: 1.1 Caddy`。当时 macOS 系统 HTTP、HTTPS、
SOCKS、PAC 代理均关闭，诊断进程没有代理环境变量；这不证明事故时配置相同，也不能
排除透明代理。免费请求成功只证明当时连通，不证明长时间生成路径正常。

作者批准一次计费重放后，用相同 reqwest、Origin、模型、提示词、`2160x1440`、
`quality: high` 和 `response_format: b64_json` 复现：60,833 ms 失败，
`phase: send`、`timeout: true`、`connect: false`，原因链为
`client error (SendRequest)` → `connection error` → `timed out`。
探针总超时为 180 秒，因此这不是探针自己的总 deadline；尚未收到 HTTP 响应头。
这确认了连接 I/O 超时，不是 API 拒绝、图片解析或写盘错误。重放使用独立 Rust 探针，
不是已安装 app 的进程；尚不能确认是哪一层施加了约 60 秒的连接限制。

作者另外批准一次 HTTP/1.1 对照：提示词和参数不变，75,614 ms 后失败，原因链为
`client error (SendRequest)` → `connection error` →
`Operation timed out (os error 60)`，`ioErrors` 为 `TimedOut` / `osCode: 60`。
强制 HTTP/1.1 也没成功，因此不能将问题归因于 HTTP/2，亦不能据此强制全局 HTTP/1.1。
两次批准的计费尝试到此为止，没有自动重试。

追加不带密钥、只带 16 KiB 虚构数据的 GET `/v1/models`：默认 HTTP/2 与 HTTP/1.1
分别约 1.1 / 0.9 秒返回 401，连接地址为 `52.221.30.93:443`。这排除了当时请求体
超过一两个 TCP 分段就普遍无法传输的假设；不证明生图路径正常。

进一步查明 reqwest 0.12.28 的 ClientBuilder 默认设置 TCP keepalive：空闲 15 秒，
间隔 15 秒，重试 3 次。这是连接失活探测，不是请求总 deadline；只有探测没有被回应
才会失败。约 60 / 75 秒的 I/O 超时与此节奏相符，是下一步重点假设，尚未通过抓包或
更改 keepalive 的对照证实。不能单凭周期相符就断言是客户端错误或是哪台网关丢包。
本地 65 秒测试的服务器会正常回应内核 TCP 探测，故它只排除固定请求时限，不排除
远端链路丢弃探测造成的连接失活。

抓包前阶段确证的失败层是等待响应头时的连接 I/O 超时，具体责任端当时尚待抓包定位。
进一步计费对照须单独获得作者批准；当时的诊断补丁保持 transport 参数不变，
没有仅凭周期直接禁用保活、加长超时或换协议。后续确认与修复见下面两节。

## 抓包对照确认（2026-10-12）

上节的「保活是否参与失败尚未确认」已被这轮对照确认；具体哪一跳没有回应仍未定位。
作者批准最多三次计费对照，实际各发送一次，没有自动重试。

### 控制条件

两应用保存的目标服务密钥经内存比较相同；Toolkit 应用代理关闭，系统代理关闭。
目标地址 `52.221.30.93:443` 的实际出站接口是 `ppp0`，MTU 1280。
抓包仅匹配该地址的 TCP 443，snapshot length 96 字节，不解密 HTTPS。

三次均发送相同 11,478 字节 JSON（相同模型、提示词、`2160x1440`、high、
`response_format: b64_json`），同一密钥与显式请求头；请求体 SHA-256 都是
`ed281e013224211de2b59fc431bf6420f9551059a8b06c88de9e357f190d8db5`。
Dart 对照使用 Toolkit 本地依赖的 `package:http` 1.6.0（`http.Client` / `AbortableRequest`），
Rust 使用应用插件同一 reqwest 0.12.28 与特性集。均为独立诊断进程，不是应用 UI 操作。
总请求上限均为 180 秒。对照中关闭 Rust 协议错误自动重试，以保证每项只发一次。

### 结果

| 客户端 | 响应头 | 总耗时 | 结果 |
|---|---:|---:|---|
| Rust 默认 TCP 保活 | 未收到 | 60,839 ms | 连接超时 |
| Toolkit 同款 Dart HTTP | 89,214 ms | 92,597 ms | HTTP 200，图片已保存 |
| Rust 仅关闭 TCP 保活 | 93,034 ms | 96,555 ms | HTTP/2 200，图片已保存 |

两次成功的用量均为 input 3463 / output 5488，总计 8951。图片实际为 1536×1024；
不能将请求尺寸误当成服务实际返回尺寸。这不影响三份请求字节相同的控制条件。

### 决定性的 TCP 序列

Rust 默认请求对应本地端口 61246。请求数据已被服务方向 ACK，之后在连接开始的
15.819 / 30.820 / 45.821 秒发出三个保活探测，序号均为 `snd_nxt - 1`、TCP 数据长度为 0。
`ppp0` 抓包中没有服务方向对这些探测的 ACK，客户端在 60.821 秒发出 RST。
不是服务返回 HTTP 错误，也不是等待满应用的 180 秒上限。

Dart 对应端口 61514，在约 89 秒收到响应，下载完成后正常 FIN；没有保活探测。
Rust 关闭保活对应端口 62031，也没有保活探测；在同一路径等待超过 93 秒仍成功，
协商协议依然是 HTTP/2。其下载完毕后的连接关闭不属于请求失败。

### 结论与修复方向

Writer 提前失败的直接原因已确认：reqwest 的默认 15 秒空闲 / 15 秒间隔 / 3 次重试
TCP 保活，在当前网络路径得不到回应，操作系统把仍可等待生成结果的连接判为失活并关闭。
Toolkit 的 Dart 客户端没有这组 TCP 保活配置，故能继续等待到图片返回。
关闭 Rust 保活保留 HTTP/2 后成功，排除了必须强制 HTTP/1.1 的假设；相同请求字节与
密钥也排除了 prompt、尺寸、质量、账号或 `response_format` 是这轮差异的原因。

尚不能仅凭客户端 `ppp0` 抓包断言是 VPN、某台中间设备或服务端丢弃保活回应；需要
远端抓包才能定位到那一跳。但已足以解释两客户端的行为差异并确定应用侧兼容修复。

修复应改 Rust 客户端的连接保活策略，而非增加 prompt 重试或强制 HTTP/1.1。
验证成功的设置是同时清空 `tcp_keepalive`、`tcp_keepalive_interval`、`tcp_keepalive_retries`；
只清空空闲时间而保留 interval / retries 可能仍让 socket2 启用保活，不构成等价修复。
抓包调查当时仅修改诊断与记录；作者随后批准共享客户端修复，落实见下节。

## 共享客户端修复与回归（2026-10-12）

所有 HTTP(S) 请求在通过 URL scope 后，从同一个 `client_builder()` 构造 reqwest 客户端，
该入口将 `tcp_keepalive`、`tcp_keepalive_interval`、`tcp_keepalive_retries` 同时设为 `None`。
普通 LLM 的五族适配器及图片、ASR 等经 `lib/http.ts` → Tauri HTTP 插件的请求都继承此策略。
不按域名、模型、操作系统或请求类型分支，也不再启用另一份默认 ClientBuilder。

HTTP/2 协商、现有 `connectTimeout`、每个调用已有的 AbortSignal/deadline、代理、TLS
校验、cookie、重定向与 URL scope 代码保留。请求取消仍走原 `fetch_cancel` 与
`fetch_send` 的 abort 接收分支；响应体取消仍走 `fetch_cancel_body` 释放资源。
没有引入自动重放、禁用证书校验或修改请求体。

回归验证不调用真实计费 API：

- 在 Unix 上连接本地服务后，通过 `getpeername` 精确找出客户端 socket，实际读取
  `SO_KEEPALIVE` 并断言为 0；能够抓住「只清空一项，其他参数又启用保活」的回归。
- 本地服务延迟 65 秒才返回响应头，使用产品共用构造器，验证仍成功收到正文。
- 本地 SSE 先输出一个事件，停顿 65 秒后输出下一个，验证流式响应不会提前结束。
- 给同一共用构造器显式设置短请求上限，验证超时仍发生并带有原因链和分类。
- Tauri MockRuntime 中执行真实 `fetch_send` / `fetch_cancel`，验证响应头尚未返回时
  取消会结束等待、释放请求资源并关闭真实 TCP 连接。
- 执行真实 `fetch_cancel_body`，验证关闭流式响应资源后不能再读，并关闭连接。

两个 65 秒用例标记为 ignored，需显式运行，避免每次小改都额外等待一分钟；实际
socket 状态和取消/超时用例进入日常门禁。插件已作为 src-tauri workspace 的成员，
共享同一 Cargo.lock；default-members 仍只有 app，因此原来的 app 命令语义不变。
CI 额外运行 `cargo test -p tauri-plugin-http`，确保依赖包内部的取消测试也执行。

原始证据暂存于 `/private/tmp/network-comparison-evidence.json`，包头抓取在
`/private/tmp/writer-toolkit-20261012-compare.pcap`。成功图片分别在
`/private/tmp/network-compare-toolkit.png` 与 `/private/tmp/network-compare-rust-no-keepalive.png`。
这些是本地诊断产物，不纳入仓库；上面的数字与结论保存于本文以避免依赖临时文件。
证据 JSON、包头抓取和两张成功图片另已保存到本次 Codex 工作目录的
`network-diagnostics/`，可从交付链接读取，不依赖 `/private/tmp` 保留时间。

## 复现工具与验证

`src-tauri/examples/http_probe.rs` 使用插件重导出的同一 reqwest，仅发送不带凭据的 GET，
依次比较默认协议与 HTTP/1.1。不输出响应内容，也不读取应用密钥。

```bash
cd src-tauri
cargo run --example http_probe -- https://ai.zhisales.com/v1/models
cargo test --all-features http_diagnostics
cargo test --all-features http_diagnostics -- --include-ignored
cargo test -p tauri-plugin-http diagnostic_tests
cargo test -p tauri-plugin-http
```

显式长用例验证超过一分钟的等待，插件用例验证取消、URL 脱敏及字符串兼容。正常测试还验证实际超时
跨 IPC 后仍有原因链，并验证图片与聊天日志确实写入 `network` 而不写入 API key。
