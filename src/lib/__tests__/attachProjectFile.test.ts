/**
 * The one construction path from a project file to a composer attachment,
 * shared by the `@` mention and the file tree's 发送到助手.
 *
 * Failures are values: each surface words the refusal itself (refError bar in
 * the chat, alert from the tree), so the helper must say *which* failure it
 * was rather than throwing a message written for someone else's UI.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));
vi.mock("../fs/fileio", () => ({
  readFile: vi.fn(async (path: string) => {
    if (path.endsWith("bad.md")) throw new Error("gone");
    return "正文内容";
  }),
  fileExists: vi.fn(async () => true),
}));
vi.mock("../image/normalize", () => ({
  imageForModel: vi.fn(async (path: string) => {
    if (path.endsWith("bad.png")) throw new Error("gone");
    if (path.endsWith("huge.png")) {
      return { dataUrl: "data:image/png;base64,XL", bytes: new Uint8Array(13 * 1024 * 1024) };
    }
    return {
      dataUrl: "data:image/png;base64,OK",
      bytes: new Uint8Array(64),
      downscaled: { from: [8000, 4000], to: [4096, 2048] },
    };
  }),
}));

const { attachProjectFile } = await import("../lore/aiTask");
import type { ProjectFile } from "../fs/images";

const text = (path: string): ProjectFile => ({ name: path.split("/").pop()!, path, kind: "text" });
const image = (path: string): ProjectFile => ({ name: path.split("/").pop()!, path, kind: "image" });

describe("attachProjectFile", () => {
  it("reads a text file into an inline attachment", async () => {
    const outcome = await attachProjectFile(text("/p/第1章.md"));
    expect(outcome).toEqual({
      ok: true,
      item: { kind: "text", file: text("/p/第1章.md"), content: "正文内容" },
    });
  });

  it("carries the normalized picture and its downscale note", async () => {
    const outcome = await attachProjectFile(image("/p/封面.png"));
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.item.kind).toBe("image");
    if (outcome.item.kind !== "image") return;
    expect(outcome.item.dataUrl).toBe("data:image/png;base64,OK");
    expect(outcome.item.downscaled).toEqual({ from: [8000, 4000], to: [4096, 2048] });
  });

  it("refuses a picture that stays over the cap even after normalizing", async () => {
    const outcome = await attachProjectFile(image("/p/huge.png"));
    expect(outcome).toEqual({ ok: false, reason: "too-large", sizeMb: "13.0", maxMb: 12 });
  });

  it("reports an unreadable file as such, for either kind", async () => {
    expect(await attachProjectFile(text("/p/bad.md"))).toEqual({ ok: false, reason: "unreadable" });
    expect(await attachProjectFile(image("/p/bad.png"))).toEqual({ ok: false, reason: "unreadable" });
  });
});
