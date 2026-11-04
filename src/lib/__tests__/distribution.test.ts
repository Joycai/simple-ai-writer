import { beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../platform", () => ({ IS_TAURI: true }));
beforeEach(() => { vi.resetModules(); invoke.mockReset(); });

it("fails closed before hydration and reads the compiled channel only once", async () => {
  const channel = await import("../distribution");
  expect(channel.terminalAvailable()).toBe(false);
  expect(channel.requiresFileAuthorization()).toBe(true);
  invoke.mockResolvedValue("app-store");
  await Promise.all([channel.hydrateDistribution(), channel.hydrateDistribution()]);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("distribution_channel");
  expect(channel.terminalAvailable()).toBe(false);
  expect(channel.requiresFileAuthorization()).toBe(true);
});
it("preserves the direct build's terminal capability", async () => {
  invoke.mockResolvedValue("direct");
  const channel = await import("../distribution");
  await channel.hydrateDistribution();
  expect(channel.terminalAvailable()).toBe(true);
  expect(channel.requiresFileAuthorization()).toBe(false);
});
it.each(["unexpected", null])("invalid channel %s cannot enable terminal", async (value) => {
  invoke.mockResolvedValue(value);
  const channel = await import("../distribution");
  await channel.hydrateDistribution();
  expect(channel.terminalAvailable()).toBe(false);
  expect(channel.requiresFileAuthorization()).toBe(true);
});
it("IPC failure cannot enable terminal", async () => {
  invoke.mockRejectedValue(new Error("IPC unavailable"));
  const channel = await import("../distribution");
  await channel.hydrateDistribution();
  expect(channel.terminalAvailable()).toBe(false);
  expect(channel.requiresFileAuthorization()).toBe(true);
});
