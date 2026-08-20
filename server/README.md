# aiw-kb-server — 知识库备份 / 同步服务端

Simple AI Writer 的**知识库备份服务器**。托管若干个**有名字的知识库**;
app 把一个项目绑定到其中一个,然后把本地 `.ai-writer/lore/` **整体推上去**
或**整体拉下来** —— 单向覆盖,不做合并。

设计与取舍见 [`../docs/remote-knowledge-base-feasibility.md`](../docs/remote-knowledge-base-feasibility.md) §13–§18。

> **状态:服务端已实现,客户端未接入。** 本目录可以独立编译、测试、运行,
> 但 app 里还没有连接它的 UI。

## 它故意不做的事

- **不理解 markdown。** 一个条目就是一个 zip,服务端不解析 frontmatter、
  不知道 facet 是什么。所以 app 的知识库格式怎么演进,这个二进制都不用跟。
- **不算 diff。** 它只提供 manifest(每个条目的 hash)并执行客户端决定的
  单个写操作。「本地 × 远端 × 上次同步快照」的三方比较发生在 app 里 ——
  只有 app 知道作者上次同意过什么。
- **不算 hash。** hash 由客户端对**条目目录的内容**计算(§15),而那个值无法
  从上传的 zip 里还原(zip 字节含压缩选项和时间戳,同样内容每次都不同)。
  服务端把它当作不透明令牌:校验形状,原样存储。

## 运行

```bash
cd server
cargo build --release

AIW_KB_TOKENS="$(openssl rand -hex 32)" \
AIW_KB_DATA_DIR=/var/lib/aiw-kb \
AIW_KB_BIND=127.0.0.1:8787 \
./target/release/aiw-kb-server
```

### 配置(全部走环境变量)

| 变量 | 默认 | 说明 |
|---|---|---|
| `AIW_KB_DATA_DIR` | `./data` | 数据目录 |
| `AIW_KB_BIND` | `127.0.0.1:8787` | 监听地址。默认只听回环 —— 知识库是作者自己的创作,不该因为「先跑起来看看」就上了网 |
| `AIW_KB_TOKENS` | 无 | 逗号分隔的 bearer token,每个至少 16 字符 |
| `AIW_KB_ALLOW_ANONYMOUS` | 无 | `1` = 关闭鉴权。**仅用于本机试跑** |
| `AIW_KB_MAX_ENTRY_MB` | `64` | 单条目请求体上限(条目含配图) |
| `RUST_LOG` | `aiw_kb_server=info` | 日志级别 |

**没有配置 token 时服务端会拒绝启动**,除非显式设置 `AIW_KB_ALLOW_ANONYMOUS=1`。
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

### manifest

```json
{
  "kb": { "id": "my-wuxia-world", "name": "我的武侠世界", "createdAtMs": 1787191234718 },
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

## 磁盘布局

```text
<data>/kbs/<kb-id>/meta.json                            { id, name, createdAtMs }
<data>/kbs/<kb-id>/entries/<category>/<id>.<hash>.zip   条目载荷
<data>/kbs/<kb-id>/tmp/                                 提交前的暂存
```

**hash 写在文件名里,而不是放在 sidecar 文件中。** 这样一次写入的提交就是
一个 `rename`,载荷和描述它的 hash 永远不可能对不上。sidecar 需要两次 rename,
中间那个窗口里记录的 hash 描述的是另一个版本的字节 —— 而这恰好是客户端那道
三方安全网**检测不到**的失败,因为它信任 hash 能描述内容。

**没有索引文件,manifest 靠遍历 `entries/` 现算。** 索引是真相的第二份副本,
它引入的失效模式(索引说一套、blob 是另一套)客户端同样看不见。遍历几千个
小目录项是个位数毫秒,用它换「不可能发生分歧」很划算。

条目 id 允许是中文(app 的 `slugifyEntityId` 保留 Unicode),分类 id 必须是
ASCII slug(app 的 `CATEGORY_ID_RE`)。校验在 `src/ids.rs`,那是这个服务端
唯一的安全边界。

## 开发

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

| 文件 | 职责 |
|---|---|
| `src/ids.rs` | 名称校验 —— 唯一的安全边界(路径穿越、Windows 设备名、hash 形状) |
| `src/store.rs` | 文件系统存储:知识库、条目、manifest、前置条件 |
| `src/routes.rs` | HTTP 表面 + bearer 鉴权(常数时间比较) |
| `src/config.rs` | 环境变量配置,无 token 则拒绝启动 |
| `src/error.rs` | 唯一的失败通路:`ApiError` → JSON |
