/**
 * The ComfyUI connection check (lib/ai/providerProbe → testComfyUiConnection).
 *
 * The 403 branch is the point of the whole function. ComfyUI's default
 * anti-DNS-rebinding middleware rejects any request whose Origin host differs
 * from its Host header, *before routing* — so a healthy instance answers 403 to
 * every path and no change to the request body can move it. `lib/http` attaches
 * such an Origin to every local request on purpose (Ollama's allowlist needs
 * it), which means this is a permanent, expected state and the only place the
 * author can learn what to do about it. See docs/feature/comfyui-plan.md §7.1.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { testComfyUiConnection } from "../ai/providerProbe";

function stubFetch(reply: () => Response | Promise<Response>) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(String(url));
    return reply();
  }));
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("testComfyUiConnection", () => {
  it("probes /system_stats and reports the version", async () => {
    const urls = stubFetch(() =>
      new Response(JSON.stringify({ system: { comfyui_version: "0.28.3" } }), { status: 200 }));
    const result = await testComfyUiConnection("http://127.0.0.1:8188");
    expect(urls).toEqual(["http://127.0.0.1:8188/system_stats"]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.message).toContain("0.28.3");
  });

  it("trims a trailing slash rather than probing a doubled path", async () => {
    const urls = stubFetch(() => new Response("{}", { status: 200 }));
    await testComfyUiConnection("http://127.0.0.1:8188/");
    expect(urls).toEqual(["http://127.0.0.1:8188/system_stats"]);
  });

  it("turns 403 into the --enable-cors-header instruction, not a bare status", async () => {
    stubFetch(() => new Response("", { status: 403 }));
    const result = await testComfyUiConnection("http://127.0.0.1:8188");
    expect(result.ok).toBe(false);
    // The flag is the actionable half; without it the author is told a running
    // server is broken and has nowhere to go.
    expect(!result.ok && result.error).toContain("--enable-cors-header");
    expect(!result.ok && result.error).not.toMatch(/^API error/);
  });

  it("distinguishes a stopped instance from a refusing one", async () => {
    stubFetch(() => { throw new Error("Connection refused"); });
    const result = await testComfyUiConnection("http://127.0.0.1:8188");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).not.toContain("--enable-cors-header");
    expect(!result.ok && result.error).toContain("Connection refused");
  });

  it("reports any other status verbatim — a proxy in front is not a CORS problem", async () => {
    stubFetch(() => new Response("", { status: 502 }));
    const result = await testComfyUiConnection("http://127.0.0.1:8188");
    expect(!result.ok && result.error).toContain("502");
  });
});
