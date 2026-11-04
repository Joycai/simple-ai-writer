# P5 测试、提审与维护准备手册

> Status: `partial` — 2.0.15 已实现本地候选测试档案和一致性检查，未运行 TestFlight、未上传或提审。P1–P4 原生验收、政策发布、正式签名及审核材料继续待完成。

## 本地档案与证据边界

```bash
pnpm tauri:appstore --build-number 3
node scripts/prepare-appstore-review.mjs create --output-dir /tmp/aiw-review-2.0.15-3 --build-number 3
node scripts/prepare-appstore-review.mjs verify --dir /tmp/aiw-review-2.0.15-3
node scripts/prepare-appstore-review.mjs verify --dir /tmp/aiw-review-2.0.15-3 --strict
```

输出目录必须不存在。create 对当前商店包重新执行 P3/P4 审计和资料检查，不接受旧报告冒充本次结果；保存版本、构建号、Bundle ID、Mach-O SHA-256、准备时的 Git commit / dirty 状态及关键输入 hash。生成 `bundle.json`、`metadata.json`、`source.json`、`test-plan.json` 和 `manifest.json`。源代码状态是在准备时观察所得，**不能证明该 commit 编译出了该二进制**；最终候选应从干净提交构建，并在 CI 中归档对应日志。

verify 可离线运行，核对固定文件集合、文件 hash、报告中的候选身份与构建号、审计结果以及全部待完成状态。它不修改 App、钥匙串或作者项目，不读取密钥，也不上传。缺文件、变更文件或混用构建都会失败。hash 用于识别意外变更，不是数字签名，不能抵御同时重写报告和清单的攻击，也不替代人工证据审查。档案内的 bundle 路径可能包含本机用户名，分享前评估隐私；不要修改已归档报告，必要时另建脱敏副本。

普通退出 0 只表示档案内部一致；`submissionReady` 始终为 false，`--strict` 对本阶段的本地准备档案始终退出 1。不能将其作为未来自动上传许可。正式签名、上传处理、作者确认与审核结果应由独立流程验收后再扩展工具，不是把 false 改成 true。

[test-plan.json](test-plan.json) 定义 N01–N18、S01–S04、T01–T03 共 25 项；生成档案时全部为 pending，不导入或继承上个版本的“通过”。细节与预期在 [P3 原生验收手册](../mac-app-store-acceptance.md)，P4 必填资料在 [提交资料](README.md)。本次未执行原生交互，因此不得把测试准备记成原生通过。

工作流 `appstore-prepare.yml` 将同一档案与候选 `.app.tar.gz`、许可报告一起作为 artifact；读取权限、无 Apple secrets、无上传。归档保存期仍为 14 天，正式测试记录应由作者保存到受控长期位置，不能只依赖临时 artifact。远端工作流仍待实际运行。

## 干净环境测试批次

每批次先记录候选四元组：Bundle ID / 营销版本 / 构建号 / 二进制 SHA-256，再记录安装渠道和签名身份。下面是待执行顺序，不是已完成结果。

1. **干净本地环境**：使用独立 macOS 测试用户或专用设备，保留主用户全部配置；只用合成项目。确认首次启动没有继承许可、供应商密钥、书签或任务。不得通过删除真实容器来制造“干净环境”。
2. **最低系统**：Apple Silicon + macOS 14，逐项执行 N01–N18 中适用步骤。另一批在每个拟声明支持的系统上执行同样核心路径；开发机版本和最低系统不可相互代替。Intel 不在商店候选范围，站外支持不变。
3. **并存 / 升级环境**：先备份合成项目，安装站外版和商店版，验证独立身份、凭据和配置；正式签名就绪后单独验证同身份跨版本升级、书签和 Keychain。ad-hoc 升级结果不能替代正式升级。
4. **离线 / 网络异常环境**：断网、本机 IPv4 / IPv6 服务、独立 IPv6-only / DNS64 网络分别记录。回环服务只覆盖 chat completions，不把它的结果用作 ASR / MCP / 图片验收。拒绝许可时零发送，撤回时活动请求结束并阻断重试。
5. **故障环境**：使用可丢弃测试卷模拟不可写或满盘；在合成项目运行中强退后恢复，验证不丢已保存内容、不重放未批准写入。出现数据丢失、越权、无法启动立即停止扩测并保留脱敏证据。
6. **TestFlight 批次（待正式签名和上传）**：核对 Apple 处理后的实际版本与构建号，安装后重跑关键路径并核对反馈 / 崩溃。Apple 分发处理可能改变签名 / 二进制，不要求安装后的 hash 与本地 ad-hoc hash 相同；分别记录实际文件 hash、Apple 构建标识和对应上传记录建立关系，不能混填。

批次完成后每条用例使用 `test-result-template.json` 的独立副本记录，不改写本地档案中的 pending 模板。`passed` 必须附实际结果、测试人、系统、时间和证据；`not-run` / `blocked` / `failed` 都不能合并成通过。模板只作为人工工作记录，当前工具不为这些人工结论背书。关闭问题后在修复构建重跑受影响用例和关键回归，旧构建结果保留历史意义但不自动成为新版本证据。

## What to Test 草稿

中文：

> 请仅使用提供的合成项目与测试服务。重点检查：选择文件夹后编辑保存；完全退出和系统重启后重开项目；导入导出不修改源文件；拒绝联网后仍可本地编辑；发送前显示接收方与内容范围；撤回后停止请求且重启仍暂停；应用保留的高级工具遵守独立审批。遇到失败请提供版本、构建号、系统版本、复现步骤和脱敏截图，不发送 API 密钥或私人作品。终端、角色扮演、Sakura 翻译和 ComfyUI 在商店版不可用。

English:

> Use only the supplied synthetic project and review-only services. Test folder selection, editing and saving, then reopen after quitting the app and restarting macOS. Verify that import/export preserves source files. Declining network consent should leave local editing available. Confirm that the recipient and data scope appear before sending, and that revoking permission stops requests and remains paused after relaunch. Retained advanced tools must keep their separate approval flow. Report the app version, build number, macOS version, reproduction steps and redacted screenshots. Do not send API keys or private documents. Terminal access, roleplay, Sakura translation and ComfyUI are unavailable in this edition.

以上只是待发布测试说明；没有邀请测试人员、发送消息或准备外部服务。TestFlight 反馈邮箱可候选使用已确认的 `joycai@joycai.cn`，用途和测试联系人仍由作者确认。实际服务凭据只放受控测试信息，不入仓库或档案。对测试人员说明 TestFlight 的反馈和诊断处理方式，按 Apple 当前页面核对，不把 P2 应用内撤回描述成撤销 Apple 的反馈数据。

## 问题与审核反馈处理

| 严重度 | 示例 | 处理 / 关闭条件 |
| --- | --- | --- |
| 阻断 | 数据丢失、越权、拒绝后仍发送、核心启动 / 保存失败 | 停止该候选推进；修复、补回归、实机复验并经作者复核 |
| 高 | 升级授权失效、核心 AI 或保留导出不可用 | 提审前解决，或明确产品范围调整后重新验收；不能偷偷隐藏功能 |
| 一般 | 可恢复的非核心体验缺陷 | 记录影响、解决版本与作者处置，不自动视为豁免 |

每条记录按以下格式保存到受控问题列表：

```text
编号 / 来源（本地、TestFlight、App Review）：
发现时间、版本 / 构建号 / 渠道、系统 / 芯片：
对应 N/S/T 用例、严重度、负责人：
前置条件与最小复现、预期、实际：
脱敏截图 / 日志位置和 SHA-256：
根因、修复提交、修复构建：
复验人 / 时间 / 环境 / 结果：
状态：待复现 / 已复现 / 修复待验收 / 已复验关闭
```

审核反馈另记 Apple 原文、规则编号、收到时间、Apple 构建标识、是否需要替换二进制。先在同版本复现，再定位实际行为或资料缺口；修改权限须有产品与沙盒理由，不为过审扩大授权或隐藏受审功能。回复草稿必须区分已修复、已验证与待确认，附最短操作路径。技术解释无法消除的产品决定交由作者处理；不自动申诉或发送回复。

## 提审与发布前交接

以下全部待完成，不因本地工具通过自动打勾：

- P1 文件授权、重启和多实例；P2 原生隐私流程及公开政策；P3 系统矩阵、保留功能与站外回归。
- P4 正式签名 / profile / 安装包验证、Apple 上传处理；真实支持 URL、政策、版权主体、价格 / 地区 / 年龄 / 出口问卷、隐私标签、许可证 / SDK 审查和随包声明。
- 审核服务可访问且限额有效、联系人可联系、实际截图匹配功能、审核路径覆盖全部保留功能。
- TestFlight 在干净环境完成、崩溃和反馈已核对、阻断问题为零、待处理问题有作者决定；冻结同一候选版本和资料。
- 作者确认提审范围和商店资料；在 Apple 审核通过后，由作者决定发布时间和发布方式。当前不替作者选择自动发布。

发布后保存构建账本、Apple 状态、反馈和修复版本；保留复现所需最小脱敏资料，限定访问，过期审核凭据及时撤销。发现严重问题先通知作者并暂停继续推进，使用更高构建号修复和重新测试；不要对有 schema 迁移的项目盲目安装旧版。需要恢复数据时使用已验证备份，由作者确认恢复范围。商店更新经 App Store 分发，站外仍使用原渠道，不能以站外安装包绕过商店更新审核。

## 依据

2026-11-04 核对 [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)、[提交审核概览](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/overview-of-submitting-for-review)、[提交应用](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app)。正式操作时需再次核对当期页面和账户状态；本手册不代表已经取得上传或发布授权。
