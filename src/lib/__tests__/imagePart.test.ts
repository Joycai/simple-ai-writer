/**
 * The image content part and the author's `detail` knob.
 *
 * Two properties are worth asserting directly rather than through a streamed
 * request. The first is that **absence stays absence**: an author who never
 * opens the setting must produce the exact object this app produced before
 * `detail` existed, because that object is the only one every non-OpenAI,
 * non-DeepSeek endpoint in the app has ever been proven against. The second is
 * the per-wire spelling — Chat Completions puts `detail` *inside* `image_url`,
 * the Responses family puts it *beside* it, and Anthropic / Gemini have no
 * spelling at all and must drop it rather than invent a key.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let prefValue: string | null = null;
vi.mock("../prefs", () => ({
  readPref: vi.fn(() => prefValue),
  writePref: vi.fn(),
}));

const { imagePart } = await import("../ai/imagePart");
const { toResponsesInput } = await import("../ai/responses");
const { convertToAnthropicMessages } = await import("../ai/anthropic");
const { convertToGeminiContents } = await import("../ai/gemini");

const URL = "data:image/png;base64,AAAA";

describe("imagePart", () => {
  beforeEach(() => { prefValue = null; });

  it("sends no detail field at all when the author never set one", () => {
    // Deep equality, not a property check: the point is that the object is
    // byte-identical to the pre-`detail` one, including having no key whose
    // value happens to be undefined (JSON.stringify would drop that, but a
    // strict endpoint validating its input would not have to).
    const part = imagePart(URL);
    expect(part).toEqual({ type: "image_url", image_url: { url: URL } });
    expect(Object.keys((part as { image_url: object }).image_url)).toEqual(["url"]);
  });

  it("treats anything that isn't low/high as unset", () => {
    for (const raw of ["", "auto", "original", "medium", "LOW", "1"]) {
      prefValue = raw;
      expect(imagePart(URL)).toEqual({ type: "image_url", image_url: { url: URL } });
    }
  });

  it("carries the author's choice beside the url", () => {
    prefValue = "low";
    expect(imagePart(URL)).toEqual({ type: "image_url", image_url: { url: URL, detail: "low" } });
    prefValue = "high";
    expect(imagePart(URL)).toEqual({ type: "image_url", image_url: { url: URL, detail: "high" } });
  });

  it("lets a call site override the preference in both directions", () => {
    prefValue = "low";
    // "auto" is the opt-out spelling — it means "send nothing", not "send auto".
    expect(imagePart(URL, "auto")).toEqual({ type: "image_url", image_url: { url: URL } });
    expect(imagePart(URL, "high")).toEqual({ type: "image_url", image_url: { url: URL, detail: "high" } });
    prefValue = null;
    expect(imagePart(URL, "low")).toEqual({ type: "image_url", image_url: { url: URL, detail: "low" } });
  });
});

describe("detail on each wire", () => {
  beforeEach(() => { prefValue = "low"; });

  it("Responses: detail is a sibling of image_url, not a member of it", () => {
    const { input } = toResponsesInput([{ role: "user", content: [imagePart(URL)] }]);
    expect(input[0]).toMatchObject({
      role: "user",
      content: [{ type: "input_image", image_url: URL, detail: "low" }],
    });
  });

  it("Responses: an unset detail leaves the part exactly as it was", () => {
    prefValue = null;
    const { input } = toResponsesInput([{ role: "user", content: [imagePart(URL)] }]);
    const part = (input[0] as { content: Record<string, unknown>[] }).content[0];
    expect(part).toEqual({ type: "input_image", image_url: URL });
  });

  it("Anthropic drops it — the protocol has no spelling for it", () => {
    const [msg] = convertToAnthropicMessages(
      [{ role: "user", content: [imagePart(URL)] }],
      "claude-sonnet-4-5",
    );
    expect(msg.content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
  });

  it("Gemini drops it too", () => {
    const [content] = convertToGeminiContents([{ role: "user", content: [imagePart(URL)] }]);
    expect(content.parts[0]).toEqual({ inlineData: { mimeType: "image/png", data: "AAAA" } });
  });
});
