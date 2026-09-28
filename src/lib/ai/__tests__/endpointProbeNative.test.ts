/**
 * The endpoint probe on DashScope's native route: every request it makes goes
 * to the native endpoint in the native envelope, and the usage it calibrates
 * on is read under DashScope's names.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { probeEndpoint } from "../endpointProbe";

const BASE = "https://maas.qianwenaiapi.com/api/v1";
const GENERATION = `${BASE}/services/aigc/multimodal-generation/generation`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeEndpoint on the DashScope native route", () => {
  it("speaks the native envelope throughout", async () => {
    const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body });
      if (body?.parameters?.max_tokens > 1_000_000) {
        return new Response(JSON.stringify({
          code: "InvalidParameter", message: "<400> InternalError.Algo.InvalidParameter: Range of max_tokens should be [1, 131072]",
        }), { status: 400 });
      }
      // Usage that grows with the prompt, as a real tokenizer's does.
      const chars = JSON.stringify(body?.input?.messages ?? []).length;
      return new Response(JSON.stringify({
        output: { choices: [{ finish_reason: "length", message: { role: "assistant", content: [{ text: "1" }] } }] },
        usage: { input_tokens: 10 + Math.round(chars / 4), output_tokens: 1 },
      }), { status: 200 });
    }));

    const report = await probeEndpoint({ baseUrl: BASE, apiKey: "k", standard: "dashscope_compat", modelId: "qwen3.7-flash" });

    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(c.url).toBe(GENERATION);
      expect(Object.keys(c.body)).toEqual(["model", "input", "parameters"]);
      expect(c.body.parameters.result_format).toBe("message");
    }
    // The error probe streams, so an accepted one could be cut at the first byte.
    expect(calls[0].headers["X-DashScope-SSE"]).toBe("enable");
    expect(report.answered).toBe(true);
    expect(report.calibration?.charsPerToken).toBeGreaterThan(0);
    expect(report.warnings.map((w) => w.code)).not.toContain("no-usage-reported");
  });
});
