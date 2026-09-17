import { describe, expect, it, vi } from "vitest";
import type { StreamOptions } from "../../ai/types";

const sent: StreamOptions[] = [];
vi.mock("../../ai", () => ({
  streamCompletion: async (o: StreamOptions) => {
    sent.push(o);
    o.onChunk({ text: "  红色斗篷，侧身站立  " });
    o.onChunk({ done: true, inputTokens: 1, outputTokens: 1 });
  },
}));

import { describeLoreImage } from "../vision";

describe("describeLoreImage", () => {
  it("describes the picture without the model's standing server tools", async () => {
    // A description of the image in hand has nothing to look up or compute.
    const text = await describeLoreImage({
      baseUrl: "http://x/v1", apiKey: "", standard: "openai_compat", modelId: "qwen3.5-plus",
      serverTools: ["web_search", "code_interpreter"],
      dataUrl: "data:image/png;base64,AAAA", entityName: "艾娃", language: "zh-CN",
    });
    expect(text).toBe("红色斗篷，侧身站立");
    expect(sent).toHaveLength(1);
    expect(sent[0].serverTools).toBeUndefined();
    expect(sent[0].modelId).toBe("qwen3.5-plus");
  });
});
