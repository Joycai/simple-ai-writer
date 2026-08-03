/**
 * http.ts's isLocalUrl — the Origin-override decision for local model
 * servers. Extended (Phase 5 fix) to cover 0.0.0.0/[::1] in addition to
 * localhost/127.0.0.1, so a packaged build's origin override actually
 * applies to Ollama configured on those hosts instead of getting a 403
 * from OLLAMA_ORIGINS, matching ai/endpointProbe.ts's own local-host check.
 */
import { describe, expect, it } from "vitest";
import { isLocalUrl } from "../http";

describe("isLocalUrl", () => {
  it("matches every local-loopback form", () => {
    expect(isLocalUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLocalUrl("http://0.0.0.0:11434/v1")).toBe(true);
    expect(isLocalUrl("http://[::1]:11434/v1")).toBe(true);
    expect(isLocalUrl("https://localhost/v1")).toBe(true);
  });

  it("does not match a remote host", () => {
    expect(isLocalUrl("https://api.openai.com/v1")).toBe(false);
    expect(isLocalUrl("http://192.168.1.5:11434/v1")).toBe(false);
  });
});
