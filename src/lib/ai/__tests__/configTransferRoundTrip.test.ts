/**
 * Every provider / model / prompt field survives the whole trip:
 *
 *   row write (`*Upsert`) → row read (`list*`) → bundle JSON → `parseConfigBundle`
 *
 * Each of those four steps names its fields by hand, so a field one of them
 * forgets is not rejected — it is silently dropped, and the loss only shows as a
 * request behaving differently on the restored machine. `configTransferModels`
 * and `configTransferPrompts` pin particular fields; this one pins *all* of them.
 *
 * The fixtures are typed `Required<…>`, so adding a field to `Provider`, `Model`
 * or `Prompt` fails `tsc` here until the fixture carries it — and then this test
 * fails until every step does. Values are chosen to survive each parser as-is
 * (no degradation, no clamping, no normalization), so `toEqual` means "nothing
 * was lost", not "something plausible came back".
 */
import { describe, expect, it, vi } from "vitest";
import type { SqlStatement } from "../../sqlTx";

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.0.0-test" }));
vi.mock("../../project", () => ({
  getGlobalDb: async () => ({ execute: async () => {}, select: async () => [] }),
  getGlobalDbPath: async () => "/app-data/config.db",
}));
vi.mock("../../keyStore", () => ({ saveApiKey: async () => {}, loadApiKey: async () => null }));
vi.mock("../../fs/transfer", () => ({
  openTextFileDialog: async () => null,
  saveTextFileDialog: async () => null,
}));

const { listModels, listPrompts, listProviders, modelUpsert, promptUpsert, providerUpsert } =
  await import("../configDb");
const { parseConfigBundle, CONFIG_BACKUP_KIND } = await import("../configTransfer");
const { feeGroupUpsert } = await import("../feeGroupDb");
type FeeGroup = import("../feeGroup").FeeGroup;
type Provider = import("../configDb").Provider;
type Model = import("../configDb").Model;
type Prompt = import("../configDb").Prompt;
type ImageCaps = import("../configDb").ImageCaps;

/** The row an upsert would store: its column list zipped with its values. */
function rowOf({ sql, values }: SqlStatement): Record<string, unknown> {
  const cols = /\(([^)]*)\)\s*VALUES/i.exec(sql)?.[1].split(",").map((c) => c.trim());
  if (!cols || cols.length !== values.length) {
    throw new Error(`column list and values disagree in: ${sql}`);
  }
  return Object.fromEntries(cols.map((c, i) => [c, values[i]]));
}

/** A db whose every select answers with the rows currently staged. */
const fakeDb = { select: async () => h.rows, execute: async () => {} } as never;

async function throughDb<T>(stmt: SqlStatement, read: (db: never) => Promise<T[]>): Promise<T> {
  h.rows = [rowOf(stmt)];
  const out = await read(fakeDb);
  return out[0];
}

// Normalized already (flat fields = the primary route's), so `toEqual` means
// nothing was lost rather than something was re-derived. Two routes, one with
// an overridden path and one on the platform's convention (no `path`).
const provider: Required<Provider> = {
  id: "p1",
  defaultFeeGroupId: "fg1",
  name: "Relay",
  baseUrl: "https://relay.example/gemini-v1beta",
  apiStandard: "gemini_compat",
  safetySettings: { HARM_CATEGORY_HARASSMENT: "BLOCK_NONE" },
  authMode: "bearer",
  sortOrder: 3,
  // Not what the address would infer (custom): the stored value must survive.
  platform: "newapi",
  host: "https://relay.example",
  endpoints: [
    {
      family: "gemini", official: false, path: "/gemini-v1beta", authMode: "bearer",
      safetySettings: { HARM_CATEGORY_HARASSMENT: "BLOCK_NONE" },
    },
    { family: "anthropic", official: false, authMode: "both" },
  ],
  createdAt: 1_700_000_000_000,
};

const caps: Required<ImageCaps> = {
  edit: true,
  dialect: "qwen-image",
  sizes: ["1024x1024", "1328x1328"],
  maxRefs: 3,
  route: "comfyui",
  asyncTask: true,
  comfy: { workflow: '{"3":{"class_type":"KSampler","inputs":{}}}' },
};

/**
 * `fee` 不在这里：它不是一列，是 `listModels` 读出来时按 `feeGroupId` 解析
 * 挂上去的（`attachFees`）。它**不该**跨机器带过去——另一台机器上那个组
 * 可能已经改了价，而这一行的价该由那台机器的组说了算。所以这份夹具只
 * 覆盖真正落库的字段，`fee` 的缺席是断言的一部分。
 */
const model: Required<Omit<Model, "fee">> = {
  id: "m1",
  feeGroupId: "fg1",
  providerId: "p1",
  modelId: "qwen3.8-max",
  name: "Qwen",
  // `asr` because `asrFormat` is set: `normalizeAsrIdentity` would otherwise
  // retype the row, and the test would be about normalization, not loss.
  type: "asr",
  priceIn: 1.5,
  priceCachedIn: 0.3,
  priceOut: 6,
  enabled: false,
  prefix: "Be terse.",
  contextSize: 131_072,
  maxOutput: 8192,
  temperature: 0.4,
  probedAt: 1_700_000_000_500,
  probedContextSize: 128_000,
  probedMaxOutput: 16_384,
  reasoningEffort: "high",
  thinkingCategory: "qwen-budget",
  thinkingBudget: 4000,
  thinkingDialect: "extended",
  serverTools: ["web_search", "web_extractor"],
  structuredOutput: "json_schema",
  pdfInput: true,
  vlHighResolution: true,
  videoInput: true,
  videoFps: 0.5,
  textVerbosity: "low",
  translateFormat: "sakura",
  asrFormat: "dashscope-sync",
  pricePerSecond: 0.00022,
  pricePerImage: 0.04,
  caps,
  activeRoute: "gemini",
  routes: {
    anthropic: {
      maxOutput: 4096, temperature: 1, reasoningEffort: "low", thinkingCategory: "claude-adaptive",
      thinkingBudget: 2048, thinkingDialect: "extended", structuredOutput: "off", textVerbosity: "high",
      vlHighResolution: true, probedAt: 1_700_000_000_900, probedContextSize: 200_000, probedMaxOutput: 64_000,
    },
  },
};

/** 计费组：整行都要跨机器带过去，价才不会在新机器上变成 0。 */
const feeGroup: Required<FeeGroup> = {
  id: "fg1",
  name: "即梦 4.0 · 按张",
  vendor: "字节 · 火山方舟",
  billingMode: "spec",
  inputPrice: 5,
  // 0 而不是 null：null 是「没填」，它序列化成 JSON 之后还是 null，而这份
  // 夹具要的是「每个字段都带着一个能被认出来的值」。null 的那一支由
  // feeGroupDb.test.ts 钉。
  cacheInputPrice: 0.5,
  outputPrice: 40,
  requestPrice: 0.04,
  outputUnit: "image",
  outputRates: [{ size: "1K", price: 0.04 }, { size: "2K", quality: "high", seconds: 8, price: 0.1 }],
  inputUnitPrice: 0.01,
  inputFreeUnits: 1,
  sortOrder: 2,
  createdAt: 1_700_000_000_000,
};

const prompt: Required<Prompt> = {
  id: "s1",
  name: "Opening line",
  content: "Start in the middle of the action.",
  scene: "snippet",
  group: "开头",
  useCount: 7,
  lastUsedAt: 1_700_000_001_000,
};

describe("config backup · every field round-trips", () => {
  it("through the config database and back out", async () => {
    expect(await throughDb(providerUpsert(provider), listProviders)).toEqual(provider);
    expect(await throughDb(modelUpsert(model, "fee-group"), (db) => listModels(db))).toEqual(model);
    expect(await throughDb(promptUpsert(prompt), listPrompts)).toEqual(prompt);
  });

  it("through a backup bundle and its parser", async () => {
    const fromDb = {
      provider: await throughDb(providerUpsert(provider), listProviders),
      model: await throughDb(modelUpsert(model, "fee-group"), (db) => listModels(db)),
      prompt: await throughDb(promptUpsert(prompt), listPrompts),
    };
    // Serialized, because that is what the file and the envelope both carry:
    // a field that only exists as `undefined` never reaches the other machine.
    const wire = JSON.parse(JSON.stringify({
      kind: CONFIG_BACKUP_KIND,
      version: 3,
      providers: [fromDb.provider],
      models: [fromDb.model],
      prompts: [fromDb.prompt],
      feeGroups: [feeGroup],
      prefs: [],
    }));
    const parsed = parseConfigBundle(wire, []);

    expect(parsed.providers).toEqual([provider]);
    expect(parsed.models).toEqual([model]);
    expect(parsed.prompts).toEqual([prompt]);
    expect(parsed.feeGroups).toEqual([feeGroup]);
  });

  it("writes back the same rows the restore read", async () => {
    // Closing the loop on the restore side: what `applyConfigImport` hands to
    // the transaction is the same statement the original row came from.
    const parsed = parseConfigBundle(JSON.parse(JSON.stringify({
      kind: CONFIG_BACKUP_KIND,
      version: 3,
      providers: [provider],
      models: [model],
      prompts: [prompt],
      feeGroups: [feeGroup],
    })), []);
    expect(providerUpsert(parsed.providers[0])).toEqual(providerUpsert(provider));
    expect(modelUpsert(parsed.models[0], "fee-group")).toEqual(modelUpsert(model, "fee-group"));
    expect(promptUpsert(parsed.prompts[0])).toEqual(promptUpsert(prompt));
    expect(feeGroupUpsert(parsed.feeGroups[0])).toEqual(feeGroupUpsert(feeGroup));
  });
});

/**
 * `fee_migrated` 不在 `Model` 上，上面的往返测试看不见它——而它正是会被悄悄
 * 写丢的那一列：`INSERT OR REPLACE` 删了旧行再插，列清单里没有的列回到默认值
 * （这一列没有默认值，就是 NULL），下次启动迁移就按旧价重新归组。
 */
describe("modelUpsert · fee_migrated", () => {
  it("列清单、占位符、values 三者等长", () => {
    const { sql, values } = modelUpsert(model, "fee-group");
    const placeholders = /VALUES\s*\(([^)]*)\)/.exec(sql)![1].split(",").length;
    expect(placeholders).toBe(values.length);
    expect(Object.keys(rowOf({ sql, values }))).toHaveLength(values.length);
  });

  it("新代码决定的绑定盖章，旧版备份的留给迁移", () => {
    expect(rowOf(modelUpsert(model, "fee-group")).fee_migrated).toBe(1);
    expect(rowOf(modelUpsert(model, "legacy")).fee_migrated).toBeNull();
  });

  it("主动不绑组的模型也盖章——否则迁移会按旧价把它绑回去", () => {
    const row = rowOf(modelUpsert({ ...model, feeGroupId: undefined }, "fee-group"));
    expect(row.fee_group_id).toBeNull();
    expect(row.fee_migrated).toBe(1);
  });
});
