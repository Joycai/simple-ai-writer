import { expect, it, vi } from "vitest";
vi.mock("../../distribution", () => ({ distributionAllows: () => false }));
const writes = vi.hoisted(() => vi.fn());
vi.mock("../../prefs", () => ({ readPref: () => "1", writePref: writes }));
vi.mock("../../../i18n", () => ({ default: { t: (key: string) => key } }));
const stream = vi.hoisted(() => vi.fn());
vi.mock("../../ai", () => ({ streamCompletion: stream }));
import { isTranslateEnabled, setTranslateEnabled } from "../flag";
import { runChunk, runDocument } from "../run";
it("legacy enabled preference cannot reactivate Sakura or its retry entry points", async () => {
  expect(isTranslateEnabled()).toBe(false);
  setTranslateEnabled(true);
  expect(writes).not.toHaveBeenCalled();
  await expect(runChunk({} as Parameters<typeof runChunk>[0], {} as Parameters<typeof runChunk>[1])).rejects.toThrow();
  await expect(runDocument("text", {} as Parameters<typeof runDocument>[1])).rejects.toThrow();
  expect(stream).not.toHaveBeenCalled();
});
