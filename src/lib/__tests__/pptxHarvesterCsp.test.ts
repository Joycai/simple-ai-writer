/**
 * The CSP hash that lets the PPTX harvester run at all.
 *
 * This test exists because of a failure with no symptom. A `blob:` document
 * inherits the CSP of the page that created it — an opaque origin is exempt
 * from same-origin access, not from policy — so under the app's
 * `script-src 'self'` the injected harvester simply never executed. Nothing
 * threw, nothing logged: every export sat for twenty seconds and reported
 * "the page did not finish rendering", on any page, including a blank one.
 *
 * The cure is a `sha256-` source for exactly that file. Which means the config
 * and the file must stay in step, and if they ever drift the *only* evidence
 * is that same silent timeout — so the check belongs here, where it fails
 * loudly instead.
 *
 * Both sides are read the way the app reads them (`?raw` for the script, the
 * config as JSON) rather than through `node:fs`, so what is hashed here is
 * what actually ships.
 */
import { describe, expect, it } from "vitest";
import tauriConf from "../../../src-tauri/tauri.conf.json";
import { HARVESTER_SOURCE } from "../pptx/harvest";

const scriptSrc: string = tauriConf.app.security.csp["script-src"];

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

describe("the harvester's CSP hash", () => {
  it("matches the script the app actually injects", async () => {
    expect(scriptSrc).toContain(`'sha256-${await sha256Base64(HARVESTER_SOURCE)}'`);
  });

  it("carries no per-run data in the hashed text", () => {
    // Anything substituted into the source changes the digest on every run,
    // which blocks the script on every run. The nonce travels on `data-nonce`
    // instead — attributes are not covered by the hash.
    expect(HARVESTER_SOURCE).not.toContain("__SAW_NONCE__");
    expect(HARVESTER_SOURCE).toContain("data-nonce");
  });

  it("normalises newlines, so the digest survives a CRLF checkout", () => {
    expect(HARVESTER_SOURCE).not.toContain("\r\n");
  });

  it("still refuses every other inline script", () => {
    // The hash is what keeps this from being a blanket 'unsafe-inline': the
    // page's own scripts are model-written and must stay blocked.
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
  });
});
