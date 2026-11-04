import { expect, it, vi } from "vitest";
vi.mock("../../distribution", () => ({ distributionAllows: () => false }));
import { generateImage } from "../image";
import { testComfyUiConnection } from "../providerProbe";
import { conversationalModels, type Model } from "../configDb";

it("imported ComfyUI configuration cannot start generation or probing", async () => {
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  try {
    await expect(generateImage({ standard: "openai", route: "comfyui" } as Parameters<typeof generateImage>[0],
      { prompt: "test" } as Parameters<typeof generateImage>[1])).rejects.toThrow();
    expect((await testComfyUiConnection("http://localhost:8188")).ok).toBe(false);
    expect(network).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
it("stored ComfyUI models stay out of active pickers without deleting the row", () => {
  const stored = { id: "old", type: "image", caps: { route: "comfyui" } } as Model;
  const retained = { id: "normal", type: "image" } as Model;
  expect(conversationalModels([stored, retained])).toEqual([retained]);
  expect(stored.caps?.route).toBe("comfyui");
});
