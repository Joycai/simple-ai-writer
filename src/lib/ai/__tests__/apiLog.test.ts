import { beforeEach, describe, expect, it, vi } from "vitest";

const { appendFile } = vi.hoisted(() => ({ appendFile: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/path", () => ({ appLogDir: async () => "/logs", join: async (...parts: string[]) => parts.join("/") }));
vi.mock("../../fs/fileio", () => ({ appendFile, fileExists: vi.fn(), makeDir: vi.fn() }));
vi.mock("../../prefs", () => ({ readPref: () => "1", writePref: vi.fn() }));

import { beginApiLog, beginImageApiLog } from "../apiLog";

describe("API network failure logging", () => {
  beforeEach(() => appendFile.mockClear());
  it("writes structured network causes for images and streaming requests", async () => {
    const network = { phase: "send", phaseElapsedMs: 61373, timeout: false, causes: ["connection reset by peer"] };
    const message = `error sending request\n[network-details] ${JSON.stringify(network)}`;
    beginImageApiLog({ standard: "openai_compat", route: "images-api", baseUrl: "https://example.com/v1", modelId: "image", prompt: "test", inputImages: 0 }).error(message);
    beginApiLog({ standard: "openai_compat", baseUrl: "https://example.com/v1", modelId: "chat", apiKey: "must-not-log", messages: [], onChunk() {} }).error(new Error(message));
    await vi.waitFor(() => expect(appendFile).toHaveBeenCalledTimes(4));
    const entries = appendFile.mock.calls.map((call) => JSON.parse(call[1] as string));
    for (const type of ["image-error", "error"]) {
      expect(entries.find((entry) => entry.type === type)).toMatchObject({ error: message, network });
    }
    expect(JSON.stringify(entries)).not.toContain("must-not-log");
  });
  it("persists first-hop context input separately from summed billable input", async () => {
    const log = beginApiLog({ standard: "gemini", baseUrl: "https://example.com/v1beta", modelId: "gemini-4-argon", apiKey: "", messages: [], onChunk() {} });
    log.chunk({ done: true, inputTokens: 90000, initialInputTokens: 100, outputTokens: 80000 });
    log.success();
    await vi.waitFor(() => expect(appendFile).toHaveBeenCalledTimes(2));
    const entries = appendFile.mock.calls.map((call) => JSON.parse(call[1] as string));
    expect(entries.find((entry) => entry.type === "response").usage).toEqual({ inputTokens: 90000, initialInputTokens: 100, outputTokens: 80000 });
  });

});
