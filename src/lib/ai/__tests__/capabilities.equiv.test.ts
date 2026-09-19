import { describe, expect, it } from "vitest";
import { capabilityVerdict, hasCapability } from "../capabilities";
import { PLATFORM_IDS, serverToolStatus, wireHasServerTools, wireIgnoresForcedToolChoice, wireReadsPdf, wireTakesQwenVisionParams } from "../platforms";
import { SERVER_TOOL_IDS } from "../serverTools";
import { canReadVideo } from "../videoInput";
import type { ApiStandard } from "../types";

const STANDARDS: ApiStandard[] = ["openai_compat", "openai_responses_compat", "gemini_compat", "anthropic_compat", "openai", "gemini", "anthropic"];
const MODELS = [undefined, "qwen3-max", "qwen3.8-flash", "qwen3.6-27b", "deepseek-v4-pro", "glm-5.3-flash", "gpt-5.6", " QWEN3.5-Plus "];

describe("capabilities ≡ legacy gates", () => {
  it("matches every legacy function over the whole matrix", () => {
    let cells = 0;
    for (const platform of PLATFORM_IDS) for (const standard of STANDARDS) {
      const wire = { platform, standard };
      expect(hasCapability("pdfInput", wire), `pdf ${platform}/${standard}`).toBe(wireReadsPdf(wire));
      expect(hasCapability("vlHighResolution", wire), `hires ${platform}/${standard}`).toBe(wireTakesQwenVisionParams(wire));
      expect(hasCapability("videoFps", wire), `fps ${platform}/${standard}`).toBe(wireTakesQwenVisionParams(wire));
      expect(!hasCapability("forcedToolChoice", wire), `force ${platform}/${standard}`).toBe(wireIgnoresForcedToolChoice(wire));
      expect(SERVER_TOOL_IDS.some((id) => hasCapability(id, wire)), `any ${platform}/${standard}`).toBe(wireHasServerTools(wire));
      for (const type of ["text", "multimodal", "vision", "image"] as const) {
        expect(hasCapability("videoInput", wire, { type }), `video ${platform}/${standard}/${type}`)
          .toBe(canReadVideo({ type, videoInput: true }, standard));
      }
      for (const id of SERVER_TOOL_IDS) for (const modelId of MODELS) {
        expect(capabilityVerdict(id, wire, { modelId }).status, `${id} ${platform}/${standard}/${modelId}`)
          .toBe(serverToolStatus(wire, id, modelId));
        cells++;
      }
    }
    expect(cells).toBeGreaterThan(4000);
  });
});
