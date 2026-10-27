import { expect, it, vi } from "vitest";
import { recordTranscriptionUsage, type TranscribeOutcome } from "../run";
import { recordUsage } from "../../ai/usageRow";
vi.mock("../../ai/usageRow", async (original) => ({
  ...await original<typeof import("../../ai/usageRow")>(), recordUsage: vi.fn(async () => {}),
}));
it("records missing billed duration as unknown and carries the task identity unchanged", async () => {
  const result = { cached: false, billedSeconds: null, requestId: "asr-task" } as TranscribeOutcome;
  await recordTranscriptionUsage("/p", { id: "m" }, result);
  await recordTranscriptionUsage("/p", { id: "m" }, result);
  expect(vi.mocked(recordUsage).mock.calls.map(([, r]) => r.requestId)).toEqual(["asr-task", "asr-task"]);
  expect(recordUsage).toHaveBeenLastCalledWith("/p", expect.objectContaining({ outputUnits: undefined, inputImages: 0 }));
});
it("cache hits do not create a new bill; actual fractional seconds are preserved", async () => {
  vi.mocked(recordUsage).mockClear();
  await recordTranscriptionUsage("/p", { id: "m" }, { cached: true, billedSeconds: 2.5 } as TranscribeOutcome);
  expect(recordUsage).not.toHaveBeenCalled();
  await recordTranscriptionUsage("/p", { id: "m" }, { cached: false, billedSeconds: 2.5, requestId: "fresh-task" } as TranscribeOutcome);
  expect(recordUsage).toHaveBeenCalledWith("/p", expect.objectContaining({ outputUnits: 2.5, requestId: "fresh-task" }));
});
