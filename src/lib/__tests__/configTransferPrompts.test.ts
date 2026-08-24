/**
 * What a restored prompt keeps.
 *
 * `parseConfigBundle` is the one gate an incoming backup passes through, and it
 * builds each `Prompt` field by field — so a field it does not name is silently
 * dropped rather than rejected. When the snippet library added `group`,
 * `useCount` and `lastUsedAt`, that meant a backup/restore round trip quietly
 * unfiled every snippet and reset every 「常用」 ordering, with no error anywhere
 * to notice. These tests pin the three fields through the gate, and pin that a
 * bundle written *before* those fields existed still opens.
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

/** The second argument is the set of provider ids already on this machine; no
 *  prompt case depends on it. */
const parseConfigBundle2 = (raw: unknown) => parseConfigBundle(raw, []);

const bundle = (prompts: unknown[]) => ({
  kind: CONFIG_BACKUP_KIND,
  version: 1,
  providers: [],
  models: [],
  prompts,
  prefs: [],
});

describe("parseConfigBundle · prompts", () => {
  it("carries a snippet's group and usage across the restore", () => {
    const out = parseConfigBundle2(bundle([{
      id: "s1", name: "条款偏差核查", content: "检查以下条款…", scene: "snippet",
      grp: "标书", useCount: 33, lastUsedAt: 1_700_000_000_000,
    }]));
    expect(out.prompts[0]).toMatchObject({
      group: "标书", useCount: 33, lastUsedAt: 1_700_000_000_000,
    });
  });

  it("opens a pre-snippet bundle, filing it into 未分组 with no usage", () => {
    const out = parseConfigBundle2(bundle([
      { id: "sys", name: "系统", content: "hi", scene: "system" },
    ]));
    expect(out.prompts[0]).toMatchObject({ group: "", useCount: 0, lastUsedAt: 0 });
  });

  it("ignores a non-numeric usage rather than letting it through", () => {
    const out = parseConfigBundle2(bundle([{
      id: "s1", name: "n", content: "c", scene: "snippet",
      useCount: "many", lastUsedAt: null,
    }]));
    expect(out.prompts[0]).toMatchObject({ useCount: 0, lastUsedAt: 0 });
  });

  it("still rejects a prompt missing its required fields", () => {
    const out = parseConfigBundle2(bundle([
      { id: "ok", name: "n", content: "c", scene: "snippet" },
      { id: "", name: "n", content: "c", scene: "snippet" },
      { id: "x", name: "n", scene: "snippet" },
    ]));
    expect(out.prompts.map((p) => p.id)).toEqual(["ok"]);
  });
});
