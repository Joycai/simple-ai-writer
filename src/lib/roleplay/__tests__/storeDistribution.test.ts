import { expect, it, vi } from "vitest";
const channel = vi.hoisted(() => ({ allowed: false }));
const writes = vi.hoisted(() => vi.fn());
vi.mock("../../distribution", () => ({ distributionAllows: () => channel.allowed }));
vi.mock("../../prefs", () => ({ readPref: () => "1", writePref: writes }));
import { isRoleplayEnabled, setRoleplayEnabled } from "../flag";
it("store ignores an old enabled preference without modifying it; direct keeps the switch", () => {
  expect(isRoleplayEnabled()).toBe(false);
  setRoleplayEnabled(true);
  expect(writes).not.toHaveBeenCalled();
  channel.allowed = true;
  expect(isRoleplayEnabled()).toBe(true);
  setRoleplayEnabled(false);
  expect(writes).toHaveBeenCalledWith(expect.any(String), "0");
});
