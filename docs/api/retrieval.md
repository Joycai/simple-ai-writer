# Embedding and rerank protocols

> Status: `living` · Ark Agent Plan, Qwen embeddings and Qwen native text rerank endpoints verified below; other formats retain fixture-only coverage. Official reference review: 2026-10-16.

These endpoints have their own request/response shapes; they are not chat-completion models.

| Format | Request | Response mapping | Usage |
| --- | --- | --- | --- |
| OpenAI embeddings | `POST /v1/embeddings`, `{model,input:string[],encoding_format:"float"}` | `data[].index` identifies the original input; `data[].embedding` is the vector | `usage.prompt_tokens` / `total_tokens` |
| Ollama native embeddings | `POST /api/embed`, `{model,input:string[],truncate:false}` | `embeddings` contains one vector per input | `prompt_eval_count` |
| DashScope multimodal embeddings | `POST /api/v1/services/embeddings/multimodal-embedding/multimodal-embedding`, `{model,input:{contents:[{text},…]}}` | `output.embeddings[].index` identifies each input; `embedding` is its vector | `usage.input_tokens` (text-only calls) |
| DashScope text rerank | `POST /api/v1/services/rerank/text-rerank/text-rerank`, `{model,input:{query,documents},parameters:{top_n}}` | `output.results[].index` and `relevance_score` | `usage.prompt_tokens` / `total_tokens` |
| Cohere rerank | `POST /v2/rerank`, `{model,query,documents:string[],top_n}` | `results[].index` identifies the input document; `relevance_score` orders relevance | `meta.billed_units.search_units`; not a token count |

OpenAI documents float or base64 outputs; explicitly requesting float avoids decoding ambiguity. Source: [OpenAI create embeddings reference](https://developers.openai.com/api/reference/resources/embeddings/methods/create).

Ollama accepts a string or array and normally truncates overlong input; `truncate:false` asks it to return an error instead. Source: [Ollama embed reference](https://docs.ollama.com/api/embed).

Cohere uses bearer authentication, accepts a list of strings and can limit the returned results with `top_n`. It documents automatic truncation for long documents via `max_tokens_per_doc`. Search units and input token counts are different billing quantities. Source: [Cohere v2 rerank reference](https://docs.cohere.com/v2/reference/rerank).

A compatible service can expose a different path while preserving these bodies. Native APIs with other bodies/authentication are not automatically covered. Embedding query/document prefixes are model-specific instructions: consult the selected model's own documentation. Scores from different models should not be treated as calibrated probabilities or compared as one shared scale.

Fixture tests validate the documented shapes; the live measurement below certifies only that endpoint/model/request combination.

## Ark Agent Plan live measurement — 2026-10-09

Official protocol reference: [Volcengine embedding integration guide](https://www.volcengine.com/docs/82379/2279748). The vendor guide describes OpenAI-compatible embeddings; the author supplied their Agent Plan base URL, which was tested exactly rather than substituted with the Coding Plan URL.

`POST https://ark.cn-beijing.volces.com/api/plan/v3/embeddings`, model `doubao-embedding-vision`, bearer authentication, `input` as four short Chinese strings and `encoding_format: "float"` returned HTTP 200 in 1.116 s. The response contained indexed `data[]` vectors, each 2,048 dimensions, and usage of 122 prompt/total tokens. Cosine scores for a poisoned-traveler query were 0.6356 for the healer, 0.1440 for a treasury and 0.0587 for a mountain gate. This is a small protocol/relevance smoke test, not a retrieval benchmark. No credentials or author documents are recorded here.

### Batch limit follow-up — 2026-10-09

The [official Agent Plan embedding guide](https://docs.volcengine.com/docs/ark/agent-plan-personal-vectorized-models?lang=zh) confirms the dedicated `/api/plan/v3` base, Agent Plan key and `doubao-embedding-vision` model. Live tests on the same `/embeddings` endpoint returned HTTP 400 for 32 inputs (both short strings and 1,600-character strings): `Embeddings API input limit exceeded: max 10, got 32`. A single 4,000-character input succeeded (HTTP 200, 3.62 s). Thus the earlier four-input success does not certify larger batches. This limit is measured for this endpoint, not inferred for all services exposing the same model name.

A follow-up request with 10 synthetic descriptions of 1,600 characters each succeeded: HTTP 200 in 1.49 s, 10 indexed vectors of 2,048 dimensions. No author documents or credentials are stored in this measurement.


## Qwen3-VL native text embeddings — 2026-10-16

Official references: [Qwen model page](https://www.qianwenai.com/models/qwen3-vl-embedding#overview) specifies the native `https://maas.qianwenaiapi.com/api/v1` base and DashScope `MultiModalEmbedding`; [HTTP API reference](https://www.alibabacloud.com/help/en/model-studio/multimodal-embedding-api-reference) specifies the service path, `input.contents`, independent/fused outputs, indices and usage. This is a different body/response contract from OpenAI embeddings. Merely changing an OpenAI `/embeddings` path cannot adapt it.

The documented independent mode returns one vector per content element; `enable_fusion=true` instead combines inputs into one vector. Text catalog batches use independent mode (omit fusion), put each text in its own `{text:…}` item, and do not send OpenAI's `encoding_format`. The documented per-request maximum for `qwen3-vl-embedding` is 20 content elements. Responses contain `output.embeddings[]` with `index`, `embedding` and `type`; `qwen3-vl-embedding` returned `type:"vl"` even for text. Order by index, require all input indices exactly once, and require equal nonzero vector dimensions. The default dimension is 2560.

Authorized measurement against `POST https://maas.qianwenaiapi.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding`, model `qwen3-vl-embedding`: four fictional Chinese texts returned HTTP 200 in 0.761 s, four independently indexed 2560-dimensional vectors, and `usage:{input_tokens:124,total_tokens:124,image_tokens:0}`. A snakebite-treatment query scored 0.6548 against the healer, 0.2861 against a treasury and 0.3548 against a mountain checkpoint. The opted-in `live.qwen-embedding.test.ts` then exercised the application adapter with 20 fictional short texts: 20 independent 2560-dimensional vectors, positive input usage and the healer ranked above the unrelated descriptions. It requires both `AI_WRITER_LIVE_QWEN_EMBEDDING=1` and `DASHSCOPE_API_KEY`; normal test runs do not incur this paid call.

Only text input was exercised. Image/video embedding, fused retrieval and general quality are not certified by these measurements. For these text-only calls `input_tokens` is the input usage; image/video accounting would need separate treatment before adding those modalities. Credentials, raw vectors and author content are not retained.


## Qwen3.7 text embedding Flash — 2026-10-16

Official references: [model page](https://www.qianwenai.com/models/qwen3.7-text-embedding-flash) and [embedding guide](https://platform.qianwenai.com/docs/developer-guides/embeddings/embedding). Unlike Qwen3-VL's native-only multimodal interface, this text model supports the standard OpenAI-compatible embeddings interface at `https://maas.qianwenaiapi.com/compatible-mode/v1/embeddings`. Use `{model:"qwen3.7-text-embedding-flash",input:string[],encoding_format:"float"}` and the indexed `data[].embedding` response. The native text interface also exists, but its `input.texts` contract is distinct from multimodal `input.contents`; these should not be interchanged.

The guide lists default 1024 dimensions (also 768, 512 and 256), 20 inputs per batch and a 128,000-token batch ceiling. The same 20-input cap is documented for `qwen3.7-text-embedding`. These are endpoint/model facts, not a reason to cap every OpenAI-compatible provider exposing a similar model name.

Authorized `live.qwen-embedding.test.ts` Flash case exercised the actual OpenAI-compatible embedding adapter, using the author's environment key and 20 fictional short texts: 20 independent 1024-dimensional vectors, positive prompt-token usage and the healer ranked above the treasury and mountain checkpoint for a snakebite query. No dimension override, native text interface, sparse output, task instruction or long-context limit was tested. This certifies only that endpoint/model/request combination; credentials and vectors are not retained.


## Qwen3.7 native text rerank — 2026-10-16

Official references: [model page](https://www.qianwenai.com/models/qwen3.7-text-rerank), [DashScope rerank reference](https://platform.qianwenai.com/docs/api-reference/rerank/dashscope-rerank) and [compatible rerank reference](https://platform.qianwenai.com/docs/api-reference/rerank/openai-rerank). The compatible endpoint explicitly supports only `qwen3-rerank`; it directs `qwen3.7-text-rerank` to the native endpoint. Do not substitute a Cohere/OpenAI-shaped body by changing only the URL.

`POST https://maas.qianwenaiapi.com/api/v1/services/rerank/text-rerank/text-rerank` uses bearer authentication, nests `query` and string `documents` under `input`, and nests `top_n` under `parameters`. Results live under `output.results`, each with the original document `index` and `relevance_score`. Requesting all candidates allows local threshold/top-five selection. Scores are relative to the request, not calibrated probabilities. Optional `instruct` exists, but the measurement used the documented default and did not test custom instructions. `usage.prompt_tokens` is documented for this model; `total_tokens` is also available.

Authorized `live.qwen-rerank.test.ts` measurement through the application adapter: one fictional snakebite-treatment query, three short descriptions (treasury, mountain checkpoint, healer), all results requested. Success in 0.401 s with 289 prompt tokens; healer index 2 scored 0.7619158377, checkpoint index 1 scored 0.2337866473 and treasury index 0 scored 0.0741386424. Indices were unique, all candidates were returned, and the relevant description ranked first. Only this short text request was measured; maximum lengths, maximum candidate count and retrieval quality across author datasets remain unverified. The test requires both `AI_WRITER_LIVE_QWEN_RERANK=1` and `DASHSCOPE_API_KEY`; no credentials, raw responses or author content are retained.
