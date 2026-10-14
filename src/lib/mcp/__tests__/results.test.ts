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
    expect(result.report).toContain("Images attached to this chat turn");
    expect(result.report).toContain("Use these saved paths");
    expect(result.report).not.toContain("call the server's image retrieval tool");
  });
  it("distinguishes completed generation metadata from an attached image, then accepts retrieval bytes", async () => {
    const metadata = { taskId: "existing-job", status: "completed", outputs: [
      { outputId: 0, available: true, path: "/server/outside-project/image.jpg",
        uri: "joycai://generations/existing-job/images/0", mimeType: "image/jpeg" },
    ] };
    for (const result of [
      { content: [], structuredContent: metadata },
      { content: [{ type: "text", text: JSON.stringify(metadata) }] },
    ]) {
      const saved = await saveMcpResult("/project", result);
      expect(saved.imagePath).toBeUndefined();
      expect(saved.report).toContain("No image bytes were received or attached");
      expect(saved.report).toContain("read_generation_image");
      expect(saved.report).toContain("returned taskId/outputId");
      expect(saved.report).toContain("do not generate again");
      expect(saved.report).not.toContain("Saved image:");
    }
    expect(writeBinary).not.toHaveBeenCalled(); // Never read a server-controlled local path.
    const retrieved = await saveMcpResult("/project", { content: [
      { type: "image", mimeType: "image/jpeg", data: btoa("original-image") },
    ] });
    expect(retrieved.imagePath).toMatch(/^\/project\/assets\/mcp\//);
    expect(retrieved.report).toContain(`Saved image: ${retrieved.imagePath}`);
    expect(writeBinary).toHaveBeenCalledTimes(1);
  });
  it("keeps the full text on disk while bounding the model's copy", async () => {
    const long = "x".repeat(20_000);
    const result = await saveMcpResult("/project", { content: [{ type: "text", text: long }], isError: true });
    expect(result.report).toContain("reported an error"); expect(result.report).toContain("Truncated");
    expect(result.report.length).toBeLessThan(13_000); expect(write.mock.calls[0][1]).toContain(long);
    expect(result.report).toContain("No image bytes were received or attached");
    expect(result.report.indexOf("No image bytes")).toBeGreaterThan(result.report.indexOf("[Truncated"));
  });
  it("includes identical text/structured JSON only once while keeping distinct text", async () => {
    const data = { modelId: 241, parameters: ["size"] };
    const result = await saveMcpResult("/project", { content: [
      { type: "text", text: JSON.stringify(data, null, 2) }, { type: "text", text: "Keep this note." },
    ], structuredContent: data });
    expect(result.report.match(/modelId/g)).toHaveLength(1);
    expect(result.report).toContain("Keep this note.");
    expect(write.mock.calls[0][1].match(/modelId/g)).toHaveLength(1);
    const distinct = await saveMcpResult("/project", { content: [{ type: "text", text: "Summary" }], structuredContent: data });
    expect(distinct.report).toContain(JSON.stringify(data));
  });
  it("does not fetch remote links or accept server-controlled file paths", async () => {
    const result = await saveMcpResult("/project", { content: [{ type: "resource_link", uri: "file:///etc/passwd" }, { type: "image", mimeType: "image/svg+xml", data: btoa("<svg/>") }] });
    expect(writeBinary).not.toHaveBeenCalled(); expect(result.report).toContain("not fetched");
    expect(result.report).toContain("No image bytes were received or attached");
  });
});
