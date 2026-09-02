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
vi.mock("../project", () => ({
  getGlobalDb: async () => ({ execute: h.execute, select: h.select }),
  getGlobalDbPath: async () => "/app-data/config.db",
}));
vi.mock("../keyStore", () => ({ saveApiKey: async () => {}, loadApiKey: async () => null }));
vi.mock("../fs/transfer", () => ({
  openTextFileDialog: async () => null,
  saveTextFileDialog: async () => null,
}));

const { parseConfigBundle, CONFIG_BACKUP_KIND } = await import("../ai/configTransfer");

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
      pdfInput: true, structuredOutput: "json_schema", temperature: 0,
    }]), []);
    expect(out.models[0]).toMatchObject({
      thinkingCategory: "qwen-budget", thinkingBudget: 8000, serverTools: ["web_search"],
      pdfInput: true, structuredOutput: "json_schema", temperature: 0,
    });
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
