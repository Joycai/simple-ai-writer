import { expect, it, vi } from "vitest";
import { recordImageUsage } from "../index";
import { recordUsage } from "../../ai/usageRow";
import type { Model } from "../../ai/configDb";
vi.mock("../../ai/usageRow", () => ({ recordUsage: vi.fn(async () => {}) }));
it("preserves the request identity, actual images and absent token counts on repeated delivery", async () => {
  const model = { id: "image-model" } as Model;
  await recordImageUsage("/p", model, "image", 2, undefined, { size: "1K" }, 3, "image-attempt");
  await recordImageUsage("/p", model, "image", 2, undefined, { size: "1K" }, 3, "image-attempt");
  expect(vi.mocked(recordUsage).mock.calls.map(([, r]) => r.requestId)).toEqual(["image-attempt", "image-attempt"]);
  expect(recordUsage).toHaveBeenCalledWith("/p", expect.objectContaining({
    outputUnits: 2, inputImages: 3, promptTokens: undefined, completionTokens: undefined, cachedTokens: undefined,
  }));
});
it("keeps explicitly reported zero distinct from missing usage", async () => {
  await recordImageUsage(null, { id: "m" } as Model, "image", 1,
    { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, {}, 0, "zero-image");
  expect(recordUsage).toHaveBeenLastCalledWith(null, expect.objectContaining({ promptTokens: 0, completionTokens: 0, cachedTokens: 0 }));
});
