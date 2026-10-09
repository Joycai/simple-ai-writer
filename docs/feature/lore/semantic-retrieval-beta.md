# Project-scoped semantic retrieval Beta

> Status: `shipped` · live Ark Agent Plan embedding smoke test verified (2026-10-09); broader retrieval quality remains unverified. Protocol fixtures and offline integration tests cover the implementation.

## Intent and design

An author can describe a task without naming the relevant knowledge-base entry. Existing name/alias matching and explicit links remain authoritative; this optional channel discovers additional entries from their compact descriptions. The author requested a **per-project Beta switch**, selectable local or hosted embedding/reranker models, and the existing theme system.

Settings → AI configuration → Labs contains **Semantic Knowledge Base retrieval · Beta**. Its first row identifies the current project and has the existing square Toggle. Off is the default. No open project means an explanatory empty state instead of an actionable switch. On reveals an optional embedding selector, optional reranker selector, and a minimum relevance score. At least one model is needed. Neither selection silently falls back to a chat model.

Model registration is in the same section: channel, arbitrary model ID, display name, API format, same-host endpoint path, optional query/document prefixes for embedding models, and fee group. This reuses existing channel credentials, the model table and config backup rather than creating a second secret store. Models are installation-wide, while enablement and selections use `prefs.ts`'s project-keyed family `lore:semantic:`. Like the existing project pins/scope, these are per-project **on this device**, not portable project files or app-config backup entries.

The production Section / Row / Toggle / Select / form controls carry the app's Settings palette and typography. New CSS uses existing tokens only; the editor's two-column fields collapse at narrow widths. No theme attributes or new colour palette are introduced. Missing channels, unavailable selections, no selected model and save failure have explicit states. Turning the switch off hides the project controls but preserves configuration and makes no retrieval request. Saving configuration itself never calls a model.

## Settings hierarchy and model removal

The settings surface separates **Project retrieval settings** from the shared **Retrieval model library** with distinct themed panels and scope labels. This prevents model registration from looking like another project preference. The library has its own add action, saved-model count and empty state. Each saved model shows its purpose, channel, model ID and current-project selection; edit forms appear directly under their model, while new-model forms appear below the library toolbar. Narrow panels stack the project controls under their labels.

Every saved model has explicit Edit and Delete actions. Delete uses the shared confirmation dialog and existing `aiStore.removeModel`, with a visible failure state. A successful deletion clears matching selections in the current project. Other projects retain the existing unavailable-model state until the author chooses a replacement; no project is silently switched to a different model. The confirmation explains the shared scope and that server-side model files are unaffected. This UI does not change retrieval or model-serving behavior.

## Pipeline and invariants

The first Beta applies to **writing tasks and assistant chat**, including subsequent chat turns. Roleplay and consistency-review retrieval retain their existing rules. This boundary avoids changing their binding/memory and exhaustive-review semantics in a retrieval experiment.

1. Run existing pins, exact matches, facet rules and linked-entry expansion unchanged.
2. Filter the semantic candidate catalog by the source scope and existing selections/resident exclusions **before transmitting any descriptions**. Pins retain their existing ability to cross the scope fence.
3. Each description contains the entry name, aliases, summary and non-manual facet titles/keys. No full entry bodies or images go to the retrieval endpoint. A connection absent from these descriptions cannot be inferred reliably: authors should improve the summary rather than expect the selector to invent it.
4. Embedding-only: encode descriptions, encode the query, rank by cosine similarity. Reranker-only: score the eligible catalog directly. Combined: embeddings produce 30 candidates and the reranker determines the final score. A reranker never sees only keyword matches; that would fail to recover unnamed entries.
5. Apply the configured score threshold (default 0.5, **not a probability**) and select at most five. Empty results are valid. The embedding threshold is not applied ahead of the reranker.
6. Load their real bodies through `selectLore`, using only remaining context space. Each semantic entry's summary must also fit; it does **not** receive the normal named-entry L0 guarantee. Existing matches are never displaced. Facets still obey keys, manual mode, exclusions, groups and the whole-facet budget rule. Semantic entries do not recursively expand references.
7. Report semantic provenance, score, counts, catalog/query/description truncation, top-five cap, budget drops, timeout or unavailable service. Task results show this in the injection report; assistant chat stores it on `context-seeded`, even if no text was injected.

Limits intentionally bound the initial experiment: 256 eligible descriptions in deterministic path order, 1,600 characters per description, 4,000 characters of query, batches of 32 embeddings and 20 seconds for the whole semantic phase by default; the verified Ark Agent Plan endpoint uses batches of 10 and a 60-second whole-phase deadline. Writing-task intent is placed before the selection so a long selection cannot displace the author's request. A larger catalog reports omissions and can be narrowed with the source scope. Pagination, persisted indexes and a general language-model selector are not part of this Beta.

Embeddings are persisted in the project's `kb_embeddings` table. Each row stores a relative entry path, SHA-256 description hash and validated vector, partitioned by a versioned hash of effective endpoint, model ID and retrieval configuration. Credentials and source descriptions are not stored. Unchanged descriptions survive restarts; edits replace only that entry's row. Deleted entries are pruned across namespaces on the next indexing pass using the full catalog, never the narrowed source scope. Different model/configuration namespaces remain separate and can be reused when switching back. Query embeddings remain fresh.

The source files remain authoritative; the table is disposable derived data. Malformed stored vectors are treated as misses. A dimension mismatch invalidates the namespace and visibly falls back rather than mixing vectors. A provider replacing a model without changing its ID or dimensions cannot be detected automatically; Rebuild index is the explicit recovery action.

## Transport, persistence and usage

`ConnOptions.retrieval` owns the transport configuration. `Model.retrieval` references its type; the `models.retrieval` JSON column survives save/load and config export/import. These models are excluded by `conversationalModels`, labelled by purpose in Channels & Models, and refused by `streamCompletion` as a final guard against stale/direct bindings.

Supported formats: OpenAI-compatible float embeddings, Ollama native `/api/embed`, Cohere-compatible rerank. Endpoint paths are configurable but same-origin; an endpoint path cannot forward a channel key to a different host. Bearer credentials use the existing keyring and empty local keys omit Authorization. HTTP(S) requests use the existing Tauri HTTP bridge. Other proprietary APIs are **not** made compatible by model name alone; they require an adapter or compatible serving layer. Wire references are in [retrieval.md](../../api/retrieval.md).

Malformed vectors, dimension changes, missing/duplicate indices and invalid rerank scores are refused. A failed/unconfigured selected model or deadline returns the original matching result and a visible status; it does not silently use a different retrieval mode. The user's cancellation propagates and stops the parent request. The timeout races the whole phase so an endpoint that ignores cancellation cannot hold the writing request indefinitely.

Every successful retrieval response records usage through `recordUsage` in both ledgers using the selected model's fee snapshot. OpenAI/Ollama input token counts and Cohere search units are read when present; missing counts are not guessed. Tasks are `kb-embedding` and `kb-rerank`. Fee groups remain the only pricing source. No prices are fetched or invented; users configure the appropriate token/request/spec fee group. Cache hits produce no document-embedding request and no corresponding usage row. No automatic retries amplify costs.

## Validation and remaining measurement

Offline tests cover wire bodies, response ordering/validation, same-host endpoint paths, model persistence/backup, chat exclusion, project opt-in isolation, scope-before-network, unnamed-entry discovery, vector reuse/invalidation, reranking/no-match, deadline/cancellation, provenance and remaining-budget protection. Existing retrieval and repository guard tests also run.

UI review uses fictional in-memory channel/model/project fixtures, never real credentials or author files: on/off, add/save, selectors, light/dark and narrow/wide settings layout. These browser checks do not prove native keyring/HTTP behavior.

Broader model quality and latency remain unverified; the Ark Agent Plan smoke test is recorded in `docs/api/retrieval.md`. Before considering this beyond Beta, evaluate real author-labelled requests against current matching: recovered necessary entries, irrelevant additions, incremental latency and actual usage. Report these separately from protocol correctness. A live endpoint is not selected automatically for testing.

## Chat report and endpoint correction (1.95.1)

The semantic report is an execution-log list row with the shared marker, typography and padding. Its own content wraps long entry names and status text within the available width. Failure reports preserve only a typed reason and HTTP status, never raw upstream errors or credentials. Legacy saved reports without these fields still render.

The default OpenAI embedding path now follows the channel API prefix: a channel ending in `/api/plan/v3` calls `/api/plan/v3/embeddings`, rather than dropping the prefix and calling the host-root `/v1/embeddings`. Root-only local channels continue to use `/v1/embeddings`; custom non-default paths remain host-root paths. This fixes the generic default for prefixed providers without changing user channel configuration. Authenticated Ark inference was subsequently verified on the author-supplied `/api/plan/v3/embeddings` endpoint with `doubao-embedding-vision`: HTTP 200, indexed 2,048-dimensional float vectors, and the relevant fictional entry ranked first. This verifies the wire format and endpoint, not the native keychain/UI path.

First-turn assembly no longer appends the author matching text twice to the semantic query. The 4,000-character bound still applies to genuinely long queries and remains visible as an informational notice.

## Ark Agent Plan batch correction (1.95.2)

The earlier four-input smoke test did not exercise the catalog batch size. The Agent Plan endpoint rejects 32 inputs with HTTP 400 and an explicit maximum of 10. Retrieval now selects a 10-input batch size by the effective official endpoint and OpenAI embedding format, not by the model name (which may also be served by unrelated providers). Other endpoints retain the existing defaults.

The extra sequential round trips for a cold catalog receive a bounded 60-second total deadline, measured from the start of retrieval, including credential lookup and reranking. This is not a per-batch reset. Cancellation, keyword fallback, usage recording and completed-batch caching remain intact; repeated requests reuse those vectors. Very slow cold catalogs can still time out rather than block writing indefinitely.

## Persistent preparation (1.96.0)

The author approved Prepare index / Rebuild index with progress and ready/outdated status. A compact, token-themed cache panel sits inside project retrieval settings, below model and threshold controls; the shared model library remains separate. It is shown only with an embedding selection. Empty scope, loading, storage/model failure, progress, stopped and complete states have explicit text in both languages. Buttons wrap on narrow layouts and progress has an accessible label. Rebuild confirms the paid regeneration; preparation describes the selected-service transfer beside its action.

Prepare covers all entries in the current source scope, including those beyond the per-request 256-candidate retrieval bound. It fills only missing/changed vectors. Rebuild first invalidates the current scope in the selected namespace, then regenerates it. This makes a stopped rebuild resumable with Prepare instead of mistaking unfinished old vectors for ready data; other scopes and namespaces remain intact. Completed batches are saved transactionally and reused after an interruption. Each preparation request has the provider's bounded timeout; unlike a chat turn, explicit preparation has no whole-catalog deadline. Closing settings, changing scope/model, switching projects or Stop cancels the work. Per-project/namespace serialization prevents duplicate preparation by concurrent chats within one app instance; separate app instances may still encode the same missing entry concurrently, with safe atomic upserts.

On-demand retrieval uses the same persistence and batch logic. Cache writes use the established SQL transaction bridge; every successful inference still records usage via the existing ledger. No background paid work starts merely by opening settings. Status reads compare hashes locally. The project database follows existing project backup rules; the cache is not part of shared KB tree sync or app-config export. Old model namespaces are retained for reuse; automatic disk-size eviction is not included in this iteration.
