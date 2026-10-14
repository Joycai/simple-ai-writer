/** Preserve image bytes on disk, never put base64 into the agent transcript. */
import { makeDir, writeBinaryFile, writeFile } from "../fs/fileio";
import { joinPath } from "../paths";
import { isObject } from "./config";
import type { McpResult } from "./client";

const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
export async function saveMcpResult(projectPath: string, result: McpResult): Promise<{ report: string; imagePath?: string }> {
  if (!projectPath) throw new Error("Open a project before saving MCP results.");
  const id = crypto.randomUUID();
  const parts: string[] = [result.isError ? "MCP tool reported an error (outputs may still be usable):" : "MCP tool result:"];
  const images: string[] = [];
  for (const block of result.content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      const ext = IMAGE_EXT[block.mimeType];
      if (!ext || block.data.length > 28 * 1024 * 1024 || images.length >= 16) {
        parts.push("Image skipped: unsupported format or size limit."); continue;
      }
      let data: Uint8Array;
      try { data = Uint8Array.from(atob(block.data), (c) => c.charCodeAt(0)); }
      catch { parts.push("Image skipped: invalid base64."); continue; }
      const dir = joinPath(projectPath, "assets/mcp");
      await makeDir(dir);
      const path = joinPath(dir, `${id}-${images.length + 1}.${ext}`);
      await writeBinaryFile(path, data);
      images.push(path);
      parts.push(`Image saved: ${path}`);
    } else if (block.type === "resource_link" && typeof block.uri === "string") {
      parts.push(`Resource link (not fetched): ${block.uri}`);
    } else if (block.type === "resource" && isObject(block.resource) && typeof block.resource.text === "string") {
      parts.push(block.resource.text);
    } else parts.push(`Unsupported MCP content: ${String(block.type)} (not saved).`);
  }
  if (result.structuredContent !== undefined) {
    const structured = JSON.stringify(result.structuredContent);
    // MCP commonly returns the same JSON as both text and structuredContent.
    // Keep distinct text, but pay for identical data only once in history/cache.
    const repeated = result.content.some((block) => {
      if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") return false;
      try { return JSON.stringify(JSON.parse(block.text)) === structured; } catch { return false; }
    });
    if (!repeated) parts.push(structured);
  }
  const text = parts.join("\n\n");
  const dir = joinPath(projectPath, ".ai-writer/tmp/mcp");
  await makeDir(dir);
  const reportPath = joinPath(dir, `${id}.txt`);
  await writeFile(reportPath, text);
  const report = text.length > 12_000 ? `${text.slice(0, 12_000)}\n[Truncated; full result: ${reportPath}]` : text;
  return { report: `${report}\n\n${images.map((p) => `Saved image: ${p}`).join("\n")}\nFull result: ${reportPath}`,
    imagePath: images[0] };
}
