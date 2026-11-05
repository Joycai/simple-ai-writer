# P4 商店提交资料与准备流程

> Status: `partial` — 2.0.14 已完成无正式签名的本地准备工具与文案草稿。2026-11-05 已配置正式签名材料并生成 2.0.15 / build 4 签名候选包；未上传、未发布。剩余原生验收、公开隐私政策和审核材料继续待完成。

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
