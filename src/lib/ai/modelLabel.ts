/**
 * Model display labels — splits a raw model name into the parts the model
 * picker renders separately.
 *
 * Aggregator and local-runtime model names carry more than a model identity:
 * a route/tier qualifier ("特价 kiro", "官逆 AWS"), a publisher namespace
 * ("VladimirGav/…"), a version tag ("…:latest"). Rendered as one string they
 * force truncation and bury the part the author actually reads — the model.
 * So the qualifiers come out as chips and a secondary line, and the model name
 * itself is never shortened.
 *
 * Extraction is delimiter-driven on purpose: only text the author explicitly
 * bracketed, piped, or namespaced is treated as a qualifier. A name with no
 * delimiters is passed through whole rather than guessed at — being wrong here
 * would mangle every row in the list.
 */

export interface ModelLabel {
  /** The model identity. Rendered in full — the UI wraps rather than truncates. */
  title: string;
  /** Qualifiers lifted out of the name, rendered as chips beside the title. */
  badges: string[];
  /** Publisher / version line, e.g. "VladimirGav · latest". Null when absent. */
  subtitle: string | null;
}

/** Bracket pairs treated as qualifier delimiters (ASCII + CJK full-width). */
const BRACKETS: [string, string][] = [
  ["[", "]"],
  ["(", ")"],
  ["（", "）"],
  ["【", "】"],
  ["〔", "〕"],
];

/** Segment separators used by aggregators to prefix a route onto a model id. */
const PIPES = /[|丨｜]/;

/** `namespace/name` or `namespace/name:tag` — Ollama, OpenRouter, HF-style ids. */
const NAMESPACED = /^([^/\s]+)\/(.+)$/;

function stripBrackets(input: string): { rest: string; badges: string[] } {
  let rest = input;
  const badges: string[] = [];
  for (const [open, close] of BRACKETS) {
    for (;;) {
      const start = rest.indexOf(open);
      if (start < 0) break;
      const end = rest.indexOf(close, start + 1);
      if (end < 0) break;
      const inner = rest.slice(start + 1, end).trim();
      if (inner) badges.push(inner);
      rest = rest.slice(0, start) + " " + rest.slice(end + 1);
    }
  }
  return { rest, badges };
}

/** Collapse runs of whitespace and trim stray separators left by extraction. */
function tidy(s: string): string {
  return s.replace(/\s+/g, " ").replace(/^[\s\-_·/|]+|[\s\-_·/|]+$/g, "").trim();
}

function stripQualifiers(raw: string): { body: string; badges: string[] } {
  const { rest, badges } = stripBrackets(raw);

  // Piped segments: everything before the last segment is a route qualifier.
  // "特价kiro | claude-opus-4-6" → badge "特价kiro", title "claude-opus-4-6".
  let body = rest;
  if (PIPES.test(body)) {
    const parts = body.split(PIPES).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      body = parts[parts.length - 1];
      badges.push(...parts.slice(0, -1));
    }
  }

  return { body: tidy(body), badges };
}

/**
 * @param name    The author-facing model name (`Model.name`).
 * @param modelId The wire id, used as a fallback when the name is blank.
 */
export function parseModelLabel(name: string, modelId = ""): ModelLabel {
  const raw = (name || "").trim() || (modelId || "").trim();
  if (!raw) return { title: "", badges: [], subtitle: null };

  const { body: stripped, badges } = stripQualifiers(raw);
  let body = stripped;

  // Namespace / tag. The tag is only split off when it follows the namespaced
  // form — a bare "gpt-4:0613" keeps its colon, since there is no publisher to
  // pair it with and the version is part of the identity.
  let subtitle: string | null = null;
  const ns = NAMESPACED.exec(body);
  if (ns) {
    const [, namespace, remainder] = ns;
    const colon = remainder.lastIndexOf(":");
    const hasTag = colon > 0 && colon < remainder.length - 1 && !remainder.slice(colon + 1).includes("/");
    const core = hasTag ? remainder.slice(0, colon) : remainder;
    const tag = hasTag ? remainder.slice(colon + 1) : null;
    body = tidy(core);
    subtitle = tag ? `${namespace} · ${tag}` : namespace;
  }

  return {
    title: body || raw,
    badges: badges.map((b) => tidy(b)).filter(Boolean),
    subtitle,
  };
}

/**
 * Provider display labels — the same bracket/pipe qualifier extraction as
 * model names, but **no** namespace/tag split: a provider name is a free-form
 * label, not a wire id, so a slash in it ("aihubmix/官转") is part of the name
 * and splitting it would silently drop half of it.
 */
export function parseProviderLabel(name: string): { title: string; badges: string[] } {
  const raw = (name || "").trim();
  if (!raw) return { title: "", badges: [] };
  const { body, badges } = stripQualifiers(raw);
  return {
    title: body || raw,
    badges: badges.map((b) => tidy(b)).filter(Boolean),
  };
}

/** Compact context-window label: 1_000_000 → "1M", 200_000 → "200k". Null when unset. */
export function contextLabel(contextSize: number | undefined): string | null {
  if (!contextSize || contextSize <= 0) return null;
  if (contextSize >= 1_000_000) {
    const m = contextSize / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (contextSize >= 1000) {
    const k = contextSize / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(contextSize);
}
