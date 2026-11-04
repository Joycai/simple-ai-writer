import { expect, it, vi } from "vitest";
const channel = vi.hoisted(() => ({ allowed: false }));
const writes = vi.hoisted(() => vi.fn());
vi.mock("../../distribution", () => ({ distributionAllows: () => channel.allowed }));
vi.mock("../../prefs", () => ({ readPref: () => "1", writePref: writes }));
import { isComfyUiEnabled, setComfyUiEnabled } from "../flag";
it("store ignores an old enabled preference without modifying it; direct keeps the switch", () => {
  expect(isComfyUiEnabled()).toBe(false);
  setComfyUiEnabled(true);
  expect(writes).not.toHaveBeenCalled();
  channel.allowed = true;
  expect(isComfyUiEnabled()).toBe(true);
  setComfyUiEnabled(false);
  expect(writes).toHaveBeenCalledWith(expect.any(String), "0");
});
