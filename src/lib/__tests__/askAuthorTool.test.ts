/**
 * The `ask_author` tool: argument validation (2–4 non-empty options), the
 * blocking contract through ToolContext.askAuthor, and the verbatim answer
 * formats the model reads back. The defensive floor — no channel wired —
 * must tell the model to proceed on its own, not error-loop.
 */
import { describe, expect, it, vi } from "vitest";

// The registry reaches the Tauri fs at import time through the write tools;
// nothing here executes one. Same mock set as agentToolSchema.test.ts.
vi.mock("../fs/fileio", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => {}),
  appendFile: vi.fn(async () => {}),
  writeBinaryFile: vi.fn(async () => {}),
  readBinaryFile: vi.fn(async () => new Uint8Array()),
  copyPath: vi.fn(async () => {}),
  makeDir: vi.fn(async () => {}),
  fileExists: vi.fn(async () => false),
  removeDir: vi.fn(async () => {}),
  removeFile: vi.fn(async () => {}),
  renamePath: vi.fn(async () => {}),
  readDir: vi.fn(async () => []),
}));
vi.mock("../project", () => ({ readDirRecursive: vi.fn(async () => []) }));
vi.mock("../../i18n", () => ({ default: { t: (key: string) => key } }));

import { executeRegisteredTool, type AskAnswer, type ToolContext } from "../agent/registry";

const baseCtx = { projectPath: "/p", loreIndex: { entities: [] }, multimodal: false };

function call(args: unknown) {
  return { id: "c1", name: "ask_author", arguments: JSON.stringify(args) };
}

async function run(args: unknown, answer?: AskAnswer) {
  const ctx = {
    ...baseCtx,
    ...(answer ? { askAuthor: vi.fn(async () => answer) } : {}),
  } as unknown as ToolContext;
  const result = await executeRegisteredTool(call(args), ["ask_author"], ctx);
  return { result, ctx };
}

describe("ask_author", () => {
  it("blocks on the channel and hands back a picked option verbatim", async () => {
    const { result, ctx } = await run(
      { question: "走哪条线？", options: ["A 线", "B 线"] },
      { kind: "option", index: 1, text: "B 线" },
    );
    expect(ctx.askAuthor).toHaveBeenCalledWith({ question: "走哪条线？", options: ["A 线", "B 线"] });
    expect(result.content).toBe("作者选择：「B 线」");
  });

  it("hands back free text verbatim, and says so for a dismissed card", async () => {
    const other = await run(
      { question: "q", options: ["1", "2"] }, { kind: "other", text: "都不要，换个方向" },
    );
    expect(other.result.content).toBe("作者的回答：「都不要，换个方向」");

    const dismissed = await run(
      { question: "q", options: ["1", "2"] }, { kind: "dismissed" },
    );
    expect(dismissed.result.content).toBe("运行已停止，问题未获回答。");
  });

  it("refuses a missing question and an option count outside 2-4", async () => {
    for (const args of [
      { options: ["1", "2"] },
      { question: "  ", options: ["1", "2"] },
      { question: "q", options: ["only one"] },
      { question: "q", options: ["1", "2", "3", "4", "5"] },
      // Blank options don't count toward the 2 — they can't be a button.
      { question: "q", options: ["1", "  "] },
      { question: "q" },
    ]) {
      const { result } = await run(args, { kind: "other", text: "unreachable" });
      expect(result.content).toMatch(/^Error:/);
    }
  });

  it("tells the model to proceed alone when no one is watching the run", async () => {
    // Routing should keep the tool off such surfaces; this is the floor.
    const { result } = await run({ question: "q", options: ["1", "2"] });
    expect(result.content).toContain("decide yourself");
  });
});
