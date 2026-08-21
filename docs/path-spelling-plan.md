# 路径拼法归一化方案（入口归一化，已实施）

> 状态：**已实施，待 Windows 真机验证**（§6）。CI 的 ubuntu 跑不出这里的拼法相关的任何一条 —— 在 Linux 上 POSIX 拼法**就是**原生拼法，那些断言都是同义反复；`staleRefs.test.ts` 是例外，它测的是「只删指不到东西的引用」，与平台无关。
> 背景：`lib/paths.ts` 已经是唯一知道两平台差别的模块（PR #263），但路径仍以**宿主自己的拼法**进入前端。Windows 上于是全应用混着两套拼法，靠 `isSamePath` 逐点消化。这份方案把消化改成根治：**进来就归一化，全应用只有一套拼法。**

## 1. 现状盘点（规划前逐项核实）

| 环节 | 规划前的现状 |
|---|---|
| 路径入口 | 三类：Rust 的对话框/目录列举命令、`plugin-dialog` 的 `open()`（5 处）、`@tauri-apps/api/path` 的 `appDataDir`/`appLogDir`（3 处） |
| 文件树 | `read_dir_inner` 用 `e.path()`（`commands.rs:314`）。`PathBuf::push` **每层按原生分隔符拼，与父路径拼法无关** —— 传 `D:/proj` 进去出来是 `D:/proj\书\第一章.md` |
| 自定义 `FsScope` | `Path::components()` + `starts_with`（`scope.rs:81-88`）。Windows 上 Rust 的 `Path` 把 `/` 和 `\` 一视同仁 —— 与分隔符无关 |
| plugin-fs 的 glob scope | pattern 侧（`push_pattern`）和查询侧（`Scope::is_allowed`）**都过 `components().collect()`**，在 Windows 上重建成原生分隔符 —— 也与分隔符无关 |
| `open_with_default_app` | `Cargo.toml:61` 开了 `shellexecute-on-windows`，最终走 `ShellExecuteExW`，路径**原样**当 `lpFile`。shell API 对正斜杠不可靠 —— **唯一真正会坏的地方** |
| `preview_html_window` | `encode_path_for_url` 本来就先 `replace('\\', "/")`（`preview.rs:114`）—— 不受影响 |
| 拖放 | `tauri.conf.json:20` `dragDropEnabled: false`，且 `src/` 里没有 `onDragDropEvent`。**不是路径入口** |
| 路径比较 | 20 处已在 PR #263 换成 `isSamePath`；本方案又发现 4 处漏网（§4.3） |

结论：**两套 scope 都与分隔符无关，我此前担心的阻塞不存在**。真正的工作量不在改拼法，在**已经落盘的、拿绝对路径当键的数据**。

## 2. 关键决策（含弃用理由）

### D1 归一化的边界是「进入应用状态」，不是「每一个字符串」

只归一化三个入口：

| 入口 | 为什么必须 |
|---|---|
| `openProjectFolder()`（`lib/project.ts:16`） | `projectPath` 是一切的根，且**被持久化**进 `app:recentProjects` |
| `readDirRecursive()`（`lib/project.ts:42`） | 整棵 `fileTree`、`activeFilePath`、`expandedDirs` 的键、卷/章的 `.path` 都由它派生 |
| `readDir()`（`lib/fs/fileio.ts:93`） | `LoreEntity.dirPath` 由它来（`lore/entity.ts:56,98,133`），而 dirPath 被**写进 `agents.json` 和 pinned lore** |

**不**归一化的：`plugin-dialog` 的 5 个 `open()`、`appDataDir`/`appLogDir`、四个 zip/文本对话框命令的返回值。它们的路径读一次就扔 —— 取字节、取 basename、显示一行 —— 既不比较也不落盘，归一化买不到任何东西，却要动到 dialog 插件给那次会话的自动授权。

- 弃用【全部归一化，一条例外都不留】：整齐，但拿"没有收益的改动"去换"扰动一处授权机制"，方向反了。边界本身是可陈述的规则（进状态的归一化，过路的不动），不是拍脑袋的例外表。

### D2 树在**前端**归一化，不在 Rust

`readDirRecursive` 返回后递归 map 一遍 `toPosixPath`。

- 弃用【Rust 侧返回 POSIX】：Rust 内部要继续用原生 `PathBuf` 做 scope 校验和真正的文件操作，让它为前端的约定改返回值，等于把一个前端的表示问题渗进后端。前端 map 一棵几千节点的树，`toPosixPath` 是一次正则 test 加一次 replace，可忽略。

### D3 一律**读时归一化**，一行写迁移都不做

落盘的绝对路径共五处（§3）。全部改成读进来的时候过一遍 `toPosixPath`：

- 幂等，跑多少次都一样；
- 不需要迁移标记，不需要"这个版本迁过了吗"的状态；
- 盘上的字节没被改写，回滚就是回滚，没有单向门。

- 弃用【写迁移】：要引入版本号和一次性标记；而且 `ai:pinnedLore:` 和 `app:recentProjects` 必须**原子地**一起改，否则启动时的 `collectOrphanedProjectPrefs`（`prefs.ts:336-350`）会拿一个精确串匹配的 `Set` 把对不上的钉住记录**自动、静默、不可撤销地**删掉。读时归一化让这个陷阱根本不存在：recents 读进来就是新拼法，钉住的键写出去也是新拼法，两边永远一致。
- 老版本写下的钉住记录（旧拼法的键）会在第一次启动时被那个 collector 收走。**这是接受的代价** —— 钉住是轻量状态，作者重新钉一下就有；为它引入长期冗余或单向迁移都不划算。真正会"消失得没道理"的东西（扮演绑定、对话注入账本、配图）走的是读时归一化，不受影响。

### D4 「清理失效数据」是按钮，不是自动扫

读时归一化解决的是**拼法**变了，解决不了**东西没了**：作者移动、重命名项目，或者把项目从另一台机器的备份恢复过来，存着绝对路径的那四处就指向不存在的位置。

所以 Settings → 通用 → 数据维护 有一个按钮（`lib/staleRefs.ts`）。三条纪律：

1. **只删指不到东西的引用**，仍然有效的一条不动 —— 这是它敢不加二次确认的全部依据；
2. **判断不出来 ≠ 不存在**。父目录列不出来（网络盘没挂上、权限没了）答"没丢"，把引用留着。往"留下一条失效的钉住"错是免费的，往另一边错是在网盘慢一次的时候删掉作者的活绑定；
3. 花名册和会话 blob 按**原始 JSON** 改，不经过各自的类型层 —— 否则新版本加的字段会被这个只认老字段的清理器抹掉。

- 弃用【启动时自动清理】：和 `collectOrphanedProjectPrefs` 一样是背着作者动数据。区别在于那个删的是可重建的轻量状态，而这里能删到扮演绑定 —— 作者应该知道它发生了，并且看到删了什么。

### D4 `open_with_default_app` 在交给 OS 前转回原生拼法

`commands.rs:347`，交给 opener 之前 `Path::new(&path).components().collect::<PathBuf>()`。这是全套里唯一一处**必须**转回去的地方，理由在 §1 那张表：它走 `ShellExecuteExW`。

放在 Rust 而不是前端：交给 OS 的拼法是 OS 的事，前端不该知道有这回事。

## 3. 落盘的绝对路径（迁移清单）

不在这张表上的都不用管 —— `profile.json`、`sync.json`、`outline.json`（书脊）、`task.md` 头、笔记头、`imagegen.json`、`memory/*.md` 头、区域 `meta.json`、两个 bundle manifest **全是项目相对路径或根本没有路径**。

| # | 位置 | 存的是什么 | 处理 |
|---|---|---|---|
| 1 | `app:recentProjects`（`config.db` 的 prefs 行） | 绝对项目路径数组 | 读时归一化 + 按路径身份去重（`appStore.loadRecentProjects`） |
| 2 | `ai:pinnedLore:<绝对项目路径>` | **键**是绝对项目路径，**值**是绝对 `dirPath`（或 `dirPath#facet`）数组 —— 双重暴露 | 不迁；旧拼法的行会被 collector 收走（D3） |
| 3 | `.ai-writer/roleplay/agents.json` | `primaryDirPath` / `boundPaths[]` / `authorPersona.dirPath`，全是绝对 lore dirPath | 读时归一化（`roleplay/store.ts` 的 `coerceAgent` / `coercePersona`） |
| 4 | `chat_sessions.data` + roleplay `session.json` | `meta.injected` 的键、`meta.lastDocPath`、`meta.bodyDocPath`、`turns[].images` | 读时归一化（`chatSession.ts` 的 `deserializeChatSession`） |
| 5 | `dbCache` 的键 + `sqlite:${dbPath}` | 不是落盘，是**连接池的键** | 归一化后自然只有一个键 |

### 3.1 那个会自动删数据的 collector

`hydratePrefs()` 启动时会调 `collectOrphanedProjectPrefs()`，它拿 `app:recentProjects` 建一个 `Set`，然后把每一条 `ai:pinnedLore:` 的键**精确串匹配**，匹配不上就删行（`prefs.ts:345-346`）：

```ts
const alive = new Set(live);
const dropped = prunePrefsWithPrefix(PINNED_LORE_PREFIX, (path) => alive.has(path));
```

这就是 D3 里"弃用写迁移"的直接原因：任何**分两步**的迁移（recents 迁了、pinnedLore 没迁，或反过来）都会让它在新版第一次启动时把所有钉住记录**自动、静默、不可撤销地**删掉。

读时归一化没有这个窗口：recents 读进来就是新拼法，钉住的键写出去也是新拼法，两边从第一刻起就一致。代价是**老版本留下的旧拼法钉住行会被收走一次** —— 已接受（D3）。

### 3.2 #4 的失败是静默的浪费，不是损坏

`meta.injected` 对不上 → 恢复出来的会话把每个 lore 条目**重新注入一遍**（烧 token，不坏数据）。`lastDocPath` 对不上 → 第一轮重发整篇正文。`turns[].images` 对不上 → 老对话里的图显示不出来。都不致命，但都查不出来 —— 所以要修。

另外 `deserializeChatSession` 遇到任何形状意外都返回 `null`、调用方重开一个新会话（`chatSession.ts:173-186`），所以这一处即便迁错了也是优雅降级。

## 4. 实施清单（已完成）

### 4.1 入口（3 处）
- `lib/project.ts` — `openProjectFolder()` 结果过 `toPosixPath`；`readDirRecursive()` 递归 map 整棵树（理由见 D2）。
- `lib/fs/fileio.ts` — `readDir()` 的 `e.path` 过 `toPosixPath`。

### 4.2 读时归一化（3 处）
- `stores/appStore.ts` `loadRecentProjects()` — 逐条 `toPosixPath` + 按 `isSamePath` 去重。
- `lib/roleplay/store.ts` `coerceAgent` / `coercePersona` — `primaryDirPath` / `boundPaths[]` / `dirPath`。
- `lib/agent/chatSession.ts` `deserializeChatSession` — `meta.injected` 的键、`lastDocPath`、`bodyDocPath`、`turns[].images`。

### 4.3 PR #263 漏掉的 4 处 `===`
- `stores/appStore.ts` `addRecentProject` / `removeRecentProject` 的 `p !== path` → `isSamePath`（否则同一个项目两条记录，且 10 条上限会挤掉更早的项目）。
- `components/roleplay/RoleplayRoster.tsx` 的两处 `e.dirPath === agent.primaryDirPath` → `isSamePath`（对不上时每个角色都显示「人物条目已删除」）。
- `stores/agentStore.ts` 的 `activeFilePath !== meta.lastDocPath` / `bodyDocPath` → `isSamePath`。
- `lib/agent/compact.ts` 的 `injected.get(e.dirPath)` —— Map 查键，靠 4.2 的读时归一化解决。

### 4.4 Rust（1 处）
- `commands.rs` `open_with_default_app` —— 交给 opener 前 `components().collect()` 转回原生拼法。注意 `Opener::open_path` 收的是 `impl Into<String>`（不是 `AsRef<Path>`），所以要 `to_string_lossy().into_owned()`。

### 4.5 清理失效数据（新）
- `lib/staleRefs.ts` —— 扫描并清理指不到东西的引用，纪律见 D4。
- `components/settings/panes/GeneralPane.tsx` —— 设置 → 通用 → 数据维护。

### 4.6 测试
- `paths.test.ts` 已有平台规则测试，不用加。
- `staleRefs.test.ts`（新，10 条）—— **整个方案里唯一能在 CI 上守住真东西的测试**：清理逻辑与平台无关。每条都是同一件事测两遍 —— 死的删掉、旁边活的留下。另有一条专门守「判断不出来 ≠ 不存在」（父目录列不出来时不删）。

## 5. 回滚

全部是读时归一化，**盘上的字节一个都没改写**，回滚就是回退代码，没有单向门、不用备份 `config.db`。

唯一不可逆的是老版本留下的旧拼法 `ai:pinnedLore:` 行会被启动时的 collector 收走一次（D3 已接受）—— 回滚后作者重新钉一下即可。

## 6. 真机验证步骤（Windows）

CI 在 ubuntu 上跑，§4.1–4.4 **没有一条**能被它覆盖 —— 在 Linux 上 POSIX 拼法就是原生拼法。完整步骤见 PR 描述。要点：

1. **升级路径**：用旧版本开项目、钉几个知识库条目、绑一个扮演角色、生成一张配图，再换新版本打开 —— 扮演绑定、配图、对话历史必须都还在（钉住的会掉，这是已接受的代价）。
2. **`ShellExecuteExW` 那条**：`.html` 预览的「在浏览器打开」，路径里带中文和空格 —— 这是全套里唯一会被正斜杠真正搞坏的地方。
3. **plugin-fs 的 glob scope**：知识库头像 / 图库、文档配图 —— 走的是另一套 scope，源码读下来与分隔符无关，但没在真机上跑过。
4. **UNC 路径**：项目放在 `\\server\share\…` 上（如果有条件）。
5. **清理按钮**：手动删掉一个被钉住的条目文件夹，点「扫描并清理」，确认只有它被清掉。
