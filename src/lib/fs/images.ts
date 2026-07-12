/**
 * Generic project-file utilities for images and text attachments:
 * discovery (scan), classification (by extension), and encoding (base64 data
 * URLs for multimodal prompts / in-app rendering).
 */

import { readFile as readBinaryFile } from "@tauri-apps/plugin-fs";
import { readDir, readFile as readTextFile } from "./fileio";

export type ProjectFileKind = "image" | "text";

export interface ProjectFile {
  name: string;
  path: string;
  kind: ProjectFileKind;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const TEXT_EXTS  = new Set(["md", "txt"]);

/** True when the path points at an image we can render (by extension). */
export function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

const MIME: Record<string, string> = {
  png:  "image/png",
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif:  "image/gif",
};

/** Recursively scan the project folder for image and text files (max depth 5). */
export async function scanProjectFiles(projectPath: string): Promise<ProjectFile[]> {
  const results: ProjectFile[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > 5) return;
    try {
      const entries = await readDir(dir);
      for (const e of entries) {
        if (e.isDirectory && !e.name.startsWith(".")) {
          await walk(e.path, depth + 1);
        } else if (!e.isDirectory) {
          const ext = e.name.split(".").pop()?.toLowerCase() ?? "";
          if (IMAGE_EXTS.has(ext)) {
            results.push({ name: e.name, path: e.path, kind: "image" });
          } else if (TEXT_EXTS.has(ext)) {
            results.push({ name: e.name, path: e.path, kind: "text" });
          }
        }
      }
    } catch {
      // unreadable dirs are skipped
    }
  }

  await walk(projectPath, 0);
  return results;
}

/** Read an image file and return a base64 data URL. */
export async function imageToDataUrl(imagePath: string): Promise<{ dataUrl: string; ext: string; bytes: Uint8Array }> {
  const bytes = await readBinaryFile(imagePath);
  const u8 = new Uint8Array(bytes as ArrayBuffer);
  const ext = imagePath.split(".").pop()?.toLowerCase() ?? "png";
  const mime = MIME[ext] ?? "image/png";

  // Uint8Array → base64 in chunks to avoid call-stack overflow on large images
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  const base64 = btoa(binary);
  return { dataUrl: `data:${mime};base64,${base64}`, ext, bytes: u8 };
}

/** Read a text file (.md / .txt) and return its content string. */
export async function readTextFileContent(filePath: string): Promise<string> {
  return readTextFile(filePath);
}
