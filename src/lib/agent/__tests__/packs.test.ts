import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model, Provider } from "../../ai/configDb";
import type { ToolContext } from "../registry";
import type { ToolCall } from "../tools";

const mockRunAgent = vi.fn();
const mockPersistUsage = vi.fn();
const mockWriteTaskNote = vi.fn();

vi.mock("../runtime", () => ({
  runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

vi.mock("../../ai/usage", () => ({
  persistUsage: (...args: unknown[]) => mockPersistUsage(...args),
}));

vi.mock("../taskWorkspace", () => ({
  writeTaskNote: (...args: unknown[]) => mockWriteTaskNote(...args),
}));

/** The export Betas, flipped by hand — same seam as routing.test.ts. */
const pptxBeta = { on: false };
vi.mock("../../pptx/flag", () => ({ isPptxExportEnabled: () => pptxBeta.on }));
const docxBeta = { on: false };
vi.mock("../../docx/flag", () => ({ isDocxExportEnabled: () => docxBeta.on }));
const xlsxBeta = { on: false };
vi.mock("../../xlsx/flag", () => ({ isXlsxExportEnabled: () => xlsxBeta.on }));

/** The orchestrator Beta — chatAgentPreset's one input. */
const orchestratorBeta = { on: false };
vi.mock("../packFlag", () => ({
  isOrchestratorEnabled: () => orchestratorBeta.on,
}));

import { chatAgentPreset, executeRunPack, ORCHESTRATOR_PRESET, PACK_IDS, PACK_PRESETS } from "../packs";
import { AGENT_ASSIST_PRESET } from "../presets";
import { partitionByGroup } from "../registry";

describe("tool packs", () => {
  const model: Model = {
    id: "m-main",
    providerId: "p1",
    modelId: "main",
    name: "Main Model",
    type: "text",
    priceIn: 1,
    priceCachedIn: 0,
    priceOut: 2,
    enabled: true,
    contextSize: 32_000,
  };
  const provider: Provider = {
    id: "p1",
    name: "Provider 1",
    baseUrl: "https://api.openai.com",
    apiStandard: "openai",
    createdAt: 0,
  };

  const makeCtx = (overrides?: Partial<ToolContext>): ToolContext => ({
    projectPath: "/test-project",
    loreIndex: {} as never,
    loreScope: "本传",
    multimodal: false,
    signal: new AbortController().signal,
    onNestedEvent: vi.fn(),
    requestApproval: vi.fn(),
    requestPlanApproval: vi.fn(),
    lorePlan: { steps: [] } as never,
    taskWorkspace: {
      taskId: "task-123",
      ensure: vi.fn(async () => ({ taskId: "task-123", isNew: false })),
    } as never,
    selfConn: { provider, model, apiKey: "k" },
    contextUtilization: 0.5,
    ...overrides,
  });

  const callFor = (args: object): ToolCall => ({
    id: "c1",
    name: "run_pack",
    arguments: JSON.stringify(args),
  });

  const happyRun = () => {
    mockRunAgent.mockImplementation(async (opts: { onOutputText: (t: string) => void }) => {
      opts.onOutputText("Done: rewrote intro.md sections 1–2.");
      return { rounds: 3, inputTokens: 500, outputTokens: 200, cachedTokens: 0, outcome: "completed" };
    });
    mockWriteTaskNote.mockResolvedValue({
      slug: "pack-file_write-x",
      title: "x",
      path: ".ai-writer/tasks/task-123/notes/pack-file_write-x.md",
      size: 40,
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    pptxBeta.on = false;
    docxBeta.on = false;
    xlsxBeta.on = false;
  });

  describe("preset shape (structural invariants)", () => {
    it("no pack can dispatch further — run_pack and delegate are absent from every pack", () => {
      // Nesting is prevented structurally, not by a depth counter: the tool
      // simply does not exist inside a pack's toolset.
      for (const id of PACK_IDS) {
        expect(PACK_PRESETS[id].tools).not.toContain("run_pack" as never);
        expect(PACK_PRESETS[id].tools).not.toContain("delegate" as never);
      }
    });

    it("lore_edit's write tools stay in the deferred groups", () => {
      // The whole reason the pack lists them (like AGENT_ASSIST does) is so
      // partitionByGroup can withhold their schemas until the shared plan
      // gate's steps demand them. If one leaks into the resident half, the
      // sub-run pays for it on every round before any plan exists.
      const { resident, deferred } = partitionByGroup(PACK_PRESETS.lore_edit.tools);
      expect(resident).not.toContain("update_lore_file");
      expect(resident).not.toContain("manage_collection");
      expect(deferred.lore_write.length).toBeGreaterThan(5);
      expect(deferred.lore_organize.length).toBeGreaterThan(0);
      expect(resident).toContain("propose_lore_plan");
    });

    it("no pack carries the drawing arm — 生图不进 pack (plan §3.1)", () => {
      for (const id of PACK_IDS) {
        expect(PACK_PRESETS[id].tools).not.toContain("generate_image" as never);
        expect(PACK_PRESETS[id].tools).not.toContain("edit_image" as never);
      }
    });

    it("the orchestrator holds no document, knowledge-base or export write tool", () => {
      // D4's clean boundary: "who writes?" has a one-word answer — a pack.
      // update_memory is the deliberate exception (tiny, frequent, not worth a
      // dispatch), and the imagegen trio rides its own existing shape (routing
      // strips it when no image binding is live).
      const writes = [
        "propose_edit", "rewrite_lines", "rewrite_document", "append_file",
        "create_file", "create_chapter", "delete_chapter", "delete_directory",
        "propose_lore_plan", "create_lore_entity", "update_lore_file",
        "edit_lore_file", "delete_lore_entity", "manage_collection",
        "export_pptx", "export_docx", "export_xlsx",
      ];
      for (const t of writes) {
        expect(ORCHESTRATOR_PRESET.tools).not.toContain(t as never);
      }
      expect(ORCHESTRATOR_PRESET.tools).toContain("update_memory");
      // run_pack itself is routing's to append — listing it here would make it
      // appear even where the surface never threaded the channels through.
      expect(ORCHESTRATOR_PRESET.tools).not.toContain("run_pack" as never);
    });

    it("chatAgentPreset is the Beta switch's one seam", () => {
      expect(chatAgentPreset()).toBe(AGENT_ASSIST_PRESET);
      orchestratorBeta.on = true;
      try {
        expect(chatAgentPreset()).toBe(ORCHESTRATOR_PRESET);
      } finally {
        orchestratorBeta.on = false;
      }
    });
  });

  describe("executeRunPack guards", () => {
    it("fails when the surface lacks the pack machinery (no selfConn)", async () => {
      const res = await executeRunPack(
        callFor({ pack: "file_write", task: "do it" }),
        makeCtx({ selfConn: undefined }),
      );
      expect(res.content).toContain("cannot run tool packs");
      expect(mockRunAgent).not.toHaveBeenCalled();
    });

    it("refuses an unknown pack by naming the real ones", async () => {
      const res = await executeRunPack(callFor({ pack: "image", task: "draw" }), makeCtx());
      expect(res.content).toContain("file_write, lore_edit, export");
    });

    it("requires a task brief", async () => {
      const res = await executeRunPack(callFor({ pack: "file_write" }), makeCtx());
      expect(res.content).toContain("'task' is required");
    });

    it("file_write fails fast without the approval channel", async () => {
      // Without this, the sub-run burns rounds discovering the missing card
      // one refused propose_edit at a time.
      const res = await executeRunPack(
        callFor({ pack: "file_write", task: "edit intro.md" }),
        makeCtx({ requestApproval: undefined }),
      );
      expect(res.content).toContain("approval card");
      expect(mockRunAgent).not.toHaveBeenCalled();
    });

    it("lore_edit fails fast without the plan gate", async () => {
      const res = await executeRunPack(
        callFor({ pack: "lore_edit", task: "update 云锦" }),
        makeCtx({ lorePlan: undefined }),
      );
      expect(res.content).toContain("plan-approval card");
      expect(mockRunAgent).not.toHaveBeenCalled();
    });

    it("export is refused outright while every export Beta is off", async () => {
      const res = await executeRunPack(
        callFor({ pack: "export", task: "export report.md to docx" }),
        makeCtx(),
      );
      expect(res.content).toContain("every export format is switched off");
      expect(mockRunAgent).not.toHaveBeenCalled();
    });

    it("export carries only the formats whose Beta is on", async () => {
      docxBeta.on = true;
      happyRun();
      await executeRunPack(callFor({ pack: "export", task: "export report.md to docx" }), makeCtx());
      const preset = mockRunAgent.mock.calls[0][0].preset;
      expect(preset.tools).toContain("export_docx");
      expect(preset.tools).toContain("read_doc_format");
      expect(preset.tools).not.toContain("export_pptx");
      expect(preset.tools).not.toContain("export_xlsx");
    });

    it("strips read_lore_image on a text-only conn — absent, not refused", async () => {
      // A pack sub-run has no delegate and cannot reach the vision subagent,
      // so the routing strip's job falls to the model's own capability here:
      // on a text-only conn the tool could only ever answer "cannot accept
      // images".
      happyRun();
      await executeRunPack(callFor({ pack: "lore_edit", task: "统一角色卡" }), makeCtx());
      const preset = mockRunAgent.mock.calls[0][0].preset;
      expect(preset.tools).not.toContain("read_lore_image");
    });

    it("keeps read_lore_image when the parent model is multimodal — a direct read beats a hop", async () => {
      happyRun();
      await executeRunPack(
        callFor({ pack: "lore_edit", task: "统一角色卡" }),
        makeCtx({ selfConn: { provider, model: { ...model, type: "multimodal" }, apiKey: "k" } }),
      );
      const preset = mockRunAgent.mock.calls[0][0].preset;
      expect(preset.tools).toContain("read_lore_image");
    });
  });

  describe("the sub-run's contract", () => {
    it("runs the pack preset on the parent's own conn with the channels passed through", async () => {
      happyRun();
      const ctx = makeCtx();
      const res = await executeRunPack(
        callFor({ pack: "file_write", task: "rewrite intro.md", references: ["notes/材料.md"] }),
        ctx,
      );

      const opts = mockRunAgent.mock.calls[0][0];
      // D1: the parent's model, flattened the usual way — not a subagent binding.
      expect(opts.modelId).toBe("main");
      expect(opts.preset.id).toBe("pack-file-write");
      // D3: the channel OBJECTS themselves, so cards render on the main
      // surface and auto-approve grants (bound inside the closures) ride along.
      expect(opts.toolContext.requestApproval).toBe(ctx.requestApproval);
      expect(opts.toolContext.lorePlan).toBe(ctx.lorePlan);
      // The fence and the material bus travel too.
      expect(opts.toolContext.loreScope).toBe("本传");
      expect(opts.toolContext.taskWorkspace).toBe(ctx.taskWorkspace);
      expect(opts.toolContext.signal).toBe(ctx.signal);
      // The sub-run sizes its own window: schemas off the ceiling before it starts.
      expect(opts.inputCeilingTokens).toBeGreaterThan(0);
      expect(opts.inputCeilingTokens).toBeLessThan(16_000);
      // The brief rides the standard subagent task template.
      expect(opts.messages).toHaveLength(2);
      expect(JSON.stringify(opts.messages[1].content)).toContain("rewrite intro.md");
      expect(JSON.stringify(opts.messages[1].content)).toContain("notes/材料.md");

      expect(res.content).toContain("pack-file_write-x.md");
      expect(res.content).toContain("Report:");
      expect(mockPersistUsage).toHaveBeenCalledWith(
        "/test-project", "m-main", 500, 200, expect.any(Number), "pack:file_write", 0,
      );
    });

    it("keeps the pack's spend out of the parent's totals via a nested run-done", async () => {
      happyRun();
      const ctx = makeCtx();
      await executeRunPack(callFor({ pack: "file_write", task: "t" }), ctx);
      const events = (ctx.onNestedEvent as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      const done = events.find((e) => e.kind === "run-done");
      expect(done).toMatchObject({ inputTokens: 500, outputTokens: 200, parentStep: "c1" });
    });

    it("resyncs the parent's lore snapshot after a lore_edit pack", async () => {
      // The pack's writes went to disk and the app; without this the parent's
      // run snapshot still shows the old index and the turn's remaining rounds
      // cannot resolve what the pack just created.
      happyRun();
      const onLoreChanged = vi.fn();
      const ctx = makeCtx({ onLoreChanged });
      await executeRunPack(callFor({ pack: "lore_edit", task: "create 云锦" }), ctx);
      expect(onLoreChanged).toHaveBeenCalled();
    });

    it("does not rescan lore for a file_write pack", async () => {
      happyRun();
      const onLoreChanged = vi.fn();
      const ctx = makeCtx({ onLoreChanged });
      await executeRunPack(callFor({ pack: "file_write", task: "t" }), ctx);
      expect(onLoreChanged).not.toHaveBeenCalled();
    });

    it("reports a pack failure as a tool error, not a thrown run", async () => {
      mockRunAgent.mockRejectedValueOnce(new Error("boom"));
      const res = await executeRunPack(callFor({ pack: "file_write", task: "t" }), makeCtx());
      expect(res.content).toContain("the file_write pack failed: boom");
    });

    it("an empty report is an error the parent can act on", async () => {
      mockRunAgent.mockImplementation(async () => ({
        rounds: 1, inputTokens: 1, outputTokens: 0, cachedTokens: 0, outcome: "completed",
      }));
      const res = await executeRunPack(callFor({ pack: "file_write", task: "t" }), makeCtx());
      expect(res.content).toContain("returned no report");
    });
  });
});
