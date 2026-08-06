/**
 * The conversational edit chain: how one turn builds on another, and what
 * happens when the endpoint cannot edit at all.
 *
 * The fallback is the delicate part. An author who asked to change the hair
 * and silently received an unrelated new picture would blame the model, so a
 * regeneration standing in for an edit has to be both *correct* (the original
 * brief plus every instruction since, not just the last one) and *marked*.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model, Provider } from "../ai/configDb";

const generateImage = vi.fn();
vi.mock("../ai/image", async () => {
  const actual = await vi.importActual<typeof import("../ai/image")>("../ai/image");
  return { ...actual, generateImage: (...args: unknown[]) => generateImage(...args) };
});

// Scratch files and usage rows are I/O; the chain logic is what's under test.
const writeCandidates = vi.fn(async (_p: string, _s: string, turnId: string, imgs: unknown[]) =>
  imgs.map((_, i) => `/proj/.ai-writer/tmp/imagegen/sess/${turnId}-${i}.png`));
vi.mock("../image/session", () => ({
  writeCandidates: (...a: [string, string, string, unknown[]]) => writeCandidates(...a),
  discardSession: vi.fn(async () => {}),
  sweepScratch: vi.fn(async () => {}),
  recordGeneration: vi.fn(async () => {}),
}));
vi.mock("../image", () => ({ recordImageUsage: vi.fn(async () => {}) }));
vi.mock("../fs/images", () => ({
  imageToDataUrl: vi.fn(async () => ({ dataUrl: "data:image/png;base64,SRC", ext: "png", bytes: new Uint8Array() })),
}));

const { useImageStore } = await import("../../stores/imageStore");

const PROVIDER = { id: "p1", baseUrl: "https://x/v1", apiStandard: "openai" } as unknown as Provider;
function model(caps?: Model["caps"]): Model {
  return { id: "m1", providerId: "p1", modelId: "img-1", type: "image", caps } as unknown as Model;
}
function ctx(m: Model) {
  return { projectPath: "/proj", model: m, provider: PROVIDER, apiKey: "k" };
}

/** One image back, so every call resolves to a usable turn. */
function oneImage() {
  return { images: [{ dataUrl: "data:image/png;base64,OUT", mime: "image/png" }] };
}

beforeEach(async () => {
  generateImage.mockReset();
  generateImage.mockResolvedValue(oneImage());
  await useImageStore.getState().begin("/proj");
});

describe("edit chain", () => {
  it("sends the source image on a model that can edit", async () => {
    const m = model({ edit: true });
    await useImageStore.getState().generate(ctx(m), "a knight");
    await useImageStore.getState().edit(ctx(m), "silver hair");

    const [, req] = generateImage.mock.calls[1];
    expect(req.images).toEqual(["data:image/png;base64,SRC"]);
    // The edit call carries the instruction alone — the picture supplies the
    // rest of the context.
    expect(req.prompt).toBe("silver hair");

    const turns = useImageStore.getState().turns;
    expect(turns).toHaveLength(2);
    expect(turns[1].parentId).toBe(turns[0].id);
    expect(turns[1].degraded).toBe(false);
  });

  it("regenerates from the accumulated brief when the model declares no edit support", async () => {
    const m = model({ edit: false });
    await useImageStore.getState().generate(ctx(m), "a knight");
    await useImageStore.getState().edit(ctx(m), "silver hair");

    expect(generateImage).toHaveBeenCalledTimes(2); // no wasted attempt
    const [, req] = generateImage.mock.calls[1];
    expect(req.images).toBeUndefined();
    expect(req.prompt).toBe("a knight\nsilver hair");
    expect(useImageStore.getState().turns[1].degraded).toBe(true);
  });

  it("falls back after the endpoint rejects the edit at runtime", async () => {
    const m = model({ edit: true });
    await useImageStore.getState().generate(ctx(m), "a knight");
    generateImage.mockRejectedValueOnce(new Error("Image edit error 404: Not Found"));
    await useImageStore.getState().edit(ctx(m), "silver hair");

    expect(generateImage).toHaveBeenCalledTimes(3); // generate, failed edit, retry
    expect(generateImage.mock.calls[2][1].prompt).toBe("a knight\nsilver hair");
    expect(useImageStore.getState().turns[1].degraded).toBe(true);
  });

  it("surfaces a genuine refusal instead of quietly regenerating", async () => {
    const m = model({ edit: true });
    await useImageStore.getState().generate(ctx(m), "a knight");
    generateImage.mockRejectedValueOnce(new Error("Image edit error 400: prompt rejected by safety system"));
    await useImageStore.getState().edit(ctx(m), "silver hair");

    expect(generateImage).toHaveBeenCalledTimes(2); // no retry
    expect(useImageStore.getState().turns).toHaveLength(1);
    expect(useImageStore.getState().error).toMatch(/safety system/);
  });

  it("accumulates every instruction down the chain, not just the last", async () => {
    const m = model({ edit: false });
    await useImageStore.getState().generate(ctx(m), "a knight");
    await useImageStore.getState().edit(ctx(m), "silver hair");
    await useImageStore.getState().edit(ctx(m), "in the rain");

    expect(generateImage.mock.calls[2][1].prompt).toBe("a knight\nsilver hair\nin the rain");
  });

  it("branches from whichever turn is on screen", async () => {
    const m = model({ edit: true });
    await useImageStore.getState().generate(ctx(m), "a knight");
    await useImageStore.getState().edit(ctx(m), "silver hair");
    const [root] = useImageStore.getState().turns;

    // Go back to the opening picture and take a different direction.
    useImageStore.getState().goTo(root.id);
    await useImageStore.getState().edit(ctx(m), "golden hair");

    const turns = useImageStore.getState().turns;
    expect(turns).toHaveLength(3);
    expect(turns[2].parentId).toBe(root.id);
    // The abandoned branch is still there to return to.
    expect(turns[1].parentId).toBe(root.id);
  });

  it("reports the chain for a saved image", async () => {
    const m = model({ edit: true });
    await useImageStore.getState().generate(ctx(m), "a knight");
    await useImageStore.getState().edit(ctx(m), "silver hair");
    const current = useImageStore.getState().currentId;

    expect(useImageStore.getState().instructionChain(current)).toEqual({
      prompt: "a knight",
      edits: ["silver hair"],
    });
  });

  it("edits the candidate the author picked, not always the first", async () => {
    generateImage.mockResolvedValue({
      images: [
        { dataUrl: "data:image/png;base64,A", mime: "image/png" },
        { dataUrl: "data:image/png;base64,B", mime: "image/png" },
      ],
    });
    const m = model({ edit: true });
    await useImageStore.getState().generate(ctx(m), "a knight");
    const [root] = useImageStore.getState().turns;
    useImageStore.getState().choose(root.id, 1);

    expect(useImageStore.getState().currentImagePath()).toBe(root.candidates[1]);
  });
});
