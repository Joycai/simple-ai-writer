# ask_author — agent 向作者提问的通道

> **Status: shipped** · 设计 2026-08-28,同日实现
>
> 一个新的阻塞式工具:模型出一道 2–4 选项的选择题,作者点一个选项或自由输入,
> 答案作为 tool result 原文回到运行中。对标 Claude Code 的 AskUserQuestion。
> 实现出入见 §9。

## 1. 要解决的问题

运行中途,模型经常需要一个**只有作者能做的决定**:两种改法都说得通、任务描述有歧义、
一个事实项目里查不到。今天它只有两条烂路:

- **对话助手里用正文问**。问得出,但代价是**这一轮运行就此结束**(`force-text` 的
  收尾就是它的回答):工具循环的状态、读进上下文的材料、做到一半的活,全部作废,
  作者回答之后模型从下一轮重新来过。问一个"要 A 还是 B"要付一整轮重建的钱。
- **面板任务里根本没有通道**。模型只能猜,把猜测做进产出,作者在审批卡上才第一次
  看到——而拒绝理由是那里唯一的反馈方式,一来一回比直接问贵得多。

现有四种卡片(审批 / 方案 / 轮数上限 / 截断)没有一种是"模型出题":前两种的选项
语义是批准/拒绝一件**既定的事**,后两种的选项是**应用写死的**,模型没有出题权。

## 2. 方案概要

新工具 `ask_author`,read 层(不写任何东西),但**阻塞**——和 L2 审批同一个契约:
工具调用 `await` 作者的选择,运行原地停住。

```
ask_author({
  question: string,        // 要作者决定的事,一句话说清
  options:  string[],      // 2–4 个互斥的短选项
})
```

卡片(`QuestionCard`)渲染:问题正文 + 选项按钮(点击即回答)+ **恒在的自由输入框**
(「其他…」)。自由输入不是 schema 里的一个选项,是卡片结构自带的——模型不需要、
也不能关掉它。

答案作为 tool result 回给模型,原文照搬:

- 选了选项 → `作者选择:「<选项原文>」`
- 自由输入 → `作者的回答:「<输入原文>」`
- 运行被停止 → `运行已停止,问题未获回答`(rejectAll 排空,见 §4)

一次调用一道题。要问第二道就再调一次——见 §7-D。

## 3. 工具装载:路由追加,不进 preset 字面量

照 `translate` / `delegate` 的先例(routing.ts 的注释就是论据):**能不能渲染这张卡
是 surface 的属性,在 preset 声明处不可知**。所以:

- `RouteOptions` 加 `askAuthor?: boolean`,`route()` 里为 true 时 append 工具——
  和 `handoff` 用同一个 opt-in 形状,谁有这个能力是 greppable 的。
- **对话助手(AgentChat)和 AiPanel 的 full 工具任务** opt in——就是今天传
  `RouteOptions.handoff` 的那几个调用点。
- **批量运行、lore 弹窗、子代理运行**永远不 opt in:无人值守/没有卡片槽位的
  surface,工具**缺席而不是拒绝**(routing 的既有论点:一个看得见但永远失败的工具,
  在作者眼里是助手坏了)。
- **扮演面板 v1 不接**:它整个就是对话,角色/旁白要问直接在戏里问;跳出戏问
  meta 问题反而破坏体验。留作后续观察。

`ToolContext` 加可选通道 `askAuthor?: (q: AskQuestion) => Promise<AskAnswer>`,
与 `requestApproval` 同形。handler 在通道缺席时返回说明性错误(防御性兜底;
路由应保证走不到这一步)。

## 4. 状态与卡片:第五个队列

`agentStore` 开第五个待决队列,和前四个共享全部既有机制:

```ts
interface PendingQuestion extends SurfaceTagged {
  id: string;               // React key(runId 是不透明对象)
  question: string;
  options: string[];
  resolve: (a: AskAnswer) => void;
  runId: RunId;
}

type AskAnswer =
  | { kind: "option"; index: number; text: string }
  | { kind: "other"; text: string }
  | { kind: "dismissed" };   // 仅 rejectAll 产生
```

- **surface 路由**:复用 `approvalRouting.ts`,规则一字不改——无标 = 默认表面
  (chat + 面板),带标只归同名表面。
- **rejectAll 排空**:第五个队列加进既有的 drain,resolve `dismissed`。这条是
  硬要求——漏了它,停止运行会留下一个永远悬着的 Promise 和一张点了没反应的卡。
- **系统通知**:入队时 `notifyApproval`(新 key `notify.approvalQuestion`),
  和其他卡片一样只在失焦时响,且**不携带问题正文**(notify.ts 的既有红线)。
- **连批永不覆盖**:问题的定义就是"无法预先回答的事",`AutoApproveState` 的任何
  grant 都不适用。它不是 `Proposal`,结构上就够不到那套机制(见 §7-B)。
- 卡片渲染在 AgentChat / AiPanel 现有的卡片槽位,样式沿用 RoundLimitCard 的
  卡片语汇(header + body + footer 按钮排)加一个输入行;遵守 design-system 的
  按钮/输入 token,不发明新组件。

执行日志(AgentLog)不需要新事件:tool call 事件已带参数(问题与选项),
tool result 事件带答案——问答对话消失在卡片之后,留存在日志里。

## 5. 成本账

- schema 估计 ~250–400 token(一段 description + 两个参数)。**路由追加意味着
  `agentToolBudget.test.ts` 的 raw-preset 棘轮不动**;照 translate 的先例,给
  routed set 的断言补上它,数字实测后写死并注明。
- 使用纪律全部写在工具 description 里,**不进** `ai.instructions.agent` briefing
  (那是每轮固定头部,description 已经是必付的钱,不付两遍):
  - 只在**被一个作者才能做的决定卡住**时用;项目里查得到的事自己查。
  - 不要用它请求写入许可——审批卡就是干这个的,问一遍等于让作者点两次。
  - 选项要互斥、要短;作者永远可以自由作答,答案原文照做。
  - 连续追问是打扰;能合成一个决定就问一次。

## 6. i18n 与措辞

新 key(zh-CN / en 同步):`ai.question.title`(「助手在等你决定」)、
`ai.question.otherPlaceholder`(「其他答案…」)、`ai.question.send`、
`notify.approvalQuestion`。用词按 terminology.md:面向作者叫「提问」,
不出现「询问卡」「反问」等新词;卡片标题不用「Agent」自称。

## 7. 被否掉的方案

- **A. 维持现状,让模型用正文问** —— chat 里丢掉整轮工具循环状态(§1);
  面板里根本没有通道。问题不是模型不会问,是问的代价错了。
- **B. 做成 Proposal 的第 11 个 kind** —— ApprovalCard 的 frame 是
  「批准/拒绝一件既定的事」:批准即应用、拒绝带理由、连批可覆盖。提问三条都
  不成立(没有"应用",没有"拒绝",连批在定义上不可能),硬塞进去等于给那套
  机制开一个处处要特判的例外。单独队列更诚实,而且前四个队列已经证明这个
  形状便宜。
- **C. 常驻 preset 字面量,无通道时报错** —— 批量运行会让模型看到一个永远
  失败的工具;routing.ts 为 pptx/image 工具写下的论点原样适用:off 意味着
  **缺席**,不是拒绝。
- **D. 一次调用多道题(Claude Code 式最多 4 题)** —— schema 贵一截,卡片
  复杂一截,而模型连调两次就能达到同样效果;运行本来就是阻塞的,分两卡不比
  一卡多等。等真实使用出现"总是连问"的模式再升级。
- **E. 超时自动选默认选项** —— 无人值守语义是错的:这个工具存在的意义就是
  "需要人"。真正无人值守的 surface(批量)在 §3 里根本拿不到这个工具,
  超时机制没有该服务的对象。
- **F. 选项带 label + description 两段(Claude Code 式)** —— 每次调用的
  参数 token 翻倍,而"选项说不清就放进 question 里说"已经够用。v1 纯字符串
  数组,留升级余地(参数对象化是向后兼容的加法)。

## 8. 切片与验证

一片 PR 就够(机制小、全在既有形状上):

1. `AskQuestion`/`AskAnswer` 类型 + registry 工具定义 + handler(走 `ctx.askAuthor`)
2. agentStore 第五队列(request / resolve / rejectAll / surface)
3. `QuestionCard.tsx` + AgentChat / AiPanel 接线(渲染 + RouteOptions opt-in +
   ctx 通道)
4. i18n、notify key

测试(全部 lib 层,照既有文件一模一样的形状):

- `agentStoreQuestions.test.ts`:入队/选项 resolve/自由文本 resolve/rejectAll
  排空/surface 过滤。
- `agentToolConventions.test.ts`:新工具过既有约定检查。
- `agentToolBudget.test.ts`:routed set 断言 + 实测数字。
- runtime 测试:工具调用阻塞到 resolve,答案原文出现在 tool result。

UI 行为(卡片出现、按钮回答、输入框回答、停止运行卡片消失)需要开着项目的
真机验证——作者侧确认。

## 9. 实现出入(2026-08-28)

- **AiPanel 的 opt-in 判定**落在 `aiTaskStore`:`preset === AGENT_ASSIST_PRESET
  && !useBatchStore.getState().running`(batchStore 动态 import,循环依赖的
  既有惯例)。read 层任务(续写)不给——它的 briefing 里没有提问这回事。
- **成本实测**:ask_author 单独 260 token(方案估 250–400 的下沿),三个路由
  追加工具(delegate / translate / ask_author)合计 895,routed 断言上限
  1,000(`agentToolBudget.test.ts`)。
- **一处结构性事实**方案没写明:read 层工具同轮并行执行,所以**一次可以有
  多张提问卡**同时挂着——`resolveQuestion` 因此按卡片 id 结算,而不是像
  RoundLimit 那样按 runId。
- 卡片没有独立的「跳过」按钮:停止运行(`rejectAll` → `dismissed`)就是跳过,
  再给一个只是第二个更含糊的停止。
