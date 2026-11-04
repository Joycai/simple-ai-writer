import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConsentAdapter, ConsentState, Decision } from "../consent";
const nativeFetch = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: nativeFetch }));
const channel = vi.hoisted(() => ({ store: true }));
vi.mock("../../distribution", () => ({ requiresPrivacyConsent: () => channel.store }));
let epoch: string;
let paused: boolean;
let decisions: Map<string, Decision>;
let adapter: ConsentAdapter;
let request: ReturnType<typeof vi.fn>;
let gate: typeof import("../consent");
let http: typeof import("../../http");
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  channel.store = true; epoch = "initial"; paused = false; decisions = new Map();
  adapter = {
    read: vi.fn(async (key: string): Promise<ConsentState> => ({ epoch, paused, decision: decisions.get(key) })),
    save: vi.fn(async (key: string, value: Decision) => { decisions.set(key, value); }),
    ask: vi.fn(async () => true),
  };
  request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
  vi.stubGlobal("fetch", request);
  gate = await import("../consent");
  http = await import("../../http");
  gate.installConsentAdapter(adapter);
});
afterEach(() => { gate.setPrivacySessionPaused(true); vi.useRealTimers(); vi.unstubAllGlobals(); });
const send = async (url = "https://service.test/v1/chat/completions") => (await http.fetch(url)).text();

it("denial means zero sends, including automatic retries", async () => {
  vi.mocked(adapter.ask).mockResolvedValue(false);
  await expect(send()).rejects.toThrow("PRIVACY_CONSENT_REQUIRED");
  await expect(send()).rejects.toThrow("PRIVACY_CONSENT_REQUIRED");
  expect(adapter.ask).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalled();
});
it("missing boot adapter and failed persistence fail closed", async () => {
  vi.resetModules();
  const uninitialized = await import("../../http");
  await expect(uninitialized.fetch("https://service.test")).rejects.toThrow("PRIVACY_CONSENT_REQUIRED");
  vi.mocked(adapter.save).mockRejectedValue(new Error("disk failed"));
  await expect(send()).rejects.toThrow("disk failed");
  expect(request).not.toHaveBeenCalled();
});
it("shares one explicit decision for concurrent requests and restored tasks", async () => {
  await Promise.all([send(), send()]);
  expect(adapter.ask).toHaveBeenCalledTimes(1);
  vi.resetModules();
  const restored = await import("../consent");
  restored.installConsentAdapter(adapter);
  const restoredHttp = await import("../../http");
  await (await restoredHttp.fetch("https://service.test/v1/chat/completions")).text();
  expect(adapter.ask).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(3);
});
it("recipient, endpoint, purpose and notice changes require new consent", async () => {
  await send();
  await send("https://other.test/v1/chat/completions");
  await send("https://service.test/other/chat/completions");
  await (await http.fetch("https://service.test/v1/chat/completions", {}, "probe")).text();
  expect(adapter.ask).toHaveBeenCalledTimes(4);
  const key = gate.recipientOf("https://service.test/v1/chat/completions", "ai").key;
  decisions.set(key, { ...decisions.get(key)!, version: 0 });
  await send();
  expect(adapter.ask).toHaveBeenCalledTimes(5);
});
it("model-only Gemini changes share a disclosed route scope, host/base changes do not", () => {
  const a = gate.recipientOf("https://service.test/v1/models/a:generateContent?key=secret", "ai");
  const b = gate.recipientOf("https://service.test/v1/models/b:generateContent?key=new", "ai");
  expect(a.key).toBe(b.key);
  expect(JSON.stringify(a)).not.toContain("secret");
  expect(a.endpoint).toContain("models/a:generateContent");
  expect(a.scope).toContain("{model}");
});
it.each(["http://localhost:11434/v1", "http://192.168.1.5:8080/v1"])("local service %s still asks", async (url) => {
  await send(url);
  expect(adapter.ask).toHaveBeenCalledWith(expect.objectContaining({ endpoint: url }));
});
it.each(["probe", "retrieval", "audio", "mcp", "sync", "backup", "fonts"] as const)("%s cannot send without permission", async (purpose) => {
  vi.mocked(adapter.ask).mockResolvedValue(false);
  await expect(http.fetch("https://service.test/path", { method: "POST", body: "private" }, purpose)).rejects.toThrow("PRIVACY_CONSENT_REQUIRED");
  expect(request).not.toHaveBeenCalled();
});
it("revocation in another process blocks the next send and aborts a live response", async () => {
  const response = await http.fetch("https://service.test/v1/chat/completions");
  const signal = request.mock.calls[0][1].signal as AbortSignal;
  paused = true; epoch = "revoked";
  await vi.advanceTimersByTimeAsync(500);
  expect(signal.aborted).toBe(true);
  await response.body?.cancel();
  await expect(send()).rejects.toThrow("PRIVACY_CONSENT_REQUIRED");
  expect(request).toHaveBeenCalledTimes(1);
});
it("revocation while a dialog is open cannot be undone by its late approval", async () => {
  vi.mocked(adapter.ask).mockImplementation(async () => { epoch = "new"; paused = true; return true; });
  await expect(send()).rejects.toThrow("PRIVACY_CONSENT_REQUIRED");
  expect(adapter.save).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
it("a canceled caller never sends after its dialog returns", async () => {
  const controller = new AbortController();
  vi.mocked(adapter.ask).mockImplementation(async () => { controller.abort(); return true; });
  await expect(http.fetch("https://service.test", { signal: controller.signal })).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
it("HTTP redirects cannot forward an approved body to an undisclosed destination", async () => {
  request.mockResolvedValue(new Response(null, { status: 307, headers: { Location: "https://other.test" } }));
  await expect(send()).rejects.toThrow("PRIVACY_REDIRECT_BLOCKED");
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][1].redirect).toBe("manual");
});
it("a DB failure cannot reuse cached approval", async () => {
  await send();
  vi.mocked(adapter.read).mockRejectedValue(new Error("unavailable"));
  await expect(send()).rejects.toThrow("unavailable");
  expect(request).toHaveBeenCalledTimes(1);
});
it("direct builds keep the original transport behavior without consent IO", async () => {
  channel.store = false;
  await send();
  expect(adapter.ask).not.toHaveBeenCalled();
  expect(adapter.read).not.toHaveBeenCalled();
  expect(request.mock.calls[0][1]).toBeUndefined();
});

it("a failed persisted withdrawal remains blocked in the local window", async () => {
  await send();
  gate.setPrivacySessionPaused(true);
  await expect(send()).rejects.toThrow("PRIVACY_CONSENT_REQUIRED");
  expect(request).toHaveBeenCalledTimes(1);
});

it("native transport disables redirects and preserves cancellation through the response", async () => {
  vi.resetModules();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  const nativeGate = await import("../consent");
  nativeGate.installConsentAdapter(adapter);
  const nativeHttp = await import("../../http");
  nativeFetch.mockResolvedValue(new Response("native"));
  const response = await nativeHttp.fetch("http://localhost:11434/v1", { method: "POST", body: "private" });
  const options = nativeFetch.mock.calls[nativeFetch.mock.calls.length - 1][1];
  expect(options.maxRedirections).toBe(0);
  expect(options.headers.get("Origin")).toBe("http://localhost");
  nativeGate.setPrivacySessionPaused(true);
  expect(options.signal.aborted).toBe(true);
  await response.body?.cancel();
  expect(request).not.toHaveBeenCalled();
});
