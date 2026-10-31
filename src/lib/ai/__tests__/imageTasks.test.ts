import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../../project", () => ({ getGlobalDb: async () => state.db }));
import { imageTaskKey, readImageTask, reserveImageTask, saveImageTask, forgetImageTask } from "../imageTasks";
const raw = new DatabaseSync(":memory:");
state.db = {
  execute: async (sql: string, values: unknown[] = []) => ({ rowsAffected: raw.prepare(sql).run(...values as never[]).changes }),
  select: async (sql: string, values: unknown[] = []) => raw.prepare(sql).all(...values as never[]),
};
afterEach(() => raw.exec("DELETE FROM image_tasks"));
it("reserves before POST and only one concurrent submitter wins", async () => {
  const reservations = await Promise.all([reserveImageTask("same"), reserveImageTask("same")]);
  expect(reservations.filter(Boolean)).toHaveLength(1);
  expect(await readImageTask("same")).toMatchObject({ taskId: "" });
  await saveImageTask("same", { taskId: "upstream-id", requestId: "receipt-id", submittedAt: 1 });
  expect(await reserveImageTask("same")).toBe(false);
  expect(await readImageTask("same")).toEqual({ taskId: "upstream-id", requestId: "receipt-id", submittedAt: 1 });
  await forgetImageTask("same");
  expect(await readImageTask("same")).toBeUndefined();
});
it("keys include endpoint, credentials, model and all request parameters without storing secrets", async () => {
  await reserveImageTask("init");
  const key = await imageTaskKey("https://a", "m", "secret", { prompt: "private" });
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(await imageTaskKey("https://a", "m", "secret", { prompt: "private" })).toBe(key);
  expect(await imageTaskKey("https://b", "m", "secret", { prompt: "private" })).not.toBe(key);
  expect(await imageTaskKey("https://a", "m", "other", { prompt: "private" })).not.toBe(key);
});

it("resumes a saved upstream job without a second POST or a new accounting identity", async () => {
  const { generateImage } = await import("../image");
  const { PNG_B64 } = await import("./imageFixtures");
  const conn = { baseUrl: "https://example.test/api/v1", modelId: "image", apiKey: "key", standard: "dashscope_compat" as const, asyncTask: true };
  const abort = new AbortController();
  const settled = vi.fn(async () => {});
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      abort.abort();
      return new Response(JSON.stringify({ output: { task_id: "paid-task" } }));
    }
    return new Response(JSON.stringify({ output: { task_status: "SUCCEEDED", results: [{ url: "data:image/png;base64," + PNG_B64 }] } }));
  });
  vi.stubGlobal("fetch", fetch);
  try {
    await expect(generateImage(conn, { prompt: "x", signal: abort.signal, onSettled: settled })).rejects.toThrow(/paid-task/);
    expect(settled).not.toHaveBeenCalled();
    const saved = raw.prepare("SELECT request_id FROM image_tasks").get();
    const pending = generateImage(conn, { prompt: "x", onSettled: settled });
    const result = await pending;
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(result.requestId).toBe(saved?.request_id);
    expect(settled).toHaveBeenCalledOnce();
    expect(raw.prepare("SELECT COUNT(*) AS n FROM image_tasks").get()?.n).toBe(0);
  } finally { vi.unstubAllGlobals(); }
});
