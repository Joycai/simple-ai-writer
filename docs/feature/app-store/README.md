# P4 商店提交资料与准备流程

> Status: `partial` — 2026-11-05：2.0.15 / build 4 已上传并由作者确认 TestFlight 可启动；2.0.16 隐私入口已本地实现，尚未签名上传。历史章节按当时状态保留，当前缺口以文末「2026-11-05 收尾复查」为准；未宣称已提审或发布。

P5 的候选档案、测试批次和提审交接见 [P5 手册](p5-release-runbook.md)；本文保留 2.0.14 的 P4 实施记录，后续版本以主计划和实际候选档案为准。

## 版本与构建记录

marketing version 继续由四份版本清单共同管理，使用项目 `bump-version` skill；这次为 2.0.14。商店专用 `bundle.macOS.bundleVersion` 对应 CFBundleVersion，默认 `1` 仅用于本地构建。站外版的版本策略不变。

```bash
pnpm tauri:appstore --build-number 2
pnpm audit:appstore --build-number 2 --output /tmp/store-bundle.json
node scripts/check-appstore-metadata.mjs
node scripts/check-appstore-metadata.mjs --strict
node scripts/appstore-license-inventory.mjs --output-dir /tmp/store-license-review
```

构建号限 1–9999 的无前导零整数；命令只覆盖本次商店配置，不写四份版本文件，不修改站外配置。审计默认核对本地默认构建号 `1`，自定义构建须传相同的 `--build-number`。改变构建号不改变应用版本。`--strict` 在未决项存在时退出 1；普通检查只表示草稿结构有效，不表示可以提交。

**上传前须查询 App Store Connect 已使用构建号并登记新号，保持单调递增，不按版本重置。** 本地脚本无法确认远端占用。当前没有任何上传记录；下表的 2 只是本地验收号，没有在 Apple 预留。

| 版本 | 构建号 | 用途 | 签名 / 上传 |
| --- | --- | --- | --- |
| 2.0.14 | 2 | 本地验证独立构建号、包审计 | ad-hoc / 未上传 |

新增手动工作流 `appstore-prepare.yml` 安装锁定依赖、验证草稿与参数、生成 arm64 ad-hoc 包、审计及授权清单，再将包以 tar.gz 和报告一起保存为 14 天 Actions artifact。打包压缩避免 artifact 丢失可执行权限。它只有仓库读取权限，无 Apple secrets、上传步骤或 GitHub Release，不改现有 `release.yml`。尚未在远端运行，不能声明 CI 已绿。日常 CI 增加两项准备工具检查，其余门禁不变。

## App Store Connect 资料

[metadata.json](metadata.json) 为中英文待确认文案，机器检查名称 30、副标题 30、关键词 100 UTF-8 字节、推广文本 170、描述 4000 字符上限。版本从构建读取，不复制到文案；商店名称可用性仍须在账户中验证。文案说明自配 AI、第三方费用、发送告知、模型可能出错及商店禁用范围，没有将候选系统和未验收 Beta 宣称为已经认证。

| 字段 | 当前准备 / 待完成 |
| --- | --- |
| Bundle ID / 分类 | `com.simple-ai-writer.app.appstore` / Productivity；账户中的 App ID、能力和应用记录尚未核对 |
| 展示名称 / 主语言 | 中英文候选名 Simple AI Writer；最终名称、主语言及可用性待作者确认 |
| 支持 URL | 未指定，不从邮箱域名推断；发布下面的支持页后填真实 HTTPS 地址 |
| 隐私 URL / 运营者 | 待确认和发布；邮箱已确认 `joycai@joycai.cn`，见现有隐私政策草稿 |
| Copyright | 仓库 LICENSE 是 Simple AI Writer Contributors，不能直接当作开发者账户的法定版权主体；待确认 |
| 价格 / 地区 / 发布方式 | 均待作者决定；不默认免费、全球或自动发布，不新增 IAP |
| 年龄分级 | 待按真实能力完成当期问卷；AI 生成内容、联网工具、用户材料须逐项核对，不自行指定 4+ |
| 内容权利 | 用户材料与生成内容的处理权、第三方服务条款和字体 / 图标授权见下节，不能将用户授权等同于应用持有版权 |
| 审核联系人 | 邮箱可用已确认隐私邮箱作为候选；姓名、电话及审核用途待确认，不填假号码 |
| 审核服务 | 未准备；API 端点、模型、限额 / 到期 / 撤销方式须确认，秘密只填受控审核信息 |
| 地区材料 | 按最终地区核对经营者身份、当地备案 / 登记和加密材料等，尚未作出适用性结论 |

支持页发布草稿：

> Simple AI Writer 支持 / Support
>
> 联系 / Contact: joycai@joycai.cn
>
> 请提供应用版本、macOS 版本、操作步骤和错误提示。不要发送 API 密钥、密码或未脱敏作品。项目访问失效时，请通过应用的选择文件夹流程重新授权。AI 服务连接问题请核对供应商地址、模型及账户状态；第三方服务费用和数据保留由对应服务方管理。
>
> Include your app version, macOS version, reproduction steps and error message. Do not send API keys, passwords or private documents. Reauthorize the project through the folder picker when access is lost. For AI connection issues, check the provider URL, model and account status. Third-party billing and data retention are managed by the service provider.

此段与政策草稿均未发布，不能拿仓库路径充当 App Store Connect 的公共支持 / 隐私地址。

## 截图计划

实机截图待完成，不使用浏览器原型或生成图片冒充沙盒包。拟使用 zh-Hans / en-US 各一组 **1440 × 900**、不含个人信息的截图，统一尺寸；这是 Apple 接受的 Mac 16:10 尺寸之一。上传前重新核对规格。

| 顺序 | 使用合成样例展示 | 拟表达内容 |
| --- | --- | --- |
| 1 | 本地文档树、Markdown 编辑和预览 | 文档与材料在一个项目中组织 |
| 2 | 合成知识库条目与材料引用 | 整理写作参考资料 |
| 3 | 真实兼容测试服务返回的审批卡 | 看过修改再应用，不伪造 AI 结果 |
| 4 | 本地常规导出与可见结果 | 使用自己的文档格式 |
| 5 | 发送前告知或隐私设置 | 展示接收方和授权控制，隐藏地址中的秘密 |

只展示本次商店真实可用功能，不拍摄终端、角色扮演、Sakura 或 ComfyUI。保留 Beta 的高级路径完成原生验收后才考虑用于宣传；截图文件和截取版本/hash 一起归档。

## 审核样例与操作说明

`node scripts/create-appstore-fixtures.mjs` 生成临时空项目及合成导入源，配合 [P3 原生验收手册](../mac-app-store-acceptance.md)。它是可重复的本地样例准备方式，发布前须把经验证的样例复制到审核可访问的位置；本机临时路径不能作为审核交付地址。内容是测试短句与项目现有 hello-world 音频，音频的对外再分发来源仍待核查，可在未确认时从对外样例中移除。

以下英文说明已可作为审核备注草稿，但服务地址、凭据和样例交付未完成，**不能原样作为最终审核材料**：

> This is a local Markdown editor with optional connections to user-configured AI services. Basic editing does not require an app account or an AI service. The App Store edition does not include terminal execution, roleplay, Sakura translation or ComfyUI. AI requests require recipient/data disclosure and consent. Document-changing tools retain their own approval flow.
>
> 1. Launch the App Store build and use the native folder picker to create or open the supplied sample project. Create a Markdown document, type text, preview and save it. Quit and reopen the app to verify project access.
> 2. Open AI configuration and add the review-only service, model and credentials provided privately with the submission. Choose that model, open the assistant and request a short revision of the sample document. Accept the recipient disclosure to send. Review the proposed edit before applying it.
> 3. In Settings → About, review the privacy notice. Revoke and pause network permissions, then retry: the app should not send another request. Local editing remains available.
> 4. Import the supplied synthetic files and use the normal export workflow. Advanced Office exports, audio transcription, MCP, orchestration and structured memory retain their experimental switches; additional service-specific review instructions must accompany any enabled route.
>
> External AI services may charge separately. The app does not provide AI credits. The local loopback test server in the repository is a development test tool, not the review service.

审核服务应使用合成项目、独立限额、可撤销凭据，覆盖预期审核时段。服务器限制与端点需在干净设备实测，不能要求审核员自购服务才能体验主要 AI 功能。MCP、音频和图片不能用仅支持 chat completions 的 P3 回环服务替代。样例和服务准备完成后，补上真实入口和每个保留功能的操作路径；未完成前保持提交阻断，不擅自删掉作者已选择保留的功能。

## App Privacy 与加密申报工作表

P2 主计划 §9 是数据流事实来源。以下是填写问卷前的映射，并非已提交标签。自带密钥和直接连接第三方不自动等于“不收集”。逐个确认服务处理方、保存期限、是否可关联身份、是否用于跟踪 / 训练及删除途径，再按 Apple 定义判断是否需披露。

| 数据事实 | 问卷候选类别 / 需核对事项 |
| --- | --- |
| 正文、提示词、历史、知识库、工具输入输出 | User Content / Other User Content；用途为应用功能；第三方保留、身份关联和训练政策未确认 |
| 图片、音频、附件 | Photos or Videos、Audio Data 或其他用户内容；包括上传 / 轮询 / 下载服务与 MCP 转发链 |
| API 凭据、模型账户、自定义认证头 | 账户关联 / Identifiers 等应按真实字段判定；不能将凭据类型直接映射为固定标签 |
| 项目路径、同步内容、备份概要 | 用户内容及潜在个人信息；device / 数量概要可能明文，含密钥备份加密不能免除申报判断 |
| IP、连接信息、请求日志 | 服务端可见信息与日志保留由运营方核对；不因为客户端未落盘就说不存在 |
| 本地用量、费用、偏好 | 本地持久化本身与离机收集分开；同步 / 支持邮件可能改变数据流，人工核对 |
| 联系邮箱 / 支持材料 | 支持邮件的数据处理、保留与删除纳入公开政策 |
| 遥测 / 广告 | 仓库未新增遥测 / 广告 SDK；仍需核查依赖与服务行为，不能代替完整 SDK 审查 |

加密技术事实（代码核实，非法律结论）：`configsync/envelope.ts` 使用 Web Crypto PBKDF2-SHA-256、310000 次迭代、16 字节 salt 派生 256 位 AES-GCM 密钥，12 字节 IV；用于可选配置备份，含密钥时强制加密。HTTP 传输还有 TLS，凭据使用 OS Keychain。并非仅有 HTTPS，也并非自创算法。没有设置 `ITSAppUsesNonExemptEncryption=false` 或编造合规代码。出口问卷须结合最终地区及这些事实确认豁免或材料；如需材料，批准后关联实际构建。

## 许可证与资源盘点

`appstore-license-inventory.mjs` 离线读取 pnpm 生产依赖及 arm64 / app-store 的 Cargo metadata，输出带锁文件 hash 的 inventory 和收集到的许可证原文。输出目录必须不存在，避免覆盖已复核材料。Cargo 范围含构建 / 测试依赖，pnpm 闭包也不等于 Vite 实际打包内容；不能把全部报告无差别宣布为应用所含 SDK。扫描只收集包根目录标准 license / notice 文件和声明文件，缺失项不等于上游无许可，需继续寻找原始来源。

当前缺失项摘要已记录在 [license-review.json](license-review.json)，可按锁文件 hash 对账并重新生成完整原文报告。当前扫描报告均标为 `unreviewed`，`approvedForDistribution: false`。识别到 MIT、Apache、BSD、OFL、ISC 等及需逐项判断的多许可证 / MPL / EPL 条目。须核实所用代码、选择条款、保留声明和可能的源码义务；不能因为多数为 MIT 就批准全部。正式声明文件尚未随商店包分发，确认后应明确随包位置和可访问入口再重建审计。

| 资源 | 已查事实 | 待完成 |
| --- | --- | --- |
| 应用源码 | 根 LICENSE 为 MIT、2026 Simple AI Writer Contributors | 最终版权主体、贡献来源和商店元数据确认 |
| JS / Rust 依赖 | 从锁文件和已安装包读取许可证、原文及 hash；vendor HTTP 含 MIT / Apache 文本 | 缺失文本补齐、双许可证选择、静态代码范围、notice 分发与 SDK 隐私复核 |
| 内置 Inter Tight / JetBrains Mono / Spectral | fontsource 包提供 OFL-1.1 文本 | 核对随包声明、字体名与使用方式；打包报告不等于履行条款 |
| 可下载 HarmonyOS Sans / MiSans | `fontPacks.ts` 链接原厂许可，固定包/版本/hash；按用户请求下载 | 核对当期许可、CDN 再分发来源、保留声明、缓存 / 删除；并非应用自有字体 |
| Lucide / KaTeX 等图形字体资源 | 已列入 npm 依赖清单 | 图标与字体的具体声明纳入最终 notices |
| 应用图标 | 仓库 `icons/icon.svg`、`public/logo.png`、Tauri 图标产物 | 创作来源 / 第三方素材授权待作者确认，存在文件不能证明版权 |
| 合成文案与截图 | 工具生成测试文字和容器，不使用真实作品 | 截图服务结果、音频样例及其他第三方素材复核 |

## 正式签名与上传的交接边界

### 2026-11-05 账户配置起点

用户确认开发者申请完成，决定暂缓剩余原生验收，先准备正式签名。只读本机检查：Xcode 路径为 `/Applications/Xcode.app/Contents/Developer`，`security find-identity -v -p codesigning` 返回 `0 valid identities found`。这不是对后台会员状态或安装包证书库存的检查。

后续安装应用分发证书后，受限工具环境仍返回 0；经正常本机钥匙串访问环境复核，已识别有效身份 `Apple Distribution: Cai Zhengxu (H9WK585493)`，指纹 `3B63BC5D87F87A908B21AEA7E2FDE817086566E6`。因此不能单凭受限环境的 0 结果判断本机没有证书。用户 App ID 截图确认 Bundle ID 为 `com.simple-ai-writer.app.appstore`、Team ID / App ID Prefix 为 `H9WK585493`。应用分发签名身份已就绪；安装包证书和 profile 仍待配置，尚未执行正式签名。

同日用户安装 Mac Installer Distribution 后，经 `security find-identity -v` 只读复核，已识别有效安装包身份 `3rd Party Mac Developer Installer: Cai Zhengxu (H9WK585493)`，指纹 `46A9B011BDBB47AB5C695225BF1D29E1BA5B7DE4`。两类签名身份均已就绪；下一步创建并核对 `Mac App Store Connect` profile，正式签名与上传仍未执行。剩余原生验收继续保留待完成状态。

用户随后提供 `Simple_AI_Writer_Store_Distribution.provisionprofile`（原文件保留仓库外）。经本机 `security cms -D` 解码核对：名称 `Simple AI Writer Store Distribution`，UUID `c54cdaef-0b16-440d-b37d-068bcdc69821`，平台 `OSX`，Team ID / App ID Prefix 为 `H9WK585493`，应用标识为 `H9WK585493.com.simple-ai-writer.app.appstore`，有效期至北京时间 **2027-11-05 09:47:47**。内含应用分发证书 SHA-1 与上述 Apple Distribution 身份完全一致；没有设备列表或全设备分发标记。profile 带有团队、应用标识与 `H9WK585493.*` 钥匙串访问组授权，应用沙盒权限仍由商店 entitlements 声明。签名材料已核对齐备；签名配置接入、构建与最终产物校验仍待执行，不能视为已有可提交包。

配置顺序：

1. 在开发者后台登记明确 App ID：`com.simple-ai-writer.app.appstore`（与商店专用配置一致，站外版身份不变），记录 Team ID。
2. 在本机生成 CSR，后台创建并下载安装到本机钥匙串的 `Apple Distribution`（或适用的 `Mac App Distribution`）应用证书，以及 `Mac Installer Distribution` 安装包证书。私钥必须留在生成 CSR 的本机并与证书配对；Developer ID 系列用于站外分发，不能代替这里的商店身份。
3. 创建 `Mac App Store Connect` 描述文件，选择上述 App ID 和应用分发证书，下载 `.provisionprofile` 到仓库外位置。
4. 在 App Store Connect 建立 macOS app 记录，使用完全相同的 Bundle ID；名称和 SKU 由作者确认。
5. 提供 Team ID、两种证书的本机身份名称和 profile 路径后，再配置商店构建的签名身份、嵌入 profile、按 profile 核对应用标识与团队 entitlement，并产出签名 `.pkg`。暂不猜填 Team ID、应用前缀或加密声明，不将账户开通当作已完成签名。

官方依据（2026-11-05 核对）：[证书类型](https://developer.apple.com/help/account/certificates/certificates-overview/)、[CSR 创建](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request)、[商店描述文件](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile)、[Tauri App Store 配置](https://tauri.app/distribute/app-store/)。

P4 初始准备阶段没有证书 / profile，未产出提交用 `.pkg`；2026-11-05 签名材料已补齐，实际正式构建尚未执行。正式阶段按以下顺序衔接：确认 App ID、Team ID 与独立 Bundle ID → 创建匹配分发证书 / 安装包签名身份及 provisioning profile → 在商店专用配置嵌入 `Contents/embedded.provisionprofile` → 核对身份、有效期和 entitlement → 重新签名构建 → `codesign` 与 profile 匹配校验 → `productbuild` 生成签名 pkg 并用 `pkgutil --check-signature` 验证 → 经批准上传并记录处理结果。

证书 / 私钥 / profile 不入仓库，正式配置不能通过站外发布入口注入。准备工作流没有预留 secrets 或运行上传；这可避免无证书时把 ad-hoc 产物误标成提交包。正式配置接入方式、签名工具链、钥匙串与跨升级书签仍需专门实测。不能将缺少正式公证警告等同于 App Store 签名检查通过。

## 本地正式签名入口

`python3 scripts/sign-appstore.py` 使用已安装在本机的分发身份，不导出私钥、不安装应用、不上传。示例（路径与指纹由本机材料替换）：

```bash
python3 scripts/sign-appstore.py \
  --profile /absolute/path/Store.provisionprofile \
  --app-identity APPLICATION_CERTIFICATE_SHA1 \
  --installer-identity INSTALLER_CERTIFICATE_SHA1 \
  --build-number 4
```

使用 Python 3、Node、pnpm、Rust 和 Xcode。脚本先解码 profile，拒绝过期、错误平台、设备分发、调试权限、Bundle ID / 团队 / 证书不匹配；身份必须是同团队的应用与安装包分发证书。App ID Prefix 独立读取，不假设它等于 Team ID。沙盒权限沿用商店基线，只补入实际 profile 授予的应用和团队标识，不额外加入通配钥匙串组。

正式编译固定 `app-store`、arm64 和 macOS 14，独立使用 `src-tauri/target/app-store-signed`，避免覆盖原有 ad-hoc 验收包与站外产物。机器专用配置、profile 副本、entitlements、最终 app/pkg 和报告放入已忽略的 `store-reports/signed-<构建号>-<随机后缀>/`；不提交签名输入，不修改主版本号或站外配置。清理继承的 `TAURI_CONFIG` / `APPLE_*` 环境变量，避免旧配置或公证凭据影响本次签名。

完成前须通过：嵌入 profile 字节一致、codesign 深度严格验证、实际签名证书指纹、完整 entitlements 一致、已有 bundle 审计、productbuild 签名以及 pkgutil 信任链 / 安装包证书指纹。成功才写入 `localSigningChecksPassed: true`；失败保留初始 false 报告与中间产物。`submissionReady` 始终为 false，Apple 服务端校验、原生验收、政策和审核材料另行完成。

防错测试：`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/__tests__ -p 'test_appstore_sign.py'`。没有改动运行时代码，本次仍使用 2.0.15，独立提升候选构建号至 4。

### 2026-11-05 签名候选结果

**2.0.15 / build 4** 已生成正式证书签名的 `.app` 和 `.pkg`。本次仅改动本地构建工具与文档，没有改动应用运行逻辑或站外发布配置。前端生产构建（含类型检查）、Rust release 构建、5 项签名前置 / 安装包校验测试、3 项原有构建策略测试及最终 bundle 审计通过。

- 输出：`store-reports/signed-4-vn0w7_cd/Simple-AI-Writer-Store-4.pkg`。
- SHA-256：`2861ea86462920d3e4de9f59cb3af3ba8992ac83f673f9a5122743371fde8383`。
- [签名报告](signed-build-4-2026-11-05.json)、[最终包静态审计](signed-build-4-bundle-audit.json) 已归档；profile、证书文件与可执行产物不入仓库。
- 应用签名为 Apple Distribution，安装包签名为同团队的 Mac Installer Distribution；实际证书指纹匹配，profile 字节匹配，六项沙盒权限和两项签名标识匹配；arm64、macOS 14、独立 Bundle ID、build 4 均符合配置。
- 当前 macOS 的 `pkgutil` 对该商店安装包显示 `signed by a developer certificate issued by Apple (Development)`；校验结合实际 `3rd Party Mac Developer Installer` 身份、指纹与命令成功状态，不误用站外 Developer ID 的状态文案。曾因校验工具的文案 / 参数兼容问题中止，修正后对同一已生成包重新验证通过。
- 未安装或启动此分发候选包，未执行 Apple 服务端验证、上传、TestFlight 或审核；不将本地签名校验视为可发布批准。现有 ad-hoc 验收包保持原样，暂停的原生验收、隐私政策发布、许可证和加密声明等材料仍待完成。

## 来源与待完成项

2026-11-04 核对：

- [Apple 平台版本资料字段](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information/)、[App information](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information/)、[Mac 截图规格](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)。
- [App Privacy](https://developer.apple.com/app-store/app-privacy-details/)、[加密出口申报](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/)。
- [Tauri App Store 分发](https://v2.tauri.app/distribute/app-store/)，构建号字段同时按仓库安装的 CLI config.schema.json 核实。

P1–P3 的原生验收、隐私政策发布、正式证书 / 描述文件 / 上传继续待完成。另有本资料中的账户必填项、实际截图、审核服务、许可声明与地区问卷待完成；P4 不能标为整体通过。


## 2026-11-05 收尾复查

范围：2.0.16 源码、商店配置、构建脚本及重新生成的离线许可证清单。本次没有重建安装包或操作 App Store Connect；下列后台进展来自作者此前确认及截图，不代表本次重新检查后台。

### 已有证据

- 2.0.15 / build 4 已完成正式签名、上传、Apple 处理；作者确认 TestFlight 可启动。不能再将“没有证书 / 未上传”列为当前缺口。
- 作者已上传截图、填写支持及隐私网址，选择免费，首发不含法国；出口问卷已保存。未核实最终年龄问卷、所有销售地区及是否提交审核。
- 2.0.16 本地提交补齐商店版公开政策入口、离线隐私说明及 Joycai 运营者；见 [政策记录](../privacy-policy-draft.md)。尚未合并发布、签名上传或进行新版原生验收。
- `Entitlements.appstore.plist` 已启用 sandbox、出站网络、用户所选文件读写、app-scope bookmarks、打印；入站网络用于多窗口 loopback。未发现需为本次收尾扩大权限的证据。
- `lib.rs` 的 `cmd` 模块被 `not(feature = "app-store")` 排除；本次扫描未发现应用自有更新器或自动登录启动插件。仅为源码检查，不替代最终产物审计。
- 字体下载通过统一隐私 HTTP 入口的 `fonts` 用途并校验预置 hash，不能将其误判为直接绕过许可的下载。本次依作者此前决定不扩展 CDN 日志及隐私标签核查。

### 当前需处理的项目（按优先级）

| 项目 | 证据与判断 | 下一步 |
| --- | --- | --- |
| 第三方声明随包分发 | 商店配置和构建脚本未接入经复核的第三方 notices；关于页仅有本项目 MIT 标识 | 核对实际随包代码和资源、选择适用许可，生成声明及源码获取说明（按各许可要求），随商店包分发并提供离线入口 |
| 许可证清单复核 | 重新扫描 2.0.16 仍为 704 条、27 条缺少声明或扫描范围内原文；包含构建 / 开发依赖，不能等同随包缺失数 | 追溯原文，剔除有证据未分发的条目；不可直接将 unreviewed 报告作为已完成声明 |
| 字体与图标授权 | `src/styles/fonts.ts` 实际导入 Spectral、Inter Tight、JetBrains Mono；可下载字体有官方许可链接；图标来源仍未记录 | 保留字体许可与版权声明，核对下载字体条款；应用图标创作来源需作者确认，不能仅凭文件存在推断授权 |
| 新隐私入口交付 | 2.0.16 已本地验证，线上仍是旧构建 | 合并、构建并上传新包；验收中英文链接、打开失败提示、离线说明；拒绝及撤回状态不得被升级清除 |
| 发布记录一致性 | `metadata.json` 仍为 proposal，多项真实已填写字段为 null；检查器还无条件列出上传和截图待办 | 更新已确认字段，并将静态资料检查与人工验收证据分开；不能用草稿检查器宣称未上传或已可提交 |
| 最终原生验收 | TestFlight 启动已通过，其余此前明确暂缓项目没有新证据 | 继续保留待验收，尤其升级书签 / 钥匙串、最低系统、保留实验室功能；不擅自改成通过 |

本次清单包含 MPL-2.0 / EPL-2.0 及双许可证条目，例如 cssparser、selectors、option-ext、elkjs、DOMPurify、JSZip。需按实际分发范围和选择的许可履约，不将其一律判断为禁止商用或必须公开整个应用。27 条中也包括本项目 Rust crate：Cargo.toml 未声明 license，而仓库根目录已有 MIT LICENSE；这是扫描范围/元数据问题的一例，不表示本项目没有许可。

本次离线扫描输出 `/tmp/store-license-review-20261105-followup`，仅为本机临时证据，不能作为长期分发声明；仓库原 `license-review.json` 保留为 2.0.14 历史扫描，不冒充新版本结果。

### 隐私清单与审核边界

没有因未找到 `PrivacyInfo.xcprivacy` 就认定 macOS 构建违规，也不添加未经核实的“空收集”清单。Apple 的 required-reason API 平台列表不含 macOS；SDK 和数据收集声明仍需按实际情况核对。隐私标签 / CDN 细查保持待确认，遵照作者先前的暂缓决定。

本轮未发现需要重做沙盒、书签或 AI 授权流程的新增证据；这不是完整合规认证。建议下一项工程工作为“第三方声明与许可整理”，之后再统一制作新的签名候选包，避免每项小改动都重复上传。

来源（2026-11-05 核对）：[Apple 审核指南 §2.4.5、§5.2](https://developer.apple.com/app-store/review/guidelines/)、[Privacy manifest files](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files)。


## 2026-11-05 离线第三方声明第一批（2.0.16）

状态：部分实现，**不构成完整分发许可验收**。与隐私入口同属尚未发布的 2.0.16 收尾版本，不另增版本号。站外版 AboutPane 不挂载声明入口，商店版「设置 → 关于」新增可搜索、逐项展开的离线列表；保留原始文本，按纯文本渲染，不执行 HTML、不请求外网。声明 JSON 经 Vite 动态导入成为本地构建资产，随 Tauri 前端资源嵌入；不依赖运行时 npm 或联网。

### 已整理的范围与选择

本批共 **49 条 npm 包版本记录**：React / React DOM、React i18next / i18next、Zustand、Lucide、CodeMirror 家族、KaTeX 的两个依赖版本、Markdown-it、docx、PptxGenJS、Mammoth、JSZip、Tauri API，以及内置 Spectral / Inter Tight / JetBrains Mono 字体。包含间接依赖；此数量不是最终二进制组件数量。

- MIT / ISC / BSD-2-Clause：保留包内完整版权与许可文本，不删除作者信息。
- 三套内置字体：保留 OFL-1.1 原文及版权，未改动字体文件或字体名称；不是单独销售字体。
- Tauri API 的 Apache-2.0 OR MIT：本批选择 MIT，仍保留包内两份原文。
- JSZip 的 MIT OR GPL-3.0-or-later：包内 LICENSE.markdown 明确允许任选，选择 MIT，并保留整个原文件；不据其另一可选许可推断整个应用必须 GPL。
- 本批仅确认上述包的许可文本取得与保留方式；最终文件、修改情况及整体分发范围仍需候选产物核对。

`src/assets/legal/third-party-notices.json` 保存包名、版本、声明许可、所选许可、npm 来源链接、每份原文 SHA-256 和锁文件哈希。`node scripts/appstore-notices.mjs` 从当前安装的生产依赖中重建，`--check` 对照生成文件，遇到缺少完整原文、未审查的许可表达式、必需条目丢失或文件/锁文件变化即失败。许可证文本来自依赖原文件，不凭模板补写未知版权主体。该检查只保证本批来源和生成一致性，不能批准其他依赖。

### 尚未确认 / 不在第一批范围

- 完整清单其余 **655 条记录**尚未纳入本批离线文件，包括 Rust 依赖与其构建/开发依赖、其他 npm 依赖；先核对最终分发范围再补齐，不意味着这 655 条全部随包。
- Tauri 前端插件包中的 `LICENSE.spdx` 只有声明和供应者等元数据，没有完整 MIT / Apache 条款；旧扫描把“存在文件”算作原文齐备，因此它的 27 条缺失数字不是完整缺口。插件暂不列入已完成批次，需要追溯对应版本的上游许可全文及版权信息。
- MPL-2.0 / EPL-2.0（如 cssparser、selectors、option-ext、elkjs）及其他复合许可：实际分发范围、适用选择和源码提供义务待逐项核对。
- 可下载 HarmonyOS Sans / MiSans 不在内置字体声明中，仍需核对对应版本官方条款及原文保留方式。
- 应用图标来源、审核样例音频的再分发权仍待作者/来源证据；本次没有捏造授权。
- 当前应用仍不能据此宣称所有第三方分发义务已履行；不得把这个部分文件当成最终完整 notices 提交结论。

本次未改变沙盒权限、文件授权、隐私许可、网络请求或站外版入口行为。声明资产由共用前端构建携带，但站外版不显示新增界面。正式签名包中离线读取、键盘展开/搜索、长文本选择复制、两种语言与主题以及站外界面仍待原生验收。

验证结果：生成一致性与原文哈希 2 项 Node 测试通过（已接入现有 CI 的 `appstore-*.test.mjs` 匹配范围）；TypeScript / 前端及原型构建通过，构建产物包含本地 `third-party-notices` chunk。离线 Vitest 467 文件 / 7073 项通过。默认全量测试另触发外部模型实测，7 个 live 测试文件因 DNS/网络失败未通过，不能写为全量绿；随后明确排除 `**/live.*` 复跑得到上述离线结果。原生安装包与最终随包检查仍待进行。

## 2026-11-05 离线声明第二批（2.0.17）

状态：部分整理完成，未完成整体分发许可验收。PR #846 已合并，本批从 main 新建分支，按版本技能同步至 2.0.17。不改变商店版功能范围、字体下载、隐私许可或站外版界面；沿用商店版已有离线入口展示新增原文。

### Rust 原文与可追溯证据

新增 **12 条 Rust 包版本记录**，离线列表合计 **61 条**：

| 包 | 版本 | 本批选择 |
| --- | --- | --- |
| tauri | 2.11.5 | MIT |
| tauri-runtime | 2.11.3 | MIT |
| tauri-runtime-wry | 2.11.4 | MIT |
| tauri-utils | 2.9.3 | MIT |
| tokio | 1.53.1 | MIT |
| reqwest | 0.12.28 | MIT |
| keyring | 4.2.0 | MIT |
| tauri-plugin-dialog | 2.7.3 | MIT |
| tauri-plugin-fs | 2.5.2 | MIT |
| tauri-plugin-notification | 2.4.0 | MIT |
| tauri-plugin-opener | 2.5.5 | MIT |
| tauri-plugin-sql | 2.4.1 | MIT |

除 Tokio 原声明为 MIT，其余均为 MIT / Apache-2.0 二选一，选择 MIT，保留包内所有根目录 LICENSE / NOTICE 文件（含另一许可全文和 SPDX 元数据）。不删除原作者版权信息，不把 SPDX 文件单独当作完整许可。本批完成的是这些包的原文取得与保留；包内嵌套第三方代码、最终链接范围与修改情况仍需产物核对，不能推广成整个传递依赖树均已批准。

`node scripts/appstore-rust-notices.mjs [--check]` 使用本机离线 Cargo metadata 的 macOS arm64 / app-store 图，仅选择表中包。逐个核对缓存 `.crate` 归档 SHA-256 与 Cargo.lock 的 checksum，从归档读取许可，与已解包文件逐字比较；必须包含完整 MIT 条款及原有 Copyright。快照写入 `scripts/legal/rust-notices.json`，含 crates.io 版本链接、registry source、归档 checksum、每份原文 SHA-256；不保存机器绝对路径。更新依赖时先复核再重建。

`appstore-notices.mjs` 将快照合入应用内资产，并校验每项锁定版本、registry source、归档 checksum 及文本 hash；默认前端 CI 不需要 Cargo 下载缓存。快照不能替代上游原文核验，需要在已备齐锁定依赖的开发机运行 Rust 收集器 `--check`。应用内读取仍完全离线。

### 字体核对

内置字体保持原文件与名称，已有原文继续随包：

| 字体 | 原文版权主体 | 本项目使用范围 |
| --- | --- | --- |
| Spectral | 2017 The Spectral Project Authors | latin 200/300/400/500/600、400 italic |
| Inter Tight | 2022 The Inter Project Authors | latin 400/500/600/700 |
| JetBrains Mono | 2020 The JetBrains Mono Project Authors | latin 400/500 |

三者均取自锁定 `@fontsource` 包的 LICENSE，保留完整 OFL-1.1 与版权行，不以通用模板替换字体原文。新增检查把 `src/styles/fonts.ts` 的 Fontsource 导入与离线声明关联，防止以后新增内置字体而漏记原文。依据 [OFL 官方文本](https://openfontlicense.org/open-font-license-official-text/) 第 2 条，随软件分发时保留版权与许可，并使用户可阅读；名称、修改版与单独销售限制仍保留在原文中。字体最终构建文件与上游子集处理来源未因此标记为全部核验通过。

### 仍待确认（不以缺少证据推断许可）

- **tauri-plugin-http 2.6.0 是本仓库 vendor 路径依赖**，不能套用 registry checksum 验证或宣称与 crates.io 归档一致。本批排除；需核对 vendor 原文、上游版本及本项目补丁后单独记录。
- anyhow、serde、serde_json、thiserror 包内 MIT 文本未含明确版权主体行：没有补写作者，也未纳入本批；需要进一步核对上游版权声明。其许可表达式本身不是禁止使用的证据。
- 第一批记录中的 objc2 / block2 / unic 等缺原文条目、复杂 MPL / EPL、其他 Rust / npm 传递依赖，以及 JS 插件对应版本全文仍待处理。Rust 插件与同名 JS 包是不同包，本次不据 Rust 证据自动结清 JS 项。
- HarmonyOS Sans SC 使用 `harmonyos-sans-sc-webfont-splitted@1.1.0`，MiSans 使用 `misans@5.0.0`，为按需下载而非安装包内置字体。2026-11-05 读取[华为官方许可页面](https://developer.huawei.com/consumer/cn/doc/design-guides/font-0000001828772001)超时，[小米官方页面](https://hyperos.mi.com/font/)未取得可读完整条款。官方对应版本原文、第三方切片/转换与镜像分发许可、原文随下载保留方式仍待确认；不以“免费商用”或 npm 的 Unlicense 标记结清字体授权。
- 应用图标与示例音频来源、最终签名包声明可读性、旧版本升级与原生离线验收仍待完成。

本节更新第一批“所有 Rust 尚未整理”的状态，不改写历史 2.0.14 扫描快照，也不将 61 条等同于最终随包组件数。

本批验证：12 条 Rust 原文归档复核 `--check` 通过；App Store Node 检查 11 项通过（含原文 hash、锁文件一致性、内置字体导入覆盖）；`pnpm build` 类型检查与构建通过，仅有现存 chunk 大小提示；`git diff --check` 通过。首次构建遇到 pnpm 缓存/依赖恢复失败，恢复锁定依赖后重跑通过，没有修改依赖锁定版本。未运行外部模型 live 测试，未新建签名包或执行原生验收。

## 2026-11-05 离线声明第三批（2.0.18）

状态：部分整理完成，整体许可清单仍未验收完成。PR #847 已合并，本批从 main 创建独立分支，版本技能同步至 2.0.18。仅增加许可原文、证据校验与文档，不修改 vendor 插件源码、网络行为、字体下载或站外版界面。

### vendor HTTP 插件已核对的范围

`src-tauri/vendor/tauri-plugin-http` 来自 `tauri-plugin-http@2.6.0`，本机缓存 `.crate` 实算 SHA-256 为 `7241a0c762649be8fba7dd4cc84684d0e409f26b335a978ef4dd5fe78da74ce6`，与已有 `PATCH.md` 的上游 registry checksum 记录一致。这里是本机归档对仓库来源记录的核验，未将路径依赖伪装成当前 Cargo.lock 中有 registry checksum 的依赖，也未声称进行了新的在线发布者身份核验。

逐文件比较结果：

- `LICENSE_MIT`、`LICENSE_APACHE-2.0` 及 README 与上游归档一致；MIT 原有 Tauri Apps Contributors 版权行保留。README 还包含 The Tauri Programme within The Commons Conservancy 的版权说明，故全文同时加入离线声明，不截掉这一处信息。
- 修改文件仅 `Cargo.toml`、`src/commands.rs`、`src/error.rs`、`src/lib.rs`。核对差异为测试依赖、共享 client builder / TCP keepalive 配置、脱敏诊断与阶段计时、对应测试；与已有 PATCH 说明相符。本次不更改这些行为。
- 本地增加 `PATCH.md`，也加入离线声明，明确这是修改版而非原封不动的上游包。
- 上游归档有而本地未复制的文件为 `.cargo_vcs_info.json`、`CHANGELOG.md`、`Cargo.lock`、`Cargo.toml.orig`、`LICENSE.spdx`、`SECURITY.md`。这份差异清单保留在快照中；SPDX 元数据的缺席不以“无许可”判断，完整双许可原文及 README 版权已保留。
- 本批依上游 `Apache-2.0 OR MIT` 声明选择 MIT，保留两份全文。不会因整理该插件而把 Reqwest 等所有传递依赖一并标为完成。

Rust 原文收集器现在单独处理 vendor：固定上游归档 checksum、校验已核对的改动/缺省/新增文件集合，并记录完整本地文件树的 SHA-256。前端声明生成器校验 Cargo 路径绑定、锁定版本、本地文件数与每份文件 hash、许可文本与本地来源一致；vendor 内容变化会要求重新复核快照。`--check` 不联网，也不改写 vendor 目录。新增快照中的 `vendorPath` 与 `upstreamDifferences` 明确区分修改版证据与 registry 包证据。

### 同时纳入的可确认依赖

新增 registry 包记录 12 条，沿用归档 checksum 对照 Cargo.lock、原文与解包文件逐字比较的机制：

| 包 | 版本 | 选择 |
| --- | --- | --- |
| base64 | 0.21.7 / 0.22.1 / 0.23.1 | MIT |
| bytes | 1.12.1 | MIT |
| futures-core / futures-util | 各 0.3.34 | MIT |
| http | 1.5.0 | MIT |
| http-body | 1.1.0 | MIT |
| log | 0.4.34 | MIT |
| mime | 0.3.17 | MIT |
| percent-encoding | 2.3.2 | MIT |
| url | 2.5.8 | MIT |

每个版本的版权主体来自各自原文件，未跨版本套用（例如 base64 的版本间版权行不同）。Bytes / http-body 原声明 MIT，其他为 MIT OR Apache-2.0，选择 MIT 并保存包内全部根目录 LICENSE / NOTICE 文件。本轮新增 13 条（含 vendor），Rust 共 25 条，整体离线声明 **74 条**。多版本及构建/间接依赖仍保留，不把这个数量当成最终安装包组件数。

### 仍待完成

第二批的 vendor HTTP“尚未取得原文和补丁证据”项由本节更新；其最终产物覆盖和依赖树仍待检查。其余未收录 Rust / npm、JS 插件完整原文、MPL / EPL 等义务、缺版权主体行包的进一步来源核对仍未结清。下载字体官方对应版本许可、切片/镜像链路、图标与样例音频权利证据也保持待确认。本次未取得新证据，不降低这些事项状态。

最终签名包的离线声明可读性、升级验证仍待原生验收；暂不宣称完整第三方分发义务已完成。

本批验证：`appstore-rust-notices.mjs --check` 通过（25 条，含 vendor 归档及本地文件树复核）；App Store Node 检查 11 项通过；`pnpm build` 类型检查和生产/原型构建通过，仅保留既有 chunk 大小提示；`git diff --check` 通过。本次没有修改 Rust 执行代码，未运行外部模型 live 测试，未生成或上传新签名包。

## 2026-11-05 离线声明第四批（2.0.19，17 条）

状态：部分整理完成，未完成整体分发许可验收。PR #848 已合并，本轮基于 main `23ad57a2` 整合，保留第三批 vendor HTTP 与依赖声明，并同步至 2.0.19。

| 包 | 版本 | 原声明 / 本轮选择 |
| --- | --- | --- |
| futures-channel / futures-executor / futures-io / futures-sink / futures-task | 各 0.3.34 | MIT OR Apache-2.0 / MIT |
| http-body-util | 0.1.5 | MIT |
| httparse | 1.10.1 | MIT OR Apache-2.0 / MIT |
| mio | 1.2.3 | MIT |
| slab | 0.4.12 | MIT |
| smallvec | 1.16.1 | MIT OR Apache-2.0 / MIT |
| socket2 | 0.6.5 | MIT OR Apache-2.0 / MIT |
| tower | 0.5.3 | MIT |
| tower-layer / tower-service | 各 0.3.3 | MIT |
| tracing | 0.1.44 | MIT |
| tracing-attributes | 0.1.31 | MIT |
| tracing-core | 0.1.36 | MIT |

这些包均来自锁定的 macOS arm64 / app-store Cargo metadata 图。逐个复核本机缓存 `.crate` SHA-256 与 Cargo.lock，归档中的根目录 LICENSE / NOTICE 原文与解包文件逐字一致；保留 MIT 版权行与完整条款，双许可包同时保留 Apache 原文。版权行分别来自 Alex Crichton / Tokio Authors、Sean McArthur / Hyper Contributors、Carl Lerche / MIO contributors、Servo Project Developers、Tower Contributors、Tokio Contributors，未根据包作者字段猜测或补写版权。

本轮仅扩充收集白名单与原文快照，不改变 Rust 执行代码、网络、沙盒或站外版行为。收录仍包含构建和间接依赖，不代表最终二进制清单或整个依赖树已核验。

### 新核对但暂不纳入

- `itoa@1.0.18`、`once_cell@1.21.4`、`pin-project-lite@0.2.17`：包内 LICENSE-MIT 有许可正文，但未含明确版权主体行。与前述 anyhow / serde / thiserror 同样继续核对来源，不从作者元数据补写，也不据此认定禁止使用。
- `ryu@1.0.23`：声明为 Apache-2.0 OR BSL-1.0，存在 LICENSE-APACHE / LICENSE-BOOST；尚未完成该许可选择及归属核对，不因 Boost 文本也包含 “Permission is hereby granted” 就误归类为 MIT。
- `memchr@2.8.3`：声明为 Unlicense OR MIT，LICENSE-MIT 含 Andrew Gallant 版权行；本轮未扩展收集器支持这一表达式，留待连同其他原文/嵌套声明核对后纳入。

既有复杂许可、JS 插件全文、下载字体许可及镜像链路、图标/音频来源、最终签名包原生离线验收均保持待完成。本轮没有重做在线发布者身份验证，也没有新建签名包或上传。

整合后验证：42 条 Rust 原文归档复核通过；离线资产共 91 条（49 条 npm、42 条 Rust），与 main 的 74 条既有记录逐项比较完全保留，新增 17 条。11 项 App Store Node 检查通过；`pnpm build` 类型检查、应用及原型生产构建通过；`git diff --check` 通过。四份版本清单已同步为 2.0.19。未运行外部模型 live 测试，未生成新签名包，未执行原生离线验收。整合前保存的临时工作副本不是发布资产，当前生成资产已包含 #848 全部记录。
