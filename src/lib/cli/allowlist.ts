/**
 * 免审批命令——作者亲手列出的程序，以它们开头的命令不再出审批卡
 * （docs/feature/agent/shell-command-plan.md §3.8）。
 *
 * 存的是**程序名**（`git`、`pandoc`），不是命令行：判断一行命令算不算被覆盖
 * 是 `command.ts` 的 `commandCover` 的事，这里只管这份清单本身——读、加、删，
 * 以及把作者打进来的字规整成同一个键（`Git.exe` 和 `git` 是同一条）。
 *
 * 机器本地（`MACHINE_LOCAL_PREF_KEYS`）：这是对**这台电脑**上某个程序的信任，
 * 不随配置备份去另一台——那边的 `gh` 可能是另一个东西，而且作者没在那台电脑上
 * 点过这个头。
 */

import { readPref, writePref } from "../prefs";
import { allowRefusal, normalizeProgramName, type AllowRefusal } from "./command";

const KEY = "app:cliAllowlist";

/** Offered as one-click chips under the editor, minus what is already listed. */
export const CLI_ALLOW_SUGGESTIONS: readonly string[] = ["git", "gh", "find", "pandoc"];

/**
 * The stored list. Anything unreadable reads as empty, and an entry that is no
 * longer acceptable (edited by hand, or refused by a newer build) is dropped
 * here rather than trusted — the matcher checks again anyway.
 */
export function readCliAllowlist(): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readPref(KEY) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = normalizeProgramName(item);
    if (!allowRefusal(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

function write(list: readonly string[]): void {
  writePref(KEY, JSON.stringify(list));
}

export type AllowAddResult =
  | { ok: true; name: string; list: string[] }
  | { ok: false; name: string; reason: AllowRefusal | "empty" | "duplicate" };

/** Add one program, typed or offered by a card. Appends; order is the author's. */
export function addCliAllowed(raw: string): AllowAddResult {
  const name = normalizeProgramName(raw);
  if (!name) return { ok: false, name, reason: "empty" };
  const refusal = allowRefusal(name);
  if (refusal) return { ok: false, name, reason: refusal };
  const list = readCliAllowlist();
  if (list.includes(name)) return { ok: false, name, reason: "duplicate" };
  const next = [...list, name];
  write(next);
  return { ok: true, name, list: next };
}

/** Add several at once (a card's 「始终允许 git · gh」); returns the new list. */
export function addCliAllowedAll(names: readonly string[]): string[] {
  let list = readCliAllowlist();
  for (const name of names) {
    const res = addCliAllowed(name);
    if (res.ok) list = res.list;
  }
  return list;
}

export function removeCliAllowed(name: string): string[] {
  const next = readCliAllowlist().filter((n) => n !== normalizeProgramName(name));
  write(next);
  return next;
}
