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
    expect(params[0]).toBe("model-deepseek");
    expect(params[1]).toBe("subagent:search");
    expect(params[2]).toBe(100);
    expect(params[3]).toBe(20);
    expect(params[4]).toBe(50);
    expect(params[5]).toBe(0.002);
    expect(typeof params[6]).toBe("number");
  });

  it("does not throw if db execution fails", async () => {
    mockExecute.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      persistUsage("/test-project", "m1", 10, 10, 0.001, "chat"),
    ).resolves.toBeUndefined();
  });
});
