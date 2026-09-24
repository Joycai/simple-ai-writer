/**
 * http.ts's isLocalUrl — the Origin-override decision for local model
 * servers. Extended (Phase 5 fix) to cover 0.0.0.0/[::1] in addition to
 * localhost/127.0.0.1, so a packaged build's origin override actually
 * applies to Ollama configured on those hosts instead of getting a 403
 * from OLLAMA_ORIGINS, matching ai/endpointProbe.ts's own local-host check.
 */
import { describe, expect, it } from "vitest";
import { isLocalUrl, isPrivateNetworkUrl } from "../http";

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

describe("isPrivateNetworkUrl", () => {
  it("matches loopback, the LAN ranges, link-local, CGNAT and mDNS", () => {
    for (const u of [
      "http://localhost:11434/v1",
      "http://192.168.2.206:11234",
      "http://10.0.0.8:1234/v1",
      "http://172.16.0.1/v1",
      "http://172.31.255.255/v1",
      "http://169.254.10.1/v1",
      "http://100.100.1.2:11434",
      "http://[fd12:3456::1]:1234/v1",
      "http://[fe80::1]:1234/v1",
      "http://studio.local:1234/v1",
    ]) expect(isPrivateNetworkUrl(u), u).toBe(true);
  });

  it("does not match a public host", () => {
    for (const u of [
      "https://api.openai.com/v1",
      "http://172.32.0.1/v1",
      "http://100.128.0.1/v1",
      "http://8.8.8.8/v1",
      "http://[2001:db8::1]/v1",
      "http://192.168.example.com/v1",
      "",
      "/v1",
    ]) expect(isPrivateNetworkUrl(u), u).toBe(false);
  });

  it("leaves isLocalUrl — the Origin rewrite — at loopback", () => {
    expect(isLocalUrl("http://192.168.2.206:11234")).toBe(false);
  });
});
