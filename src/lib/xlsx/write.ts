/**
 * `SheetSpec[]` → .xlsx 字节。**唯一**知道生成端在 Rust 的文件。
 *
 * 生成放 Rust（`rust_xlsxwriter`），和 docx 的「生成放 TS」看似相反，其实是同
 * 一条规则的两次应用——**跟着已有的那一份走**（docx 00-feasibility D5）：docx
 * 要生成就要先解析 markdown，而 markdown 方言在 TS，所以生成留在 TS；这里
 * **方言一个字都不过界**（`sheets.ts` 已经把 markdown 解析完、`cells.ts` 已经
 * 把类型判完），过去的是一张定了型的格子表，而 xlsx 的读写库早就在 Rust 了。
 *
 * 字节按 base64 回来，不按 JSON 数字数组——数字数组会把体积撑成四倍，这一条
 * 在 `fs_write_binary_file` 和 pptx 抽图那边都已经踩过（pptx-plan D3）。
 */

import { invoke } from "@tauri-apps/api/core";
import { fromBase64, writeBinaryFile } from "../fs/fileio";
import type { SheetSpec } from "./sheets";

export async function workbookBytes(sheets: SheetSpec[]): Promise<Uint8Array> {
  const data = await invoke<string>("xlsx_write_workbook", { sheets });
  return fromBase64(data);
}

/** 生成并落盘。返回写到了哪里，因为落点可能不是调用方猜的那个。 */
export async function writeWorkbook(sheets: SheetSpec[], outPath: string): Promise<string> {
  await writeBinaryFile(outPath, await workbookBytes(sheets));
  return outPath;
}
