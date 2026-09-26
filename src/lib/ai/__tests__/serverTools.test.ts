import { describe, expect, it } from "vitest";
import {
  nonWebServerTools,
  parseServerTools,
  effectiveServerTools,
  serverToolsSent,
  summarizeServerToolResult,
  createGeminiServerToolReader,
} from "../serverTools";
import { wireOf } from "../platforms";
import { hasCapability, type CapabilityWire } from "../capabilities";

const DS = { platform: "dashscope", standard: "openai_compat" } as const;

/** The question the drawer and the adapters ask of the capability table, per model. */
const offered = (wire: CapabilityWire, id: Parameters<typeof hasCapability>[0], modelId: string) => hasCapability(id, wire, { modelId });

describe("which server tool a wire offers a model", () => {
  it("is a DashScope tool only, whatever the standard", () => {
    // A row still labelled dashscope, switched to an official standard or to
    // a family DashScope has no interpreter on (wireOf resolves the official
    // ones to their vendor).
    for (const standard of ["openai", "openai_responses", "anthropic_compat", "gemini_compat"] as const) {
      const wire = wireOf({ platform: "dashscope", baseUrl: "", standard });
      expect(offered(wire, "code_interpreter", "qwen3.5-plus"), standard).toBe(false);
    }
    // Same standard, another platform: the bug this table exists to fix.
    for (const platform of ["deepseek", "newapi", "orcarouter", "ollama", "custom"] as const) {
      expect(offered({ platform, standard: "openai_compat" }, "web_search", "qwen3.5-plus"), platform).toBe(false);
      expect(offered({ platform, standard: "openai_compat" }, "code_interpreter", "qwen3.5-plus"), platform).toBe(false);
    }
  });

  it("gates only the code interpreter by model id — a measured refusal, not an unlisted id", () => {
    expect(offered(DS, "web_search", "anything")).toBe(true);
    expect(offered(DS, "code_interpreter", "qwen3.8-flash")).toBe(false);
    expect(offered(DS, "code_interpreter", "qwen3.5-plus")).toBe(true);
    // Unmeasured: offered, the drawer saying so (capability-gating-plan §8.7).
    expect(offered(DS, "code_interpreter", "anything")).toBe(true);
  });
});

describe("effectiveServerTools", () => {
  it("cuts a declaration to what the wire can say, canonically, absent when nothing is left", () => {
    const all = ["image_search", "web_extractor", "web_search", "code_interpreter"] as const;
    expect(effectiveServerTools({ platform: "dashscope", standard: "openai_responses_compat" }, all, "qwen3.5-plus"))
      .toEqual(["web_search", "web_extractor", "image_search", "code_interpreter"]);
    expect(effectiveServerTools({ platform: "xai", standard: "openai_responses_compat" }, all, "grok-4.6"))
      .toEqual(["web_search"]);
    expect(effectiveServerTools({ platform: "deepseek", standard: "openai_compat" }, all, "deepseek-flash"))
      .toBeUndefined();
    // Extraction survives only beside search.
    expect(effectiveServerTools(DS, ["web_extractor"], "qwen3.5-plus")).toBeUndefined();
  });
});

describe("serverToolsSent", () => {
  const model = { providerId: "p", modelId: "deepseek-flash", serverTools: ["web_search"] as ["web_search"] };
  const provider = (baseUrl: string) => ({ id: "p", name: "P", baseUrl, apiStandard: "openai_compat" as const, createdAt: 0 });

  it("answers what the provider's platform sends, the declaration only without a provider list", () => {
    expect(serverToolsSent(model, [provider("https://dashscope.aliyuncs.com/compatible-mode/v1")])).toEqual(["web_search"]);
    expect(serverToolsSent(model, [provider("https://api.deepseek.com")])).toBeUndefined();
    expect(serverToolsSent(model, [])).toBeUndefined();
    expect(serverToolsSent(model)).toEqual(["web_search"]);
  });
});

describe("code_interpreter declarations", () => {
  it("round-trips through storage and stands alone", () => {
    expect(parseServerTools('["code_interpreter","web_search"]')).toEqual(["web_search", "code_interpreter"]);
    expect(parseServerTools('["code_interpreter"]')).toEqual(["code_interpreter"]);
  });

  it("keeps only the non-web ids for a main model whose web belongs to the search subagent", () => {
    expect(nonWebServerTools(["web_search", "web_extractor", "image_search", "code_interpreter"])).toEqual(["code_interpreter"]);
    expect(nonWebServerTools(["web_search"])).toBeUndefined();
    expect(nonWebServerTools(undefined)).toBeUndefined();
  });
});

describe("summarizeServerToolResult", () => {
  const result = (output: string | undefined) => ({
    phase: "result" as const, id: "x", name: "code_interpreter", results: [], output,
  });

  it("shows the last line a code run printed — the exception's line after a traceback", () => {
    expect(summarizeServerToolResult(result("77269364466549865653073473388030061522211723"))).toBe(
      "77269364466549865653073473388030061522211723",
    );
    expect(summarizeServerToolResult(result(
      "----\nZeroDivisionError                         Traceback (most recent call last)\n----> 1 1/0\n\nZeroDivisionError: division by zero\n",
    ))).toBe("ZeroDivisionError: division by zero");
    expect(summarizeServerToolResult(result("x".repeat(200)))).toBe(`${"x".repeat(160)}…`);
  });

  it("falls back to a search's hits when there is no output", () => {
    expect(summarizeServerToolResult({
      phase: "result", id: "s", name: "web_search",
      results: [{ title: "Rust", url: "https://www.rust-lang.org/" }],
    })).toBe("Rust");
  });
});

// Shapes from OrcaRouter's Vertex route (landscape.md §7 第十八个样本「再补测」).
describe("createGeminiServerToolReader", () => {
  it("reports a code run as a call and its printed result", () => {
    const read = createGeminiServerToolReader();
    const events = read({
      content: {
        parts: [
          { executableCode: { language: "PYTHON", code: "print(2**10)", id: "c1" }, thoughtSignature: "sig" },
          { codeExecutionResult: { outcome: "OUTCOME_OK", output: "1024\n", id: "c1" } },
        ],
      },
    });
    expect(events).toEqual([
      { phase: "call", id: "c1", name: "code_interpreter", input: { language: "PYTHON", code: "print(2**10)" } },
      { phase: "result", id: "c1", name: "code_interpreter", results: [], output: "1024" },
    ]);
  });

  it("marks a failed run with its outcome, and pairs an id-less result with the latest code", () => {
    const read = createGeminiServerToolReader();
    const call = read({ content: { parts: [{ executableCode: { language: "PYTHON", code: "1/0" } }] } });
    const result = read({ content: { parts: [{ codeExecutionResult: { outcome: "OUTCOME_FAILED", output: "ZeroDivisionError" } }] } });
    expect(call[0]).toMatchObject({ phase: "call", id: "gemini_code_1" });
    expect(result).toEqual([{
      phase: "result", id: "gemini_code_1", name: "code_interpreter", results: [], output: "ZeroDivisionError", error: "OUTCOME_FAILED",
    }]);
  });

  it("reports each page read through urlContext, failures included", () => {
    const events = createGeminiServerToolReader()({
      urlContextMetadata: {
        urlMetadata: [
          { retrievedUrl: "https://example.com/a", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" },
          { retrievedUrl: "https://example.com/b", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_ERROR" },
        ],
      },
    });
    expect(events).toEqual([
      { phase: "call", id: "gemini_url:https://example.com/a", name: "web_extractor", input: { urls: ["https://example.com/a"] } },
      { phase: "result", id: "gemini_url:https://example.com/a", name: "web_extractor", results: [{ title: "https://example.com/a", url: "https://example.com/a" }] },
      { phase: "call", id: "gemini_url:https://example.com/b", name: "web_extractor", input: { urls: ["https://example.com/b"] } },
      {
        phase: "result", id: "gemini_url:https://example.com/b", name: "web_extractor",
        results: [{ title: "https://example.com/b", url: "https://example.com/b" }], error: "URL_RETRIEVAL_STATUS_ERROR",
      },
    ]);
  });

  it("reports a search from its queries, with the grounding chunks as hits", () => {
    const events = createGeminiServerToolReader()({
      finishReason: "STOP",
      groundingMetadata: {
        webSearchQueries: ["harbour town ferry timetable", "harbour town ferry winter"],
        groundingChunks: [
          { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "ferries.example", domain: "ferries.example" } },
          { retrievedContext: { uri: "gs://x" } },
        ],
        searchEntryPoint: { renderedContent: "<div/>" },
      },
    });
    expect(events).toEqual([
      { phase: "call", id: "gemini_search:harbour town ferry timetable\nharbour town ferry winter", name: "web_search", input: { queries: ["harbour town ferry timetable", "harbour town ferry winter"] } },
      {
        phase: "result", id: "gemini_search:harbour town ferry timetable\nharbour town ferry winter", name: "web_search",
        results: [{ title: "ferries.example", url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc" }],
      },
    ]);
  });

  it("does not call a URL-context answer's grounding chunks a search", () => {
    const events = createGeminiServerToolReader()({
      groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com/a", title: "A page" } }] },
    });
    expect(events).toEqual([]);
  });

  it("reports each row once, however many blocks repeat it", () => {
    const read = createGeminiServerToolReader();
    const block = { urlContextMetadata: { urlMetadata: [{ retrievedUrl: "https://example.com/a", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" }] } };
    expect(read(block)).toHaveLength(2);
    expect(read(block)).toEqual([]);
  });

  it("reads nothing out of a plain block or junk", () => {
    const read = createGeminiServerToolReader();
    expect(read({ content: { parts: [{ text: "hi" }] } })).toEqual([]);
    expect(read(undefined)).toEqual([]);
    expect(read({ groundingMetadata: { webSearchQueries: "not a list" } })).toEqual([]);
  });
});
