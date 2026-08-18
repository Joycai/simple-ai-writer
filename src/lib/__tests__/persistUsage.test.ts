import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecute = vi.fn(async () => {});
vi.mock("../project", () => ({
  getDb: vi.fn(async () => ({
    execute: mockExecute,
  })),
}));

import { persistUsage } from "../ai/usage";

describe("persistUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts a token_usage row with expected fields", async () => {
    await persistUsage("/test-project", "model-deepseek", 100, 50, 0.002, "subagent:search", 20);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [sql, params] = mockExecute.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("INSERT INTO token_usage");
    // Match params to their column by name (from the SQL's own column list)
    // rather than by array index, so a harmless column reorder can't fail this.
    const columns = sql.match(/\(([^)]+)\)/)![1].split(",").map((c) => c.trim());
    const row = Object.fromEntries(columns.map((c, i) => [c, params[i]]));
    expect(row).toMatchObject({
      model_id: "model-deepseek",
      task: "subagent:search",
      prompt_tokens: 100,
      cached_tokens: 20,
      completion_tokens: 50,
      cost_usd: 0.002,
    });
    expect(typeof row.created_at).toBe("number");
  });

  it("does not throw if db execution fails", async () => {
    mockExecute.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      persistUsage("/test-project", "m1", 10, 10, 0.001, "chat"),
    ).resolves.toBeUndefined();
  });
});
