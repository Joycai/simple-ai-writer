# 被拒请求的报文：五个适配器共用一个读取器

状态：`shipped`（2026-09-28）。报文形状的事实在 [`streaming.md`](streaming.md) §3.5 与 [`landscape.md`](landscape.md) §7 第二十二个样本；
这里写本项目怎么读、为什么。

## 1. 问题

五个流式适配器的非 2xx 分支都是 `res.text()` 原样拼进报错。百炼 compatible-mode（① 在 `dashscope` 平台上）在思考中拒绝强制
`tool_choice` 时，400 的报文是一行 SSE：`data: {"error":{"code":"invalid_parameter_error","param":null,"message":"The tool_choice …","type":…}}`，
作者看到的是 `data:` 前缀和整段 JSON 脚手架。原生线路此前已在 `dashscope.ts` 里单独解决（`vendorErrorText` + `refusalText`），
[`dashscope-native-plan.md`](dashscope-native-plan.md) §3 记下了「该做的是所有适配器共用一个函数，而不是在 `openai.ts` 再抄一份」。

## 2. 做了什么

`src/lib/ai/refusal.ts`，两个函数：

- **`refusalText(body)`**：候选依次是整段报文、每一行 `data:`（行先 trim，与流读取器认同样的分帧，CRLF 与缩进都认）；第一个能读出
  厂商错误的候选胜出，都读不出（网关的 HTML、没有 `message` 的对象、空报文）就原样退回，不截断。
- **`vendorErrorText(json)`**：一个错误对象拼成一句 `标签: message — 上游 (param …, request_id …)`。认的形状：
  `{error:{…}}`（① ② ③ ④，④ 外面多一层 `{type:"error"}`）、`[{error:{…}}]`（③ 的数组包装）、`{error:"…"}`、裸 `{code, message, request_id}`
  （DashScope 原生，也是它 ④ 面的拒绝）与裸 `{message, type}`。

五个适配器的非 2xx 分支都改成 `refusalText(await res.text())`，前缀（`OpenAI API error 400 (<url>): `）不变。`dashscope.ts` 删掉自己的
那两份，改从这里引入；它流中途的 `event:error` 帧仍经 `vendorErrorText` 拼同一句。

## 3. 决定与理由

1. **只剥包装，不删读者在认的字段。** 报错消息有三个读者在正则匹配：学到的降级（`capability/learned.ts` 的 `/tool[_ ]?choice/i`
   与结构化输出那条）、`agent/structured.ts` 的 `TOOL_CAPABILITY_ERROR`、`modelHealth.isSafetyBlockMessage`（`content_filter`）。
   原文里它们能匹配到的，剥完之后必须还在。所以留下的是：
   - **`message` 一字不改**——绝大多数拒绝在这里点名字段。
   - **标签**：`code`，没有就 `status`（③ 的 `code` 是数字、字符串在 `status`：`INVALID_ARGUMENT`），再没有就 `type`（④ 只有 `type`，
     `overloaded_error` 之类正是作者要看的）。数字的 `code` 不要——它与报错里的 HTTP 状态重复。
   - **`param`**：OpenAI 形状的拒绝常常只在 `param` 里点名字段，`message` 里不点（`Invalid value: 'required'…` + `param:"tool_choice"`）。
     原文带着它，学到的降级就认得出；剥掉它就是一次静默的回归——那个端点从此每一轮都 400，而不是学一次。
   - **`request_id`**（错误对象里的，或顶层的，④ 与百炼都放顶层）：API 日志的 `error` 条目只记报错的 message，剥掉它就再也找不回
     找厂商排查要用的那个 id。响应头里的 id（OpenAI 的 `x-request-id`）不读：读取器只看报文，头里的 id 是另一个改动。
   - **中继转述的上游报文**（OpenRouter 的 `error.metadata.raw`，字符串或对象，旁边是 `provider_name`）：它自己的 `message` 是
     占位句「Provider returned error」，真正的原因——也是学到的降级要认的那句——只在 `raw` 里。`raw` 递归地过同一个读取器，
     读不出就原样附上。**这一条是按 OpenRouter 的文档写的，未实测**；OrcaRouter 的 ① ② 走的是 OpenRouter 形状的一层
     （[`orcarouter-probe-plan.md`](orcarouter-probe-plan.md)），是最可能碰到它的地方。
   其余字段（③ 的 `details`、OpenRouter 审核的 `reasons` / `flagged_input`、`type` 在有 `code` 时）丢掉。它们不是任何读者在认的，
   也不是作者据以行动的那句话；要看全文，API 日志的请求体旁边就是这个端点。

2. **不按 `content-type` 或平台分支。** 百炼的形状跟着请求头走、不跟状态码走，中间的代理还可能改写或丢掉 `content-type`；两种都试一遍，
   读的只是字节。按平台分支则正是平台表要消灭的写法。

3. **读不出就原样退回，不截断。** 读不出多半是「回来的不是这个 API」（网关、登录页、CDN 的 404），这时原文就是诊断本身，
   与 [`provider-standards.md`](provider-standards.md) §3.5「错误信息带上 URL」同一个理由。

4. **不与 `providerProbe.apiErrorMessage` 合并。** 那个函数回答的是另一个问题——「回来的是不是 API」：有 `error` 就算（没有 `message`
   也返回空串，表示「API 说话了」），只认整段 JSON，结果塞进一句 i18n 文案里，只要裸 `message`。共用「找错误对象」那一步会把两个
   判据绑在一起：这里为了少丢信息加的形状（数组包装、`metadata.raw`、SSE 行）会悄悄放宽连接测试的「是 API」判据，而那个判据宁严勿宽
   （HTML 不能读成成功）。两边的改动理由不同，分开。

5. **一个模块，不放进某个适配器。** 原生线路先做，函数原本在 `dashscope.ts`；但 ① 引入 `dashscope.ts` 会反过来依赖（`dashscope.ts`
   已经从 `openai.ts` 拿 `chatParams`），放在叶子模块里谁都能引。

测试在 `src/lib/ai/__tests__/refusal.test.ts`：五个真实适配器 × 十二种报文形状，在 `globalThis.fetch` 上桩拒绝，断言作者拿到的整句、
脚手架不进报错、三种退回原文；对「message 点名 / 只有 `param` 点名 / 上游点名」三种强制选择的拒绝，`classify` 都认得出，
`content_filter` 仍被 `isSafetyBlockMessage` 认出；① 在百炼上那一行 `data:` 的 400 端到端学到、以 `auto` 重发。去掉 `param`、
去掉 `metadata.raw`、把 ① 退回原文，各自都有测试失败（突变检查）。

## 4. 没做的

- **① ② ③ ④ 流中途的错误帧**（HTTP 200 里的 `data: {"error":…}`）照旧各读各的 `message`，没有改用 `vendorErrorText`：它们已经不带脚手架，
  换过去会给正在流通的报错加上标签与 id、改变每一族中途失败的措辞，是另一次决定。**已知的缺口**：中途帧同样可能只在 `param`
  里点名字段，而一个在第一个 chunk 之前到达的中途帧（中继先回 200 再报错）仍会被 `streamCompletion` 拿去学——那时学不到。
  这是改动之前就有的，这次没有变好也没有变坏；遇到样本时，改法是让那几处也走 `vendorErrorText`。
- **连接测试的 `/models` 被拒**（`providerProbe.ts` 的 `testProviderConnection`）仍原样显示报文。它不是适配器，报文也不会是 SSE；
  要改就是在那里调 `refusalText`，与上面的第 4 条不冲突。
- **MiniMax 的 `base_resp`**（[`streaming.md`](streaming.md) §3.2）只在 200 里见过，非 2xx 是不是这个形状没有样本，读取器不认它，退回原文。
- 多行 `data:` 拼接（SSE 规范允许）不认，没有厂商这样发过拒绝。
