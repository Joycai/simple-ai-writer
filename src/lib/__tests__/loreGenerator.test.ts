/**
 * Lore entity generation's request shape. What is guarded: the entity schema
 * reaches the wire as strict `json_schema` on a model that takes it — with the
 * `category` enum pinned to the categories that exist — and an endpoint that
 * rejects the mode gets the request again one level down, once.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent/runtime", () => ({ runAgent: vi.fn() }));
import { runAgent } from "../agent/runtime";
import { __resetJsonModeMemo } from "../ai/jsonMode";
import { generateLore, loreEntitySchema } from "../lore/generator";

const mockRun = vi.mocked(runAgent);

type RunOpts = Parameters<typeof runAgent>[0];

function reply(json: string) {
  return async (opts: RunOpts) => {
    opts.onOutputText?.(json);
    return {} as never;
  };
}

const conn = {
  baseUrl: "https://relay/v1",
  apiKey: "k",
  standard: "openai_compat" as const,
  modelId: "qwen3.8-max",
};

const ENTITY = '{"name":"Ava","category":"characters","aliases":["A"],"summary":"s","content":"## 概述\\nx"}';

beforeEach(() => {
  mockRun.mockReset();
  __resetJsonModeMemo();
});

describe("loreEntitySchema", () => {
  it("requires every field and pins category to the given ids", () => {
    const s = loreEntitySchema(["characters", "world"]);
    expect(s.parameters.required).toEqual(["name", "category", "aliases", "summary", "content"]);
    expect((s.parameters.properties as Record<string, { enum?: string[] }>).category.enum).toEqual(["characters", "world"]);
  });
});

describe("generateLore", () => {
  it("sends the entity schema as strict json_schema on a model that takes it, with no cue turn", async () => {
    mockRun.mockImplementationOnce(reply(ENTITY));

    const out = await generateLore({ ...conn, description: "A knight", images: [], onProgress: () => {} });

    expect(out).toMatchObject({ name: "Ava", category: "characters", aliases: ["A"] });
    const req = mockRun.mock.calls[0][0];
    const rf = (req.extraBody as { response_format: Record<string, unknown> }).response_format;
    expect(rf.type).toBe("json_schema");
    const schema = (rf.json_schema as { schema: { properties: Record<string, unknown>; required: string[] } }).schema;
    expect(schema.required).toEqual(["name", "category", "aliases", "summary", "content"]);
    // The enum is the authoritative list, the same one the prose appends.
    expect((schema.properties.category as { enum: string[] }).enum).toContain("characters");
    // strict mode has no "json" precondition, so the user turn is the prompt alone.
    const user = req.messages[1].content as { type: string }[];
    expect(user).toHaveLength(1);
  });

  it("stays on json_object for a model not known to take strict mode", async () => {
    mockRun.mockImplementationOnce(reply(ENTITY));
    await generateLore({ ...conn, modelId: "qwen-plus", description: "A knight", images: [], onProgress: () => {} });
    expect(mockRun.mock.calls[0][0].extraBody).toEqual({ response_format: { type: "json_object" } });
  });

  it("re-sends one level down when the endpoint rejects the mode, and remembers for the next entity", async () => {
    mockRun.mockImplementationOnce(async () => {
      throw new Error("400 Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.");
    });
    mockRun.mockImplementationOnce(reply(ENTITY));

    const args = { ...conn, description: "A knight", images: [], onProgress: () => {} };
    await generateLore(args);
    expect(mockRun).toHaveBeenCalledTimes(2);
    expect(mockRun.mock.calls[1][0].extraBody).toEqual({ response_format: { type: "json_object" } });

    mockRun.mockReset();
    mockRun.mockImplementationOnce(reply(ENTITY));
    await generateLore(args);
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun.mock.calls[0][0].extraBody).toEqual({ response_format: { type: "json_object" } });
  });

  it("sends nothing but the cue when the model's declaration is off", async () => {
    mockRun.mockImplementationOnce(reply(ENTITY));
    await generateLore({ ...conn, structuredOutput: "off", description: "A knight", images: [], onProgress: () => {} });
    const req = mockRun.mock.calls[0][0];
    expect(req.extraBody).toBeUndefined();
    const user = req.messages[1].content as { type: string; text?: string }[];
    expect(user[user.length - 1]?.text).toMatch(/ONLY valid JSON/);
  });

  it("surfaces a real failure without a second request", async () => {
    mockRun.mockImplementationOnce(async () => { throw new Error("401 invalid api key"); });
    await expect(generateLore({ ...conn, description: "x", images: [], onProgress: () => {} })).rejects.toThrow("401");
    expect(mockRun).toHaveBeenCalledTimes(1);
  });
});
