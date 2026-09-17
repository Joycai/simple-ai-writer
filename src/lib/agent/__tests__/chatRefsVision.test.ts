/**
 * The attach pipeline when the active model cannot read images.
 *
 * PR-D widened the UI gate (the attach chip now appears whenever *anything* on
 * the chain can see) without widening what happens behind it: the picture was
 * still dropped and the model was told only the file's name — which it could do
 * nothing with, because delegate(vision) takes a path.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async () => "text body"),
  fileExists: vi.fn(async () => true),
}));

import { buildChatMessage } from "../chatRefs";
import type { AttachedItem } from "../../lore/aiTask";

const image = {
  kind: "image",
  file: { name: "cover.png", path: "/proj/assets/ch1/cover.png" },
  dataUrl: "data:image/png;base64,AAA",
} as unknown as AttachedItem;

describe("buildChatMessage with an unsendable image", () => {
  it("names the PATH, not just the filename", async () => {
    const res = await buildChatMessage("这张图里是什么？", undefined, [image], {
      allowImages: false,
    });
    expect(res.text).toContain("/proj/assets/ch1/cover.png");
    expect(res.imagePaths).toHaveLength(0);
  });

  it("tells the model to delegate when a vision subagent is standing by", async () => {
    const res = await buildChatMessage("这张图里是什么？", undefined, [image], {
      allowImages: false,
      visionDelegate: true,
    });
    expect(res.text).toContain("delegate");
    expect(res.text).toContain("/proj/assets/ch1/cover.png");
  });

  it("does not promise delegation when no subagent is available", async () => {
    const res = await buildChatMessage("这张图里是什么？", undefined, [image], {
      allowImages: false,
      visionDelegate: false,
    });
    expect(res.text).not.toContain("delegate");
    expect(res.text).toContain("/proj/assets/ch1/cover.png");
  });

  it("still sends base64 to a model that can read it, and adds no notice", async () => {
    const res = await buildChatMessage("这张图里是什么？", undefined, [image], {
      allowImages: true,
      visionDelegate: true,
    });
    expect(res.imagePaths).toEqual(["/proj/assets/ch1/cover.png"]);
    expect(Array.isArray(res.content)).toBe(true);
    expect(res.text).not.toContain("delegate");
  });
});

describe("buildChatMessage with more picture than one request carries", () => {
  const sized = (name: string, mib: number) => ({
    kind: "image",
    file: { name, path: `/proj/${name}` },
    dataUrl: `data:image/png;base64,${"A".repeat(mib * 1024 * 1024)}`,
  }) as unknown as AttachedItem;

  it("sends what fits and names the rest by path, without claiming the model is blind", async () => {
    const res = await buildChatMessage("比较这几张", undefined, [sized("a.png", 10), sized("b.png", 10), sized("c.png", 10)], {
      allowImages: true,
    });
    expect(res.imagePaths).toEqual(["/proj/a.png", "/proj/b.png"]);
    expect(res.text).toContain("/proj/c.png");
    expect(res.text).not.toContain("读不了图");
    expect(res.text).toContain("24 MB");
  });

  it("names count overflow the same way", async () => {
    const five = ["1", "2", "3", "4", "5"].map((n) => ({ ...(image as object), file: { name: `${n}.png`, path: `/proj/${n}.png` } }) as AttachedItem);
    const res = await buildChatMessage("看图", undefined, five, { allowImages: true });
    expect(res.imagePaths).toHaveLength(4);
    expect(res.text).toContain("/proj/5.png");
    expect(res.text).not.toContain("读不了图");
  });
});
