/**
 * The rendering engine's capability floor — probed, not inferred.
 *
 * A Tauri window is only as new as the machine's webview: WebView2 on Windows
 * (Chromium, normally evergreen but frozen on machines where updates are
 * blocked or a Fixed Version runtime was installed), WKWebView on macOS
 * (whatever Safari that macOS release tops out at), WebKitGTK on Linux. The
 * build targets Vite's `baseline-widely-available` (Chromium 107 / Safari 16),
 * but that only decides which *syntax* gets transpiled — a missing built-in
 * is not transpiled away, it throws at the call site, with a minified name
 * (`n.toHex is not a function`, 2026-09: pdfjs on a WebView2 below 140).
 *
 * Two rules follow. **Decide by feature, not by OS or version**: the same
 * failure reaches a macOS 12 machine (Safari 17.6 at most) and a stale
 * WebView2 alike, an OS table would have to be maintained, and WKWebView's
 * user agent on macOS carries no `Version/` token at all — so the version is
 * display-only and the probes are the truth. **Fill where the dependency
 * offers a fill, warn where it doesn't**: pdfjs ships a legacy build with
 * polyfills, so `lib/import/pdf.ts` loads that and the author never hears
 * about `toHex`; what stays here is the floor the app itself stands on, the
 * things nobody polyfills for us. A miss is reported once per distinct set
 * (`capsNoticeKey`) and permanently in Settings → 关于 — the line to ask for
 * in the next bug report.
 *
 * Every probe here must be *below* the floor: a probe above it would report
 * an engine that the build already promises to run on.
 */

export type EngineKind = "chromium" | "webkit" | "gecko" | "unknown";

export interface EngineInfo {
  kind: EngineKind;
  /** Major version where the UA says one; WKWebView on macOS says nothing. */
  version: number | null;
}

/** What the build targets (`vite` default `baseline-widely-available`). */
export const ENGINE_FLOOR = { chromium: 107, webkit: "16" } as const;

/**
 * Chromium first — every Chromium UA also says `AppleWebKit`, and WebView2 adds
 * `Edg/` after `Chrome/`, which is the Chromium version that matters.
 */
export function parseEngine(ua: string): EngineInfo {
  const chrome = /\bChrome\/(\d+)/.exec(ua);
  if (chrome) return { kind: "chromium", version: Number(chrome[1]) };
  const firefox = /\bFirefox\/(\d+)/.exec(ua);
  if (firefox) return { kind: "gecko", version: Number(firefox[1]) };
  if (/\bAppleWebKit\//.test(ua)) {
    const v = /\bVersion\/(\d+)/.exec(ua);
    return { kind: "webkit", version: v ? Number(v[1]) : null };
  }
  return { kind: "unknown", version: null };
}

/**
 * The engine as a proper noun plus its major version — not translated, and
 * not the host: "WebView2" is what the *caller* knows (a Tauri window on
 * Windows), the UA only ever says Chromium.
 */
export function engineName(info: EngineInfo): string {
  switch (info.kind) {
    case "chromium":
      return `Chromium ${info.version ?? "?"}`;
    case "webkit":
      return info.version === null ? "WebKit" : `WebKit ${info.version}`;
    case "gecko":
      return `Gecko ${info.version ?? "?"}`;
    default:
      return "";
  }
}

export interface Cap {
  /** Shown to the author verbatim — the name they would search for. */
  id: string;
  /** First engine versions with it — for the About line and the docs. */
  chromium: number;
  webkit: string;
  probe: (g: ProbeGlobal) => boolean;
}

/** The slice of `globalThis` the probes touch; tests hand in a stub. */
export interface ProbeGlobal {
  structuredClone?: unknown;
  Array?: { prototype: Record<string, unknown> };
  Object?: Record<string, unknown>;
  AbortSignal?: Record<string, unknown>;
  CSS?: { supports?: (q: string) => boolean };
}

const fn = (v: unknown) => typeof v === "function";

/**
 * Built-ins the app calls without a guard. Each is within the floor, so a
 * miss means "older than the build was made for", not "a fancy feature".
 */
export const CAPS: readonly Cap[] = [
  // Doc-format presets, ComfyUI graphs.
  { id: "structuredClone", chromium: 98, webkit: "15.4", probe: (g) => fn(g.structuredClone) },
  // `.at(-1)` — dozens of call sites.
  { id: "Array.prototype.at", chromium: 92, webkit: "15.4", probe: (g) => fn(g.Array?.prototype.at) },
  { id: "Array.prototype.findLast", chromium: 97, webkit: "15.4", probe: (g) => fn(g.Array?.prototype.findLast) },
  { id: "Object.hasOwn", chromium: 93, webkit: "15.4", probe: (g) => fn(g.Object?.hasOwn) },
  // The sync server's health check.
  { id: "AbortSignal.timeout", chromium: 103, webkit: "16", probe: (g) => fn(g.AbortSignal?.timeout) },
  // The file panel's row tiers (设计稿 17) are container queries.
  {
    id: "CSS container queries",
    chromium: 105,
    webkit: "16",
    probe: (g) => g.CSS?.supports?.("container-type: inline-size") === true,
  },
];

/** The caps this engine lacks. A probe that throws counts as missing. */
export function missingCaps(g: ProbeGlobal = globalThis as unknown as ProbeGlobal): Cap[] {
  return CAPS.filter((c) => {
    try {
      return !c.probe(g);
    } catch {
      return true;
    }
  });
}

/**
 * The value stored once the author has dismissed the notice — the *set* that
 * was missing, so a later engine that lacks something different is reported
 * again rather than hidden behind the old dismissal.
 */
export function capsNoticeKey(missing: readonly Cap[]): string {
  return missing.map((c) => c.id).sort().join(",");
}

export function shouldShowCapsNotice(missing: readonly Cap[], dismissed: string | null): boolean {
  return missing.length > 0 && dismissed !== capsNoticeKey(missing);
}

/** Preference row holding the dismissed set — machine-local, see `lib/prefs`. */
export const CAPS_NOTICE_PREF = "app:webviewCapsNoticed";
