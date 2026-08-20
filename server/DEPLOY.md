# aiw-kb-server 启动手册

从零把知识库备份服务器跑起来:编译 → 生成密钥 → 启动 → 验证 → 长期运行。

> 这份文档只讲**怎么部署和运维**。API 细节和设计取舍见
> [`README.md`](README.md);为什么是这个形态见
> [`../docs/remote-knowledge-base-feasibility.md`](../docs/remote-knowledge-base-feasibility.md) §13–§18。

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

## 2. 生成密钥(必读)

**服务端没有用户系统,也没有登录。** 鉴权只有一样东西:一个 bearer token。
拿到 token 的人可以读写这台服务器上的**每一个**知识库,所以它就是密码,
按密码对待。

### 生成

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

token 通过环境变量 `AIW_KB_TOKENS` 传入,**逗号分隔可以配多个**:

```bash
AIW_KB_TOKENS="7f3c1e0a…,9d2b7f10…"
```

配多个的用处只有一个:**轮换而不中断**。见 §5。

### 不要这样做

- ❌ **不要把 token 写进 shell 历史。** `AIW_KB_TOKENS=xxx ./aiw-kb-server`
  会留在 `~/.bash_history` 里。用 systemd 的 `EnvironmentFile`(§4)或
  docker 的 `env_file`(§4.2),文件权限设 `600`。
- ❌ **不要提交进 git。** 本目录的 `.gitignore` 已经排除了 `/data`,
  但环境文件放在别处更稳妥。
- ❌ **不要多台机器共用一个 token 却又想区分是谁写的。** 区分靠的是客户端
  发的 `X-Source-Device`(见 §7),不是 token。
- ❌ **不要开 `AIW_KB_ALLOW_ANONYMOUS=1` 然后监听 `0.0.0.0`。** 那等于把
  你的设定集公开可写。这个开关只用于本机试跑,而且它必须显式设置 ——
  没有 token 时服务端**拒绝启动**正是为了防止这种默认。

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
export AIW_KB_DATA_DIR=/var/lib/aiw-kb
export AIW_KB_BIND=127.0.0.1:8787
export AIW_KB_TOKENS="$(openssl rand -hex 32)"   # 记下来,客户端要用
./aiw-kb-server
```

看到这一行就算起来了:

```
INFO aiw_kb_server: listening on 127.0.0.1:8787, data in "/var/lib/aiw-kb"
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

### 全部配置项

| 变量 | 默认 | 说明 |
|---|---|---|
| `AIW_KB_DATA_DIR` | `./data` | 数据目录 |
| `AIW_KB_BIND` | `127.0.0.1:8787` | 监听地址。默认只听回环 |
| `AIW_KB_TOKENS` | 无 | 逗号分隔的 bearer token,每个 ≥16 字符 |
| `AIW_KB_ALLOW_ANONYMOUS` | 无 | `1` = 关闭鉴权。**仅本机试跑** |
| `AIW_KB_MAX_ENTRY_MB` | `64` | 单条目请求体上限。条目含配图,图多的话调大 |
| `RUST_LOG` | `aiw_kb_server=info` | `debug` 会打印每个请求 |

---

## 4. 长期运行

### 4.1 systemd(推荐)

密钥单独放一个只有 root 能读的文件:

```bash
sudo install -d -m 700 /etc/aiw-kb
sudo tee /etc/aiw-kb/env >/dev/null <<'ENV'
AIW_KB_DATA_DIR=/var/lib/aiw-kb
AIW_KB_BIND=127.0.0.1:8787
AIW_KB_TOKENS=在这里填你生成的token
AIW_KB_MAX_ENTRY_MB=64
ENV
sudo chmod 600 /etc/aiw-kb/env
```

```ini
# /etc/systemd/system/aiw-kb.service
[Unit]
Description=Simple AI Writer knowledge-base sync server
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
ExecStart=/usr/local/bin/aiw-kb-server
EnvironmentFile=/etc/aiw-kb/env
Restart=on-failure
RestartSec=5s

# 专用账号,别用 root 跑
DynamicUser=yes
StateDirectory=aiw-kb
# StateDirectory 会把 /var/lib/aiw-kb 建好并交给动态用户

# 收紧权限:它只需要读自己的二进制、写自己的数据目录、开一个端口
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
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
ENV AIW_KB_DATA_DIR=/data AIW_KB_BIND=0.0.0.0:8787
EXPOSE 8787
ENTRYPOINT ["/aiw-kb-server"]
```

```yaml
# docker-compose.yml
services:
  aiw-kb:
    build: .
    env_file: ./secrets.env        # 里面写 AIW_KB_TOKENS=…,chmod 600
    volumes:
      - ./data:/data
    ports:
      - "127.0.0.1:8787:8787"      # 只暴露给本机,外面套反向代理
    restart: unless-stopped
```

容器里 `AIW_KB_BIND` 必须是 `0.0.0.0:8787`,否则宿主机映射不进去;
但**端口映射写成 `127.0.0.1:8787:8787`**,让 TLS 由反向代理负责。

---

## 5. 轮换 token

服务端接受多个 token,所以可以不停机换:

1. 生成新 token,追加到 `AIW_KB_TOKENS`(**旧的先留着**):
   `AIW_KB_TOKENS=旧token,新token`
2. `sudo systemctl restart aiw-kb`
3. 在每台机器的 app 里改成新 token,点「连接」确认能列出知识库
4. 全部换完后,把旧 token 从环境文件里删掉,再重启一次

怀疑泄露就别按这个流程 —— 直接只留新 token 重启,让旧的立刻失效。

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
```

**备份**:直接打包整个数据目录即可,没有数据库、没有 WAL、不需要停机:

```bash
tar -czf aiw-kb-$(date +%F).tar.gz -C /var/lib/aiw-kb .
```

**迁移到新机器**:拷数据目录 + 二进制 + 环境文件,起服务。客户端只要
地址不变(或改成新地址并重填 token),绑定关系和哈希快照都仍然有效 ——
条目身份是路径和内容哈希,与服务器无关。

**`tmp/` 里有残留**:说明有过一次被强杀的上传。可以随时删,它不含任何
已提交的数据。

**同一个条目出现两个 `.zip`**:同样是崩在提交与清理之间。服务端会按
mtime 取新的那个,并在下次写入时清掉旧的 —— 不用手工处理。

---

## 8. 排错

| 现象 | 原因与处理 |
|---|---|
| 启动即退出,提示 `no tokens configured` | 没配 `AIW_KB_TOKENS`。这是故意的,见 §2 |
| 启动即退出,提示 token `shorter than 16 characters` | token 太短,重新生成 |
| app 报 401 | token 不对,或地址填成了另一台服务器(钥匙串按地址分账户) |
| app 报 404 `no knowledge base named …` | 绑定的知识库在服务端被删了。解除绑定后重新绑 |
| app 报 412 并提示「服务器在你确认之后又变了」 | **正常行为**,不是故障:另一台机器在你确认之后写入了。按提示重新预览 |
| 上传报 413 | 条目(含配图)超过上限。调大 `AIW_KB_MAX_ENTRY_MB`,**并同步调大反向代理的 body 上限** |
| 上传卡住/超时 | 反向代理开了请求缓冲。nginx 加 `proxy_request_buffering off` |
| 局域网连不上 | `AIW_KB_BIND` 还是 `127.0.0.1`,改成 `0.0.0.0:8787`;再检查防火墙 |
| 知识库列表里没有「来自 XXX」 | 那个库还没被写过,或写它的客户端版本没有发 `X-Source-Device` |
| 想看每个请求 | `RUST_LOG=aiw_kb_server=debug,tower_http=debug` |

---

## 9. 上线前对照一遍

- [ ] token 是 32 字节随机值,不是手敲的
- [ ] token 在权限 600 的文件里,没进 shell 历史、没进 git
- [ ] `AIW_KB_ALLOW_ANONYMOUS` **没有**设置
- [ ] 公网暴露的话,前面有 TLS
- [ ] 反向代理的 body 上限 ≥ `AIW_KB_MAX_ENTRY_MB`
- [ ] 服务不是用 root 跑的
- [ ] 数据目录在会被备份的分区上,并且真的验证过能恢复
- [ ] `curl` 无 token 访问 `/v1/kbs` 确实返回 401
