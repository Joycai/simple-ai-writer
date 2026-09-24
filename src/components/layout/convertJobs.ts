/**
 * 「转换文档」的进行中与失败，按路径记——顶栏和文件树两个入口共用这一份。
 *
 * 不放在 `ConvertButton` 自己的 state 里：按钮只在「可转换」的文件上渲染，作者在
 * 转换途中点开一篇 `.md`，它就整个卸载了——还在跑的那次转换失败时没人接，又回到
 * 「点了却什么都没发生」；切回原文件时按钮是新的一枚，`busy` 也丢了，同一个文件能
 * 被再转一次。给按钮加 `key={path}` 是同一个问题。
 *
 * 和 `components/ai/snippetTrace.ts` 同一个做法：模块级的一小份状态 +
 * `useSyncExternalStore`，不进 zustand——它是顶栏上的一个回执，不是应用状态。
 *
 * **同一个文件夹里一次只转一份。** `convertProjectFile` 先用 `uniqueImportPath` 挑
 * 一个空着的名字、再写，两次并发的转换在挑名字时都看见它空着：`a.docx` 与 `a.pdf`
 * 一起挑中 `a.md` 和 `assets/a/`，互相覆盖；`a.docx`（`a.md` 已在，挑 `a-2.md`）与
 * `a-2.docx` 也一样。转换只往源文件自己的文件夹里写，所以不同文件夹之间照样并行。
 */

import { useSyncExternalStore } from "react";
import { dirName, isSamePath } from "../../lib/paths";

interface ConvertFailure {
  path: string;
  message: string;
  /** Monotonic, so a timer started for an older failure can't clear a newer one. */
  seq: number;
}

interface ConvertJobs {
  /** Files being converted right now — more than one when the author moves on and starts another. */
  busy: readonly string[];
  /** The latest failure and the file it was about. One slot: the newest failure is the one worth saying. */
  failed: ConvertFailure | null;
}

let current: ConvertJobs = { busy: [], failed: null };
let seq = 0;
const listeners = new Set<() => void>();

function update(next: Partial<ConvertJobs>): void {
  current = { ...current, ...next };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useConvertJobs(): ConvertJobs {
  return useSyncExternalStore(subscribe, () => current);
}

export function getConvertJobs(): ConvertJobs {
  return current;
}

/** The conversion `path` would have to wait for — any running in its folder (itself included) — or null. */
export function convertBlocker(jobs: ConvertJobs, path: string): string | null {
  return jobs.busy.find((p) => isSamePath(dirName(p), dirName(path))) ?? null;
}

/**
 * Claim `path`'s folder for a conversion. `false` when one is already running
 * there — the caller says so (the top bar's button is already showing it). A
 * new attempt also retires that file's previous failure, whichever entry made it.
 */
export function beginConvert(path: string): boolean {
  if (convertBlocker(current, path)) return false;
  update({
    busy: [...current.busy, path],
    failed: current.failed && isSamePath(current.failed.path, path) ? null : current.failed,
  });
  return true;
}

/** Release `path`; with `error`, record the failure against it. */
export function endConvert(path: string, error?: string): void {
  update({
    busy: current.busy.filter((p) => !isSamePath(p, path)),
    ...(error !== undefined ? { failed: { path, message: error, seq: ++seq } } : {}),
  });
}

/** Retire a failure once it has been shown — only if nothing newer replaced it. */
export function clearConvertFailure(failureSeq: number): void {
  if (current.failed?.seq === failureSeq) update({ failed: null });
}

/** Tests only. */
export function resetConvertJobs(): void {
  current = { busy: [], failed: null };
  for (const l of listeners) l();
}
