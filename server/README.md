# aiw-kb-server — 知识库备份 / 同步服务端

Simple AI Writer 的**知识库备份服务器**。托管若干个**有名字的知识库**;
app 把一个项目绑定到其中一个,然后把本地 `.ai-writer/lore/` **整体推上去**
或**整体拉下来** —— 单向覆盖,不做合并。

它同时存放**应用配置备份**:app 的供应商 / 模型 / Prompt / 偏好打成一个包
推上来,换一台设备再拉下去。带 API Key 的包**在作者的机器上就已经加密**,
密码这台服务器从来没见过、也没有任何办法找回 —— 它存的是一段自己读不懂的字节。
见下面的 [应用配置备份](#应用配置备份)。

它自带一个**管理后台**(`/admin`):知识库与条目、配置备份、同步 token、
活动日志、磁盘与备份、配置编辑,以及一份对着 `DEPLOY.md` §9 的健康自检。
见下面的 [管理后台](#管理后台)。

设计与取舍见 [`../docs/feature/knowledge-base/remote-knowledge-base-feasibility.md`](../docs/feature/knowledge-base/remote-knowledge-base-feasibility.md) §13–§18,
管理后台自己的取舍见 [`../docs/feature/knowledge-base/kb-admin-console.md`](../docs/feature/knowledge-base/kb-admin-console.md)。
**部署、生成密钥、systemd / Docker / 反向代理、轮换与排错见
[`DEPLOY.md`](DEPLOY.md)** —— 这里只讲它是什么和 API 长什么样。

## 它故意不做的事

- **不理解 markdown。** 一个条目就是一个 zip,服务端不解析 frontmatter、
  不知道 facet 是什么。所以 app 的知识库格式怎么演进,这个二进制都不用跟。
- **不算 diff。** 它只提供 manifest(每个条目的 hash)并执行客户端决定的
  单个写操作。「本地 × 远端 × 上次同步快照」的三方比较发生在 app 里 ——
  只有 app 知道作者上次同意过什么。
- **不算条目的 hash。** 它由客户端对**条目目录的内容**计算(§15),而那个值无法
  从上传的 zip 里还原(zip 字节含压缩选项和时间戳,同样内容每次都不同)。
  服务端把它当作不透明令牌:校验形状,原样存储。
  (配置备份是**例外**,那里的 hash 由服务端自己算 —— 见 [应用配置备份](#应用配置备份)。)
- **不解密,也没有能力解密。** 配置备份的信封是在作者机器上封的,密钥由作者的
  密码派生,从不上网。这里既没有密码,也没有任何一行试图解析信封的代码。

## 运行

```bash
cd server
cargo build --release
./target/release/aiw-kb-server
```

**第一次启动会自己生成配置文件**,并把生成的后台密码和同步 token 打在终端里:

```text
┌──────────────────────────────────────────────────────────────
│ 已生成配置文件:/etc/aiw-kb/config.toml
│
│ 管理后台   http://127.0.0.1:8787/admin
│ 用户名     admin
│ 密码       cUv7scHwxC9R8TrY
│
│ app 里填的同步 token:
│ aiw_c697ac51c2c851db787bca02df9c610474cb957033c63d8f
└──────────────────────────────────────────────────────────────
```

生成一份带随机密钥的配置,而不是打印一条「请先配置 token」再退出:后者在一台
没有开着终端的机器上(NAS、双击运行的 Windows)等于死路。它**仍然是 fail-closed**
—— 服务端从不在没有凭据的情况下起来,只是凭据由它自己生成。

完整流程(交叉编译、systemd 单元、Docker、TLS、token 轮换)见
[`DEPLOY.md`](DEPLOY.md)。

### 配置(一个 TOML 文件,环境变量可覆盖)

优先级:**内置默认值 < 配置文件 < 环境变量**。

配置文件的查找顺序:`--config <路径>` > `AIW_KB_CONFIG` > 可执行文件同目录的
`aiw-kb.toml` > 系统配置目录(Windows `%APPDATA%\aiw-kb\config.toml` ·
Linux `/etc/aiw-kb/config.toml`,不存在则 `~/.config/aiw-kb/config.toml` ·
macOS `~/Library/Application Support/aiw-kb/config.toml`)。

```toml
[server]
bind            = "127.0.0.1:8787"   # 默认只听回环
data_dir        = "./data"
max_entry_mb    = 64                 # 单条目请求体上限(条目含配图),1–1024
config_max_mb   = 4                  # 单个配置备份请求体上限,1–64
config_versions = 10                 # 每个配置备份档保留几个历史版本,1–100
allow_anonymous = false              # true = 关闭同步 API 鉴权,仅本机试跑
log             = "aiw_kb_server=info,tower_http=info"

[admin]                              # 管理后台的账号;没有这一段则后台是关着的
username        = "admin"
password        = "…"                # 明文,见下
session_hours   = 168

[[tokens]]                           # 同步 API 的 bearer token,app 里填的就是它
name            = "书房 iMac"
value           = "aiw_…"
created_at_ms   = 1787191234718
```

对应的环境变量(设置了就**覆盖**文件里的值,后台会把这一项标成锁定):
`AIW_KB_BIND` · `AIW_KB_DATA_DIR` · `AIW_KB_MAX_ENTRY_MB` ·
`AIW_KB_CONFIG_MAX_MB` · `AIW_KB_CONFIG_VERSIONS` ·
`AIW_KB_ALLOW_ANONYMOUS` · `RUST_LOG` · `AIW_KB_TOKENS`(逗号分隔) ·
`AIW_KB_ADMIN_USER` / `AIW_KB_ADMIN_PASSWORD`。

**为什么从「只有环境变量」改成「文件为主」:** 原来的注释说「每种部署方式都会说
环境变量」,那对 systemd 和 docker 成立,对真正需要这个后台的那种人不成立 ——
在自己机器上双击运行的 Windows 用户,设六个环境变量是一趟对话框旅行,而且忘了就没了。
环境变量保留下来,是因为容器化部署里它仍然是最顺手的临时覆盖手段。

**密码是明文的**,和同一个文件里的 token 一样。这不是疏忽:token 必须能和客户端
递过来的值逐字节比对,所以它一定是明文;而如果密码要哈希,想手工设密码的人就得先
跑一个子命令去算哈希 —— 又把这个功能想消灭的命令行请了回来。保护它的是**文件权限**
(新建时会 `chmod 600`,后台的健康自检会检查),不是加密。

**没有任何 token 时服务端拒绝启动**,除非配置里写了 `allow_anonymous = true`。
这是故意的:一个「没鉴权也照常启动」的默认值,迟早会出现在公网 IP 上。

生产部署建议放在反向代理后面并启用 TLS —— 这个进程不做 TLS 终结。

## API

所有 `/v1/*` 需要 `Authorization: Bearer <token>`;`/health` 不需要。
错误统一为 `{"code": "...", "message": "..."}`,`code` 是稳定的那一半。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 存活探针 |
| `GET` | `/v1/kbs` | 列出知识库 |
| `POST` | `/v1/kbs` | 新建:`{"name": "我的武侠世界", "id": "可选"}` |
| `GET` | `/v1/kbs/{kb}/manifest` | 每个条目的 hash —— 同步计划的输入 |
| `GET` | `/v1/kbs/{kb}/entries/{category}/{id}` | 下载条目 zip |
| `PUT` | `/v1/kbs/{kb}/entries/{category}/{id}` | 上传条目 zip |
| `DELETE` | `/v1/kbs/{kb}/entries/{category}/{id}` | 删除(镜像语义) |
| `GET` | `/v1/configs` | 列出应用配置备份档 |
| `POST` | `/v1/configs` | 新建:`{"name": "书房台式机", "id": "可选"}` |
| `GET` | `/v1/configs/{slot}` | 下载当前版本 |
| `PUT` | `/v1/configs/{slot}` | 上传新版本 |
| `DELETE` | `/v1/configs/{slot}` | 删除整个档(含全部历史) |
| `GET` | `/v1/configs/{slot}/versions` | 列出保留的历史版本 |
| `GET` | `/v1/configs/{slot}/versions/{atMs}` | 下载其中一个 |

### manifest

```json
{
  "kb": {
    "id": "my-wuxia-world", "name": "我的武侠世界", "createdAtMs": 1787191234718,
    "entryCount": 1, "updatedAtMs": 1787191247004, "lastDevice": "MacBook-Pro"
  },
  "digest": "990a0206…",
  "entries": [
    { "path": "characters/爱丽丝", "hash": "fe25ec9d…", "size": 15, "updatedAtMs": 1787191247004 }
  ]
}
```

- `digest` 是所有 `path`+`hash` 排序后的 sha256:一个值就能回答「整个库有没有变」,
  不用逐条比。
- `updatedAtMs` 来自文件 mtime,**仅供显示**。同步判断一律看 hash(§14.2):
  mtime 会被复制数据目录、恢复备份、解压归档重置,拿它做判断会在任何一次
  搬迁之后报告「所有条目都变了」。
- `entryCount` / `updatedAtMs` 是**读时现算**的(遍历 `entries/`),不是维护出来的
  计数器 —— 和 manifest 一样,不给「记的数」和「实际有的」留下分歧的可能。
  `lastDevice` 是唯一算不出来的那个,见下。

### 谁写的:`X-Source-Device`

写操作(`PUT` / `DELETE`)可以带一个 `X-Source-Device` 头,内容是客户端
**自己报的机器名**(app 用主机名)。服务端把它记在 `<kb>/last-write.json`,
并在知识库列表里回显成「来自 MacBook-Pro」,好让作者在几个知识库之间认出
哪个是自己一直在写的那个。

它是**纯标签**:没有任何鉴权或授权看它,值非法就丢弃而不是拒绝请求 ——
为一个装饰性的头失败掉一次已经落盘的上传,是永远划不来的交易。不带这个头
的客户端不会把别人记下的名字抹掉:「未知」不是一个关于谁写过的断言。

单独存一个文件而不是塞进 `meta.json`:后者创建时写一次、列表时每次读,
把它变成每次上传都要改的东西等于在热路径上加一次读-改-写,而换来的只是
一行装饰。

### 写入的前置条件(重要)

每个写操作都应该带前置条件:

- `If-None-Match: *` —— 仅当条目不存在时创建
- `If-Match: "<hash>"` —— 仅当当前 hash 等于该值时替换 / 删除

客户端拿到 manifest 到真正写入之间可能已经过去几分钟。没有这两个头,
另一台机器在这段时间里推上来的工作会被静默覆盖 —— 正是客户端那道安全网
要防的事,在下一层重新发生一遍。

不满足时返回 `412` 并带上**当前实际的 hash**,客户端不用再多一次往返就能重新规划:

```json
{ "code": "precondition_failed", "currentHash": "fe25ec9d…", "message": "…" }
```

两个头都不带会被接受(有些流程确实就是「强制覆盖」),所以这条保证是**客户端的责任**。

### 上传

```bash
HASH=$(compute_entry_hash …)          # 客户端对条目目录内容算的 hash
curl -X PUT "$SERVER/v1/kbs/my-kb/entries/characters/爱丽丝" \
     -H "Authorization: Bearer $TOKEN" \
     -H "X-Entry-Hash: $HASH" \
     -H 'If-None-Match: *' \
     --data-binary @entry.zip
```

`X-Entry-Hash` 必填。返回 `201`(新建)或 `204`(替换)。
下载时同一个值同时出现在 `X-Entry-Hash` 和标准的 `ETag` 头里。

## 应用配置备份

app 的**装机级配置** —— 供应商、模型、Prompt 模板、可迁移偏好,以及(可选的)
API Key —— 打成一个包推上来,另一台设备拉下去合并。和知识库是**两个互不相干的资源**,
只是共用一台服务器、一批 token 和一个数据目录。

### 服务端读不懂它,这是设计

上传的字节是一个**信封**:明文头部(设备名、app 版本、条目数、是否加密)加一段载荷。
服务端**不解析信封**,只把客户端随 `X-Config-Meta` 头递过来的那串 base64url
原样存下、原样发回。信封格式往前走多少版,这个二进制都不用跟 —— 和「不解析
markdown」是同一条规矩。

**带 API Key 的包必须加密**,这条约束在客户端:密钥由作者的密码经 PBKDF2 派生,
AES-GCM 加密,全过程在作者的机器上。这台服务器没有密码、没有解密代码,
也没有任何找回路径 —— 作者忘了密码,那个备份就作废了,只能重推一份。

### hash 由服务端算,和条目相反

条目的 hash 必须客户端给,因为它算的是**目录内容**,从 zip 字节里还原不出来。
配置包没有这个问题:上传的就是客户端自己拼好的那串字节,服务端 `sha256` 一遍
必然得到同一个值。所以这里服务端自己算,写进文件名,用 `ETag` / `X-Config-Hash`
发回 —— 少一个可被伪造的输入。

### 版本历史

每次上传都是一个新版本,按 `atMs` 定址,保留最近 `config_versions` 个(默认 10),
旧版本在新版本**落盘之后**才裁掉。一次导入把配置搞乱了,还有路可退。

### 上传

```bash
curl -X PUT "$SERVER/v1/configs/study-desktop" \
     -H "Authorization: Bearer $TOKEN" \
     -H "X-Config-Meta: $(base64url_of_envelope_header)" \
     -H "X-Source-Device: REINE-DESKTOP" \
     -H 'If-Match: "<上一版的 hash>"' \
     --data-binary @envelope.json
```

返回 `201`(首次)或 `204`(替换)。`If-Match` / `If-None-Match` 与条目那边同义:
两台设备同时推同一个档,后到的拿 `412`,响应体里带着服务器**实际**存着的 hash。
没有它,A 机器的配置会被 B 机器悄悄盖掉。

`X-Config-Meta` 可选,上限 4 KiB,只接受 base64url —— 它会被放进响应头,而响应头
装不了任意字节。

## 管理后台

`http://<监听地址>/admin`。一个编译进二进制的自包含页面 —— 没有 npm、没有打包器、
没有会和源码对不上的 `dist/`,`cargo build` 就是全部构建。

它做的事,就是 `DEPLOY.md` 里那些「ssh 上去敲一行」的步骤:

| 页面 | 做什么 |
|---|---|
| 总览 | 运行状态、条目/占用统计、最近活动、需要注意的事(每条都带一个能按的按钮) |
| 知识库 | 列表 / 新建 / 重命名 / 删除;进去是 manifest 浏览器(按分类分组、按 path 搜索、下载或删除条目、整库 tar.gz) |
| 配置备份 | 每个档的版本、大小、来自哪台设备、加没加密;可以改名、删版本、删整个档。**故意没有下载** |
| Token | 新建 / 改名 / 吊销,以及「最后使用」—— 轮换时用来确认旧 token 真的没人用了 |
| 活动日志 | 谁、什么时候、写了哪个条目、结果如何。**412 那一行自己会解释自己** |
| 维护与备份 | 磁盘占用、整库备份下载、清 `tmp/` 残留、清重复 zip、健康自检(§9 上线清单) |
| 配置 | 直接改配置文件,每一项标出它来自默认值 / 配置文件 / 环境变量 |

### 两套鉴权,不要混

|  | 谁在用 | 凭据 | 范围 |
|---|---|---|---|
| **同步 API** | 桌面 app | bearer token(`[[tokens]]`) | `/v1/*`,读写知识库 |
| **管理后台** | 操作者本人(浏览器) | 用户名 + 密码(`[admin]`) | `/admin`,看和改这台服务器 |

同步 token **不能**登录后台;后台的会话 cookie **不能**调 `/v1`。把两者合并,
等于让每一台装了 app 的笔记本都握着一个能删光服务器的凭据。

唯一的例外是 `allow_anonymous`,它同时关掉两边 —— 那是「我在自己机器上跑跑看」
的开关,在一栋没有墙的房子上锁一扇门没有意义。这种模式下后台不会直接进去,
而是先给一张红色警告卡,要点一下才进。

密码可以被猜,32 字节的随机 token 不能,所以后台(而不是 `/v1`)有**失败限速**:
连续 5 次失败锁 5 分钟。会话只在内存里,重启即失效 —— 一次重启通常正意味着
配置(可能就是密码)刚被改过。

### 后台自己的 API

`/admin/api/*`,全部要求会话 cookie(匿名模式除外)。它**不复用 `/v1`**:
后台的每个动作都带着「是一个人在按按钮」的语义(删除不带前置条件、批量删除
只报告失败的那几条、下载带 `Content-Disposition`),而 `/v1` 的每个动作都带着
「是一次同步」的语义。让它们共用一条路径,两边都会被对方的需求扭曲。

配置写回走 `toml_edit`,**保留操作者手写的注释和排版**:一个配置文件的注释是
它的理由所在,一个保存一次就把注释吃掉的后台,没人会再手工编辑那个文件第二次。

## 磁盘布局

```text
<data>/kbs/<kb-id>/meta.json                            { id, name, createdAtMs }
<data>/kbs/<kb-id>/last-write.json                      { device, atMs } · 仅用于显示
<data>/kbs/<kb-id>/entries/<category>/<id>.<hash>.zip   条目载荷
<data>/kbs/<kb-id>/tmp/                                 提交前的暂存
<data>/configs/<slot>/meta.json                         { id, name, createdAtMs }
<data>/configs/<slot>/versions/<atMs>.<hash>.bin        配置信封
<data>/configs/<slot>/versions/<atMs>.<hash>.meta       该版本的展示元数据 · 仅用于显示
<data>/configs/tmp/                                     提交前的暂存
<data>/audit.log                                        活动日志(JSONL,8 MB 轮转)
```

**hash 写在文件名里,而不是放在 sidecar 文件中。** 这样一次写入的提交就是
一个 `rename`,载荷和描述它的 hash 永远不可能对不上。sidecar 需要两次 rename,
中间那个窗口里记录的 hash 描述的是另一个版本的字节 —— 而这恰好是客户端那道
三方安全网**检测不到**的失败,因为它信任 hash 能描述内容。

**没有索引文件,manifest 靠遍历 `entries/` 现算。** 索引是真相的第二份副本,
它引入的失效模式(索引说一套、blob 是另一套)客户端同样看不见。遍历几千个
小目录项是个位数毫秒,用它换「不可能发生分歧」很划算。

**`configs/` 里的 `.meta` 侧车是这条规矩的一次破例,而它站得住脚。**
`entries/` 那边禁止侧车,是因为侧车装的是 **hash**:它和载荷对不上时,客户端那道
三方安全网看不出来。这里的侧车装的是设备名和 app 版本 —— 列表上的一行装饰,丢了
最坏就是少显示一句话,和已经存在的 `last-write.json` 是同一档次。它在载荷提交
**之前**落盘,所以载荷的到达仍然是唯一的提交点,崩在中间只留下一个没人看的孤儿。

条目 id 允许是中文(app 的 `slugifyEntityId` 保留 Unicode),分类 id 必须是
ASCII slug(app 的 `CATEGORY_ID_RE`)。配置备份档的 id 与知识库同形(ASCII slug),
因为它同样要出现在 URL 里和操作者的 shell 里。校验在 `src/ids.rs`,那是这个服务端
唯一的安全边界。

`audit.log` 是这里唯一一份「不算出来的」记录,而它**故意待在真相通路之外**:
没有任何同步判断读它,`manifest` 从不看它,删掉它只损失历史。它回答的是文件系统
答不出来的那个问题 —— 「为什么这个条目不是我以为的样子」(因为 11:52 另一台机器
推了一次,你拿到 412)。在这之前,那个问题的唯一答案是 `journalctl`。

## 开发

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

| 文件 | 职责 |
|---|---|
| `src/ids.rs` | 名称校验 —— 唯一的安全边界(路径穿越、Windows 设备名、hash 形状) |
| `src/store.rs` | 文件系统存储:知识库、条目、manifest、前置条件,以及后台用的那几个扫描 |
| `src/routes.rs` | 同步 API 的 HTTP 表面 + bearer 鉴权(常数时间比较) |
| `src/config.rs` | 配置:TOML 文件 + 环境变量覆盖 + 每一项的来源;无 token 则拒绝启动 |
| `src/confedit.rs` | 把配置写回去,保留注释(`toml_edit`) |
| `src/admin.rs` | 管理后台:`/admin` 页面 + `/admin/api/*` |
| `src/session.rs` | 后台会话与失败限速 |
| `src/audit.rs` | 活动日志(JSONL + 内存环形缓冲) |
| `src/maint.rs` | 磁盘、备份打包、健康自检 |
| `src/error.rs` | 唯一的失败通路:`ApiError` → JSON |
| `admin/index.html` `admin/app.css` `admin/app.js` | 后台页面本体,`include_str!` 进二进制 |

改后台的页面只要重新 `cargo build` —— 三个文件是编译期嵌进去的,没有单独的前端构建。
