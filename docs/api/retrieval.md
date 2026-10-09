# Embedding and rerank protocols

> Status: `living` · Ark Agent Plan embedding endpoint verified below; other formats retain fixture-only coverage. Official reference review: 2026-10-09.

These endpoints have their own request/response shapes; they are not chat-completion models.

| Format | Request | Response mapping | Usage |
| --- | --- | --- | --- |
| OpenAI embeddings | `POST /v1/embeddings`, `{model,input:string[],encoding_format:"float"}` | `data[].index` identifies the original input; `data[].embedding` is the vector | `usage.prompt_tokens` / `total_tokens` |
| Ollama native embeddings | `POST /api/embed`, `{model,input:string[],truncate:false}` | `embeddings` contains one vector per input | `prompt_eval_count` |
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
