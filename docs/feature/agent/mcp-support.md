# MCP servers

> **Status: `partial`.** Streamable HTTP tool discovery and approved calls are built. Stdio, legacy HTTP+SSE, OAuth, resources/prompts browsing, sampling, elicitation, and the stateless 2026 protocol are outside this version.

## Author workflow

Settings → AI configuration → Labs → MCP servers (Beta). Enable the feature,
paste a standard `mcpServers` object, then choose **Import configuration**.
The same server name replaces its connection and headers. Test connection performs
only `initialize`, `notifications/initialized`, and paginated `tools/list`, then
closes the session. It never calls a tool or generates an image.

```json
{
  "mcpServers": {
    "joycai-images": {
      "url": "http://127.0.0.1:39287/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

Open a project and ask the chat assistant (or a non-batch Agent task) to use the
server. A sole enabled server is selected automatically; discovery returns all
input schemas together when the catalogue fits 12,000 characters. Larger services
return a compact index and accept individual schema requests. It then proposes a
call with the exact server URL, tool, and arguments visible on an approval card.
Remote calls ask by default, including reads and polling. The card also offers
**Allow for this session** (or **Allow for this task** on a task panel) for this
server's currently discovered tools, including paid calls. This dedicated grant
is bound to the conversation/run, server identity, URL, configuration revision
and each tool's definition. New or changed tools ask again; execution still checks
the live definition. It survives chat turns, but is never persisted or restored;
closing/clearing a conversation, switching projects or restarting clears it.
The auto-approval indicator lists allowed servers and revokes grants in one click.
As with existing grants, only one surface holds the active grant at a time.
Server annotations never grant permission, and prose/shell/image grants do not
cover MCP. This is deliberately an explicit server-wide author choice, since
requiring repeated cards for model queries and job polling obscures the workflow.

For joycai-images the sequence is `list_models` → `get_model_schema` →
`generate_image` → `get_generation` → `read_generation_image`. The server owns
queued jobs; a successful submission is not a finished image. Use its `requestId`
contract if a retry is needed, poll its returned task ID, and request
`preview: false` when the original image is wanted. Stopping an HTTP request or
closing a session does not cancel a durable job; `cancel_generation` is a separate
approved call. Charges are external, unknown to the app, and not entered into its
LLM usage ledger.

## Design and boundaries

- `lib/mcp/config.ts`: only metadata in `app:mcpServers`; Beta and server list are
  machine-local preferences excluded from backup and import. All header values
  are one JSON credential per server under `mcp:<id>` in the existing OS keyring.
  No token, header value, or sample credential is shipped in source. A confirmed
  database write (`writePrefConfirmed`) registers a disabled server before its
  secret is saved. Failed secret writes leave the server disabled. Removal and
  app reset erase the keyring account before discarding its record.
- Endpoint validation accepts HTTPS and loopback HTTP, rejects credentials,
  query strings and fragments in URLs, and reserves protocol headers. Redirects
  are disabled both through Fetch and the Tauri HTTP plugin's `maxRedirections`;
  Fetch's `redirect` alone does not control the native plugin.
- Native requests explicitly omit the synthetic webview `Origin`: the Tauri
  HTTP plugin interprets an empty `Origin` as removal with its existing
  `unsafe-headers` feature. The shared HTTP helper otherwise supplies
  `http://localhost` for Ollama, which joycai-images rejects with HTTP 403.
  MCP is a native client; no browser-origin allowlist is changed on the server.
  Browser/Node requests do not receive this native-only header directive.
- `client.ts`: one short-lived session per operation, no shared connection across
  chats. Implements MCP 2025-03-26 / 2025-06-18 / 2025-11-25 initialization,
  negotiated version/session headers, JSON and streamed SSE responses, cursor
  pagination, cancellation, bounded responses and best-effort session DELETE.
  Discovery is capped at 30 seconds; an approved operation at 120 seconds.
  The parser completes as soon as the matching response arrives, even if SSE
  remains open. Unsupported server requests fail explicitly.
- No automatic retry or reconnection of calls. A lost response or HTTP 404 may
  follow a billable submission; repeating it blindly can buy a second image.
  Authentication/protocol errors never echo response bodies into the transcript.
- `agent/toolTable/mcp.ts`: two compact resident tools, `discover_mcp_tools` and
  `call_mcp_tool`. External schemas arrive as tool results on demand, never as
  unbounded additions to every round's fixed header. Server names are selected
  from configuration; the model cannot supply arbitrary endpoint URLs or headers.
- `routing.ts`: explicit `mcp` surface opt-in, desktop environment, Beta enabled,
  and at least one enabled server. Chat and non-batch Agent tasks opt in;
  roleplay, batch jobs and subagents do not inherit the permission. Context
  estimates price the same bridge tools. Off means absent.
- `tools.ts`: discovery and proposal construction do not call external tools.
  Catalogue requests share a run-scoped promise cache keyed by server identity,
  URL and revision; failures are evicted and approval always rechecks live tools.
  This saves connections without caching executions or retrying paid operations.
  If the compact index's combined descriptions exceed 48,000 characters, it
  falls back to tool names only. A per-description cap alone is insufficient
  for a 256-tool server; throwing before returning names would ask the assistant
  to select a name it has never received. Individual schema lookups retain the
  response limit and full definitions. A 256-tool regression covers the fallback
  and subsequent selective schema lookup through the same run cache.
  `proposalApply.ts` dispatches the approved call. It checks endpoint identity,
  configuration revision and discovered tool schema again before execution;
  changing any invalidates the pending approval. Calls serialize with other
  approval tools. Existing run-scoped approval cleanup handles rejection/Stop.
- `results.ts`: saves PNG/JPEG/WebP/GIF content blocks under unique
  `assets/mcp/<uuid>-N.ext` filenames and a full text/structured result under
  `.ai-writer/tmp/mcp/`. Tool history contains a bounded report and local paths,
  not inline image base64. Identical text JSON and structuredContent are included
  only once, saving history tokens without dropping distinct text. The first image is attached to the originating chat
  turn through the existing image receipt; all image paths are in the report.
  Unsupported binary content is reported. Resource links are not fetched, and
  server-returned filenames are never used as write destinations. The app keeps
  returned bytes even if Stop arrives after a successful response.
  Every result ends with an app-owned image receipt, outside the truncation
  budget: saved bytes name the project assets the chat can display; metadata-only
  results explicitly say that no image was attached and direct the assistant to
  retrieve existing outputs through the server's image-reading tool. This is
  necessary because `get_generation` can report `completed` with an external
  filesystem path and `joycai://` URI, neither of which is a chat attachment.
  On 2026-10-14 a real conversation stopped at that status response and embedded
  the external path, so the chat correctly refused it. Keep the project path
  fence; finish `read_generation_image` instead of granting arbitrary filesystem
  access or reissuing a paid generation. Retrieval remains a separate approved
  call (or uses the existing explicit session grant), never an implicit extra
  call hidden inside polling. Original bytes use `preview: false`.

## Validation and protocol references

`lib/mcp/__tests__/` covers the JSON import shape, credential isolation, keyring
failures, revision invalidation, protocol negotiation, JSON/SSE, pagination,
request cancellation, no retry, approval/rejection, schema changes, error results,
and asset persistence. Session-grant tests cover turn continuity, revocation,
server/schema changes, new tools, surface isolation and task expiry. Routing, preference, reset and context-budget guards cover
integration with the app. `live.test.ts` is opt-in via `MCP_SMOKE_URL` and
`MCP_SMOKE_TOKEN` and performs discovery only.

Live checks on 2026-10-14:

- joycai-images 1.0.0 negotiated 2025-11-25 and returned six tools through the
  implemented client. The native macOS development app initially received 403
  because of its synthetic Origin; the native-only omission above fixed this.
- In an isolated project, imported the server through Settings (headers in the
  keyring), passed Test connection, and asked the chat assistant for one red
  apple on a pale blue background. Approved `list_models`, two
  `get_model_schema` reads, exactly one `generate_image` (Nano Banana 2,
  `imageSize: 1K`, `aspectRatio: 1:1`), `get_generation`, and
  `read_generation_image` with `preview: false` through the normal cards.
- Task `74be6d38-256c-49bb-9acf-36af2ad7bba4` completed with one 1024×1024 JPEG.
  The app saved `assets/mcp/17dafecf-08ad-4a56-81d8-464ff99d62be-1.jpg`
  (271,635 bytes), byte-for-byte identical to the server's original;
  SHA-256 `c54083e93d3ddf03a5701d5a9b50ceb00aa29e4b2f0f8a3460786f5eeb0e10a0`.
- Visually verified the chat thumbnail and full-resolution in-app lightbox,
  then quit/relaunched the app and reopened the project: the saved conversation
  and image preview remained available. This was a real generation, not a mock.
  Credentials and generated test assets are not repository fixtures.
- Regression run: 6,393 frontend tests passed (one skipped; opt-in live probes
  excluded), TypeScript check and app/prototype production builds passed.

Discovery/session-grant regression (2026-10-14): 6,430 offline tests passed,
including catalogue batching/fallback, run-cache isolation, result deduplication
and explicit session grants. TypeScript and app/prototype production builds
passed. Live provider probes were excluded; this change did not run a paid
image-generation validation.

Protocol: [Streamable HTTP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
This implementation deliberately targets the server's negotiated session-based
protocol family; it does not claim support for the newer stateless transport.

## Chat slash commands

The chat composer offers `/help`, `/mcp`, `/imageGen` and
`/<server>:<tool>` shortcuts. `/help` and `/mcp` are local browsing actions,
requiring no conversational model request. `/mcp` lists configured servers;
**Load tools** performs bounded discovery only, with per-server loading, error,
disabled and not-loaded states. **Refresh** replaces the catalogue. Counts refer
to discovered tools, never an assumed zero. Catalogues are component-local and
keyed by server revision; they are discarded when the chat changes or composer unmounts.
Server/tool names are URL-encoded within shortcuts so spaces and colons cannot
create ambiguous selections. Tool descriptions render as plain text.

Selecting a command replaces only its editable prefix and preserves the request,
including whitespace and multiline text. Unrecognized slash-prefixed prose and
file paths remain ordinary chat messages. Arrow keys select, Enter
inserts, Escape dismisses, and forward Tab explicitly enters the catalogue
buttons. The panel follows the textarea in DOM order, while CSS places it
visually above; subsequent Tabs reach the footer without cycling back through the
input. Shift+Tab retains native backward traversal. Add a natural
language request after an execution command, then send. The first version expands
that command into an explicit request to the existing assistant (the transcript
keeps the author’s original command): MCP requests identify the exact server/tool and request current
schema discovery; image requests select the built-in `generate_image` route.
This remains model-mediated argument preparation, not a deterministic direct
RPC. Missing required details are requested by the assistant. This choice reuses
the existing tool approvals, destination selection, image receipts and session
grants rather than creating a second execution path. No slash command grants
approval. Image availability comes from the same planned routing as the chat.
All command surfaces use theme tokens, and descriptions/status/help are localized.
