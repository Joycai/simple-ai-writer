# 集中式(远程)知识库可行性分析

> **状态:可行性论证,未实现。** 本文只回答「能不能做、卡在哪、按什么顺序做」,
> 不是落地方案 —— 真要动手时,按 §7 的分期各写一份 `*-plan.md`。
>
> 日期:2026-08-19 · 基于当前 `main` 分支代码阅读
> (`lib/lore/*` · `lib/context/loreSelect.ts` · `lib/agent/writeTools.ts` ·
> `stores/loreStore.ts` · `lib/fs/fileio.ts` · `src-tauri/src/scope.rs`)

## 0. 结论先说

**可行,而且比预期容易 —— 但工作量的重心不在服务端。**

服务端本身是一个平淡的 CRUD + 全文检索服务(P0/P1 合计约 1000~1500 行),
真正的成本在客户端:整个 app 里,「知识库条目」的**身份就是它在磁盘上的绝对路径**
(`LoreEntity.dirPath`,全库 132 处引用)。要接远程库,必须先把
「条目 = 磁盘目录」这个假设从**读写两条路径上**拆掉,换成一层可分派的仓储抽象。

好消息是这层拆解的**范围是可枚举的**(§3 给出了完整清单,约 20 个直接文件调用点),
而且注入、引用解析、导航三条最复杂的链路**都不需要改算法**,只需要换掉两个读函数。

坏消息是有一条容易被漏掉的安全退化:agent 的 L1 自动写工具靠「写前自动备份」当安全阀,
而这个备份在远程路径上会**静默失效**(§5.4)。这条不处理,远程知识库上线当天
就等于把 agent 的写保护关了。

需要用户先拍板的两个问题在 §8。

---

## 1. 现状:知识库到底是什么

| 维度 | 现状 |
|---|---|
| 真相来源 | `.ai-writer/lore/<category>/<entity>/` 目录树,**纯文件,无数据库副本** |
| 数据库 | 无。`project.db` 里曾有 `lore_entities`(带 `embedding_status`),已作为死表在 `project.ts` 的 `DEAD_PROJECT_TABLES` 里删除 |
| 条目 | 目录 = 一个条目;`index.md` 的 frontmatter 提供 `name`/`aliases`/`summary` |
| 特征(facet) | 同目录下带 `facet:` frontmatter 的普通 `.md`;`keys`/`group`/`priority`/`mode` 控制激活 |
| 图片 | 目录内的 `avatar.*` + `images.md` 描述的图库,渲染时读成 base64 data URL |
| 索引 | `scanLore(projectPath)` 全量扫盘 → `LoreIndex = {[category]: LoreEntity[]}`,存在 `loreStore.index` |
| 注入 | `selectLore()` 三层预算(summary / index.md 正文 / facet),**每次调用都重新读盘取正文**,以保证手改不被缓存成陈旧内容 |
| 检索 | 无索引、无向量。就是对 `name` + `aliases` 做**大小写无关子串包含**(`lower.includes(term)`,CJK 友好) |

这张表有两条直接决定可行性的结论:

1. **没有本地数据库要同步。** 不存在「SQLite 索引 ↔ 文件树」的一致性问题,
   远程化只需要接管「一棵目录树」,不需要接管两份状态。
2. **命中是纯文本子串匹配,不是语义检索。** 所以「搜索/命中」这件事
   **不需要服务端算力** —— 只要客户端手上有全量的 `name`/`aliases`/facet `keys`,
   匹配就能完全在本地跑,和现在一模一样。这个观察是 §4 缓存策略的地基。

## 2. 已经现成、可以直接复用的东西

接远程库这件事,这个代码库里已经躺着不少半成品:

- **`lib/http.ts`** —— 走 Tauri `reqwest` 的 fetch,天然绕开 webview CORS,
  已经在处理 Origin 覆写和本地地址判定。连自建服务端可以直接用,一行不用改。
- **`lib/keyStore.ts`** —— OS keyring(Keychain / Credential Manager / Secret Service),
  凭证的现成归宿。只需把 key 的命名空间从 `apikey:<providerId>` 扩到
  `kb:<sourceId>`,并复用它已经写好的 `KeyringError`「keyring 坏了 ≠ 没配置」的区分。
- **`lib/lore/transfer.ts`** —— 已有 `manifest.json` + `lore/<cat>/<id>/…` 的 zip bundle
  格式,以及 `overwrite`/`skip`/`keepBoth` 三种冲突策略。这就是现成的
  **首次导入 / 全量推送**载荷,服务端的存储布局照抄它即可。
- **`lib/agent/registry.ts` 的 lore 工具契约** —— `list_lore_entities` /
  `read_lore_entity` / `create_lore_entity` / `update_lore_file` /
  `update_lore_meta` / `append_lore_file` / `edit_lore_file` /
  `move_lore_entity` / `delete_lore_entity`。这已经是一套设计过的 CRUD 面,
  **服务端 REST API 几乎可以 1:1 照抄**,连语义都不用重新想。
- **`scanLore` 的孤儿分类逻辑** —— 「分类目录存在但没有能力包声明它」时,
  条目降级为可读可注入、但不可新建。远程库带来本地没启用的分类时,
  需要的正是这套语义,**不用新设计**。

## 3. 核心障碍:`dirPath` 是身份证

`LoreEntity.dirPath` 是绝对路径,而它同时被当作**主键**用:

- pin 以 `"<dirPath>"` 或 `"<dirPath>#<facetFile>"` 字符串持久化(`prefs` 的 `ai:pinnedLore:<项目路径>`)
- `loreStore.detailPath` / 导航历史(`navStore`)记录的是 dirPath
- `citations.ts` 的第三条兜底解析规则是 dirPath 的 `category/id` 尾巴
- agent 工具、备份、图库、注入,全部靠 `` `${dirPath}/${file}` `` 拼路径直接读写

**需要改造的直接文件调用点(已枚举完毕,共 ~20 处 + agent 侧 29 处引用):**

| 文件 | 性质 |
|---|---|
| `lib/lore/entity.ts` | 扫描/创建/改名/搬迁/facet 读写 —— 8 处,**主战场** |
| `lib/context/loreSelect.ts:371,381` | 注入取正文 —— **只有 2 处,且是整条注入链路的唯一读盘点** |
| `lib/lore/gallery.ts` | 图库 + avatar 二进制 —— 6 处 |
| `lib/agent/writeTools.ts` | agent 写工具 —— 引用 `dirPath` 29 处 |
| `components/lore/{LoreDetail,LoreSplitModal,LoreGenerator}.tsx`、`ai/LoreImageGenModal.tsx` | 组件直接调 fs —— 4 处 |

**建议的拆法:保留 `dirPath` 这个字段名,但把它降级为不透明句柄。**

```
本地: /Users/x/proj/.ai-writer/lore/characters/alice      (原样,零迁移)
远程: kb://<sourceId>/characters/alice
```

新增 `lib/lore/repo.ts` 作为唯一分派层,把上面所有调用点收口成 6~8 个函数
(`readEntryFile` / `writeEntryFile` / `readEntryBinary` / `writeEntryBinary` /
`removeEntryFile` / `entryFileExists` / `createEntry` / `moveEntry`),
按 `dirPath` 前缀分派到本地 fs 或远程 HTTP。

**为什么不新开一根 `source` 字段而是复用 `dirPath`:** 因为 pin 字符串、导航历史、
citation 解析这三处**已经落盘的历史数据**都是路径形状的。换字段等于要写迁移;
换前缀不用 —— 老数据天然全是本地路径。这和 `lore-entry-type-plan.md` 里
「不新开一根 `type` 轴」是同一个判断。

### 3.1 意外之喜:「关闭远程库」这件事,现有代码已经天然安全

关掉远程源 = 索引里那批 `kb://` 条目消失。三个会踩到悬空路径的地方**都已经写对了**:

- `selectLore` 明确跳过 stale pin(包括 facet 指向的文件已不存在的情况),不会退化成隐形的整条目 pin
- `citations.ts` 解析不到就标 `data-missing`,不跳转
- `loreStore.detailPath` 注释写明「解析不到就渲染网格」

也就是说 **§0 需求里的「可以屏蔽远程知识库」几乎是免费的** ——
只要开关只影响「合并进 index 与否」,不去清理 pin(清理才是 bug:
远程库重新连上时 pin 应该复活)。

## 4. 注入路径:唯一的性能陷阱,以及它的解法

`selectLore` 的设计前提是**读盘几乎免费**:每次调用都重新读实体正文和每个候选
facet 的正文(为了不把作者的手改缓存成陈旧内容)。一次续写命中 5 个实体 × 3 个 facet
= 20 次文件读 —— 本地无所谓,**远程就是 20 次 HTTP 往返,一次续写卡两秒**。

这是整个方案里最容易做错的地方。但因为 §1 的第二条结论(匹配是纯本地子串比较),
有一个干净的解法:

> **把「匹配」留在本地,只把「取正文」搬到远程,并且批量取。**

- 连接时拉一次**全量元数据**:每个条目的 `name` / `aliases` / `summary` /
  `category` / facet 的 `title`/`slot`/`keys`/`group`/`priority`/`mode`/`charCount`。
  这正好是 `LoreEntity` 减去正文 —— 几千条目也就几十 KB,一次拉完常驻内存。
- `selectLore` 的三层预算算法**一行不用改**:它只读 `entity.name`/`aliases`/
  `facet.keys` 做匹配,读正文只发生在最后两个函数里。
- 那两个函数换成走 `repo`,并加一个**批量端点** `POST /entries:fetch`
  (一次请求取回本轮选中的全部正文)+ ETag 本地缓存。20 次往返变 1 次。

元数据的新鲜度用一个 `GET /index?since=<version>` 的增量拉取维持,
比每次注入都回源便宜几个数量级。

## 5. 风险清单(按严重性排序)

### 5.1 同步语义 —— 建议 v1 直接回避

facet 是文件、元数据在 frontmatter 里,冲突不是行级 diff 能解决的
(两个人同时改 `aliases`,merge 出来是坏 YAML)。

**建议:v1 不做双向同步。远程为唯一权威,本地只做只读缓存,写入直接打 API,
用乐观锁(`If-Match: <version>`)防覆盖。** 双向同步留给 v2,而且到那时
更可能的答案是「服务端就用 git 裸仓库」(见 §6)而不是自己写 merge。

### 5.2 本地库 + 远程库合并成一个 `LoreIndex`

结构上很容易(`{[category]: LoreEntity[]}` 直接 concat),但有三个语义问题:

- **同名实体**:本地和远程都有「爱丽丝」→ auto-match 会两个都注入,
  citation 解析会随机命中一个。**建议:本地优先,远程重名的在墙上打冲突标记。**
- **分类 id 撞车**:远程的 `characters` 和本地的 `characters` 是不是同一个?
  **建议:是,直接合并** —— 分类只是个文件夹名,合并才符合作者直觉。
- 需要在 `LoreEntity` 上加 `origin: "local" | <sourceId>`,供 UI 打标、
  写工具决定走哪条路径、以及作者一眼看出这条是不是团队共享的。

### 5.3 离线

桌面写作应用,断网必须能继续写。→ **本地缓存必须是持久的**,
落在 `.ai-writer/remote-cache/<sourceId>/`,形状和本地 lore 树完全一样
(这样离线时 `repo` 的远程分支可以直接降级成读这棵树,零特判)。
离线期间的写入排队,重连后按乐观锁重放,冲突交给作者裁决。

### 5.4 ⚠️ agent 写保护会静默失效 —— 必须显式处理

这是代码阅读里最值得单独拎出来的一条。

`docs/unified-agent-plan.md` §3.2 的分级写策略是:L1(lore/memory)**不需要作者确认、
自动落盘**,安全阀是 `lib/agent/backup.ts` 的「写前自动快照到 `.ai-writer/backups/`」。
而 `backupFile()` 的第一行是:

```ts
if (!(await fileExists(absPath))) return null;   // 不存在 = 新建文件,无需备份
```

远程条目的 `dirPath` 在本地磁盘上**不存在**,于是 `fileExists` 返回 false,
`backupFile` 返回 `null` —— **不报错、不阻断,写照常进行**。
结果:agent 对远程知识库的所有自动写入,都没有任何可回滚的快照。
而 lore 写工具的注释明确要求「备份失败必须当作写入失败,绝不能照写」。

**必须二选一(或都做):**
- 服务端为每次写入保存版本历史(git 后端天然满足);
- `repo` 的远程写分支在提交前**先把旧内容拉下来写进本地 `backups/`**,拉不到就拒绝写。

顺带:`propose_lore_plan` 的计划审批闸门是纯客户端逻辑,远程化不影响它 —— 这条是安全的。

### 5.5 安全边界

`src-tauri/src/scope.rs` 的 `FsScope` 只约束本地路径。`kb://` 路径完全绕开它,
需要在 `repo` 的远程分支自建校验:`sourceId` 必须在已注册白名单里,
`category`/`entityId`/文件名各段用现成的 `CATEGORY_ID_RE` 和
`checkEntityFilename`/`checkFacetFilename` 校验,防止服务端返回
`../../` 这类段被拼进本地缓存路径造成穿越写。

### 5.6 图片

avatar / 图库走二进制 + base64 data URL。远程需要独立的 blob 端点 + 强缓存
(按内容哈希做 URL,永久缓存),否则每次打开知识库墙都会重新拉一遍全部头像。
这条不难,但别忘了排进 P2。

## 6. 服务端形态建议

| 决策 | 建议 | 理由 |
|---|---|---|
| 存储 | **git 裸仓库**,或 SQLite(元数据/FTS)+ 文件树(正文) | 内容本来就是 markdown。git 白送版本历史、回滚、冲突检测和 §5.4 要的写前快照。自己写这些不划算 |
| API | REST,约 8 个端点 | 见下 |
| 检索 | v1:SQLite FTS5 + name/alias 精确匹配即可 | 客户端的命中是子串匹配,不需要语义检索。向量检索是 v2,且 `lore-granularity-research.md` 已把「向量兜底」列为未实现方向 |
| 认证 | Bearer token,存 OS keyring | 复用 `keyStore` |
| 并发 | 每条目版本号 + `If-Match` 乐观锁 | 比行锁简单,对写入稀疏的知识库够用 |

端点(直接照 agent 工具契约来):

```
GET    /v1/index?since=<version>     元数据全量/增量(§4 的地基)
POST   /v1/entries:fetch             批量取正文(注入路径唯一的热点)
GET    /v1/entries/{cat}/{id}        单条目全文 + facet 列表
POST   /v1/entries                   新建
PATCH  /v1/entries/{cat}/{id}        改元数据 / 单文件(If-Match)
DELETE /v1/entries/{cat}/{id}
POST   /v1/entries/{cat}/{id}/move   改名/换分类
GET    /v1/search?q=                 服务端检索(v1 可选)
GET    /v1/blobs/{hash}              图片
```

## 7. 分期建议

**P0 —— 远程只读(拿到 ~90% 的价值,几乎不碰写路径)**
连接配置 + 凭证 + `repo` 抽象层 + 元数据拉取 + 批量取正文 + 合并进 `LoreIndex`
+ UI 打 origin 标 + 总开关。写路径全部对远程条目禁用(工具直接返回「该条目只读」)。
客户端约 800~1200 行,服务端约 600 行。

**P1 —— 远程写**
乐观锁 + §5.4 的备份补救 + agent 工具放开 + 手工编辑放开 + 冲突提示 UI。
客户端约 500~800 行,服务端约 400 行。

**P2 —— 打磨**
持久离线缓存与写入队列、图片 blob、服务端检索、多人协作(锁或 CRDT)。

## 8. 需要你先拍板的两件事

这两个答案会实质改变 P0 的设计,建议动手前定下来:

1. **场景是「一个人多设备」还是「一个团队共享」?**
   前者可以放心用「远程为权威 + 乐观锁」,冲突基本不会发生;
   后者需要认真做条目锁 / 冲突 UI,P1 的成本会翻倍。
2. **远程库是**「唯一权威、本地只缓存」**,还是**「本地和远程都能独立编辑、事后合并」**?**
   本文的所有建议都基于前者。选后者的话,§5.1 说的 merge 问题会成为整个项目
   最大的一块,那时应该直接把服务端做成 git,让 git 去解决。
