# 小模型三处缺口 — gemma4:12b on ollama 0.32，2026-08-21

> 状态：`research`。一次台架跑分，不是契约——数字随模型和机器走。结论（三条规则）住在 [`reference/architecture.md` → 小模型 / 本地端点](../../../reference/architecture.md#小模型--本地端点三处不能靠模型自己推断的地方)；这里是得出它们的实测。
>
> 2026-09 从 `architecture.md` 移出（`reference/` 只放今天为真的规则，测量放 `feature/`）。落地提交：`fix(ai): 小模型跑不动，是因为请求里有三处话没说`。

用 `gemma4:12b` 在 ollama 0.32 上走真实代码路径。协议本身没问题：流式 `tool_calls` 能正确累加，`content: null` + `role: "tool"` 配对被接受，回显的 `_reasoning` 字段在输入侧被忽略，`response_format: json_object` 能用且与思考分开，ollama 按满额 262144 `num_ctx` 加载了模型——常见嫌疑都排除了。

## 1. read 档任务没说自己有工具

真实的续写形态，是否调用了知识库工具：

| system prompt | 调用了知识库工具 |
|---|---|
| before（无 briefing） | 6 / 10 |
| after（`ai.instructions.toolsRead`） | 9 / 10 |

每格 n=10，两次坐下合并。样本小，差距的**大小**不值得报到小数点——它确立的是方向：模型从来不是拒绝查，只是从没被告知可以查。

## 2. 具名的强制 `tool_choice`

`{type:"function",function:{name}}` 被 ollama **静默忽略**：回一段散文、没有工具调用，走到 `EMPTY_TOOL_CALL`，白花一整次请求之后 JSON 兜底才跑。换成 `"required"` 就好。

## 3. 温度

原假设——温度 1 让工具选择飘忽——**测了，被否掉**。全量 39 个工具、一个含糊请求，每个温度 8 次：

| | 首选工具 | 参数畸形 |
|---|---|---|
| temp 1.0（ollama 默认） | `list_lore_entities` 8/8 | 0 |
| temp 0.2 | `list_lore_entities` 8/8 | 0 |

真正有变化的是欠规定的续写——模型到底伸不伸手去拿工具（每格 n=6）：

| | 默认温度 | temp 0.2 |
|---|---|---|
| 无 briefing | 4/6 | 6/6 |
| 有 briefing | 5/6 | 6/6 |

要连着 briefing 那一行读：§1 就位之后，剩下的空间是 n=6 里的一次，什么也证明不了。**briefing 是修法，温度不是。** 温度还有代价：同一上下文出 5 个版本，两两三元组平均重合 1.0 时 3%、0.7 时 6%、0.2 时 8%——幅度小，但对「N 个不同版本」这个功能来说方向是错的（`lib/ai/drafts.ts`）。

gemma4 的 Modelfile 默认是 `temperature 1 / top_k 64 / top_p 0.95`。
