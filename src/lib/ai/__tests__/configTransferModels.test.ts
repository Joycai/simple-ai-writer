/**
 * What a restored model keeps.
 *
 * Same gate as `configTransferPrompts.test.ts`: `parseConfigBundle` builds each
 * `Model` field by field, so a field it does not name is silently dropped on
 * restore rather than rejected. This pins the per-model wire declarations
 * through it — the ones whose loss is invisible until a request behaves
 * differently on the new machine.
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
  execute: vi.fn(async () => {}),
  select: vi.fn(async () => [] as { name: string }[]),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.0.0-test" }));
vi.mock("../../project", () => ({
  getGlobalDb: async () => ({ execute: h.execute, select: h.select }),
  getGlobalDbPath: async () => "/app-data/config.db",
}));
vi.mock("../../keyStore", () => ({ saveApiKey: async () => {}, loadApiKey: async () => null }));
vi.mock("../../fs/transfer", () => ({
  openTextFileDialog: async () => null,
  saveTextFileDialog: async () => null,
}));

const { parseConfigBundle, CONFIG_BACKUP_KIND } = await import("../configTransfer");

const bundle = (models: unknown[]) => ({
  kind: CONFIG_BACKUP_KIND,
  version: 1,
  providers: [{ id: "p1", name: "Relay", baseUrl: "https://relay.example/v1", apiStandard: "openai_compat", createdAt: 0 }],
  models,
  prompts: [],
  prefs: [],
});

const base = { id: "m1", providerId: "p1", modelId: "qwen3.8-max", name: "Qwen", type: "text" };

describe("parseConfigBundle · models", () => {
  it("carries the per-model wire declarations across the restore", () => {
    const out = parseConfigBundle(bundle([{
      ...base,
      thinkingCategory: "qwen-budget", thinkingBudget: 8000, serverTools: ["web_search"],
      pdfInput: true, structuredOutput: "json_schema", temperature: 0, textVerbosity: "low",
    }]), []);
    expect(out.models[0]).toMatchObject({
      thinkingCategory: "qwen-budget", thinkingBudget: 8000, serverTools: ["web_search"],
      pdfInput: true, structuredOutput: "json_schema", temperature: 0, textVerbosity: "low",
    });
    // A level this build doesn't know degrades to "send nothing".
    const odd = parseConfigBundle(bundle([{ ...base, textVerbosity: "extreme" }]), []);
    expect(odd.models[0].textVerbosity).toBeUndefined();
  });

  it("keeps the vision type and the hi-res declaration", () => {
    const out = parseConfigBundle(bundle([{ ...base, type: "vision", vlHighResolution: true }]), []);
    expect(out.models[0]).toMatchObject({ type: "vision", vlHighResolution: true });
    // Video declaration rides along; a hand-edited fps is clamped, junk dropped.
    const video = parseConfigBundle(bundle([
      { ...base, id: "v1", type: "vision", videoInput: true, videoFps: 0.5 },
      { ...base, id: "v2", type: "vision", videoInput: true, videoFps: 500 },
      { ...base, id: "v3", type: "vision", videoInput: "yes", videoFps: "fast" },
    ]), []);
    expect(video.models[0]).toMatchObject({ videoInput: true, videoFps: 0.5 });
    expect(video.models[1].videoFps).toBe(10);
    expect(video.models[2].videoInput).toBeUndefined();
    expect(video.models[2].videoFps).toBeUndefined();
  });

  it("upgrades a pre-type transcription row (asrFormat on a text row) to the asr type", () => {
    // A backup from before `asr` was a type: the identity lived on the format.
    const out = parseConfigBundle(bundle([{ ...base, type: "text", asrFormat: "dashscope-filetrans" }]), []);
    expect(out.models[0]).toMatchObject({ type: "asr", asrFormat: "dashscope-filetrans" });
  });

  it("degrades an unknown structured-output value to auto instead of sending it", () => {
    // A backup from a newer build can name a mode this build doesn't know.
    const out = parseConfigBundle(bundle([{ ...base, structuredOutput: "json_schema_v2" }]), []);
    expect(out.models[0].structuredOutput).toBeUndefined();
  });

  it("opens a bundle written before the declaration existed", () => {
    const out = parseConfigBundle(bundle([base]), []);
    expect(out.models).toHaveLength(1);
    expect(out.models[0].structuredOutput).toBeUndefined();
  });
});

/**
 * 落库时模型算「新代码决定的绑定」还是「只有旧价」，全看包的版本：v3 起价在
 * 计费组上，更早的包价还在模型行上。
 */
describe("parseConfigBundle · legacyPrices", () => {
  it.each([
    [1, true],
    [2, true],
    [3, false],
  ])("version %s → %s", (version, legacy) => {
    expect(parseConfigBundle({ ...bundle([base]), version }, []).legacyPrices).toBe(legacy);
  });

  it("没写版本号的包按最老的读", () => {
    const { version: _v, ...noVersion } = bundle([base]);
    expect(parseConfigBundle(noVersion, []).legacyPrices).toBe(true);
  });
});
