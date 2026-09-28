/**
 * What a refused request's body says, as one line for the author — the one
 * reader every streaming adapter's non-2xx branch goes through
 * (docs/api/refusal-plan.md).
 *
 * The five families refuse in a handful of shapes: `{error:{message, code |
 * status | type, param}}` (Chat Completions, Responses, Gemini — the last also
 * wrapped in a one-item array — and Anthropic under `{type:"error"}`),
 * `{error:"…"}`, and a bare `{code, message, request_id}` (DashScope native).
 * Each can arrive as the whole body or inside an SSE `data:` line: a DashScope
 * refusal follows the request's `X-DashScope-SSE` header, not the status, and
 * its compatible mode frames a 400 the same way (landscape.md §7 第二十二个样本).
 *
 * Only the wrapping is removed. The message is kept verbatim, and so is every
 * field a reader of the thrown message matches on and the raw body used to
 * carry: the classifier (`code`, else Gemini's `status`, else `type` —
 * `modelHealth`'s `content_filter`), the `param` a refusal names when its
 * message does not (`capability/learned.ts`'s `tool_choice` / `response_format`),
 * the request id (the API log records only the thrown message), and a relay's
 * upstream body (OpenRouter's `metadata.raw`).
 */

type Obj = Record<string, unknown>;

const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const object = (v: unknown): Obj | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;

/**
 * A relay's copy of what its upstream answered — OpenRouter puts it under
 * `error.metadata.raw`, a string or an object, next to `provider_name`. Its
 * own message is a placeholder ("Provider returned error"), so the upstream's
 * is the one that says what went wrong.
 */
function upstreamText(error: Obj): string | undefined {
  const metadata = object(error.metadata);
  if (!metadata || metadata.raw === undefined || metadata.raw === null) return undefined;
  const raw = metadata.raw;
  const said = typeof raw === "string" ? refusalText(raw) : vendorErrorText(raw) ?? JSON.stringify(raw);
  return said ? `${text(metadata.provider_name) ?? "upstream"}: ${said}` : undefined;
}

/**
 * One vendor error object as `label: message (param …, request_id …) — upstream`,
 * or undefined when it carries no message. Also reads a mid-stream error
 * frame, which is the same object on a 200.
 */
export function vendorErrorText(json: unknown): string | undefined {
  if (Array.isArray(json)) {
    for (const item of json) {
      const found = vendorErrorText(item);
      if (found) return found;
    }
    return undefined;
  }
  const outer = object(json);
  if (!outer) return undefined;
  // `{error: "…"}` is the message with the outer fields beside it; `{error:
  // {…}}` nests them; anything else is the bare shape.
  const error = typeof outer.error === "string" ? { ...outer, message: outer.error } : object(outer.error) ?? outer;
  const message = text(error.message);
  if (!message) return undefined;
  const label = text(error.code) ?? text(error.status) ?? text(error.type);
  const upstream = upstreamText(error);
  const param = text(error.param);
  const requestId = text(error.request_id) ?? text(outer.request_id);
  const notes = [param && `param ${param}`, requestId && `request_id ${requestId}`].filter(Boolean);
  // This object's notes before the upstream's line, which may carry its own:
  // what is in parentheses belongs to the text just before it.
  return `${label ? `${label}: ` : ""}${message}${notes.length ? ` (${notes.join(", ")})` : ""}${upstream ? ` — ${upstream}` : ""}`;
}

/**
 * The vendor's error out of a refused request's body, or the body itself when
 * no candidate reads as one (a gateway's HTML, an object with no message).
 * The candidates are the whole body, then each `data:` line — trimmed as the
 * stream readers trim them, so a CRLF or an indented line reads the same.
 */
export function refusalText(body: string): string {
  const dataLines = body.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).map((l) => l.slice(5));
  for (const candidate of [body, ...dataLines]) {
    let json: unknown;
    try {
      json = JSON.parse(candidate);
    } catch {
      continue; // not JSON — try the next candidate
    }
    const found = vendorErrorText(json);
    if (found) return found;
  }
  return body;
}
