/**
 * Lore entity generation's request shape, through the real agent runtime and
 * `streamCompletion` with only `fetch` stubbed. What is guarded: the entity
 * schema reaches the wire as strict `json_schema` on a model that takes it —
 * with the `category` enum pinned to the categories that exist — and an
 * endpoint that rejects the mode gets the request again one level down, once,
 * and the next entity starts there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetLearned } from "../../ai/capability/learned";
import { generateLore, loreEntitySchema } from "../generator";

const conn = {
  baseUrl: "https://relay/v1",
  apiKey: "k",
  standard: "openai_compat" as const,
  // The platform decides whether json_schema is lifted to (capabilities.ts `jsonSchema`).
  platform: "dashscope" as const,
  modelId: "qwen3.8-max",
};

const ENTITY = { name: "Ava", category: "characters", aliases: ["A"], summary: "s", content: "## 概述\nx" };

function sse(text: string): Response {
  const encoder = new TextEncoder();
  const lines = [`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`, "data: [DONE]\n"];
  return new Response(new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(encoder.encode(l));
      c.close();
    },
  }), { status: 200 });
}

/** Answer each request with the next reply (the last one repeats); record every body. */
function script(replies: (() => Response)[]) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return replies[Math.min(bodies.length - 1, replies.length - 1)]();
  }));
  return bodies;
}
const entity = () => sse(JSON.stringify(ENTITY));
const refuse = (text: string) => () => new Response(text, { status: 400 });

const args = { ...conn, description: "A knight", images: [], onProgress: () => {} };
const format = (b: Record<string, unknown>) => b.response_format as Record<string, unknown> | undefined;
const userTurn = (b: Record<string, unknown>) =>
  (b.messages as { role: string; content: unknown }[]).find((m) => m.role === "user")?.content as { type: string; text?: string }[];

beforeEach(() => __resetLearned());
afterEach(() => vi.unstubAllGlobals());

describe("loreEntitySchema", () => {
  it("requires every field and pins category to the given ids", () => {
    const s = loreEntitySchema(["characters", "world"]);
    expect(s.parameters.required).toEqual(["name", "category", "aliases", "summary", "content"]);
    expect((s.parameters.properties as Record<string, { enum?: string[] }>).category.enum).toEqual(["characters", "world"]);
  });
});

describe("generateLore", () => {
  it("sends the entity schema as strict json_schema on a model that takes it, with no cue", async () => {
    const bodies = script([entity]);

    const out = await generateLore(args);

    expect(out).toMatchObject({ name: "Ava", category: "characters", aliases: ["A"] });
    const rf = format(bodies[0])!;
    expect(rf.type).toBe("json_schema");
    const schema = (rf.json_schema as { schema: { properties: Record<string, unknown>; required: string[] } }).schema;
    expect(schema.required).toEqual(["name", "category", "aliases", "summary", "content"]);
    // The enum is the authoritative list, the same one the prose appends.
    expect((schema.properties.category as { enum: string[] }).enum).toContain("characters");
    // strict mode has no "json" precondition, so the user turn is the prompt alone.
    expect(userTurn(bodies[0])).toHaveLength(1);
  });

  it("stays on json_object for a model not known to take strict mode", async () => {
    const bodies = script([entity]);
    await generateLore({ ...args, modelId: "qwen-plus" });
    expect(format(bodies[0])).toEqual({ type: "json_object" });
  });

  it("re-sends one level down when the endpoint rejects the mode, and remembers for the next entity", async () => {
    const bodies = script([
      refuse("400 Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model."),
      entity,
    ]);
    await generateLore(args);
    expect(bodies.map((b) => format(b)?.type)).toEqual(["json_schema", "json_object"]);

    const next = script([entity]);
    await generateLore(args);
    expect(next.map((b) => format(b)?.type)).toEqual(["json_object"]);
  });

  it("sends nothing but the cue, at the end of the user turn, when the model's declaration is off", async () => {
    const bodies = script([entity]);
    await generateLore({ ...args, structuredOutput: "off" });
    expect(format(bodies[0])).toBeUndefined();
    const user = userTurn(bodies[0]);
    expect(user[user.length - 1]?.text).toMatch(/ONLY valid JSON/);
  });

  it("surfaces a real failure without a second request", async () => {
    const bodies = script([refuse("401 invalid api key")]);
    await expect(generateLore(args)).rejects.toThrow("401");
    expect(bodies).toHaveLength(1);
  });
});
