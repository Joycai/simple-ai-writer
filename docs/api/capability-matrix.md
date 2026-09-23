# 能力矩阵（生成物，勿手改）

> **状态：`living`——由 `src/lib/ai/capabilities.ts` 的两张表渲染，`capabilities.test.ts` 保证与代码一致。**
> 改的是那两张表；改完用测试文件头注里的命令重新生成。设计与理由：[`capability-gating-plan.md`](capability-gating-plan.md)。
>
> `✓` 会发送 · `?` 未实测、照发并在抽屉里注明 · `·` 不发送。符号后面是原因码；「按模型」= 该格还要过模型 id 这一轴。
> 空格 = 这个平台没有这一族的线路。模型类型（看图的能力只对多模态 / 视觉模型成立）不在此表内——那是模型行上的事，不是线路上的。

## pdfInput

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
| volcengine-plan | ✓ protocol | ✓ protocol |  | ✓ measured |
| zhipu | ✓ protocol |  |  |  |
| orcarouter | ✓ protocol | ✓ protocol | · | · |
| newapi | ✓ 按模型 protocol | ✓ protocol | · | · |
| ollama | ✓ protocol |  |  |  |
| comfyui | ✓ protocol |  |  |  |
| custom | ✓ 按模型 protocol | ✓ protocol | · | · |

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
| newapi | ✓ 按模型 protocol | ✓ protocol | ✓ protocol | ✓ 按模型 protocol |
| ollama | ✓ protocol |  |  |  |
| comfyui | ✓ protocol |  |  |  |
| custom | ✓ 按模型 protocol | ✓ protocol | ✓ protocol | ✓ 按模型 protocol |

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
| newapi | ✓ protocol | ✓ protocol | ✓ protocol | · |
| ollama | ✓ protocol |  |  |  |
| comfyui | ✓ protocol |  |  |  |
| custom | ✓ protocol | ✓ protocol | ✓ protocol | · |

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
| newapi | · | ✓ protocol | · | · |
| ollama | · |  |  |  |
| comfyui | · |  |  |  |
| custom | · | ✓ protocol | · | · |

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
| newapi | ✓ 按模型 protocol | ✓ protocol | ✓ protocol | · |
| ollama | ✓ protocol |  |  |  |
| comfyui | ✓ protocol |  |  |  |
| custom | ✓ 按模型 protocol | ✓ protocol | ✓ protocol | · |

## jsonSchema

`native` · 规则缺省适用的协议族：Chat / Resp / Gemini

| 平台 | Chat | Resp | Gemini | Anth |
| --- | --- | --- | --- | --- |
| openai | ✓ measured | ✓ measured |  |  |
| anthropic |  |  |  | · |
| google |  |  | ✓ measured |  |
| deepseek | ? unmeasured | ? unmeasured |  | · |
| dashscope | ✓ measured | ? unmeasured |  | · |
| dashscope-intl | ✓ measured | ? unmeasured |  |  |
| xai | ? unmeasured | ✓ measured |  |  |
| minimax | ? unmeasured |  |  | · |
| volcengine | ? unmeasured | ? unmeasured |  |  |
| volcengine-plan | ✓ measured | ✓ measured |  | · |
| zhipu | · |  |  |  |
| orcarouter | ? unmeasured | ? unmeasured | ? unmeasured | · |
| newapi | ? unmeasured | ? unmeasured | ? unmeasured | · |
| ollama | ? unmeasured |  |  |  |
| comfyui | ? unmeasured |  |  |  |
| custom | ? unmeasured | ? unmeasured | ? unmeasured | · |

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
| orcarouter | · | ? unmeasured | · | ? unmeasured |
| newapi | · | ? unmeasured | · | ? 按模型 unmeasured |
| ollama | · |  |  |  |
| comfyui | · |  |  |  |
| custom | · | ? unmeasured | · | ? 按模型 unmeasured |

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
