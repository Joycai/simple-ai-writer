/**
 * 计划模式's wire shape: the standing directive rides on the message the author
 * sent, and only there.
 *
 * The `text` half is what retrieval matches on (`assembleTurnInjection`'s
 * matchTarget) — a fixed block of instructions repeated on every turn would be
 * noise to match lore entries against, so the directive must never reach it.
 * And with pictures attached, the parts array has to keep the images last: an
 * image after the text is the subject of the request, an image after a trailing
 * instruction part is anyone's guess.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../fs/fileio", () => ({
  readFile: vi.fn(async () => "text body"),
  fileExists: vi.fn(async () => true),
}));

import { buildChatMessage, withDirective } from "../agent/chatRefs";
import type { AttachedItem } from "../lore/aiTask";
import type { ContentPart } from "../ai/types";

const DIRECTIVE = "【计划模式已开启】先用 task_plan 立清单。";

const image = {
  kind: "image",
  file: { name: "cover.png", path: "/proj/assets/ch1/cover.png" },
  dataUrl: "data:image/png;base64,AAA",
} as unknown as AttachedItem;

describe("withDirective", () => {
  it("appends after a plain text message", () => {
    expect(withDirective("把第三章改短一点", DIRECTIVE))
      .toBe(`把第三章改短一点\n\n${DIRECTIVE}`);
  });

  it("leaves the message untouched when there is no directive", () => {
    expect(withDirective("原样", "   ")).toBe("原样");
  });

  it("folds into the text part, keeping images last", async () => {
    const built = await buildChatMessage("这张图里是什么？", undefined, [image], {
      allowImages: true,
    });
    const parts = withDirective(built.content, DIRECTIVE) as ContentPart[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: "text" });
    expect(parts[0].type === "text" && parts[0].text).toContain(DIRECTIVE);
    expect(parts[1]).toMatchObject({ type: "image_url" });
    // The matchable text is the author's message alone.
    expect(built.text).not.toContain(DIRECTIVE);
  });

  it("adds a text part when the message carries nothing but images", () => {
    const parts = withDirective(
      [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }],
      DIRECTIVE,
    ) as ContentPart[];
    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({ type: "text", text: DIRECTIVE });
  });
});
