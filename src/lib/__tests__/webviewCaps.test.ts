import { describe, expect, it } from "vitest";
import {
  CAPS,
  ENGINE_FLOOR,
  capsNoticeKey,
  engineName,
  missingCaps,
  parseEngine,
  shouldShowCapsNotice,
  type ProbeGlobal,
} from "../webviewCaps";

const WEBVIEW2_OLD =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.91";
const WKWEBVIEW_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const WEBKITGTK =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";

/** A global that has everything the probes look for. */
function fullGlobal(): ProbeGlobal {
  return {
    structuredClone: () => undefined,
    Array: { prototype: { at: () => undefined, findLast: () => undefined } },
    Object: { hasOwn: () => false },
    AbortSignal: { timeout: () => undefined },
    CSS: { supports: (q: string) => q === "container-type: inline-size" },
  };
}

describe("parseEngine", () => {
  it("reads WebView2 as Chromium by its Chrome/ token, not its Edg/ one", () => {
    expect(parseEngine(WEBVIEW2_OLD)).toEqual({ kind: "chromium", version: 120 });
  });

  it("knows WKWebView on macOS carries no version", () => {
    expect(parseEngine(WKWEBVIEW_MAC)).toEqual({ kind: "webkit", version: null });
  });

  it("reads WebKitGTK's Version/ token", () => {
    expect(parseEngine(WEBKITGTK)).toEqual({ kind: "webkit", version: 17 });
  });

  it("names Gecko and gives up on anything else", () => {
    expect(parseEngine(FIREFOX)).toEqual({ kind: "gecko", version: 133 });
    expect(parseEngine("curl/8.0")).toEqual({ kind: "unknown", version: null });
  });
});

describe("engineName", () => {
  it("is a proper noun plus a major version, and just the noun when the UA gave none", () => {
    expect(engineName(parseEngine(WEBVIEW2_OLD))).toBe("Chromium 120");
    expect(engineName(parseEngine(WKWEBVIEW_MAC))).toBe("WebKit");
    expect(engineName(parseEngine(WEBKITGTK))).toBe("WebKit 17");
    expect(engineName(parseEngine("curl/8.0"))).toBe("");
  });
});

describe("CAPS", () => {
  it("only probes built-ins within the floor the build targets", () => {
    for (const c of CAPS) {
      expect(c.chromium, c.id).toBeLessThanOrEqual(ENGINE_FLOOR.chromium);
      expect(parseFloat(c.webkit), c.id).toBeLessThanOrEqual(parseFloat(ENGINE_FLOOR.webkit));
    }
  });

  it("passes on a complete engine — and on the one running the tests", () => {
    expect(missingCaps(fullGlobal())).toEqual([]);
    // Node 22 lacks `CSS`; everything else is there.
    const here = missingCaps().map((c) => c.id);
    expect(here.filter((id) => id !== "CSS container queries")).toEqual([]);
  });

  it("reports each missing built-in by name and treats a throwing probe as missing", () => {
    const g = fullGlobal();
    delete g.structuredClone;
    g.Array = { prototype: { at: () => undefined } };
    g.CSS = {
      supports: () => {
        throw new Error("no CSS here");
      },
    };
    expect(missingCaps(g).map((c) => c.id)).toEqual([
      "structuredClone",
      "Array.prototype.findLast",
      "CSS container queries",
    ]);
  });
});

describe("the once-per-set notice", () => {
  it("shows for a new set and stays hidden for the dismissed one, whatever the order", () => {
    const g = fullGlobal();
    delete g.structuredClone;
    delete g.AbortSignal;
    const missing = missingCaps(g);
    expect(shouldShowCapsNotice(missing, null)).toBe(true);
    const key = capsNoticeKey(missing);
    expect(key).toBe("AbortSignal.timeout,structuredClone");
    expect(shouldShowCapsNotice(missing, key)).toBe(false);
    expect(shouldShowCapsNotice([...missing].reverse(), key)).toBe(false);
    // A different engine, lacking something else, is news again.
    expect(shouldShowCapsNotice(missing.slice(0, 1), key)).toBe(true);
  });

  it("never shows when nothing is missing", () => {
    expect(shouldShowCapsNotice([], null)).toBe(false);
    expect(shouldShowCapsNotice([], "")).toBe(false);
  });
});
