# Embedding and rerank protocols

> Status: `living` · `unverified` against live services. Official reference review: 2026-10-09.

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

No live endpoint measurements were performed for this change. Fixture tests validate the documented shapes; they do not certify every compatible provider.
