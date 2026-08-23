# 同轮工具调用并行执行 · 设计与实现记录

> **Status: shipped** · 2026-08-23 设计并落地（单片 PR）
> 范围：`runAgent` 的工具执行循环。**不是**多智能体编排框架——subagent-lld §非目标
> （无子代理间通信、无并行编排、无递归）原封不动；这里并行的是**模型自己在一轮里
> 发出的多个 tool call** 的执行侧，编排权始终在模型手里。

## 1. 问题

模型在一轮里发出 N 个 tool call 时（三个协议族都支持，累积层 `roundToolCalls` 也早已
是数组），`runtime.ts` 的执行循环逐个 `await`。本地读文件是毫秒级，无所谓；但
`delegate` 每次是一整个子模型运行——网络请求、可能多轮循环，动辄十几秒。一轮
「查 A 资料 + 搜 B + 看图 C」三个 delegate 串行，作者等三倍时间，而三者互相之间没有
任何数据依赖。

## 2. 方案：按 access 分段，读并行、写作屏障

`registry` 的 `access` 字段本来就是精确的边界，直接派生，不另立第二份清单
（`isParallelSafeTool`，registry.ts）：

- **`read` 层（含 `delegate`）→ 可并行**：纯 IO，只读自己的输入；run 级的
  `loreIndex` 克隆对它们只读。
- **`write-auto` / `write-approval` → 屏障**，各自独占一段，前面全部落定才执行。
  两个理由都关正确性，不是保守：
  - L2 工具阻塞在审批卡上——并发就是同时叠两张卡；且 `editApply` 的 occurrence
    计数假设文档在提案与落盘之间不动，同轮两个编辑并发会互相打破对方的计数。
  - L1 工具改 lore 快照和磁盘，并发写同一实体会竞态。
- 未知工具名视为安全：`executeRegisteredTool` 对它只回错误文本，什么都不执行。

执行：`partitionParallelSegments` 把一轮的调用按原序切段（连续 read 归一段，写各成
一段），并行段用 `runLanes` 跑，**并发上限 4**（`MAX_PARALLEL_TOOLS`——delegate 是
真金白银的端点请求，供应商有限流；本地读快到无所谓上限）。

## 3. 不变量（改这段代码前先读）

1. **history 顺序不变**。段内结果先收集、段落定后按模型的调用原序追加 tool 消息和
   图片 follow-up。三个协议的重放因此和串行时代逐字节一致。
2. **配对不变量不破**。worker 永不 throw（每个调用必然记下一个结果，错误也是文本
   结果），所以 `Promise.all` 不会半途 reject 丢下兄弟调用；abort 时未派发的调用照旧
   拿 `ABORTED_TOOL_RESULT` 存根。与串行版的差别只有一处语义：abort 落下时**已在
   飞行中**的调用会跑到自己的头（它们持有同一个 signal，自己会尽快断），而不是
   「下一个循环迭代」被拦住——存根只发给还没派发的。
3. **事件日志天然兼容**。`tool-step` 按 `(parentStep, toolCallId, name)` 折叠
   （events.ts `replaceableIndex`），乱序完成只是替换各自的行；多行同时 running
   正是并行该有的样子。
4. **`writeTaskNote` 自串行**（挂在 taskWorkspace 的 `writeChain` 上）。它的 slug
   探测是 check-then-write，两个并行 delegate 撞同名 slug 时后写的会静默覆盖先写的
   ——这恰是 notes 目录的「永不覆盖」规则要防的丢失。**因此调用方绝不能再在
   `serializeTaskWrite` 里包它**：同链重入 = 外层等内层、内层排在外层后面，死锁。
   `write_note` 工具（scratchpadTools）为此去掉了外层包裹；task_plan / task_progress
   只碰 task.md，保持原样。
5. **`ensure()` 不需要链**：`activeId` 在第一个 await 之前同步赋值，JS 单线程下
   双重创建不可能发生；第二个调用方拿到 dir 时 task.md 可能还没写完，但 notes 路径
   不读它，`patchTaskDoc` 对缺失的 task.md 是 no-op。

## 4. 模型侧配合

执行器并行只在模型**真的一轮发多个调用**时兑现。`ai.instructions.agent`（zh/en）的
「工作方式」一节从「一轮里可以连续调用多个工具」升级为明确指令：独立的只读查询和
delegate 要在同一轮一次性全部发出，并说明写入类不受影响。工具 schema 一个字没动
（`delegate` 的 634/720 预算余量太小，且指引属于流程而非工具语义）。

## 5. 测试

- `agentRuntimeParallel.test.ts`：读调用真实重叠（两个都派发后才放行任何一个）、
  结果乱序完成但 history 按原序、写调用作为屏障（前后读段都等它）、abort 时超出
  lane 上限排队中的调用拿存根且配对完整、`isParallelSafeTool` 的层级判定。
- `taskNoteConcurrency.test.ts`：同 slug 并发写出两个文件而非覆盖，落败方拿到
  `renamedFrom`。
- 既有 runtime 测试（含 abort 中途配对、串行时代写的全部行为断言）不改一字全数通过
  ——这是「history 顺序不变」的回归证据。

## 6. 明确不做的

- **不做跨轮编排 / 子代理互通 / 递归**——subagent-lld 的非目标原样有效。
- **不并行 L1 写**（哪怕两个写不同实体理论上无冲突）：收益是毫秒级，代价是把
  「写永远串行」这条一句话不变量换成按实体粒度的锁分析。
- **不给并行段做进度聚合 UI**：执行日志的多行 running 已经如实呈现。
