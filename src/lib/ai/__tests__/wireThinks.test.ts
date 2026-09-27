/**
 * Whether a request thinks — one definition, and the three places that used
 * to decide it each their own way (docs/api/capability-resolution-lld.md §3.5, P4).
 *
 * The file snapshot below was taken from the old code *before* P4 moved those
 * three decisions onto `wireThinks` and request conditions, over every
 * category × every stored effort × every family:
 *
 *   - whether a forced `tool_choice` is downgraded (`forcesToolChoiceAuto`);
 *   - whether a temperature is sent (Anthropic refuses one while thinking);
 *   - which endpoint-run tools DashScope's two OpenAI wires carry — the
 *     interpreter yields to thinking-off on Responses, and both it and page
 *     reading yield to function tools on Chat Completions.
 *
 * Every answer must still be given. A deliberate change updates the snapshot,
 * and the diff names the category and the effort.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasCapability } from "../capabilities";
import { __resetLearned } from "../capability/learned";
import { streamCompletion } from "../index";
import { forcesToolChoiceAuto, THINKING_CATEGORIES, type ReasoningEffort, type ThinkingCategoryId } from "../reasoning";
import type { ServerToolId } from "../serverTools";
import type { ApiStandard, ProtocolFamily, StreamOptions, ToolDefinition } from "../types";

const CATEGORIES = Object.keys(THINKING_CATEGORIES) as ThinkingCategoryId[];
const EFFORTS: readonly (ReasoningEffort | undefined)[] = [
  undefined, "default", "off", "minimal", "low", "medium", "high", "xhigh", "max",
];
const FAMILY_STANDARD: Record<ProtocolFamily, ApiStandard> = {
  openai: "openai_compat", responses: "openai_responses_compat", gemini: "gemini_compat", anthropic: "anthropic_compat",
};

const DASHSCOPE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const TOOL: ToolDefinition = {
  type: "function",
  function: { name: "pick", description: "Pick one.", parameters: { type: "object", properties: {} } },
};
const SERVER_TOOLS: ServerToolId[] = ["web_search", "web_extractor", "code_interpreter"];

/** The body `streamCompletion` would POST, with only the fields this file is about. */
async function sent(opts: Partial<StreamOptions> & Pick<StreamOptions, "standard">): Promise<string> {
  let body: Record<string, unknown> = {};
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    throw new Error("captured");
  }));
  await streamCompletion({
    baseUrl: DASHSCOPE, apiKey: "k", platform: "dashscope", modelId: "qwen3.5-plus",
    messages: [{ role: "user", content: "hi" }], onChunk: () => {}, ...opts,
  }).catch(() => {});
  const tools = Array.isArray(body.tools)
    ? (body.tools as { type?: string }[]).map((t) => t.type).join(",")
    : "-";
  const picked = ["enable_search", "search_options", "enable_code_interpreter", "reasoning", "enable_thinking", "reasoning_effort"]
    .filter((k) => k in body)
    .map((k) => `${k}=${JSON.stringify(body[k])}`);
  return `tools=${tools} ${picked.join(" ")}`.trim();
}

async function behaviour(): Promise<string> {
  const out: string[] = ["# forced tool_choice downgraded (category · effort)"];
  for (const c of CATEGORIES) {
    out.push(`${c} ${EFFORTS.map((e) => `${e ?? "unset"}:${forcesToolChoiceAuto(THINKING_CATEGORIES[c], e) ? "auto" : "-"}`).join(" ")}`);
  }
  out.push("", "# temperature sent (family · category)");
  for (const [family, standard] of Object.entries(FAMILY_STANDARD)) {
    const wire = { platform: "custom" as const, standard };
    out.push(`${family} ${CATEGORIES.map((c) => `${c}:${hasCapability("temperature", wire, { thinkingCategory: c }) ? "yes" : "-"}`).join(" ")}`);
  }
  for (const standard of ["openai_compat", "openai_responses_compat"] as const) {
    for (const withTools of [false, true]) {
      out.push("", `# DashScope ${standard}, server tools declared${withTools ? ", function tools" : ""}`);
      for (const c of CATEGORIES) {
        for (const e of EFFORTS) {
          const body = await sent({
            standard, thinkingCategory: c, reasoningEffort: e, serverTools: SERVER_TOOLS,
            ...(withTools ? { tools: [TOOL] } : {}),
          });
          out.push(`${c} ${e ?? "unset"} ${body}`);
        }
      }
    }
  }
  return `${out.join("\n")}\n`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  __resetLearned();
});

describe("what depends on whether a request thinks", () => {
  it("answers what the three old judgements answered", async () => {
    await expect(await behaviour()).toMatchFileSnapshot("./__snapshots__/wireThinks.txt");
  });
});
