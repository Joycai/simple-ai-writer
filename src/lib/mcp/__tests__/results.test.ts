import { beforeEach, describe, expect, it, vi } from "vitest";
const write = vi.fn(); const writeBinary = vi.fn(); const mkdir = vi.fn();
vi.mock("../../fs/fileio", () => ({ writeFile: (...args: unknown[]) => write(...args),
  writeBinaryFile: (...args: unknown[]) => writeBinary(...args), makeDir: (...args: unknown[]) => mkdir(...args) }));
import { saveMcpResult } from "../results";
beforeEach(() => vi.clearAllMocks());
describe("MCP results", () => {
  it("saves images under a generated filename and keeps base64 out of the transcript", async () => {
    const data = btoa("image-bytes");
    const result = await saveMcpResult("/project", { content: [{ type: "image", mimeType: "image/png", data }, { type: "text", text: "done" }] });
    expect(result.imagePath).toMatch(/^\/project\/assets\/mcp\/[\w-]+-1.png$/);
    expect(writeBinary).toHaveBeenCalledWith(result.imagePath, new TextEncoder().encode("image-bytes"));
    expect(result.report).toContain("done"); expect(result.report).not.toContain(data);
  });
  it("keeps the full text on disk while bounding the model's copy", async () => {
    const long = "x".repeat(20_000);
    const result = await saveMcpResult("/project", { content: [{ type: "text", text: long }], isError: true });
    expect(result.report).toContain("reported an error"); expect(result.report).toContain("Truncated");
    expect(result.report.length).toBeLessThan(13_000); expect(write.mock.calls[0][1]).toContain(long);
  });
  it("does not fetch remote links or accept server-controlled file paths", async () => {
    const result = await saveMcpResult("/project", { content: [{ type: "resource_link", uri: "file:///etc/passwd" }, { type: "image", mimeType: "image/svg+xml", data: btoa("<svg/>") }] });
    expect(writeBinary).not.toHaveBeenCalled(); expect(result.report).toContain("not fetched");
  });
});
