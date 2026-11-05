# 商店版许可来源与当前整理范围

> 状态：`partial`；2026-11-05，应用版本 2.0.23。此目录是维护资料，不作为应用资源导入。

工作状态：按作者决定，本轮许可证整理到此结束。除非新增依赖，不再主动核查或扩大范围。下文待确认项仅保留历史事实，不安排继续调查；新增依赖只处理新增项。已有一致性测试照常运行，不等于重新开展许可审计。

## 范围决定

按作者要求，离线声明的独立条目仅列项目直接运行依赖和实际提供的字体，不再按整个依赖树逐层增加独立条目。组件内部的必要声明归在对应组件下；此组织方式不表示传递组件的原有许可可以忽略。

- npm：package.json 的 39 个 dependencies，加上应用 PPTX 写入器直接 import 的 JSZip，共 40 项。读取项目顶层安装入口的实际版本，避免同名传递版本混入。
- Rust：macOS arm64 / app-store 的应用根节点 normal 依赖，共 26 项。排除 build/dev、Windows 专用和传递依赖。cargo metadata 只用于确定直接边，不遍历扩展收集范围。
- 字体：三套内置 Fontsource 字体（Spectral、Inter Tight、JetBrains Mono）在上述 npm 条目内；额外列出按需下载的 MiSans 和 HarmonyOS Sans SC。这两项版本栏表示字体包版本，不是字体内部版本。
- KaTeX 数学字体留在 KaTeX 条目；markdown-it-katex 内部 KaTeX 的代码许可放在插件条目，字体文件与直接 KaTeX 相同，经逐文件哈希核对后共用 KaTeX 字体声明。
- PDF.js 的 LiberationSans、Foxit、QuickJS、QCMS、OpenJPEG、JBIG2 声明保留在 PDF.js 条目下，不扩展成独立顶层依赖。

结果：107 个独立条目移除 58 个传递版本条目，新增 17 个直接 Rust 条目和 2 个下载字体条目，成为 68 个。没有删除、替换运行时依赖或字体文件。

## 文件用途

- rust-notices.json：26 个直接 crate 的归档 checksum、许可原文及 vendor HTTP 证据；由 appstore-rust-notices.mjs 离线复核。
- tauri-js-notices.json：六个 JS 插件的锁定上游原文与包文件指纹。
- pdfjs-resource-notices.json、katex-font-notices.json：组件内部声明来源与资源绑定。
- resource-inventory.json：PDF.js / KaTeX 资源哈希，供维护检查，不随离线声明进入应用。
- download-font-notices.json：下载字体的完整协议文本、来源及证据状态。
- MiSans-LICENSE.pdf / .txt：小米官网的协议原文件及 PDFKit 提取的完整双语文本；保留原 PDF 以核对文字提取。
- HarmonyOS-Sans-LICENSE.txt：OpenHarmony 上游 LICENSE_Fonts，来源固定到 a52632e5d3901cc860b87fe923142077de194b42。
- 两份字体包 README.md.txt：当前项目使用版本的 npm 原文，仅作字体来源证据，不进入应用声明。
- objc2 的两份提交级 LICENSE.md 原文（以 .md.txt 保存）：由 crate 的 .cargo_vcs_info.json 定位上游提交；不是自行拼写的 MIT 模板。

应用侧只生成 src/assets/legal/third-party-notices.json：包名、版本、许可、来源以及许可/版权文本。完整 README、PATCH、归档清单、资源哈希和上游差异证据留在此目录。许可头中的实际版权与许可文字仍保留，不能将它们当作普通审计说明删掉。

## 本次确认与剩余事项

13 个此前缺失的直接 Rust 依赖已取得归档内完整原文：calamine、chardetng、encoding_rs、gethostname、keyring-core、libc、quick-xml、rust_xlsxwriter、serde、serde_json、sha2、sqlx、zip。encoding_rs 额外保留 LICENSE-WHATWG，标记 MIT AND BSD-3-Clause；gethostname 保持 Apache-2.0。serde / serde_json 的归档 LICENSE-MIT 自身没有版权主体行，保留上游全文，不补写猜测版权主体。

objc2、objc2-foundation、objc2-app-kit、objc2-web-kit 四项目前只取得各自版本所指向的上游许可声明。原归档没有完整许可证，上游 LICENSE.md 也没有原始版权行与完整 MIT 条款。因此独立条目保留真实声明，完整版权许可原文仍待确认，不将通用模板或猜测作者补作上游原文。

MiSans 使用 misans@5.0.0（包 README 写明字体版本 4.009）；取得包引用的 [小米官方完整协议](https://hyperos.mi.com/font-download/MiSans%E5%AD%97%E4%BD%93%E7%9F%A5%E8%AF%86%E4%BA%A7%E6%9D%83%E8%AE%B8%E5%8F%AF%E5%8D%8F%E8%AE%AE.pdf)。HarmonyOS 使用 harmonyos-sans-sc-webfont-splitted@1.1.0；取得 [OpenHarmony 原始字体协议](https://github.com/openharmony/utils_system_resources/blob/a52632e5d3901cc860b87fe923142077de194b42/LICENSE_Fonts)。不将 npm 包的脚本许可或 Unlicense 当作字体许可。两份字体条款含不修改字体的限制，而当前使用的是第三方切片包；切片/转换与下载分发是否得到相应授权仍待确认，本次仅补齐真实协议和使用声明，不修改下载行为或宣称授权已全部解决。

PDF.js 内部资源此前记录的源码提供、确切构建来源等未决事项维持原状态，参见上级 README 的历史记录。旧 license-review.json 是早期全树扫描记录，不再用其中 704 包清单作为应用许可收集范围。

## 验证与交付边界

验证结果：Node App Store 检查 18 项通过；26 个 Rust 原始归档及快照 --check 通过；TypeScript --noEmit 通过；文档引用检查 1 项通过；git diff --check 通过。不生成安装包，不签名，不上传。应用内入口继续只在商店渠道挂载；本次不修改站外版 UI、字体下载或功能代码。
