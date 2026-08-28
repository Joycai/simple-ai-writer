# aiw-kb-server 启动手册

从零把知识库备份服务器跑起来:编译 → 启动 → 验证 → 长期运行。

> **这份手册里的绝大多数运维动作,现在也能在管理后台里点。**
> 服务启动后打开 `http://<监听地址>/admin`:改配置、发/吊销 token、看谁写了什么、
> 清 `tmp/`、下载备份、跑一遍 §9 的上线自检,都在那里。
> 下面仍然保留命令行做法 —— 后台连不上的时候,你需要它。

> 这份文档只讲**怎么部署和运维**。API 细节和设计取舍见
> [`README.md`](README.md);为什么是这个形态见
> [`../docs/feature/knowledge-base/remote-knowledge-base-feasibility.md`](../docs/feature/knowledge-base/remote-knowledge-base-feasibility.md) §13–§18。

---

## 0. 先决定两件事

**放在哪?** 三种典型场景,后面的配置只有这一处不同:

| 场景 | 监听地址 | 是否需要 TLS |
|---|---|---|
| 只在本机试 | `127.0.0.1:8787`(默认) | 不需要 |
| 家里的 NAS / 小主机,只在局域网用 | `0.0.0.0:8787` | 建议要(见 §6) |
| 公网 VPS | `127.0.0.1:8787` + 反向代理 | **必须要** |

**存在哪?** 数据目录会长成你知识库的大小(条目正文 + 配图),
建议放在一个你会记得备份的分区上,例如 `/var/lib/aiw-kb`。

---

## 1. 编译

需要 Rust **稳定版**工具链(用 axum 0.8,别用太旧的版本;`rustup update stable` 即可)。没有的话:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

然后:

```bash
cd server
cargo build --release
```

产物是 `target/release/aiw-kb-server` —— **一个可执行文件**。部署时把它单独拷到
目标机器即可,不需要 Rust、不需要运行时。它动态链接 libc(所以 Docker 用
`distroless/cc` 而不是 `distroless/static`),除此之外没有外部依赖。

### 交叉编译到 NAS / 树莓派

```bash
# 先装目标工具链
rustup target add aarch64-unknown-linux-gnu
cargo build --release --target aarch64-unknown-linux-gnu
```

链接器报错的话,用 [`cross`](https://github.com/cross-rs/cross) 更省事:

```bash
cargo install cross
cross build --release --target aarch64-unknown-linux-gnu
```

---

## 2. 密钥(必读)

这台服务器上有**两种**凭据,别混:

| | 谁在用 | 配置在哪 | 能干什么 |
|---|---|---|---|
| **同步 token** | 桌面 app | `[[tokens]]` | 读写这台服务器上的**每一个**知识库 |
| **后台账号** | 你本人(浏览器) | `[admin]` | 看和改这台服务器本身 |

拿到同步 token 的人可以读写每一个知识库,所以它就是密码,按密码对待。
后台密码可以被人猜,所以后台有失败限速(连续 5 次锁 5 分钟),同步 API 没有 ——
32 字节的随机 token 猜不出来。

### 最省事的办法:让它自己生成

**第一次启动时,如果找不到配置文件,服务端会生成一份**,里面有一个随机 token
和一个随机后台密码,并把两者打印在终端上(见 §3)。绝大多数情况下这就够了,
下面的手工生成只在你想自己指定值时才需要。

### 手工生成

```bash
openssl rand -hex 32
# → 7f3c1e0a9b4d2f68a5c7e1039b8d4f62a0c3e5719d8b2f46c0a7e3915d8b4f26
```

没有 openssl 时的等价做法:

```bash
head -c 32 /dev/urandom | xxd -p -c 64          # Linux / macOS
python3 -c "import secrets; print(secrets.token_hex(32))"
```

```powershell
# Windows PowerShell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

**要求:至少 16 个字符,否则服务端拒绝启动。** 这不是形式检查 ——
一个短 token 在局域网里几分钟就能穷举完。实际请用 64 位十六进制(32 字节)。

### 配置

token 写在配置文件里,**可以配多个**:

```toml
[[tokens]]
name  = "书房 iMac"
value = "aiw_7f3c1e0a…"

[[tokens]]
name  = "MacBook-Pro"
value = "aiw_9d2b7f10…"
```

配多个的用处只有一个:**轮换而不中断**。见 §5 —— 后台的 Token 页把那四步
做成了按钮,并且用「最后使用」告诉你旧的还有没有人在用。

也可以用环境变量 `AIW_KB_TOKENS="a,b"` 覆盖整份列表。**一旦这么做,后台里的
token 列表就变成只读的** —— 因为写回文件也不会生效,后台会明说这一点,而不是
假装保存成功。

### 不要这样做

- ❌ **不要把 token 写进 shell 历史。** `AIW_KB_TOKENS=xxx ./aiw-kb-server`
  会留在 `~/.bash_history` 里。直接写配置文件,权限 `600`。
- ❌ **不要提交进 git。** 本目录的 `.gitignore` 排除了 `/data` 和
  `/aiw-kb.toml`,但配置文件放在仓库外更稳妥。
- ❌ **不要让配置文件全局可读。** 它明文存着全部 token 和后台密码。
  自动生成时是 `600`;手工创建的请自己 `chmod 600`(后台的健康自检会检查这一条)。
- ❌ **不要多台机器共用一个 token 却又想区分是谁写的。** 区分靠的是客户端
  发的 `X-Source-Device`(见 §7),不是 token。
- ❌ **不要开 `allow_anonymous` 然后监听 `0.0.0.0`。** 那等于把你的设定集
  公开可写,而且管理后台也会一并敞开。这个开关只用于本机试跑,而且它必须显式
  设置 —— 没有 token 时服务端**拒绝启动**正是为了防止这种默认。

### 客户端那一侧的密钥去哪了

app 里在 **设置 → 知识库同步** 填地址和令牌。填完点「连接」后:

- token 存进**操作系统钥匙串**(macOS Keychain / Windows 凭据管理器 /
  Linux Secret Service),按服务器地址分账户;
- **不会**写进项目文件夹,所以把项目发给别人、或用 git 同步项目,
  都不会带上 token;
- 项目里只有 `.ai-writer/sync.json`,记录「绑定了哪个服务器的哪个知识库」
  和上次同步的哈希快照 —— 没有任何密钥。

换服务器地址会用新的钥匙串账户,不会拿旧密钥去连新地址。

---

## 3. 第一次启动与验证

```bash
./aiw-kb-server --config /etc/aiw-kb/config.toml
```

没有那个文件的话,它会**先生成一份**,并把生成的密钥打印出来 ——
这是它们唯一一次出现在终端里,记下来:

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

(密码和 token 也一直躺在那个文件里,忘了可以回去看,或者在后台里改。)

然后看到这两行就算起来了:

```
INFO aiw_kb_server: listening on 127.0.0.1:8787, data in "/var/lib/aiw-kb", config /etc/aiw-kb/config.toml
INFO aiw_kb_server: admin console: http://127.0.0.1:8787/admin
```

验证四件事:

```bash
S=http://127.0.0.1:8787
T=你刚才生成的token

# 1. 活着(不需要鉴权)
curl -s $S/health                      # → ok

# 2. 鉴权真的在拦
curl -s -o /dev/null -w '%{http_code}\n' $S/v1/kbs        # → 401

# 3. 带上 token 能列(一开始是空数组)
curl -s -H "Authorization: Bearer $T" $S/v1/kbs           # → []

# 4. 能建
curl -s -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
     -d '{"name":"我的设定集"}' $S/v1/kbs
# → {"id":"kb","name":"我的设定集","createdAtMs":…,"entryCount":0,…}
```

第 2 步返回 200 而不是 401 ——说明你开了匿名访问,立刻关掉。

第 5 件事:**打开 `http://127.0.0.1:8787/admin`**,用打印出来的用户名密码登录。
上面这四条 curl,后台的「维护与备份 → 健康自检」会自己跑一遍(包括第 2 条,
它是真的发一次无凭据请求去测,不是照着代码猜)。

### 全部配置项

配置文件里的项(环境变量列同名覆盖;优先级 **默认值 < 文件 < 环境变量**):

| 配置项 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `server.data_dir` | `AIW_KB_DATA_DIR` | `./data` | 数据目录 |
| `server.bind` | `AIW_KB_BIND` | `127.0.0.1:8787` | 监听地址。默认只听回环 |
| `server.max_entry_mb` | `AIW_KB_MAX_ENTRY_MB` | `64` | 单条目请求体上限。条目含配图,图多的话调大 |
| `server.config_max_mb` | `AIW_KB_CONFIG_MAX_MB` | `4` | 单个**应用配置备份**请求体上限。一份通常只有几十 KB,不必动 |
| `server.config_versions` | `AIW_KB_CONFIG_VERSIONS` | `10` | 每个配置备份档保留几个历史版本。调小它不会立刻删东西,下次上传才裁 |
| `server.allow_anonymous` | `AIW_KB_ALLOW_ANONYMOUS` | `false` | 关闭同步 API 与后台的鉴权。**仅本机试跑** |
| `server.log` | `RUST_LOG` | `aiw_kb_server=info` | `debug` 会打印每个请求 |
| `[[tokens]]` | `AIW_KB_TOKENS`(逗号分隔) | 无 | 同步 API 的 bearer token,每个 ≥16 字符 |
| `admin.username` | `AIW_KB_ADMIN_USER` | 无 | 后台账号;整个 `[admin]` 缺失 = 后台关闭 |
| `admin.password` | `AIW_KB_ADMIN_PASSWORD` | 无 | 明文,靠文件权限保护 |
| `admin.session_hours` | — | `168` | 后台登录保持多久 |

配置文件的查找顺序:`--config <路径>` > `AIW_KB_CONFIG` > 可执行文件同目录的
`aiw-kb.toml` > 系统配置目录。后台的「配置」页会显示当前生效的是哪一个,
以及每一项到底来自默认值、文件还是环境变量 —— **被环境变量覆盖的项在后台里
是锁着的**,因为在那里改了也不会生效,而一个假装保存成功的配置页比没有配置页更糟。

---

## 4. 长期运行

### 4.1 systemd(推荐)

**把配置文件放进数据目录,而不是 `/etc`。** 下面的单元用了
`DynamicUser=yes`:每次启动的 uid 都是新的,所以一个 root 拥有的 `/etc/aiw-kb/config.toml`
它既读不到、更写不了 —— 而写不了就意味着管理后台的「保存」永远失败。
`StateDirectory=aiw-kb` 建出来的 `/var/lib/aiw-kb` 是**属于那个动态用户的**,
两个问题一起解决。

第一次启动会在那里自动生成配置(并打印密钥,`journalctl -u aiw-kb` 里看)。

```ini
# /etc/systemd/system/aiw-kb.service
[Unit]
Description=Simple AI Writer knowledge-base sync server
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
ExecStart=/usr/local/bin/aiw-kb-server --config /var/lib/aiw-kb/config.toml
Environment=AIW_KB_DATA_DIR=/var/lib/aiw-kb/data
Restart=on-failure
RestartSec=5s
# 后台的「重启服务」按钮就是让进程干净地退出,靠这一行把它拉起来。
# 没有它,那个按钮等于关机按钮。

# 专用账号,别用 root 跑
DynamicUser=yes
StateDirectory=aiw-kb
# StateDirectory 会把 /var/lib/aiw-kb 建好并交给动态用户

# 收紧权限:它只需要读自己的二进制、写自己的数据目录、开一个端口
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
# StateDirectory 已经隐含允许写 /var/lib/aiw-kb;配置文件在那里,所以
# 后台保存配置是可以落盘的。把配置放回 /etc 的话,这里要加
# ReadWritePaths=/etc/aiw-kb,否则后台只能读不能写。
ProtectHome=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes

[Install]
WantedBy=multi-user.target
```

```bash
sudo cp target/release/aiw-kb-server /usr/local/bin/
sudo systemctl daemon-reload
sudo systemctl enable --now aiw-kb
systemctl status aiw-kb
journalctl -u aiw-kb -f
```

> 用了 `DynamicUser=yes` + `StateDirectory=aiw-kb` 的话,数据实际在
> `/var/lib/private/aiw-kb`,而 `/var/lib/aiw-kb` 是指向它的符号链接。
> 备份时跟着链接走(`tar -h` 或直接备份真实路径)。

### 4.2 Docker

仓库里没有 Dockerfile —— 一个静态二进制不太需要容器。真要用:

```dockerfile
FROM rust:1-slim AS build
WORKDIR /src
COPY . .
RUN cargo build --release

FROM gcr.io/distroless/cc-debian12
COPY --from=build /src/target/release/aiw-kb-server /aiw-kb-server
ENV AIW_KB_DATA_DIR=/data AIW_KB_BIND=0.0.0.0:8787 AIW_KB_CONFIG=/data/config.toml
EXPOSE 8787
ENTRYPOINT ["/aiw-kb-server"]
```

配置文件指向挂载卷里(`/data/config.toml`),否则它会写进容器的可写层 ——
容器一重建,后台里改过的配置和发过的 token 全部消失。

```yaml
# docker-compose.yml
services:
  aiw-kb:
    build: .
    volumes:
      - ./data:/data               # 配置文件也在这里面,chmod 600
    ports:
      - "127.0.0.1:8787:8787"      # 只暴露给本机,外面套反向代理
    restart: unless-stopped
```

容器里 `AIW_KB_BIND` 必须是 `0.0.0.0:8787`,否则宿主机映射不进去;
但**端口映射写成 `127.0.0.1:8787:8787`**,让 TLS 由反向代理负责。

注意上面用 `ENV` 设了三项 —— 它们会**覆盖**配置文件里的同名项,所以这三项在
后台的配置页里是锁着的(显示「环境变量覆盖」)。想在后台里改 bind 或数据目录,
就别在这里设它们。

### 4.3 Windows:托盘启动器(aiw-kb-tray)

Windows 上不需要 systemd 也不需要包装服务 —— 仓库里有第二个二进制
`aiw-kb-tray`,把同一个服务器**在进程内**跑在一个托盘图标后面:

```powershell
cd server
cargo build --release
# 得到 target\release\aiw-kb-tray.exe,放到哪个目录都行,双击运行
```

- 双击即启动:图标进托盘(实心 = 运行中,空心 = 已停止),没有控制台窗口;
- 首次启动生成配置文件时,管理密码和同步 token **弹在对话框里**(headless 版
  打印到终端的那份信息,换了一个观众);
- 托盘菜单:启动/停止服务器 · 打开管理后台 · 服务器状态 · **开机自启**
  (写 HKCU Run 键,不需要管理员权限,取消勾选即撤销)· 退出;
- 它会把工作目录定到 exe 所在目录,所以默认布局是 exe 旁边的
  `aiw-kb.toml` + `data\`,无论是双击还是开机自启拉起的;
- 日志在 `data\tray.log`(GUI 进程没有终端可打)。

配置编辑、token 管理、活动日志、备份都在管理后台(菜单一键直达),托盘自己
不再长一套界面。设计与取舍:
[`docs/feature/knowledge-base/kb-server-tray.md`](../docs/feature/knowledge-base/kb-server-tray.md)。

「无人登录也要跑」的场景(机房里的 Windows Server),Run 键不够 —— 用
[WinSW](https://github.com/winsw/winsw) 之类的包装器把 **headless 的
`aiw-kb-server.exe`** 注册成 Windows 服务即可,托盘版不适合做服务(它假设
有一个能显示图标和对话框的桌面会话)。

---

## 5. 轮换 token

服务端接受多个 token,所以可以不停机换。**后台的 Token 页就是这四步**
(而且改动立即生效,不用重启 —— token 是每个请求现读的):

1. 新建一个 token,旧的先留着,新旧并存
2. 在每台机器的 app 里改成新 token,点「连接」确认能列出知识库
3. 看 Token 页的「最后使用」,确认旧 token 已经没有机器在用
4. 吊销旧的

第 3 步是这个流程里唯一需要证据的一步,也是命令行做不到的那一步 ——
在有活动日志之前,你只能靠「应该都换完了吧」。

手工做法:编辑配置文件的 `[[tokens]]`,加一个,换完再删掉旧的那一段。
用环境变量 `AIW_KB_TOKENS` 的话则需要改环境文件并重启。

怀疑泄露就别按这个流程 —— 直接只留新 token,让旧的立刻失效。

---

## 6. TLS 与反向代理

这个进程**不做 TLS**。公网必须套一层;局域网也建议套,因为 bearer token
是明文发的,同一个 Wi-Fi 下抓包就能拿到。

### Caddy(最省事,自动证书)

```caddyfile
lore.example.com {
    reverse_proxy 127.0.0.1:8787
    # 条目带配图,默认上限可能不够
    request_body {
        max_size 64MB
    }
}
```

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name lore.example.com;

    ssl_certificate     /etc/letsencrypt/live/lore.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/lore.example.com/privkey.pem;

    # 必须调大:默认 1MB,一个带图的条目会直接 413
    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        # 不要缓冲上传,条目可能几十 MB
        proxy_request_buffering off;
    }
}
```

> **代理的 body 上限要 ≥ `AIW_KB_MAX_ENTRY_MB`。** 两边不一致的话,
> 超限会以代理的 413 返回,而 app 看到的是一个没有 `code` 字段的 HTML 错误页
> —— 排查起来比服务端自己拒绝要麻烦得多。

局域网自签证书的话,app 那边的 HTTP 客户端会校验证书链;把自签 CA 装进
系统信任库,或者干脆在局域网里用 HTTP 并接受风险(仅当你信任这个网络)。

---

## 7. 数据目录、备份、迁移

```text
<data>/kbs/<kb-id>/meta.json                            { id, name, createdAtMs }
<data>/kbs/<kb-id>/last-write.json                      { device, atMs } · 仅用于显示
<data>/kbs/<kb-id>/entries/<分类>/<条目>.<hash>.zip     条目载荷
<data>/kbs/<kb-id>/tmp/                                 提交前暂存,可随时清空
<data>/audit.log                                        活动日志,JSONL,超 8 MB 轮转为 audit.log.1
```

`audit.log` 删掉只损失历史 —— 没有任何同步逻辑读它。

**备份**:直接打包整个数据目录即可,没有数据库、没有 WAL、不需要停机:

```bash
tar -czf aiw-kb-$(date +%F).tar.gz -C /var/lib/aiw-kb .
```

**迁移到新机器**:拷数据目录 + 二进制 + 环境文件,起服务。客户端只要
地址不变(或改成新地址并重填 token),绑定关系和哈希快照都仍然有效 ——
条目身份是路径和内容哈希,与服务器无关。

**`tmp/` 里有残留**:说明有过一次被强杀的上传。可以随时删,它不含任何
已提交的数据。后台「维护与备份」页有一个按钮。

**同一个条目出现两个 `.zip`**:同样是崩在提交与清理之间。服务端会按
mtime 取新的那个,并在下次写入时清掉旧的 —— 不用手工处理。后台会列出这些条目
并标明哪一个是生效的那个,想提前回收空间可以点一下。

---

## 8. 排错

| 现象 | 原因与处理 |
|---|---|
| 启动即退出,提示 `no sync tokens configured` | 配置文件里没有 `[[tokens]]`,而且没开 `allow_anonymous`。这是故意的,见 §2 |
| 后台打不开,日志说 `the admin console at /admin is disabled` | 配置文件里没有 `[admin]` 段。加上 `username` / `password` 再重启 |
| 后台登录一直提示「失败次数过多」 | 连续 5 次失败会锁 5 分钟。忘了密码就停服务、打开配置文件看 `[admin]`(它是明文的),或者删掉 `password` 那一行让它重新生成 |
| 后台里保存配置报错 | 配置文件不可写。看进程用哪个账号跑、文件属于谁;systemd + `DynamicUser` 的话把配置放进 `StateDirectory`,见 §4.1 |
| 后台里某一项是灰的、标着「环境变量覆盖」 | 那一项由环境变量提供,文件里的值没生效,在后台改也不会有用。去掉那个环境变量并重启 |
| 点了后台的「重启服务」,服务就没了 | 那个按钮只是让进程干净退出,需要 systemd / Docker 把它拉起来。裸跑的话,退出就是退出 |
| 启动即退出,提示 token `shorter than 16 characters` | token 太短,重新生成 |
| app 报 401 | token 不对,或地址填成了另一台服务器(钥匙串按地址分账户) |
| app 报 404 `no knowledge base named …` | 绑定的知识库在服务端被删了。解除绑定后重新绑 |
| app 报 412 并提示「服务器在你确认之后又变了」 | **正常行为**,不是故障:另一台机器在你确认之后写入了。按提示重新预览 |
| 上传报 413 | 条目(含配图)超过上限。调大 `AIW_KB_MAX_ENTRY_MB`,**并同步调大反向代理的 body 上限** |
| 推配置备份报 413 | 那是另一个上限:`AIW_KB_CONFIG_MAX_MB`(默认 4 MB)。一份配置只有几十 KB,撞上它通常说明推错了东西 |
| app 说「密码错误,或这个备份已损坏」 | 服务端帮不上忙:密码从不上网,这里既没有它也没有解密代码。换个密码试,或者重推一份 |
| 想把某个配置备份下载下来看看 | 后台**故意没有这个按钮**。它是加密的凭据材料,整机备份(§6)已经覆盖了 `configs/` |
| 上传卡住/超时 | 反向代理开了请求缓冲。nginx 加 `proxy_request_buffering off` |
| 局域网连不上 | `AIW_KB_BIND` 还是 `127.0.0.1`,改成 `0.0.0.0:8787`;再检查防火墙 |
| 知识库列表里没有「来自 XXX」 | 那个库还没被写过,或写它的客户端版本没有发 `X-Source-Device` |
| 想看每个请求 | `RUST_LOG=aiw_kb_server=debug,tower_http=debug` |

---

## 9. 上线前对照一遍

> 这一节现在也是后台「维护与备份 → 健康自检」的内容,它会**实测**其中几条
> (包括真的发一次无凭据请求)。下面留着,是给后台还没打开的时候用的。

- [ ] token 是 32 字节随机值,不是手敲的
- [ ] 配置文件权限 600,没进 shell 历史、没进 git
- [ ] 后台密码不是默认生成后就贴在群里的那个
- [ ] `allow_anonymous` **是 false**(环境变量里也没有)
- [ ] 公网暴露的话,前面有 TLS
- [ ] 反向代理的 body 上限 ≥ `AIW_KB_MAX_ENTRY_MB`
- [ ] 服务不是用 root 跑的
- [ ] 数据目录在会被备份的分区上,并且真的验证过能恢复 —— 它现在也装着作者的**配置备份**,那里面有(加密的)API Key
- [ ] `curl` 无 token 访问 `/v1/kbs` 确实返回 401
