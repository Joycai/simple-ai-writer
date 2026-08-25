# 按输入长度分档的计价，平价字段表达不了

> **状态：open。** 事实已确认（2026-08-25 实查千问模型页），未实现，也暂不实现——
> 失真只发生在单次请求输入跨过档位门槛时，本应用的典型任务离 256K 门槛很远。
> 这里记下证据和设计草案，等真的撞上（或千问把门槛下调）再动手。

## 现象

qwen3.7-plus 的定价页（`qianwenai.com/models/qwen3.7-plus`）不是一张平价表：

- 价格表顶部是一个**档位下拉**，默认「输入<=256k」——平价定价不需要门槛标签，
  这个下拉本身就是分档存在的证明；
- 页面侧栏给出了跨档的上下界：**输入 ¥1.6 – 4.8/M tokens，输出 ¥6.4 – 19.2/M**。
  顶档单价是底档的 **3 倍**——跨档失真不是零头；
- 计费语义（DashScope 惯例）：按**这一次请求的输入 token 数落在哪一档**，
  整单（含输出侧）用那一档的单价。

同一张表还暴露了第二根缺失的价格轴：**显式缓存创建 ¥2/M**（写入价）。
现在的 `priceCachedIn` 只有命中价，没有写入价——Anthropic 式 cache write
计费是同一个洞。Batch 档（Batch File / Batch Chat）不用管，app 不走 batch 端点。

## 现状与影响圈

`Model` 行只有三个平价字段（`priceIn` / `priceCachedIn` / `priceOut`，USD per 1M），
`costFor`（`lib/ai/configDb.ts`）拿它们线性计算。

影响止于**成本统计**：价格字段只进 `token_usage.cost_usd` 和用量页汇总，
不影响任何路由、上下文预算或行为。算错的后果是账面失真，不是功能故障。

两条既有的、独立的失真顺带记在这里，实现时别混为一谈：

1. 标价是人民币，字段存 USD——作者填价时自行换汇，一直如此；
2. 限时折扣（页面上 ¥2 划掉写 ¥1.6）——作者填的是哪个就是哪个，app 无从知晓。

## 设计草案（实现时的起点，不是承诺）

原则：L3 的**可选**声明，不向平价模型收税。

- `Model` 增加可选 `priceTiers?: { upToInput: number; priceIn: number;
  priceCachedIn: number; priceOut: number }[]`（升序，最后一档 `upToInput` 可为
  `Infinity`/缺省）。字段缺省 = 现有三个平价字段，行为零变化；
- `costFor` 多一步：有 `priceTiers` 时按本次 `inputTokens` 选档，无则走老路。
  **改动收在这一个函数里**，全部调用点不动（`imageCostFor` 不受影响——
  图片端点没有这种分档）；
- 显式缓存写入价若同期做，是 `costFor` 的第四个参数（cache creation tokens），
  但 OpenAI 兼容面的 usage 里要先确认有没有这个计数可读（`cache_creation`
  字段见 `docs/issues/thinking-verification.md` §2.8 同类问题：发没发 ≠ 报没报）；
- UI 藏在模型抽屉的高级折叠里；
- 落库走 `caps` 同款 JSON 列或新列均可,但**配置备份/同步**
  （`lib/ai/configTransfer.ts`、`lib/configsync/`）要同步携带新字段——
  这两处是历史上加模型字段时最容易漏的。

## 相关

- 同一次调查确认了 DashScope 兼容面**流式**响应带
  `prompt_tokens_details.cached_tokens`（两次实测 curl，2048/2215 命中），
  现有解析链路（`openai.ts` → `persistUsage` → `token_usage.cached_tokens`）
  完整可用——缓存**计数**不依赖本文任何改动，价格不配也照记。
