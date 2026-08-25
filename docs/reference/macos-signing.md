# macOS 代码签名（自签名证书）· 操作手册

> Status: **planned** — 手册里的每条命令都在真机上跑过（§附录 A 是实测记录），但仓库还没启用。
> 启用之后把这行改成 `living`。

## 0. 这解决的是什么

**一句话：让 macOS 在应用更新之后不再反复索要登录密码。**

钥匙串里每条记录各带一张 ACL，ACL 记的信任是请求方二进制的**代码签名身份**。今天的 release 是 ad-hoc 签名，身份就是二进制的哈希，每次构建都变 —— 于是每次更新在 macOS 眼里都是「另一个程序」，ACL 失效，密码框回来。机制全貌见
[architecture.md → Secure Key Storage](architecture.md#secure-key-storage)。

用一张**固定不变**的证书签名，designated requirement 就从「二进制的哈希」变成「证书的哈希」，跨版本稳定，ACL 一直认。

### 做完能得到

- 更新之后不再要登录密码（这是全部目的）
- bundle 被正确签名并封装资源（今天只有可执行文件被 linker ad-hoc 签了，`Sealed Resources=none`）
- 应用 `Identifier` 从 `simple_ai_writer-ed18bbf93812d9b5` 变成 `com.simple-ai-writer.app`

### 做完**得不到**

- **Gatekeeper 仍然不认**（`spctl → rejected`）。没有 Apple 公证就没有这一条，用户下载后依旧要右键打开，见 §7.2
- 这不是 Developer ID 的替代品，是它不花钱的那一半

---

## 1. 前置检查

```bash
openssl version
```

必须是 **OpenSSL 3.x**。macOS 自带的 `/usr/bin/openssl` 是 LibreSSL，不支持下面用到的 `-addext`。
如果 `openssl version` 显示 LibreSSL，装一个（`brew install openssl` 后重开终端），或者改走 §附录 B 的 GUI 路线。

> 本机实测：`openssl version` → `OpenSSL 3.0.14`（来自 miniconda / homebrew），`/usr/bin/openssl` → `LibreSSL 3.3.6`。

---

## 2. 生成证书（本机，一次性）

找一个**你会长期保管**的目录，不要放在仓库里。

### 2.1 生成密钥和自签名证书（有效期 20 年）

```bash
openssl req -x509 -newkey rsa:2048 -sha256 -days 7300 -nodes -keyout signing-key.pem -out signing-cert.pem -subj "/CN=Simple AI Writer Self Signed" -addext "basicConstraints=critical,CA:false" -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning"
```

`-days 7300` 是刻意的：**证书过期 = 换证书 = 密码框回来一轮**。20 年后再说。

检查扩展项对不对：

```bash
openssl x509 -in signing-cert.pem -noout -text | grep -A2 "Extended Key Usage"
```

期望看到 `Code Signing`。

### 2.2 打包成 .p12

```bash
openssl pkcs12 -export -out signing-cert.p12 -inkey signing-key.pem -in signing-cert.pem -name "Simple AI Writer Self Signed" -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1
```

会让你设一个密码，记下来，后面要填进 GitHub Secrets。

> ⚠️ 后面那三个 `-certpbe` / `-keypbe` / `-macalg` **不能省**。OpenSSL 3 默认用 AES-256 + PBKDF2，macOS 的导入器读不懂，会报
> `SecKeychainItemImport: MAC verification failed during PKCS12 import (wrong password?)` ——
> 密码明明是对的。这个坑我先踩过了。

### 2.3 记下证书指纹（后面验收要用）

```bash
openssl x509 -in signing-cert.pem -noout -fingerprint -sha1
```

形如 `sha1 Fingerprint=20:7B:C1:F1:...`。**去掉冒号、转小写**之后，它应该和后面签出来的 designated requirement 里那串哈希**一模一样** —— 这是最好用的验收锚点。

### 2.4 转成 base64（给 GitHub Secrets）

```bash
base64 -i signing-cert.p12 | pbcopy
```

已经在剪贴板里了。

---

## 3. 存进 GitHub Secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret，加两个：

| Secret 名 | 值 |
|---|---|
| `MACOS_CERT_P12` | 刚才 base64 的内容（已在剪贴板） |
| `MACOS_CERT_PASSWORD` | 2.2 里设的那个密码 |

签名身份的名字（`Simple AI Writer Self Signed`）不敏感，直接写在 workflow 里就行。

---

## 4. 改 `release.yml`

两处改动。

### 4.1 在 `Build Tauri app` **之前**插入一个导入步骤

```yaml
      - name: Import self-signed signing certificate (macOS)
        if: matrix.platform == 'macos-latest'
        env:
          MACOS_CERT_P12: ${{ secrets.MACOS_CERT_P12 }}
          MACOS_CERT_PASSWORD: ${{ secrets.MACOS_CERT_PASSWORD }}
        run: |
          set -euo pipefail
          KC="$RUNNER_TEMP/signing.keychain"
          echo "$MACOS_CERT_P12" | base64 --decode > "$RUNNER_TEMP/cert.p12"
          security create-keychain -p ci "$KC"
          security set-keychain-settings "$KC"
          security unlock-keychain -p ci "$KC"
          security import "$RUNNER_TEMP/cert.p12" -k "$KC" -P "$MACOS_CERT_PASSWORD" -T /usr/bin/codesign -A
          security set-key-partition-list -S apple-tool:,apple:,unsigned: -s -k ci "$KC" > /dev/null
          # 关键一步：codesign 只在「钥匙串搜索列表」里认得出未受信任的自签名身份。
          # 单给 --keychain 不够 —— 见 §附录 A.3 的四组对照。
          security list-keychains -d user -s $(security list-keychains -d user | tr -d '" ') "$KC"
          rm "$RUNNER_TEMP/cert.p12"
          security find-identity -p codesigning "$KC"
```

最后那行 `find-identity` 是留给你看日志的：应该打出一行
`1) <指纹> "Simple AI Writer Self Signed" (CSSMERR_TP_NOT_TRUSTED)`。
**`CSSMERR_TP_NOT_TRUSTED` 是正常的** —— 自签名证书本来就没有可信任的锚点，签名不需要它被信任。

### 4.2 给 `Build Tauri app` 加一个环境变量

```yaml
      - name: Build Tauri app
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          APPLE_SIGNING_IDENTITY: Simple AI Writer Self Signed
        with:
          args: ${{ matrix.args }}
```

> ### ⚠️ 千万不要设 `APPLE_CERTIFICATE`
>
> 那是给 Apple 正式证书用的路。tauri 看到它会自己建一个**临时钥匙串**然后 `codesign --keychain <临时钥匙串>` ——
> 而它**不会**把那个钥匙串加进搜索列表（`tauri-macos-sign/src/keychain.rs` 里只有
> create / unlock / import / set-keychain-settings）。自签名身份在那条路上会直接
> `no identity found`。
>
> 只给 `APPLE_SIGNING_IDENTITY`，tauri 走的是 `Keychain::with_signing_identity`，
> **不带** `--keychain`，签的就是我们上一步加进搜索列表的那张证书。

其余什么都不用加。**不要**设 `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` —— 那是公证，自签名证书公证不了。

Hardened runtime 是 tauri 的默认值（`hardened_runtime: true`），保持默认即可：这个 app 的 bundle 里没有
`Contents/Frameworks`，没有第三方 dylib 会撞上 library validation。实测签完 `codesign --verify --deep --strict` 通过。

---

## 5. 发一版

```bash
gh workflow run release.yml -f version=1.30.3
```

（版本号换成你要发的。`release.yml` 不带参数会用 `YY.M.D` 日期戳，不是仓库里的版本 —— 见
[bump-version 技能的说明](../../.claude/skills/bump-version/SKILL.md)。）

在 Actions 里盯 `Import self-signed signing certificate` 这一步的输出，确认它打出了那行 identity。

---

## 6. 验收

下载 release 的 `.dmg`，装进 `/Applications`，然后：

### 6.1 签名信息

```bash
codesign -dvvv "/Applications/Simple AI Writer.app"
```

| 字段 | 之前（ad-hoc） | 现在应该是 |
|---|---|---|
| `Identifier` | `simple_ai_writer-ed18bbf93812d9b5` | `com.simple-ai-writer.app` |
| `Authority` | （没有） | `Simple AI Writer Self Signed` |
| `Signature` | `adhoc` | （不再是 adhoc） |
| `CodeDirectory flags` | `0x20002(adhoc,linker-signed)` | `0x10000(runtime)` |
| `Sealed Resources` | `none` | `version=2 rules=13 …` |

### 6.2 designated requirement —— **最关键的一条**

```bash
codesign -d --requirements - "/Applications/Simple AI Writer.app"
```

期望：

```
designated => identifier "com.simple-ai-writer.app" and certificate leaf = H"207bc1f1…"
```

要点：
- 盯的是 `certificate …`，**不是** `cdhash` —— 这就是它能扛过更新的原因；
- `certificate leaf` 和 `certificate root` 两种写法我都见过（自签名证书自己既是叶也是根），**都对**；
- 那串哈希应该等于 §2.3 记下的证书 SHA-1 指纹（去冒号、转小写）。对上了就说明签的确实是你那张证书。

### 6.3 完整性

```bash
codesign --verify --deep --strict --verbose=2 "/Applications/Simple AI Writer.app"
```

期望 `valid on disk` + `satisfies its Designated Requirement`。

### 6.4 真正的验收在**下一版**

再发一版（哪怕只改一个字），装上，重跑 6.2。**两版的 designated requirement 必须一模一样。**
一样 = 成了；不一样 = 两次构建用的不是同一张证书。

---

## 7. 装上之后你会看到什么

### 7.1 还会问最后一次密码

签名换了，但钥匙串里那条记录的 ACL 记的还是旧的 ad-hoc 身份。所以第一次读会再弹一次
「输入登录密码」—— 点**「始终允许」**。

**只会有一次**（不是过去那 18 次）：所有机密现在住在一条记录里，
见 [architecture.md → Secure Key Storage](architecture.md#secure-key-storage)。

这一次点完，以后每次更新都不再问。

### 7.2 Gatekeeper 依旧不认

从 GitHub Releases 下载的文件带 quarantine 标记，双击会被拦。用户需要：

**右键（或 Control + 点按）→ 打开 → 在弹窗里再点一次「打开」**

或者系统设置 → 隐私与安全性 → 找到那条「已阻止」→「仍要打开」。

命令行的绕法：

```bash
xattr -dr com.apple.quarantine "/Applications/Simple AI Writer.app"
```

> 这一条**没有变差**：今天的 ad-hoc 包 `spctl` 报的是
> `code has no resources but signature indicates they must be present`（bundle 根本没签、资源没封），
> 这种下载后常见的提示是「已损坏，应移到废纸篓」，比「无法验证开发者」更吓人且更难绕。
> 自签名之后至少落回正常的「无法验证开发者」。
> **这一条是从两次 `spctl` 判定推出来的，我没跑过真实的下载—双击流程** —— 你试的时候顺手确认一下。

---

## 8. 出错对照表

| 症状 | 原因 | 处理 |
|---|---|---|
| `SecKeychainItemImport: MAC verification failed during PKCS12 import (wrong password?)` | .p12 用了 OpenSSL 3 的默认算法 | 回 §2.2，带上那三个 `-certpbe` / `-keypbe` / `-macalg` 重新导出 |
| `Simple AI Writer Self Signed: no identity found` | 证书没进钥匙串**搜索列表** | 确认 §4.1 里的 `security list-keychains -d user -s …` 那行跑了；确认没有设 `APPLE_CERTIFICATE` |
| `find-identity` 打出 `CSSMERR_TP_NOT_TRUSTED` | 正常 | 不用管，自签名证书就是这样，不影响签名 |
| `errSecInternalComponent` | 钥匙串锁了，或 key partition list 没设 | 确认 `unlock-keychain` 和 `set-key-partition-list` 两步都跑了 |
| DR 里还是 `cdhash H"…"` | 根本没签上，退回了 ad-hoc | 看 build 日志里有没有 `Signing with identity "…"` |
| 两版的 DR 不一样 | 用了两张不同的证书 | 对一下 §2.3 的指纹 |
| 更新后还是每次都问 | 见上一条，或者你换过证书 | 同上 |

---

## 9. 长期维护

- **`.p12` 和密码必须离线备份好。** 丢了 = 只能换一张新证书 = 全部用户再被问一次（一次，不是 18 次）。
- **不要改 bundle identifier。** DR 里写着 `identifier "com.simple-ai-writer.app"`，改了它 DR 就变了。
- **证书过期前换掉。** 20 年后的事，但换证书就是换 DR。
- **哪些操作会让密码框回来**：换证书、改 bundle identifier、证书过期、或者某次 release 忘了带
  `APPLE_SIGNING_IDENTITY`（那次会退回 ad-hoc，装上它的用户被问一次，再装回签名版又被问一次）。
- **以后要不要上 Developer ID**：可以随时切。切的那一次同样会问一次，之后 Gatekeeper 也一起解决。

---

## 附录 A：这些结论是怎么验出来的

全部在真机（macOS 26.6，Apple Silicon）上跑过，用一次性 service 名和一次性钥匙串，没有碰任何真实凭据。

### A.1 DR 的形状 —— 这是整件事的支点

编两个内容不同的二进制（模拟「更新前 / 更新后」），让 v1 建钥匙串记录、v2 去读。
探针里调了 `SecKeychainSetUserInteractionAllowed(false)`，所以信任检查失败会直接返回错误码，
不会弹框。

**对照组（ad-hoc，今天的样子）：**

```
v1 designated => cdhash H"6d6c7ac2…"
v2 designated => cdhash H"b393c910…"     ← 两次构建不一样
v1 write -> 0
v1 read  -> 0   secret=sk-secret
v2 read  -> -25293                        ← errSecAuthFailed，就是那个密码框
```

**实验组（同一张自签名证书签两次）：**

```
v1 designated => identifier "com.probe.app" and certificate root = H"cf507a6e…"
v2 designated => identifier "com.probe.app" and certificate root = H"cf507a6e…"   ← 一模一样
CDHash  v1=e4f2e3fa…   v2=3b6309a5…      ← 二进制确实不同
v1 write -> 0
v2 read  -> 0   secret=sk-selfsigned      ← 换了构建照样读得到
```

### A.2 拿真 app 试过

复制一份 `/Applications/Simple AI Writer.app` 到临时目录签（原件没动，签完删了）：

```
Identifier=com.simple-ai-writer.app
Authority=Simple AI Writer Self Signed
CodeDirectory flags=0x10000(runtime)       ← hardened runtime 接受
Sealed Resources version=2 rules=13 files=1
designated => identifier "com.simple-ai-writer.app" and certificate root = H"cf507a6e…"

codesign --verify --deep --strict  → valid on disk / satisfies its Designated Requirement
spctl -a -t exec                   → rejected (origin=Simple AI Writer Self Signed)
```

### A.3 为什么必须进搜索列表

同一张未受信任的自签名证书，四种组合：

| 在钥匙串搜索列表 | 带 `--keychain` | 结果 |
|---|---|---|
| ❌ | ✅ | `no identity found` |
| ❌ | ❌ | `no identity found` |
| ✅ | ❌ | **签成功** |
| ✅ | ✅ | **签成功** |

结论：**决定成败的是搜索列表，`--keychain` 既不帮忙也不碍事。**
而 tauri 的 `APPLE_CERTIFICATE` 路径恰好只做 `--keychain`，不动搜索列表 —— 所以 §4.2 里那条禁令是实测出来的，不是猜的。

---

## 附录 B：GUI 路线（钥匙串访问的证书助理）

不想碰 openssl 的话：

1. 打开「钥匙串访问」→ 菜单栏「钥匙串访问」→ 证书助理 → 创建证书…
2. 名称填 `Simple AI Writer Self Signed`，身份类型选**自签名根证书**，证书类型选**代码签名**
3. 勾上「让我覆盖这些默认值」，把有效期改长（默认 365 天太短）
4. 建好之后在「我的证书」里右键 → 导出 → `.p12`，设个密码

之后从 §2.3 继续。

> 这条路我**没有亲测**（它是 GUI）。判断它成没成，用 §2.3 的指纹 + §6.2 的 DR 对照即可 ——
> 只要 DR 里出现 `certificate leaf`/`root = H"<你的证书指纹>"`，就是对的。

---

## 附录 C：本机构建也想签

把证书导进登录钥匙串（`security import signing-cert.p12 -k ~/Library/Keychains/login.keychain-db -P <密码> -T /usr/bin/codesign -A`），
然后：

```bash
APPLE_SIGNING_IDENTITY="Simple AI Writer Self Signed" pnpm tauri build
```

登录钥匙串本来就在搜索列表里，所以不需要 §4.1 那步。

> 注意 `pnpm tauri dev` **签不了** —— dev 二进制每次重编都是新的 ad-hoc 哈希。
> 开发时要么忍着那个密码框，要么给那条钥匙串记录设「允许所有应用程序访问此项目」。

---

## 附录 D：回滚

把 §4.1 的步骤和 §4.2 的 `APPLE_SIGNING_IDENTITY` 删掉，重新发一版即可。没有任何东西会丢 ——
应用退回 ad-hoc，代价只是密码框回来（每次更新一次）。
