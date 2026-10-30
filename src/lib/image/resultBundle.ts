/** Preserve a related set/layer stack together, outside disposable candidate scratch. */
import { makeDir, writeBinaryFile, writeFile } from "../fs/fileio";
import { dataUrlToBytes } from "../fs/images";
import type { ImageResult } from "../ai/image";
export async function saveImageBundle(projectPath: string, result: ImageResult): Promise<string> {
  if (!result.requestId || !/^[a-z0-9-]+$/i.test(result.requestId)) throw new Error("Invalid image result identity");
  const dir = `${projectPath}/.ai-writer/image-results/${result.requestId}`;
  await makeDir(dir);
  const entries = [];
  for (const [i, image] of result.images.entries()) {
    const { bytes, ext } = dataUrlToBytes(image.dataUrl);
    const file = `${i}.${ext}`;
    await writeBinaryFile(`${dir}/${file}`, bytes);
    entries.push({ file, ...(image.layer ? { layer: image.layer } : {}) });
  }
  await writeFile(`${dir}/manifest.json`, JSON.stringify({ version: 1, images: entries }, null, 2));
  return `${dir}/manifest.json`;
}
