# 能力矩阵（生成物，勿手改）

> **状态：`living`——由 `src/lib/ai/capabilities.ts` 的三张表渲染，`capabilities.test.ts` 保证与代码一致。**
> 改的是那三张表；改完用测试文件头注里的命令重新生成。设计与理由：[`capability-gating-plan.md`](capability-gating-plan.md)。
>
> `✓` 会发送 · `?` 未实测、照发并在抽屉里注明 · `·` 不发送。符号后面是原因码；「按模型」= 该格还要过模型 id 这一轴；
> 「按上游」= 中转站上还要看模型背后的上游（本文末节）。表里是没有上游时的答案。
> 空格 = 这个平台没有这一族的线路。模型类型（看图的能力只对多模态 / 视觉模型成立）不在此表内——那是模型行上的事，不是线路上的。

## pdfInput

`native` · 规则缺省适用的协议族：Chat / Resp

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | ✓ protocol | ✓ protocol |  |  |
| anthropic |  |  |  | ✓ measured |
| google |  |  | · |  |
| deepseek | ✓ protocol | ✓ protocol |  | · |
| dashscope | ✓ protocol | ✓ protocol |  | · |
| dashscope-intl | ✓ protocol | ✓ protocol |  |  |
| xai | ✓ protocol | ✓ protocol |  |  |
| minimax | ✓ protocol |  |  | · |
| volcengine | ✓ protocol | ✓ protocol |  |  |
| volcengine-plan | ✓ protocol | ✓ protocol |  | ✓ measured |
| zhipu | ✓ protocol |  |  |  |
| orcarouter | ✓ protocol | ✓ protocol | ✓ measured | ✓ measured |
| newapi | ✓ 按上游 protocol | ✓ 按上游 protocol | · | · 按上游 |
| ollama | ✓ protocol |  |  |  |
| comfyui | ✓ protocol |  |  |  |
| custom | ✓ 按上游 protocol | ✓ 按上游 protocol | · | · 按上游 |

## vlHighResolution

`private` · 规则缺省适用的协议族：Chat

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | · | · |  |  |
| anthropic |  |  |  | · |
| google |  |  | · |  |
| deepseek | · | · |  | · |
| dashscope | ✓ measured | · |  | · |
| dashscope-intl | ✓ measured | · |  |  |
| xai | · | · |  |  |
| minimax | · |  |  | · |
| volcengine | · | · |  |  |
| volcengine-plan | · | · |  | · |
| zhipu | · |  |  |  |
| orcarouter | · | · | · | · |
| newapi | ? relay | · | · | · |
| ollama | · |  |  |  |
| comfyui | · |  |  |  |
| custom | ? relay | · | · | · |

## videoInput

`native` · 规则缺省适用的协议族：Chat

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | ✓ protocol | · |  |  |
| anthropic |  |  |  | · |
| google |  |  | · |  |
| deepseek | ✓ protocol | · |  | · |
| dashscope | ✓ protocol | · |  | · |
| dashscope-intl | ✓ protocol | · |  |  |
| xai | ✓ protocol | · |  |  |
| minimax | ✓ protocol |  |  | · |
| volcengine | ✓ protocol | · |  |  |
| volcengine-plan | ✓ protocol | · |  | · |
| zhipu | ✓ protocol |  |  |  |
| orcarouter | ✓ protocol | · | · | · |
| newapi | ✓ protocol | · | · | · |
| ollama | ✓ protocol |  |  |  |
| comfyui | ✓ protocol |  |  |  |
| custom | ✓ protocol | · | · | · |

## videoFps

`private` · 规则缺省适用的协议族：Chat

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | · | · |  |  |
| anthropic |  |  |  | · |
| google |  |  | · |  |
| deepseek | · | · |  | · |
| dashscope | ✓ measured | · |  | · |
| dashscope-intl | ✓ measured | · |  |  |
| xai | · | · |  |  |
| minimax | · |  |  | · |
| volcengine | · | · |  |  |
| volcengine-plan | · | · |  | · |
| zhipu | · |  |  |  |
| orcarouter | · | · | · | · |
| newapi | ? relay | · | · | · |
| ollama | · |  |  |  |
| comfyui | · |  |  |  |
| custom | ? relay | · | · | · |

## forcedToolChoice

`native` · 规则缺省适用的协议族：Chat / Resp / Gemini / Anth

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | ✓ protocol | ✓ protocol |  |  |
| anthropic |  |  |  | ✓ protocol |
| google |  |  | ✓ protocol |  |
| deepseek | ✓ protocol | ✓ protocol |  | ✓ protocol |
| dashscope | ✓ protocol | ✓ protocol |  | ✓ protocol |
| dashscope-intl | ✓ protocol | ✓ protocol |  |  |
| xai | ✓ protocol | ✓ protocol |  |  |
| minimax | ✓ protocol |  |  | ✓ protocol |
| volcengine | ✓ protocol | ✓ protocol |  |  |
| volcengine-plan | ✓ protocol | ✓ protocol |  | ✓ protocol |
| zhipu | · |  |  |  |
| orcarouter | ✓ protocol | ✓ protocol | ✓ protocol | ✓ protocol |
| newapi | ✓ 按上游 protocol | ✓ 按上游 protocol | ✓ protocol | ✓ 按上游 protocol |
| ollama | ✓ protocol |  |  |  |
| comfyui | ✓ protocol |  |  |  |
| custom | ✓ 按上游 protocol | ✓ 按上游 protocol | ✓ protocol | ✓ 按上游 protocol |

## temperature

`native` · 规则缺省适用的协议族：Chat / Resp / Gemini / Anth

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | ✓ protocol | ✓ protocol |  |  |
| anthropic |  |  |  | · |
| google |  |  | ✓ protocol |  |
| deepseek | ✓ protocol | ✓ protocol |  | · |
| dashscope | ✓ protocol | ✓ protocol |  | · |
| dashscope-intl | ✓ protocol | ✓ protocol |  |  |
| xai | ✓ protocol | ✓ protocol |  |  |
| minimax | ✓ protocol |  |  | · |
| volcengine | ✓ protocol | ✓ protocol |  |  |
| volcengine-plan | ✓ protocol | ✓ protocol |  | · |
| zhipu | ✓ protocol |  |  |  |
| orcarouter | ✓ protocol | ✓ protocol | ✓ protocol | · |
| newapi | ✓ protocol | ✓ 按上游 protocol | ✓ protocol | · |
| ollama | ✓ protocol |  |  |  |
| comfyui | ✓ protocol |  |  |  |
| custom | ✓ protocol | ✓ 按上游 protocol | ✓ protocol | · |

## textVerbosity

`native` · 规则缺省适用的协议族：Resp

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | · | ✓ protocol |  |  |
| anthropic |  |  |  | · |
| google |  |  | · |  |
| deepseek | · | ✓ protocol |  | · |
| dashscope | · | ✓ protocol |  | · |
| dashscope-intl | · | ✓ protocol |  |  |
| xai | · | ✓ protocol |  |  |
| minimax | · |  |  | · |
| volcengine | · | ✓ protocol |  |  |
| volcengine-plan | · | ✓ protocol |  | · |
| zhipu | · |  |  |  |
| orcarouter | · | ✓ protocol | · | · |
| newapi | · | ✓ 按上游 protocol | · | · |
| ollama | · |  |  |  |
| comfyui | · |  |  |  |
| custom | · | ✓ 按上游 protocol | · | · |

## instructionsField

`native` · 规则缺省适用的协议族：Resp

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | · | ✓ protocol |  |  |
| anthropic |  |  |  | · |
| google |  |  | · |  |
| deepseek | · | ✓ protocol |  | · |
| dashscope | · | ✓ protocol |  | · |
| dashscope-intl | · | ✓ protocol |  |  |
| xai | · | ✓ protocol |  |  |
| minimax | · |  |  | · |
| volcengine | · | ✓ protocol |  |  |
| volcengine-plan | · | ✓ protocol |  | · |
| zhipu | · |  |  |  |
| orcarouter | · | ✓ protocol | · | · |
| newapi | · | ✓ 按上游 protocol | · | · |
| ollama | · |  |  |  |
| comfyui | · |  |  |  |
| custom | · | ✓ 按上游 protocol | · | · |

## translateFormat

`native` · 规则缺省适用的协议族：Chat

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | ✓ protocol | · |  |  |
| anthropic |  |  |  | · |
| google |  |  | · |  |
| deepseek | ✓ protocol | · |  | · |
| dashscope | ✓ protocol | · |  | · |
| dashscope-intl | ✓ protocol | · |  |  |
| xai | ✓ protocol | · |  |  |
| minimax | ✓ protocol |  |  | · |
| volcengine | ✓ protocol | · |  |  |
| volcengine-plan | ✓ protocol | · |  | · |
| zhipu | ✓ protocol |  |  |  |
| orcarouter | ✓ protocol | · | · | · |
| newapi | ✓ protocol | · | · | · |
| ollama | ✓ protocol |  |  |  |
| comfyui | ✓ protocol |  |  |  |
| custom | ✓ protocol | · | · | · |

## structuredOutput

`native` · 规则缺省适用的协议族：Chat / Resp / Gemini / Anth

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | ✓ protocol | ✓ protocol |  |  |
| anthropic |  |  |  | ✓ protocol |
| google |  |  | ✓ protocol |  |
| deepseek | ✓ protocol | ✓ protocol |  | ✓ protocol |
| dashscope | ✓ protocol | ✓ protocol |  | ✓ protocol |
| dashscope-intl | ✓ protocol | ✓ protocol |  |  |
| xai | ✓ protocol | ✓ protocol |  |  |
| minimax | ✓ protocol |  |  | ✓ protocol |
| volcengine | ✓ protocol | ✓ protocol |  |  |
| volcengine-plan | ✓ protocol | ✓ protocol |  | ✓ protocol |
| zhipu | ✓ protocol |  |  |  |
| orcarouter | ✓ protocol | ✓ protocol | ✓ protocol | ✓ protocol |
| newapi | ✓ 按上游 protocol | ✓ 按上游 protocol | ✓ protocol | ✓ protocol |
| ollama | ✓ protocol |  |  |  |
| comfyui | ✓ protocol |  |  |  |
| custom | ✓ 按上游 protocol | ✓ 按上游 protocol | ✓ protocol | ✓ protocol |

## jsonSchema

`native` · 规则缺省适用的协议族：Chat / Resp / Gemini / Anth

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | ✓ measured | ✓ measured |  |  |
| anthropic |  |  |  | ✓ measured |
| google |  |  | ✓ measured |  |
| deepseek | ? unmeasured | ? unmeasured |  | ? unmeasured |
| dashscope | ✓ measured | ? unmeasured |  | ? unmeasured |
| dashscope-intl | ✓ measured | ? unmeasured |  |  |
| xai | ? unmeasured | ✓ measured |  |  |
| minimax | ? unmeasured |  |  | ? unmeasured |
| volcengine | ? unmeasured | ? unmeasured |  |  |
| volcengine-plan | ✓ measured | ✓ measured |  | ? unmeasured |
| zhipu | · |  |  |  |
| orcarouter | ✓ measured | ✓ measured | ✓ measured | ✓ measured |
| newapi | ? 按上游 unmeasured | ? 按上游 unmeasured | ? unmeasured | ? unmeasured |
| ollama | ? unmeasured |  |  |  |
| comfyui | ? unmeasured |  |  |  |
| custom | ? 按上游 unmeasured | ? 按上游 unmeasured | ? unmeasured | ? unmeasured |

## web_search

`native` · 规则缺省适用的协议族：Resp / Anth

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | · | ✓ measured |  |  |
| anthropic |  |  |  | ✓ measured |
| google |  |  | · |  |
| deepseek | · | ? unmeasured |  | ? unmeasured |
| dashscope | ✓ measured | ✓ measured |  | ? unmeasured |
| dashscope-intl | ✓ measured | ✓ measured |  |  |
| xai | · | ✓ measured |  |  |
| minimax | · |  |  | ✓ measured |
| volcengine | · | ? unmeasured |  |  |
| volcengine-plan | · | ✓ measured |  | ✓ measured |
| zhipu | · |  |  |  |
| orcarouter | · | ✓ measured | · | ✓ measured |
| newapi | · | ? 按上游 unmeasured | · | ? 按上游 unmeasured |
| ollama | · |  |  |  |
| comfyui | · |  |  |  |
| custom | · | ? 按上游 unmeasured | · | ? 按上游 unmeasured |

## web_extractor

`private` · 规则缺省适用的协议族：Chat / Resp

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | · | · |  |  |
| anthropic |  |  |  | · |
| google |  |  | · |  |
| deepseek | · | · |  | · |
| dashscope | ✓ measured | ✓ measured |  | · |
| dashscope-intl | ✓ measured | ✓ measured |  |  |
| xai | · | · |  |  |
| minimax | · |  |  | · |
| volcengine | · | · |  |  |
| volcengine-plan | · | · |  | · |
| zhipu | · |  |  |  |
| orcarouter | · | · | · | · |
| newapi | · | · | · | · |
| ollama | · |  |  |  |
| comfyui | · |  |  |  |
| custom | · | · | · | · |

## web_search_image

`private` · 规则缺省适用的协议族：Resp

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | · | · |  |  |
| anthropic |  |  |  | · |
| google |  |  | · |  |
| deepseek | · | · |  | · |
| dashscope | · | ✓ measured |  | · |
| dashscope-intl | · | ✓ measured |  |  |
| xai | · | · |  |  |
| minimax | · |  |  | · |
| volcengine | · | · |  |  |
| volcengine-plan | · | · |  | · |
| zhipu | · |  |  |  |
| orcarouter | · | · | · | · |
| newapi | · | · | · | · |
| ollama | · |  |  |  |
| comfyui | · |  |  |  |
| custom | · | · | · | · |

## image_search

`private` · 规则缺省适用的协议族：Resp

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | · | · |  |  |
| anthropic |  |  |  | · |
| google |  |  | · |  |
| deepseek | · | · |  | · |
| dashscope | · | ✓ measured |  | · |
| dashscope-intl | · | ✓ measured |  |  |
| xai | · | · |  |  |
| minimax | · |  |  | · |
| volcengine | · | · |  |  |
| volcengine-plan | · | · |  | · |
| zhipu | · |  |  |  |
| orcarouter | · | · | · | · |
| newapi | · | · | · | · |
| ollama | · |  |  |  |
| comfyui | · |  |  |  |
| custom | · | · | · | · |

## code_interpreter

`private` · 规则缺省适用的协议族：Chat / Resp

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | · | · |  |  |
| anthropic |  |  |  | · |
| google |  |  | · |  |
| deepseek | · | · |  | · |
| dashscope | ✓ 按模型 measured | ✓ 按模型 measured |  | · |
| dashscope-intl | ✓ 按模型 measured | ✓ 按模型 measured |  |  |
| xai | · | · |  |  |
| minimax | · |  |  | · |
| volcengine | · | · |  |  |
| volcengine-plan | · | · |  | · |
| zhipu | · |  |  |  |
| orcarouter | · | · | · | · |
| newapi | · | · | · | · |
| ollama | · |  |  |  |
| comfyui | · |  |  |  |
| custom | · | · | · | · |

## 中转站上游画像

中转站平台（`newapi` / `custom`）上，模型背后的上游由 `relayUpstream.ts` 解析（模型手选 → 渠道前缀表 → id 里的产品名）。
上游的格子先于平台格生效，只作用于画像覆盖的模型（见表头各上游的作用域）。`✓` 实测可用 · `·` 实测不生效 · 空 = 不写，落回平台格与规则。

| 能力 | 族 | kiro（Claude） | cc（Claude） | anti（Claude） | bedrock（Claude） | official（Claude） | codex（GPT） | azure（GPT） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pdfInput | Chat | · | ✓ | · | ✓ |  | ✓ | ✓ |
| pdfInput | Resp |  |  |  |  |  | ✓ | ✓ |
| pdfInput | Anth |  | ✓ |  | ✓ |  |  |  |
| forcedToolChoice | Chat | · |  | · | ✓ |  | ✓ | · |
| forcedToolChoice | Resp |  |  |  |  |  | ✓ | ✓ |
| forcedToolChoice | Anth | · |  | · | ✓ |  |  |  |
| temperature | Resp |  |  |  |  |  | · | · |
| textVerbosity | Resp |  |  |  |  |  | ✓ | ✓ |
| instructionsField | Resp |  |  |  |  |  | ✓ | · |
| structuredOutput | Chat | · |  |  |  |  |  | ✓ |
| structuredOutput | Resp |  |  |  |  |  |  | ✓ |
| jsonSchema | Chat |  |  |  |  |  |  | ✓ |
| jsonSchema | Resp |  |  |  |  |  |  | ✓ |
| web_search | Resp |  |  |  |  |  | ✓ | · |
| web_search | Anth | · | ✓ | · | · |  |  |  |
