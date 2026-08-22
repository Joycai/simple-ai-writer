# 应用配置备份到服务端（跨设备同步 + 密码保护）

> 状态：`planned` — 已决定，未实现。落地后逐条改成 `shipped`。
>
> 前置阅读：[`remote-knowledge-base-feasibility.md`](remote-knowledge-base-feasibility.md)（服务端为什么长这样）、[`kb-admin-console.md`](kb-admin-console.md)（后台的两套鉴权）。改 `src/lib/ai/configTransfer.ts` 或 `server/src/store.rs` 前先读本文。

## 0. 一句话

现有的「配置备份」只能导出成一个本地 JSON 文件靠 U 盘搬家；本方案让同一份包能推到已有的 `aiw-kb-server` 上、在另一台设备拉回来，并且**在离开这台机器之前就用作者的密码加密**，服务端全程拿不到明文。顺带把设置页那个已经名不副实的「知识库同步」改名。

---

## 1. 要解决的问题

今天 `lib/ai/configTransfer.ts` 已经能把 供应商 / 模型 / Prompt / 可迁移偏好（+ 可选的 API Key）打成一个 `ConfigBackup` JSON。缺的是三件事：

1. **搬运方式只有文件。** 换一台机器要先导出、传文件、再导入。而这个项目已经自带了一台服务器（`server/`），作者已经为知识库同步在设置里填过它的地址和 token。
2. **带 Key 的备份是明文的。** 本地文件明文尚可接受（文件在作者自己盘上，UI 也警告了）；一旦推到一台**别人也能用 token 访问、后台还能一键下载整个 data 目录**的服务器上，明文就等于把所有供应商的 API Key 交出去。
3. **设置页那一栏叫「知识库同步」。** 加进配置备份之后这个名字就是错的。

## 2. 四条不变量

这四条是本方案的骨架，后面每个设计选择都能回到其中一条：

**① 服务端永远看不懂它存的是什么。**
它对配置包做的事和对知识库条目完全一样：收下一串字节、算个 hash、原样发回去。它不解析信封、不认识 KDF、不知道里面有没有 Key。理由和 `store.rs` 顶部那条「服务端不解析 markdown、不认识 facet」是同一条：客户端的格式还要演进很多轮，任何一次演进都不该需要重新部署服务器。

**② 带 API Key 的包，必须加密才能上传。**
不是提示，是硬约束——`sealBundle()` 在 `hasKeys && !password` 时直接抛错，UI 上「包含 API Key」和「不设密码」互斥。本地文件导出维持现状（明文 + 警告），因为文件在作者自己手里；服务端不行，一个 token 泄漏就是全部供应商凭据泄漏。

**③ 密码只存在于作者脑子里（和可选的本机 keyring 里），绝不上网。**
服务端没有任何字段能验证密码、也没有任何路径能重置。忘了密码 = 这个备份档作废、重新推一份。UI 必须把这句话说出来，而不是等作者输错三次才发现。

**④ 恢复要先预览再确认。**
和知识库同步那条「两个同步按钮都不同步，都只打开预览」同源。恢复会按 id 覆盖本地供应商/模型/Prompt、覆盖 keyring 里的 Key、并且立刻改主题字体面板宽度。作者必须先看见「将合并 6 个供应商 / 23 个模型 / 4 个 Prompt / 含 6 个 API Key」再点确认。

---

## 3. 信封格式（客户端唯一真相）

上传的字节就是一个 UTF-8 JSON 文档：

```jsonc
{
  "kind": "ai-writer-config-envelope",
  "version": 1,
  "createdAt": "2026-08-23T09:12:44.301Z",
  "appVersion": "1.23.1",
  "device": "REINE-DESKTOP",
  "encrypted": true,
  "hasKeys": true,
  "counts": { "providers": 6, "models": 23, "prompts": 4, "prefs": 31 },

  // encrypted=true 时出现；encrypted=false 时两者都不出现
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 310000, "salt": "<base64>" },
  "cipher": { "name": "AES-GCM", "iv": "<base64>" },

  // encrypted=true → 密文的 base64；false → 明文 ConfigBackup 对象本身
  "payload": "<base64>" 
}
```

几个刻意的点：

- **头部是明文的，而且只装展示用的事实。** `device` / `appVersion` / `counts` / `hasKeys` 让「另一台设备上的列表」在不解密的前提下就有内容可显示——作者在输密码之前就该看得见「这是我上周从笔记本推的，6 个供应商」。头部里没有任何能反推密码或明文的东西。
- **`counts` 是自报的。** 加密之后没人能核对它，所以它只能出现在列表里，**绝不能**参与「要合并多少条」那句确认文案——那句必须在解密**之后**从真实解析结果算出来。这条不写下来，将来一定有人图省事直接把 `counts` 渲染进确认框。
- **KDF 和 cipher 的参数写在信封里，不是写在代码里。** 迭代次数以后要调（见 §8），旧包必须还能开。
- **不设密码时 payload 是明文对象而不是 base64。** 这样一个不加密的备份档用任何 JSON 工具都能看，和现在的本地导出文件保持同一种可读性。

**密码 → 密钥**：`PBKDF2-SHA256`，盐 16 字节随机，迭代 310 000（OWASP 对 PBKDF2-SHA256 的建议下限），导出 256 位给 `AES-GCM`，IV 12 字节随机，每次上传都重新生成盐和 IV。全部走 WebCrypto（`crypto.subtle`），不引第三方加密库。

**密码错**：AES-GCM 的认证标签会失败，`decrypt` 抛异常。客户端把它统一成一句「密码错误，或这个备份已损坏」——GCM 在密码上分不出这两种情况，硬要分只会得到一句谎话。

## 4. 服务端：`/v1/configs`

和 `/v1/kbs` 平级的一个新资源，复用同一个 `require_token` 中间件、同一批 token、同一个审计日志。

```text
GET    /v1/configs                        列出所有备份档
POST   /v1/configs                        新建一个档 { name } → 档信息
GET    /v1/configs/{id}                   下载当前版本（application/octet-stream）
PUT    /v1/configs/{id}                   上传新版本（If-Match / If-None-Match）
DELETE /v1/configs/{id}                   删除整个档
GET    /v1/configs/{id}/versions          列出保留的历史版本
GET    /v1/configs/{id}/versions/{at}     下载某个历史版本
```

### 磁盘布局

```text
configs/<id>/meta.json                       { id, name, createdAtMs }
configs/<id>/versions/<atMs>.<hash>.bin      信封字节
configs/<id>/versions/<atMs>.<hash>.json     该版本的展示元数据（客户端给的，不透明）
```

- **当前版本 = `atMs` 最大的那个**，靠列目录得出，没有指针文件。和 `store.rs` 第 3 条同源：指针是第二份真相，而它和 blob 不一致时客户端看不见。
- **保留最近 N 个版本**（`[server] config_versions`，默认 10），写入成功后裁掉最老的。配置包只有几十 KB，留几版的成本可以忽略，换来的是「昨天那次导入把我配置搞乱了」有路可退。
- **`.json` 侧车是允许的破例，要写清楚为什么。** 知识库那边禁止侧车，是因为侧车里的 hash 一旦和 blob 不同步，客户端的三方安全栏杆就会基于错的 hash 做判断。这里的侧车装的是 `device` / `appVersion` / `counts` / `encrypted` ——纯展示，丢了或者对不上最坏就是列表少显示一行字，和已经存在的 `last-write.json` 同一档次。写入顺序：先落侧车，再 rename blob；blob 的到达是提交点，孤儿侧车由 dedupe 维护任务清理。

### hash 由服务端算，这是和条目的**故意分歧**

条目的 hash 必须客户端给，因为服务端拿到的是 zip，而 zip 字节含压缩选择/顺序/时间戳，重算必然得到另一个值。配置包没有这个问题：上传的就是客户端自己拼的那串字节，服务端 `sha256` 一遍必然和客户端算的一致。所以这里**不需要** `X-Entry-Hash` 那样的信任，服务端自己算，写进文件名，用 `ETag` 发回。少一个可被伪造的输入。

### 前置条件照旧

`PUT` 接 `If-Match: "<hash>"`（替换）或 `If-None-Match: *`（首次），复用 `routes.rs` 已有的 `precondition_from`。两台设备同时往一个档推，后到的拿 412，客户端提示「另一台设备刚更新过这个备份档，先刷新再推」。没有这条，A 机器的配置会被 B 机器的静默盖掉——和条目那边完全一样的失败，换个资源重演一次。

### 展示元数据怎么进服务端

客户端在 `PUT` 时带一个 `X-Config-Meta` 头：把上面那个信封头部（去掉 `payload`）压成 base64url 的 JSON。服务端**原样存进 `.json` 侧车、原样在列表里发回**，不 parse、不校验字段，只限长度（≤ 4 KiB）和字符集（base64url）。这就是不变量 ① 在这一层的落地：信封格式改了，服务端一行都不用动。

### 配置项与限制

`[server]` 下新增两个键（沿用 `max_entry_mb` 的命名法）：

| 键 | 默认 | 作用 |
|---|---|---|
| `config_max_mb` | 4 | 单个配置包上限。Key + Prompt 全带上也就几十 KB，4 MiB 是宽到不会误伤又不会被当上传通道滥用的量级 |
| `config_versions` | 10 | 每个档保留几版 |

两个都要进 `Config::source_of` 的 provenance 表和后台的配置编辑页（`confedit.rs` 写回时保留注释那条路径）。

### 审计

`config-upload` / `config-download` / `config-delete` / `config-create`，字段沿用 `EntryLog`（`kb` 位置放档 id）。412 一样要记——「B 机器告诉 A 机器它慢了一步」正是活动页存在的理由。

### 后台

新增一页「配置备份」：档列表（名称 / 版本数 / 当前版本大小 / 设备 / 时间 / 是否加密）、展开看历史版本、删除档或单个版本。**后台不提供下载**——它是运维界面，而配置包（哪怕加密）是作者的凭据材料，运维没有需要拿它的场景；整机备份 tar 本来就覆盖了 `configs/`（`spawn_tar_gz` 打的是整个 data 目录），不需要第二条出口。

---

## 5. 客户端

### 5.1 先拆 `configTransfer.ts`（这是第一步，不是顺手）

现在「怎么打包」和「弹哪个文件对话框」缠在一起：`exportAiConfig()` 里既构造 bundle 又调保存对话框，`stageConfigImport()` 里既开文件又做那 80 行逐字段校验。服务端这条路需要的是中间那两段，不是对话框。

抽出两个纯函数：

```ts
export async function buildConfigBundle(includeKeys: boolean): Promise<ConfigBackup>
export function parseConfigBundle(
  raw: unknown,
  existingProviderIds: string[],
): ParsedConfigBundle          // = StagedConfigImport 去掉 path
```

`exportAiConfig` / `stageConfigImport` 变成它们外面的一层对话框壳。这样文件导入和服务端恢复**共用同一套校验**——包括「未知的 `reasoningEffort` 要降级成不发」「未知的 `translateFormat` 要降级成普通模型」这些已经用 bug 换来的判断。两条路各写一份的话，第二份一定会漏掉其中一条。

`applyConfigImport(staged)` 原样复用，一行不改。

### 5.2 新模块 `src/lib/configsync/`

| 文件 | 职责 |
|---|---|
| `envelope.ts` | 信封的封/开：`sealBundle(bundle, password \| null, meta)` → `Uint8Array`，`openEnvelope(bytes, password?)` → `{ header, bundle }`。纯函数，vitest 直接跑（node 有 `crypto.subtle`，`pptxHarvesterCsp.test.ts` 已经在用） |
| `client.ts` | `/v1/configs` 的 HTTP 客户端。照抄 `lib/sync/client.ts` 的形状：`lib/http` 的 fetch、`Expect` 前置条件、412 → `SyncConflictError` |
| `run.ts` | 两条流程：`pushConfig(slot, opts)` = 打包 → 封 → PUT；`pullConfig(slot, password)` = GET → 开 → `parseConfigBundle` → 交给 UI 预览 |
| `store.ts`（可选） | 档的本机记忆：上次推的是哪个档、密码存没存 keyring |

**连接信息完全复用 `lib/sync/config.ts`**：`app:kbServerUrl` 这个偏好 + keyring 里 `kbsync:<url>` 那个 token。它们本来就是「装机级」的（模块注释里就是这么论证的），不是知识库专属。不要为配置备份新开一份地址和 token。

**密码可选存 keyring**：账号 `cfgpwd:<serverUrl>:<slotId>`，走同一套 `secret_*`。默认不存；勾了「记住密码」才存，并且在 UI 上说明白「记住 = 存进本机系统凭据管理器，换机器还是要输」。

### 5.3 状态：新开一个 `stores/configSyncStore.ts`

不塞进 `syncStore`。`syncStore` 整个是项目作用域的（`hydrate(projectPath)`、binding、三方 plan、预览决策），而配置备份**不需要打开任何项目**——一台刚装好的新机器，还没有项目的时候，恰恰是最想恢复配置的时刻。混在一起就得给每个字段加「这个要不要项目」的判断。

### 5.4 设置页重构

`SyncPane` 现在的第一件事是「没有项目 → 整个面板变成一句提示」。这条要下移：

```
┌ 同步与备份 ─────────────────────────────┐
│ 服务器            （装机级，不需要项目） │   ← 地址 / token / 连接，现有逻辑原样
│ 应用配置          （装机级，不需要项目） │   ← 新增
│   · 本地文件：导出 / 导入               │   ← 从 GeneralPane 整段搬过来
│   · 服务器备份档：列表 / 上传 / 恢复    │   ← 新增
│ 知识库同步        （需要打开项目）      │   ← 现有逻辑，未开项目时本节内联提示
└────────────────────────────────────────┘
```

「配置备份」那一节从 `GeneralPane` 搬走：本地文件导出/导入和服务端备份是同一件事的两个出口，分在两页会让作者以为它们是两套东西（也会让「带 Key 时必须加密」这条规则看起来只适用于其中一个）。`GeneralPane` 不留跳转入口，导航栏里就有。

### 5.5 上传 / 恢复的交互

**上传**：选档（或新建）→ 勾「包含 API Key」→ 若勾了则密码框变必填 → 显示将要上传的条数 → 推。推完刷新列表，显示「当前版本 · 刚刚 · 本机」。

**恢复**：选档 → 选版本（默认当前）→ 下载 → 若加密则要密码 → 解密 → `parseConfigBundle` → **预览**（复用现有的 `systemSettings.backup.importConfirm` / `importKeysNote` / `importPrefsNote` 三句文案，它们说的正是同一件事）→ 确认 → `applyConfigImport` → `useAppStore.getState().reloadFromPrefs()`。

**恢复前自动留一份回滚包**（可做可不做，倾向做）：`buildConfigBundle(true)` 写到 `<appdata>/config-rollback-<时间戳>.json`，只保留最近 3 份。恢复是唯一一个会同时覆盖数据库行和 keyring 的操作，而 keyring 的旧值一旦被盖就真没了。

---

## 6. 改名

| 位置 | 现在 | 改成 |
|---|---|---|
| `systemSettings.tabs.sync`（zh） | 知识库同步 | **同步与备份** |
| `systemSettings.tabs.sync`（en） | KB sync | **Sync & Backup** |
| `sync.paneTitle` | 知识库同步 | 同步与备份 |
| `sync.subIntro` / `subConnected` / `subBound` | 只讲知识库 | 改写成同时涵盖配置与知识库 |

**`SettingsTab` 的 id 保持 `"sync"` 不变。** 它是 `appStore` 的状态、`openSettings(tab)` 的参数、命令面板可能引用的字符串；改 id 只为了好看，收益是零，风险是某处传了旧字符串而 TS 查不出来（比如从持久化的值里读出来的）。名字改在 i18n 层就够了。

`server/` 那边的目录名（`docs/feature/knowledge-base/`、`aiw-kb-server`、`kbsync:` keyring 前缀、`app:kbServerUrl`）**一律不动**。它们是磁盘上和 keyring 里的真实标识，改名等于所有老用户重连一次，换来的只是命名整齐。这份文档放在 `knowledge-base/` 目录下、内容却讲配置备份，就是这个取舍的结果。

---

## 7. PR 切片

按「一片一 PR，每片之后停下来给真机测」推进。

### PR-1 · 服务端 `/v1/configs`
- `store.rs`：`configs/` 布局、`list_config_slots` / `create_slot` / `put_version` / `read_version` / `list_versions` / `delete_slot` / 裁版本；单元测试覆盖「版本裁剪」「当前版本 = 最大 atMs」「孤儿侧车被忽略」
- `routes.rs`：七条路由 + `If-Match` 复用 + `X-Config-Meta` 长度/字符集校验 + 审计
- `config.rs` / `confedit.rs`：`config_max_mb`、`config_versions` + provenance
- `admin.rs` + `server/admin/*`：配置备份页（只读 + 删除）
- `server/README.md`（API 一节 + 磁盘布局一节）、`server/DEPLOY.md`（新配置项）
- 验收：`cargo fmt` / `clippy` / `test`，curl 跑一遍七条路由

### PR-2 · 信封 + `configTransfer` 拆分（纯前端，无 UI）
- 抽 `buildConfigBundle` / `parseConfigBundle`，两个对话框函数改成壳
- `lib/configsync/envelope.ts` + vitest：加密往返、不加密往返、错密码报错、篡改一个字节报错、`hasKeys && !password` 抛错、旧迭代次数的包仍能开
- **本片第一件事是验证 WebCrypto 在 Tauri webview 里可用**（见 §8 风险 1），不可用就整个方案要换实现层
- 验收：`pnpm tsc --noEmit`、`pnpm test`

### PR-3 · 客户端接线 + 设置页重构 + 改名
- `lib/configsync/client.ts` / `run.ts`、`stores/configSyncStore.ts`
- `SyncPane` 三节重构、「配置备份」从 `GeneralPane` 搬入、上传/恢复交互、i18n（zh + en）
- 验收：真机跑一遍两台设备的推/拉，含错密码、412 冲突、不加密档

### PR-4 · 文档收尾
- 本文状态改 `shipped`，`docs/README.md` 索引加一行
- `CLAUDE.md` 里 `server/` 那段和 `src/lib/` 清单补上 `configsync/`

---

## 8. 风险与待验证

1. **WebCrypto 在 Tauri webview 里是否可用。** `crypto.subtle` 只在安全上下文里存在。Windows 上 WebView2 的源是 `http://tauri.localhost`，按规范 `*.localhost` 属于可信源，Chromium 应当判为安全上下文——但这是**推断，不是实测**。PR-2 的第一个提交就该是一行 `console.log(!!crypto.subtle)` 在真机上跑一次。不可用的话，退路是把封/开挪到 Rust（`src-tauri` 已经有 sha2 依赖链，加 `aes-gcm` + `pbkdf2` 两个 crate），信封格式不变。
2. **310 000 次 PBKDF2 在 webview 里要多久。** 目标是 ≤ 500 ms；实测超了就下调到 210 000 并在信封里记实际值（格式已经为此留了字段）。不要为了快而换成迭代次数写死在代码里的实现。
3. **两台设备推同一个档。** 靠 412 兜住，但 UI 要给出「刷新后再推」的明确出路，而不是把 412 直接当红字错误抛出来。
4. **`app:kbServerUrl` 会跟着配置包旅行**（它不在 `MACHINE_LOCAL_PREF_KEYS` 里）。这是好事——新机器恢复完配置就已经知道服务器在哪，只差一个 token。但要在文案里说清楚 **token 不会旅行**，否则作者会以为恢复完就能直接同步。
5. **`counts` 是自报字段。** 见 §3。确认文案必须用解密后的真实解析结果。
6. **忘记密码没有任何补救。** 不是 bug，是 ③。UI 上要在设密码那一刻就说，不是在恢复失败时才说。
