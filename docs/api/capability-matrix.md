# 能力矩阵（生成物，勿手改）

> **状态：`living`——由 `src/lib/ai/capabilities.ts` 的三张表渲染，`capabilities.test.ts` 保证与代码一致。**
> 改的是那三张表；改完用测试文件头注里的命令重新生成。设计与理由：[`capability-gating-plan.md`](capability-gating-plan.md)。
>
> `✓` 会发送 · `?` 未实测、照发并在抽屉里注明 · `·` 不发送。符号后面是原因码；「按模型」= 该格还要过模型 id 这一轴；
> 「按上游」= 中转站上还要看模型背后的上游（本文末节）。表里是没有上游时的答案。
> 每格按该平台自己的那条线路问：官方标准还是兼容标准（规则的 `official`）。
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

## effortWithTools

`native` · 规则缺省适用的协议族：Chat / Resp

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | ✓ 按模型 protocol | ✓ protocol |  |  |
| anthropic |  |  |  | · |
| google |  |  | · |  |
| deepseek | ✓ protocol | ✓ protocol |  | · |
| dashscope | ✓ protocol | ✓ protocol |  | · |
| dashscope-intl | ✓ protocol | ✓ protocol |  |  |
| xai | ✓ protocol | ✓ protocol |  |  |
| minimax | ✓ protocol |  |  | · |
| volcengine | ✓ protocol | ✓ protocol |  |  |
| volcengine-plan | ✓ protocol | ✓ protocol |  | · |
| zhipu | ✓ protocol |  |  |  |
| orcarouter | ✓ 按模型 protocol | ✓ protocol | · | · |
| newapi | ✓ protocol | ✓ protocol | · | · |
| ollama | ✓ protocol |  |  |  |
| comfyui | ✓ protocol |  |  |  |
| custom | ✓ protocol | ✓ protocol | · | · |

## reasoningOff

`native` · 规则缺省适用的协议族：Chat / Resp

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | ✓ protocol | ✓ protocol |  |  |
| anthropic |  |  |  | · |
| google |  |  | · |  |
| deepseek | ✓ protocol | ✓ protocol |  | · |
| dashscope | ✓ protocol | ✓ protocol |  | · |
| dashscope-intl | ✓ protocol | ✓ protocol |  |  |
| xai | ✓ protocol | ✓ protocol |  |  |
| minimax | ✓ protocol |  |  | · |
| volcengine | ✓ protocol | ✓ protocol |  |  |
| volcengine-plan | ✓ protocol | ✓ protocol |  | · |
| zhipu | ✓ protocol |  |  |  |
| orcarouter | ✓ 按模型 protocol | ✓ 按模型 protocol | · | · |
| newapi | ✓ protocol | ✓ protocol | · | · |
| ollama | ✓ protocol |  |  |  |
| comfyui | ✓ protocol |  |  |  |
| custom | ✓ protocol | ✓ protocol | · | · |

## effortMax

`native` · 规则缺省适用的协议族：Chat / Resp

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | ✓ protocol | ✓ protocol |  |  |
| anthropic |  |  |  | · |
| google |  |  | · |  |
| deepseek | ✓ protocol | ✓ protocol |  | · |
| dashscope | ✓ protocol | ✓ protocol |  | · |
| dashscope-intl | ✓ protocol | ✓ protocol |  |  |
| xai | ✓ protocol | ✓ protocol |  |  |
| minimax | ✓ protocol |  |  | · |
| volcengine | ✓ protocol | ✓ protocol |  |  |
| volcengine-plan | ✓ protocol | ✓ protocol |  | · |
| zhipu | ✓ protocol |  |  |  |
| orcarouter | ✓ 按模型 protocol | ✓ protocol | · | · |
| newapi | ✓ protocol | ✓ protocol | · | · |
| ollama | ✓ protocol |  |  |  |
| comfyui | ✓ protocol |  |  |  |
| custom | ✓ protocol | ✓ protocol | · | · |

## effortMinimal

`native` · 规则缺省适用的协议族：Chat / Resp

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | ✓ protocol | ✓ protocol |  |  |
| anthropic |  |  |  | · |
| google |  |  | · |  |
| deepseek | ✓ protocol | ✓ protocol |  | · |
| dashscope | ✓ protocol | ✓ protocol |  | · |
| dashscope-intl | ✓ protocol | ✓ protocol |  |  |
| xai | ✓ protocol | ✓ protocol |  |  |
| minimax | ✓ protocol |  |  | · |
| volcengine | ✓ protocol | ✓ protocol |  |  |
| volcengine-plan | ✓ protocol | ✓ protocol |  | · |
| zhipu | ✓ protocol |  |  |  |
| orcarouter | ✓ 按模型 protocol | ✓ protocol | · | · |
| newapi | ✓ protocol | ✓ protocol | · | · |
| ollama | ✓ protocol |  |  |  |
| comfyui | ✓ protocol |  |  |  |
| custom | ✓ protocol | ✓ protocol | · | · |

## temperature

`native` · 规则缺省适用的协议族：Chat / Resp / Gemini / Anth

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | ✓ protocol | ✓ 按模型 protocol |  |  |
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
| orcarouter | ✓ protocol | ✓ 按模型 protocol | ✓ protocol | · |
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

## jsonObjectTier

`native` · 规则缺省适用的协议族：Chat / Resp / Gemini

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
| newapi | ✓ protocol | ✓ protocol | ✓ protocol | · |
| ollama | ✓ protocol |  |  |  |
| comfyui | ✓ protocol |  |  |  |
| custom | ✓ protocol | ✓ protocol | ✓ protocol | · |

## promptCache

`private` · 规则缺省适用的协议族：Anth

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | · | · |  |  |
| anthropic |  |  |  | ✓ protocol |
| google |  |  | · |  |
| deepseek | · | · |  | · |
| dashscope | · | · |  | · |
| dashscope-intl | · | · |  |  |
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

## web_search

`native` · 规则缺省适用的协议族：Resp / Anth / Gemini

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | · | ✓ measured |  |  |
| anthropic |  |  |  | ✓ measured |
| google |  |  | ? unmeasured |  |
| deepseek | · | ? unmeasured |  | ? unmeasured |
| dashscope | ✓ measured | ✓ measured |  | ? unmeasured |
| dashscope-intl | ✓ measured | ✓ measured |  |  |
| xai | · | ✓ measured |  |  |
| minimax | · |  |  | ✓ measured |
| volcengine | · | ? unmeasured |  |  |
| volcengine-plan | · | ✓ measured |  | ✓ measured |
| zhipu | · |  |  |  |
| orcarouter | · | ✓ measured | ✓ measured | ✓ measured |
| newapi | · | ? 按上游 unmeasured | ? unmeasured | ? 按上游 unmeasured |
| ollama | · |  |  |  |
| comfyui | · |  |  |  |
| custom | · | ? 按上游 unmeasured | ? unmeasured | ? 按上游 unmeasured |

## web_extractor

`private` · 规则缺省适用的协议族：Chat / Resp / Gemini

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
| orcarouter | · | · | ✓ measured | · |
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

`private` · 规则缺省适用的协议族：Chat / Resp / Gemini

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
| orcarouter | · | · | ✓ measured | · |
| newapi | · | · | · | · |
| ollama | · |  |  |  |
| comfyui | · |  |  |  |
| custom | · | · | · | · |

## 思考类目缺省

模型行的思考类目留在「自动」时的取值：作者声明 → 旧方言迁移 → 平台格里这个 id 的行（只取本线路能拼的类目）→ 协议族缺省。
协议族缺省：Chat `openai-generic` · Resp `responses-effort` · Gemini `gemini3` · Anth `claude-adaptive`。下表只列平台行给出的、与族缺省不同来源的格。

| 平台 | 族 | 模型 id | 类目 |
| --- | --- | --- | --- |
| deepseek | Chat | `deepseek-flash` | `deepseek` |
| deepseek | Chat | `deepseek-v4-pro` | `deepseek` |
| volcengine-plan | Chat | `doubao-seed-2.0-lite` | `doubao` |
| volcengine-plan | Chat | `doubao-seed-2.0-mini` | `doubao` |
| volcengine-plan | Chat | `doubao-seed-2.1-turbo` | `doubao` |
| volcengine-plan | Anth | `doubao-seed-2.0-lite` | `doubao-switch` |
| volcengine-plan | Anth | `doubao-seed-2.0-mini` | `doubao-switch` |
| volcengine-plan | Anth | `doubao-seed-2.1-turbo` | `doubao-switch` |
| zhipu | Chat | `glm-5.3` | `glm` |
| zhipu | Chat | `glm-5.3-flash` | `glm` |
| zhipu | Chat | `glm-5.3-flashx` | `glm` |
| zhipu | Chat | `glm-5.2` | `glm-effort` |
| zhipu | Chat | `glm-5.1` | `glm-switch` |
| zhipu | Chat | `glm-5` | `glm-switch` |
| zhipu | Chat | `glm-5-turbo` | `glm-switch` |
| zhipu | Chat | `glm-4.7` | `glm-switch` |
| zhipu | Chat | `glm-4.6` | `glm-switch` |
| zhipu | Chat | `glm-4.5` | `glm-switch` |
| zhipu | Chat | `glm-4.5-air` | `glm-switch` |

## 输出上限来源

窗口与单次输出上限留空时的取值：作者值（含探测写入的）→ 平台格里这个 id 的行 → 全局模型目录（`cells/catalog.ts`，只有上限）→ 应用缺省（设置 → 通用，只有上限）。
每个值带着出处走，消费方只信自己收的出处：

| 消费方 | 收哪些出处 |
| --- | --- |
| planner | author · platform · catalog · protocol · default |
| contextGate | author |
| anthropicMaxTokens | author |

平台行给出的值（留空的行在该线路上得到的）：

| 平台 | 族 | 模型 id | 窗口 | 上限 |
| --- | --- | --- | --- | --- |
| deepseek | Chat | `deepseek-flash` | 1,048,576 | 393,216 |
| deepseek | Chat | `deepseek-v4-pro` | 1,048,576 | 393,216 |
| deepseek | Resp | `deepseek-flash` | 1,048,576 | 393,216 |
| deepseek | Resp | `deepseek-v4-pro` | 1,048,576 | 393,216 |
| deepseek | Anth | `deepseek-flash` | 1,048,576 | 393,216 |
| deepseek | Anth | `deepseek-v4-pro` | 1,048,576 | 393,216 |
| volcengine-plan | Chat | `doubao-seed-2.0-lite` | 262,144 | 131,072 |
| volcengine-plan | Chat | `doubao-seed-2.0-mini` | 262,144 | 131,072 |
| volcengine-plan | Chat | `doubao-seed-2.1-turbo` | 262,144 | 262,144 |
| volcengine-plan | Resp | `doubao-seed-2.0-lite` | 262,144 | 131,072 |
| volcengine-plan | Resp | `doubao-seed-2.0-mini` | 262,144 | 131,072 |
| volcengine-plan | Resp | `doubao-seed-2.1-turbo` | 262,144 | 262,144 |
| volcengine-plan | Anth | `doubao-seed-2.0-lite` | 262,144 | 131,072 |
| volcengine-plan | Anth | `doubao-seed-2.0-mini` | 262,144 | 131,072 |
| volcengine-plan | Anth | `doubao-seed-2.1-turbo` | 262,144 | 262,144 |
| zhipu | Chat | `glm-5.3` | 1,048,576 | 131,072 |
| zhipu | Chat | `glm-5.3-flash` | 1,048,576 | 131,072 |
| zhipu | Chat | `glm-5.3-flashx` | 1,048,576 | 131,072 |
| zhipu | Chat | `glm-5.2` | 1,048,576 | 131,072 |
| zhipu | Chat | `glm-5.1` | 204,800 | 131,072 |
| zhipu | Chat | `glm-5` | 204,800 | 131,072 |
| zhipu | Chat | `glm-5-turbo` | 204,800 | 131,072 |
| zhipu | Chat | `glm-4.7` | 204,800 | 131,072 |
| zhipu | Chat | `glm-4.6` | 204,800 | 131,072 |
| zhipu | Chat | `glm-4.5` | 131,072 | 98,304 |
| zhipu | Chat | `glm-4.5-air` | 131,072 | 98,304 |
| orcarouter | Chat | `openai/gpt-6-luna` | 1,050,000 | 128,000 |
| orcarouter | Chat | `openai/gpt-6-sol` | 1,050,000 | 128,000 |
| orcarouter | Chat | `openai/gpt-6-astra` | 1,050,000 | 128,000 |
| orcarouter | Chat | `openai/gpt-5.6-luna` | 1,050,000 | 128,000 |
| orcarouter | Chat | `openai/gpt-5.6-terra` | 1,050,000 | 128,000 |
| orcarouter | Chat | `openai/gpt-5.6-sol` | 1,050,000 | 128,000 |
| orcarouter | Chat | `anthropic/claude-sonnet-5` | 1,000,000 | 128,000 |
| orcarouter | Chat | `anthropic/claude-opus-5.5` | 1,000,000 | 128,000 |
| orcarouter | Chat | `anthropic/claude-fable-5.1` | 1,000,000 | 128,000 |
| orcarouter | Chat | `google/gemini-3.8-flash` | 1,048,576 | 65,536 |
| orcarouter | Resp | `openai/gpt-6-luna` | 1,050,000 | 128,000 |
| orcarouter | Resp | `openai/gpt-6-sol` | 1,050,000 | 128,000 |
| orcarouter | Resp | `openai/gpt-6-astra` | 1,050,000 | 128,000 |
| orcarouter | Resp | `openai/gpt-5.6-luna` | 1,050,000 | 128,000 |
| orcarouter | Resp | `openai/gpt-5.6-terra` | 1,050,000 | 128,000 |
| orcarouter | Resp | `openai/gpt-5.6-sol` | 1,050,000 | 128,000 |
| orcarouter | Resp | `anthropic/claude-sonnet-5` | 1,000,000 | 128,000 |
| orcarouter | Resp | `anthropic/claude-opus-5.5` | 1,000,000 | 128,000 |
| orcarouter | Resp | `anthropic/claude-fable-5.1` | 1,000,000 | 128,000 |
| orcarouter | Resp | `google/gemini-3.8-flash` | 1,048,576 | 65,536 |
| orcarouter | Anth | `openai/gpt-6-luna` | 1,050,000 | 128,000 |
| orcarouter | Anth | `openai/gpt-6-sol` | 1,050,000 | 128,000 |
| orcarouter | Anth | `openai/gpt-6-astra` | 1,050,000 | 128,000 |
| orcarouter | Anth | `openai/gpt-5.6-luna` | 1,050,000 | 128,000 |
| orcarouter | Anth | `openai/gpt-5.6-terra` | 1,050,000 | 128,000 |
| orcarouter | Anth | `openai/gpt-5.6-sol` | 1,050,000 | 128,000 |
| orcarouter | Anth | `anthropic/claude-sonnet-5` | 1,000,000 | 128,000 |
| orcarouter | Anth | `anthropic/claude-opus-5.5` | 1,000,000 | 128,000 |
| orcarouter | Anth | `anthropic/claude-fable-5.1` | 1,000,000 | 128,000 |
| orcarouter | Anth | `google/gemini-3.8-flash` | 1,048,576 | 65,536 |
| orcarouter | Gemini | `openai/gpt-6-luna` | 1,050,000 | 128,000 |
| orcarouter | Gemini | `openai/gpt-6-sol` | 1,050,000 | 128,000 |
| orcarouter | Gemini | `openai/gpt-6-astra` | 1,050,000 | 128,000 |
| orcarouter | Gemini | `openai/gpt-5.6-luna` | 1,050,000 | 128,000 |
| orcarouter | Gemini | `openai/gpt-5.6-terra` | 1,050,000 | 128,000 |
| orcarouter | Gemini | `openai/gpt-5.6-sol` | 1,050,000 | 128,000 |
| orcarouter | Gemini | `anthropic/claude-sonnet-5` | 1,000,000 | 128,000 |
| orcarouter | Gemini | `anthropic/claude-opus-5.5` | 1,000,000 | 128,000 |
| orcarouter | Gemini | `anthropic/claude-fable-5.1` | 1,000,000 | 128,000 |
| orcarouter | Gemini | `google/gemini-3.8-flash` | 1,048,576 | 65,536 |

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
