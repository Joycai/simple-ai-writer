# Simple AI Writer 隐私政策 / Privacy Policy

适用于 Mac App Store 版 Simple AI Writer（Simple AI Writer Store）。

运营者：Joycai（Cai Zhengxu）  
隐私联系邮箱：[joycai@joycai.cn](mailto:joycai@joycai.cn)  
版本日期：2026 年 11 月 5 日。本政策自发布至本仓库 main 分支之日起生效。

## 1. 本地使用与数据保存

本应用是本地文档编辑与 AI 写作客户端，无需注册开发者提供的应用账号即可使用本地编辑功能。文档、知识库、项目数据库、对话与任务记录、用量记录、素材和缓存保存在用户选择的项目目录或本机应用数据目录。API 凭据通过操作系统凭据管理器保存。

商店版使用系统文件选择窗口取得文件或项目文件夹访问权限，并通过本机 security-scoped bookmarks 恢复已授权的访问。文件访问书签及数据分享许可不包含在配置备份中。可选诊断日志可能包含请求和回复，保存在本机；向他人提供前请检查并移除敏感信息。

开发者不提供面向用户的默认 AI 服务、中转接口或同步服务器。应用不会为了向开发者上传作品而自动收集本地文档。

## 2. 用户自行配置的在线服务

AI、检索、MCP 和同步服务的地址及凭据由用户自行配置。使用这些功能时，请求直接发送至配置的接收方，不经过开发者提供的代理服务器。应用仅在使用相关功能时发送相应数据：

- **AI 写作与多模态功能：**提示词、正文或选区、自动组装的上下文、知识库材料、对话历史、摘要、工具结果及所选附件，可能包括图片、音视频。音频转写需要向所选服务发送音频。
- **检索：**根据所选检索功能，可能发送查询文本、条目描述或文档片段。
- **模型检测：**认证信息、模型标识及测试文本。检测也可能产生第三方费用。
- **MCP：**客户端信息、工具发现请求及工具参数；参数可能包含项目文本和文件路径。远端工具可执行操作或继续向其他服务转发数据。
- **知识库同步：**条目、图片、目录结构、路径及版本信息。
- **配置备份：**渠道、模型、提示词、可迁移偏好及备份概要。只有用户另行选择时才包含 API 密钥；包含密钥的备份载荷需使用密码加密，但服务器仍可能看到认证信息及备份信封概要。

服务凭据会在相应请求需要认证时发送给配置的服务。媒体上传、结果下载可能涉及不同接收地址，应用分别检查相应的数据分享许可。

这些服务可能保留请求、回复、账户信息或连接日志，也可能有自己的模型训练或转发规则。其处理目的、保存期限、所在地区和删除方式由各服务运营方及用户与其订立的条款决定。请在配置及授权前阅读对应政策。开发者不保证用户选择的服务采用零保留、不用于训练或仅在某一国家或地区处理数据。本机、局域网及中转地址也可能继续向外部服务转发数据。

## 3. 字体下载及外部页面

用户选择下载字体时，应用连接预置的资源站点，包括实际下载所用的 npmmirror、jsDelivr 或 unpkg 镜像。请求包含字体包、版本与资源路径，不包含文档正文或 AI API 密钥。下载服务会接收 IP 地址及完成连接所需的技术信息，并可能依照自身政策保留访问日志。

打开 GitHub 项目、帮助链接或本政策页面时，对应网站会按其自身政策处理访问数据。访问本政策的 GitHub 页面适用 [GitHub 隐私声明](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)。

## 4. 许可与撤回

受数据分享许可控制的在线功能会说明接收地址、用途及数据范围，并请求用户许可。许可按接收方、用途及告知版本保存在本机，不随配置备份迁移。文件访问授权、工具操作确认和费用确认分别管理。

可在“设置 → 关于 → 隐私与数据分享”中撤回许可，暂停相应后续请求。应用会尽力取消活动请求，但无法召回已经发出的内容，也无法保证接收方立即停止处理。“允许再次询问”只恢复询问，不会直接授权或重发请求。拒绝或撤回数据分享许可不影响基础本地编辑。

## 5. 保存期限、删除与隐私请求

本地数据依其用途保留，直到用户删除相应文件、缓存或记录，或执行应用提供的重置操作；部分缓存可能由应用清理。移除最近项目记录不等于删除项目文件。重置应用配置会删除应用配置及本应用管理的凭据，不会删除项目文件或外部备份。卸载应用也不保证删除项目文件及所有应用数据。

用户可以通过文件管理、应用内管理功能及系统凭据管理工具管理本机数据。独立的系统备份、同步目录或远端备份需要分别处理。若需要帮助访问、更正或删除开发者实际持有的个人信息，请联系上述邮箱。第三方服务保存的数据需向对应运营方申请处理；开发者不能代替第三方承诺删除结果。

## 6. 支持与反馈

用户主动发送支持邮件时，开发者会收到发件邮箱、邮件内容以及用户附上的截图或诊断资料，用于回复、排查问题及处理请求。邮件服务提供方也会参与邮件传输和存储。这些资料仅在处理请求、必要的后续沟通或履行法律义务所需期间保留，不用于广告或模型训练；可通过上述邮箱请求删除。

GitHub Issues 是公开反馈渠道，提交的内容可能被任何人查看。请勿提交密码、API 密钥或私人文档。涉及个人信息的问题建议使用邮件联系。

## 7. 广告、跟踪与安全

本应用不集成广告或跨应用广告跟踪 SDK。开发者不出售用户的个人信息，也不将支持资料用于广告定向。用户自行配置服务的行为受该服务自身政策约束。

应用使用操作系统沙盒、文件访问授权及系统凭据管理来限制访问。在线传输的保护也取决于所选服务及协议；建议使用 HTTPS。任何存储或传输方式都不能保证绝对安全。

## 8. 政策更新与联系

本政策更新时会在此页面公布，并更新版本日期；历史版本可通过 GitHub 文件历史查看。若相关功能的数据分享告知发生变化，应用会按告知版本重新请求所需许可。

隐私问题、数据请求或对本政策的疑问，请联系蔡正旭（Cai Zhengxu）：[joycai@joycai.cn](mailto:joycai@joycai.cn)。

---

# English

Applies to the Mac App Store edition of Simple AI Writer (Simple AI Writer Store).

Operator: Joycai（Cai Zhengxu）  
Privacy contact: [joycai@joycai.cn](mailto:joycai@joycai.cn)  
Version date: November 5, 2026. This policy takes effect when published to this repository's main branch.

## 1. Local use and storage

The app is a local document editor and AI writing client. Basic local editing does not require an app account provided by the developer. Documents, knowledge-base content, project databases, conversations, task records, usage records, assets and caches are stored in the selected project folder or local app data directory. API credentials are stored through the operating system's credential manager.

The App Store edition obtains file and folder access through system file selection dialogs and uses local security-scoped bookmarks to restore authorized access. File-access bookmarks and data-sharing permissions are excluded from configuration backups. Optional local diagnostic logs may contain requests and responses; review and redact sensitive information before sharing them.

The developer does not provide a default AI service, proxy or synchronization server for users. The app does not automatically collect local documents to upload users' work to the developer.

## 2. Services configured by the user

Users configure the addresses and credentials for AI, retrieval, MCP and synchronization services. Requests go directly to the configured recipients, without a developer-provided proxy. Data sent depends on the feature used:

- **AI writing and multimodal features:** prompts, document text or selections, assembled context, knowledge-base material, conversation history, summaries, tool results and selected attachments, potentially including images, audio or video. Transcription sends audio to the selected service.
- **Retrieval:** queries, entry descriptions or document chunks, depending on the retrieval feature.
- **Model testing:** authentication information, model identifiers and test text. Tests may incur third-party charges.
- **MCP:** client information, discovery requests and tool arguments, which may contain project text and file paths. Remote tools may perform operations or forward data to other services.
- **Knowledge-base synchronization:** entries, images, directory structure, paths and version information.
- **Configuration backups:** channels, models, prompts, transferable preferences and backup summaries. API keys are included only when separately selected by the user. Backups containing keys require password encryption of the payload; the server may still see authentication information and backup envelope metadata.

Credentials are sent to the configured service when authentication is required. Media uploads and result downloads may use different destinations, with separate permission checks.

These services may retain requests, responses, account information or connection logs and may have their own training and forwarding practices. Their purposes, retention periods, processing locations and deletion procedures depend on their operators and the user's agreement with them. Review their policies before configuring and authorizing them. The developer does not guarantee zero retention, exclusion from training or processing in a particular country or region by user-selected services. Localhost, local-network and proxy endpoints may forward data elsewhere.

## 3. Font downloads and external pages

When users choose to download fonts, the app connects to preset resource hosts, including the npmmirror, jsDelivr or unpkg mirror used for the download. Requests identify the font package, version and resource path, and do not include document text or AI API keys. Download services receive the IP address and technical connection information and may retain access logs under their own policies.

When opening the GitHub project, help links or this policy, the destination website processes access data under its own policy. The GitHub-hosted policy page is subject to the [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

## 4. Permission and withdrawal

Online features controlled by data-sharing permissions explain the recipient address, purpose and data scope and request permission. Permissions are stored locally by recipient, purpose and notice version, and are not migrated through configuration backups. File access, tool-operation approvals and charge confirmations are managed separately.

Permissions can be withdrawn under Settings → About → Privacy and Data Sharing to pause subsequent requests. The app attempts to cancel active requests, but cannot recall transmitted content or guarantee that a recipient stops processing immediately. Allowing the app to ask again does not grant permission or resend requests. Refusing or withdrawing data-sharing permission does not prevent basic local editing.

## 5. Retention, deletion and privacy requests

Local data remains according to its purpose until the user deletes the relevant files, caches or records, or uses the app's reset functions; some caches may be cleared by the app. Removing a recent-project entry does not delete project files. Resetting app configuration deletes app configuration and credentials managed by the app, but does not delete projects or external backups. Uninstalling does not guarantee deletion of projects or all app data.

Users can manage local data through file management, in-app controls and system credential tools. System backups, synchronized folders and remote backups require separate management. Contact the privacy email for help accessing, correcting or deleting personal information actually held by the developer. Requests concerning data retained by another service must be addressed to that operator; the developer cannot guarantee deletion by third parties.

## 6. Support and feedback

When users email support, the developer receives the sender's email address, message and any attached screenshots or diagnostics to respond, troubleshoot and handle the request. Email service providers also participate in transmission and storage. Support material is retained only as needed to handle the request, necessary follow-up or legal obligations, and is not used for advertising or model training. Deletion can be requested at the privacy email.

GitHub Issues is public, and submitted content may be viewed by anyone. Do not include passwords, API keys or private documents. Use email for matters involving personal information.

## 7. Advertising, tracking and security

The app does not integrate advertising or cross-app advertising tracking SDKs. The developer does not sell personal information or use support material for advertising targeting. User-configured services operate under their own policies.

The app uses OS sandboxing, file-access authorization and system credential storage to limit access. Transport protection also depends on the selected service and protocol; HTTPS is recommended. No storage or transmission method guarantees absolute security.

## 8. Changes and contact

Updates are published on this page with a revised version date. Earlier versions remain available through GitHub file history. When a feature's data-sharing notice changes, the app requests the required permission according to the notice version.

For privacy questions or data requests, contact 蔡正旭（Cai Zhengxu） at [joycai@joycai.cn](mailto:joycai@joycai.cn).
