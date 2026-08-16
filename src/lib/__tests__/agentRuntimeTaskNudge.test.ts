/**
 * Task-checklist staleness nudge — after TASK_NUDGE_ROUNDS tool rounds without
 * a successful task_plan/task_progress call, the runtime injects a reminder
 * carrying a snapshot of the checklist, then retracts it after the request
 * (same lifecycle as the scratchpad checkpoint notice). Only the model knows
 * which tool call finished which step, so the runtime enforces cadence, not
 * truth: it detects silence, it cannot verify progress.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskPreset } from "../agent/presets";
import { runAgent, type AgentRuntimeOptions } from "../agent/runtime";
import type { LoreIndex } from "../lore";
import type { StreamMessage, StreamOptions } from "../ai/types";

vi.mock("../ai", () => ({ streamCompletion: vi.fn() }));
import { streamCompletion } from "../ai";
const mockStream = vi.mocked(streamCompletion);

// Real parsing (parseSteps), mocked disk (loadTaskDoc/saveTaskDoc): the nudge
// logic under test is the runtime's, not the Tauri file layer's.
vi.mock("../agent/taskWorkspace", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../agent/taskWorkspace")>();
  return { ...orig, loadTaskDoc: vi.fn(), saveTaskDoc: vi.fn() };
});
import {
  loadTaskDoc,
  type TaskDoc,
  type TaskWorkspaceHandle,
} from "../agent/taskWorkspace";
const mockLoad = vi.mocked(loadTaskDoc);

const NUDGE_MARKER = "任务清单已连续多轮没有更新";

const LORE_INDEX = {
  characters: [
    { name: "Ava", summary: "the protagonist", dirPath: "/p/.ai-writer/lore/characters/ava", images: [] },
  ],
  world: [],
} as unknown as LoreIndex;

const PRESET: TaskPreset = {
  id: "test-nudge",
  tools: ["list_lore_entities", "task_progress"],
  maxRounds: 10,
  finishPolicy: "force-text",
  scratchpad: "required",
};

const WORKSPACE = {
  taskId: "t1",
  ensure: async () => ({ taskId: "t1", dir: "/p/.ai-writer/tasks/t1" }),
} as TaskWorkspaceHandle;

const taskDoc = (body: string): TaskDoc => ({
  meta: {
    taskId: "t1",
    status: "in_progress",
    modelId: "m",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  body,
});

const OPEN_PLAN = "# 目标\n\n<!-- ai-writer-task-steps -->\n\n- [ ] 第一步\n- [/] 第二步\n- [ ] 第三步\n";
const DONE_PLAN = "# 目标\n\n<!-- ai-writer-task-steps -->\n\n- [x] 第一步\n- [x] 第二步\n- [-] 第三步\n";

/** What each round actually sent — the history is mutated in place, so copy. */
const sent: StreamMessage[][] = [];

function queueRound(chunks: Array<Record<string, unknown>>): void {
  mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
    sent.push(opts.messages.map((m) => ({ ...m })));
    for (const c of chunks) opts.onChunk(c as never);
  });
}

const toolRound = (id: string, name = "list_lore_entities", args = "{}") =>
  queueRound([
    { toolCalls: [{ index: 0, id, name, arguments: args }] },
    { done: true, inputTokens: 1, outputTokens: 1 },
  ]);
const textRound = () => queueRound([{ text: "done" }, { done: true, inputTokens: 1, outputTokens: 1 }]);

const hasNudge = (messages: StreamMessage[]) =>
  messages.some(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.includes(NUDGE_MARKER),
  );

function makeOptions(): AgentRuntimeOptions {
  return {
    baseUrl: "http://localhost",
    apiKey: "k",
    standard: "openai",
    modelId: "m",
    preset: PRESET,
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
    ],
    toolContext: { projectPath: "/p", loreIndex: LORE_INDEX, multimodal: false, taskWorkspace: WORKSPACE },
    signal: new AbortController().signal,
    onEvent: () => {},
    onOutputText: () => {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sent.length = 0;
});

describe("agentRuntime task checklist nudge", () => {
  it("injects the nudge with a checklist snapshot after 3 silent tool rounds, and retracts it after the request", async () => {
    mockLoad.mockResolvedValue(taskDoc(OPEN_PLAN));
    for (let i = 1; i <= 4; i++) toolRound(`c${i}`);
    textRound();
    const opts = makeOptions();

    await runAgent(opts);

    // Rounds 1-3 ran without it; the 4th request carries it.
    expect(sent.slice(0, 3).some(hasNudge)).toBe(false);
    expect(hasNudge(sent[3])).toBe(true);
    const nudge = sent[3].find(
      (m) => typeof m.content === "string" && m.content.includes(NUDGE_MARKER),
    );
    expect(nudge?.content).toContain("1. [ ] 第一步");
    expect(nudge?.content).toContain("2. [/] 第二步");

    // The counter reset with the nudge: round 5 doesn't repeat it.
    expect(hasNudge(sent[4])).toBe(false);
    // And it was retracted from the persistent transcript.
    expect(hasNudge(opts.messages)).toBe(false);
  });

  it("a successful task_progress call resets the silence counter", async () => {
    mockLoad.mockResolvedValue(taskDoc(OPEN_PLAN));
    toolRound("c1");
    toolRound("c2");
    toolRound("c3", "task_progress", JSON.stringify({ action: "check", step: 1 }));
    toolRound("c4");
    toolRound("c5");
    textRound();
    const opts = makeOptions();

    await runAgent(opts);

    // Silence never reached 3 consecutive rounds, so no request carried the nudge.
    expect(sent.some(hasNudge)).toBe(false);
  });

  it("stays silent when every step is already done or skipped", async () => {
    mockLoad.mockResolvedValue(taskDoc(DONE_PLAN));
    for (let i = 1; i <= 4; i++) toolRound(`c${i}`);
    textRound();
    const opts = makeOptions();

    await runAgent(opts);

    expect(sent.some(hasNudge)).toBe(false);
  });

  it("stays silent when the run has no task workspace", async () => {
    mockLoad.mockResolvedValue(taskDoc(OPEN_PLAN));
    for (let i = 1; i <= 4; i++) toolRound(`c${i}`);
    textRound();
    const opts = makeOptions();
    opts.toolContext = { projectPath: "/p", loreIndex: LORE_INDEX, multimodal: false };

    await runAgent(opts);

    expect(sent.some(hasNudge)).toBe(false);
    expect(mockLoad).not.toHaveBeenCalled();
  });
});
