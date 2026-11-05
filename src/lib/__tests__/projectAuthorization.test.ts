import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(), ask: vi.fn(), message: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: h.ask, message: h.message }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: {} }));
vi.mock("../../i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("../ai/usageSchema", () => ({ ensureUsageSchema: vi.fn() }));
vi.mock("../ai/usageBackfill", () => ({ backfillUsagePartsQuietly: vi.fn() }));
import { authorizeProjectRoot, chooseAuthorizedProjectFolder } from "../projectAuthorization";
beforeEach(() => { h.invoke.mockReset(); h.ask.mockReset(); h.message.mockReset(); });

it("uses the restored path without prompting", async () => {
  h.invoke.mockResolvedValue("/moved/中文 project");
  expect(await authorizeProjectRoot("/old")).toBe("/moved/中文 project");
  expect(h.ask).not.toHaveBeenCalled();
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith("project_register_root", { path: "/old" });
});
it("refusing reauthorization never opens the picker", async () => {
  h.invoke.mockRejectedValue("PROJECT_ACCESS_REQUIRED: missing bookmark");
  h.ask.mockResolvedValue(false);
  expect(await authorizeProjectRoot("/old")).toBeNull();
  expect(h.invoke).toHaveBeenCalledTimes(1);
});
it("picker cancel leaves authorization unresolved", async () => {
  h.invoke.mockRejectedValueOnce("PROJECT_ACCESS_REQUIRED: invalid bookmark").mockResolvedValueOnce(null);
  h.ask.mockResolvedValue(true);
  expect(await authorizeProjectRoot("/old")).toBeNull();
  expect(h.invoke).toHaveBeenLastCalledWith("project_reauthorize", {
    path: "/old", title: "project.reauthorizeTitle",
  });
});
it("accepts only the native reauthorization result", async () => {
  h.invoke.mockRejectedValueOnce("PROJECT_ACCESS_REQUIRED: revoked").mockResolvedValueOnce("/old");
  h.ask.mockResolvedValue(true);
  expect(await authorizeProjectRoot("/old")).toBe("/old");
});
it.each([
  ["PROJECT_ACCESS_UNSAFE_METADATA", "project.reauthorizeUnsafeMetadata"],
  ["PROJECT_ACCESS_WRONG_FOLDER", "project.reauthorizeWrongFolder"],
  ["PROJECT_ACCESS_MISSING_PROJECT", "project.reauthorizeMissingProject"],
  ["PROJECT_ACCESS_REQUIRED: disk full", "project.reauthorizeFailed"],
])("explains reauthorization failure %s", async (failure, message) => {
  h.invoke.mockRejectedValueOnce("PROJECT_ACCESS_REQUIRED: missing").mockRejectedValueOnce(failure);
  h.ask.mockResolvedValue(true);
  expect(await authorizeProjectRoot("/old")).toBeNull();
  expect(h.message).toHaveBeenCalledWith(message, { title: "project.reauthorizeTitle", kind: "error" });
});
it("does not reinterpret a direct build's missing marker as authorization", async () => {
  h.invoke.mockRejectedValue("Not an existing project folder (missing .ai-writer)");
  await expect(authorizeProjectRoot("/old")).rejects.toBe("Not an existing project folder (missing .ai-writer)");
  expect(h.ask).not.toHaveBeenCalled();
});

it("unsafe metadata is explained without attempting to reauthorize it", async () => {
  h.invoke.mockRejectedValue("PROJECT_ACCESS_UNSAFE_METADATA");
  expect(await authorizeProjectRoot("/old")).toBeNull();
  expect(h.ask).not.toHaveBeenCalled();
  expect(h.message).toHaveBeenCalledWith("project.reauthorizeUnsafeMetadata", {
    title: "project.reauthorizeTitle", kind: "error",
  });
});

it("a failed fresh selection neither opens nor silently ignores the error", async () => {
  h.invoke.mockRejectedValue("PROJECT_ACCESS_REQUIRED: cannot save bookmark");
  expect(await chooseAuthorizedProjectFolder()).toBeNull();
  expect(h.message).toHaveBeenCalledWith("project.reauthorizeFailed", {
    title: "project.reauthorizeTitle", kind: "error",
  });
});
