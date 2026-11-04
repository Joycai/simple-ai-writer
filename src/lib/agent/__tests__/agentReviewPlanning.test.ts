import { expect, it, vi } from "vitest";
import { streamCompletion } from "../../ai";
import { runAgent } from "../runtime";
import { CONSISTENCY_PRESET } from "../presets";
import { saveTaskDoc } from "../taskWorkspace";
import type { StreamOptions } from "../../ai/types";

vi.mock("../../ai", () => ({ streamCompletion: vi.fn() }));
vi.mock("../taskWorkspace", async (original) => ({
  ...await original<typeof import("../taskWorkspace")>(),
  loadTaskDoc: vi.fn(async () => ({ body: "# Review", meta: { status: "in_progress" } })),
  saveTaskDoc: vi.fn(async () => {}),
}));

it("unlocks research only after the existing task_plan handler successfully saves the plan", async () => {
  const chunks = [
    [{ toolCalls: [{ index: 0, id: "plan", name: "task_plan", arguments: JSON.stringify({ title: "Verify facts", steps: ["Compare dates", "Check names"] }) }] }],
    [{ text: "Research finished." }],
    [{ text: "Results submitted." }],
  ];
  for (const round of chunks) vi.mocked(streamCompletion).mockImplementationOnce(async (opts: StreamOptions) => {
    for (const chunk of round) opts.onChunk(chunk);
    return {};
  });
  let taskId: string | null = null;
  await runAgent({
    baseUrl: "http://localhost", apiKey: "unused", standard: "openai", modelId: "test",
    preset: CONSISTENCY_PRESET,
    messages: [{ role: "user", content: "Verify facts" }],
    toolContext: { projectPath: "/fixture", loreIndex: {}, multimodal: false,
      taskWorkspace: { get taskId() { return taskId; }, ensure: async () => {
        taskId = "review-plan";
        return { taskId, dir: "/fixture/.ai-writer/tasks/review-plan" };
      } },
    },
    signal: new AbortController().signal, onEvent: () => {}, onOutputText: () => {},
  });
  const requests = vi.mocked(streamCompletion).mock.calls.map(([request]) => request);
  expect(requests[0].tools?.map((t) => t.function.name)).toEqual(["task_plan"]);
  expect(saveTaskDoc).toHaveBeenCalledWith("/fixture", "review-plan", expect.objectContaining({
    body: expect.stringContaining("Compare dates"),
  }));
  expect(requests[1].tools?.some((t) => t.function.name === "read_file")).toBe(true);
  expect(requests[2].tools?.map((t) => t.function.name)).toEqual(["task_progress", "report_issue", "report_pass"]);
});
