# 工具在场性契约

> **状态：`living`。** 与代码不符时，是代码的 bug。
> **改 preset、往 `routeTools` 加分支、写任何工具的 description 或结果文本之前读它。**

## 规则

**一次运行说的话，必须和这次运行能做的事一致。**

模型只从两个地方知道自己有什么：工具 schema，和工具**结果里的文字**。这两处但凡
点名一个本次运行没有的工具，模型就会照做——而它照做的后果分三档，最贵的那档不
报错。

## 三种失败形状

| 形状 | 长什么样 | 代价 |
|---|---|---|
| **死指针** | 结果文本教模型调一个已被摘掉／这个 preset 本来就没有的工具 | 一轮 Unknown tool。看得见，能自愈 |
| **能力静默消失** | 文本说「做不到」，其实换条路做得到 | **模型再也不去要了。** 作者打开的开关没有效果，且没有任何报错 |
| **后门** | 工具集比 preset 声明的宽——通常是被某个 `some()`／通配追加进来的 | 一条 preset 注释明说不该有的路，隔一层间接又通了 |

第二种是这份文档存在的理由。第一种是它的常见形态，第三种是它的镜像。

三种都发生过，且都不是有人写错了一行——是**判据取错了变量**。

## 判据取哪个变量

| 要回答的问题 | 读什么 | 别读什么 |
|---|---|---|
| 本次运行有没有这个工具？ | `ToolContext.allowedTools`（`executeRegisteredTool` 填，调用方永远不填） | 工具自己在不在 registry 里——它一直在 |
| 该不该挂某份随工具走的清单？ | `preset.tools.includes(那个工具)` | 任务的档位／id。见 [edit-loop-plan §7.2](../feature/agent/edit-loop-plan.md) |
| 谁来读图？ | `routeTools` 交出的 `visionDelegate` | `ToolContext.multimodal`——识图子代理开着时它是**错的那个模型**的属性 |
| 这个 surface 能不能渲染某张卡？ | `RouteOptions` 里那个显式的 opt-in | 「大概都能吧」 |
| 某个子代理算不算数？ | 按 kind 逐个判 | `DELEGATE_KINDS.some(live)`——四选一会把 longread 的开关变成 delegate 的开关 |

一条贯穿的：**判定要算在做出那个决定的同一处**。摘掉 `read_lore_image` 的是
`routeTools`，所以「谁来读图」的答案也该由它交出来，而不是让四个 surface 各自
重新推一遍——推错一个，界面和运行就开始各说各的（`resolveVisionConn` 的注释写的
是同一件事：「谁在这里读图」只该有一个答案）。

## 加东西时过一遍

往 preset 加工具、加一种子代理、加一个 Beta、写一句工具结果文本时：

1. **这句话点名了工具吗？** 点名了就查 `allowedTools`，别查标志位、别查 `multimodal`、
   更别假设「带 A 的 preset 都带 B」。
2. **关掉时是缺席还是拒绝？** 一律**缺席**。一个看得见却总是回答「作者没开这个」
   的工具，在作者读来是助手坏了，而且白烧一轮。
3. **新加的 kind 会从哪个 `some()` / 通配里漏进去？** 收窄用**白名单**，走入参
   自己的键——从常量表推出来的关闭清单，对一个还没进那张表的 kind 是不设防的。
4. **摘掉一个工具时，谁在指着它？** 至少查三处：别的工具的 description、别的工具的
   **结果文本**、以及 briefing／清单。
5. **改 description 的长度了吗？** `agentToolBudget.test.ts` 的棘轮量的就是它。撞红了
   不是测试坏了。

## 先例

都在代码里，都带着自己的注释：

| 位置 | 做的事 |
|---|---|
| `routing.ts` `applyExportFlags` | Beta 关 = 工具**缺席**，不是拒绝 |
| `routing.ts` 图像工具 | 没有可用的 imagegen 绑定就摘掉三个画图工具——主模型根本不会画 |
| `routing.ts` `ask_author` / `run_pack` | 渲染得了卡的 surface 才追加；批量运行拿不到，否则会阻塞在一张看不见的卡上 |
| `tools.ts` `loreGutterNote` | 行号提示点名 `rewrite_lore_lines`，**仅当**本次运行真的持有它 |
| `registry.ts` `galleryViewer` | 图集抬头三档 here / delegate / none，两条臂都查 `allowedTools`（见 [subagent-lld §6.1.4](../feature/agent/subagent-lld.md)） |
| `chatRefs.ts` 未发送图片段 | 只在识图子代理真的在时，才教模型 `delegate(kind:"vision")` |
| `aiTaskStore` / `agentStore` 的两份清单 | 工作流卡与 docx 格式表跟着 `read_workflow` / `export_docx` 走，不跟档位走 |
| `roleplay/presets.ts` `subAgentsFor` | 扮演角色的子代理白名单，只有 vision（见 [02-design §8](../feature/roleplay/02-design.md)） |
| `roleplay/presets.ts` 旁白工具集 | `read_slides` 与 `read_document` **一起**缺席——只留一个会让 `read_file` 的改口指向不存在的工具 |
| `routing.ts` `transcribe_audio` · `tools.ts` 音频改口 | 追加规则同 `translate`（Beta 开 **且** `asr` 档位绑了 `isAsrOnly` 的模型）；`read_file` 遇到音视频文件时按 `allowedTools` 判：有就点名 `transcribe_audio`，没有就说要作者去实验室开开关并绑模型——不点一个本次运行没有的工具 |
| `routing.ts` `run_command` · `registry.ts` `describe` | 三个条件缺一即缺席：surface 能渲染审批卡（`RouteOptions.commands`，chat 与非批量任务面板）、命令行 Beta 开、在 Tauri 里（浏览器没有 shell）。description 在交出定义时才生成（`RegisteredTool.describe`）——它点名这台机器**真正**会用的 shell，模型据此写 PowerShell 还是 POSIX 语法；失败的结果文本再点一次名，教模型改写而不是重试。见 [shell-command-plan §1 不变量 4、5、11](../feature/agent/shell-command-plan.md) |

## 一个例外：跨工具改口

`read_file` 撞上 .docx 时回「Use read_document to read it.」，`read_slides` 和
`read_document` 也互相改口。这些字符串**点名了一个可能不在场的工具**，而它们是对的：

- 它们是**拒绝**，不是指路。就算那个工具不在，模型收到的也是一句「此路不通」，
  这本身就是正确的结果，只是少了下一步。
- 替代方案是让它们按后缀猜，而那是把一个明确的契约换成猜（同 `document-read-plan`
  拒绝按文件名全树搜索的理由）。

但**成对的工具要成对地在场**：给旁白留 `read_slides` 而不给 `read_document`，等于
让一半格式有出路、另一半撞空。要么都有，要么都没有。
