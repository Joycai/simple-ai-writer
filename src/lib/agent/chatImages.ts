/**
 * What to do with a picture the **model** put in its reply.
 *
 * `![](…)` in an assistant turn is the one image link in the app that comes
 * from a model rather than from a file the author is editing, and that decides
 * both halves of the policy this module is:
 *
 * - **Where it resolves.** A document resolves its links against its own
 *   folder; a chat turn is not a file and has no folder. So a relative link
 *   resolves against the **project root** — the only directory a conversation
 *   can be said to be "in".
 * - **What is refused.** The string is model-controlled, so anything landing
 *   outside the project is not read at all. `src-tauri/src/protocol.rs` already
 *   answered the same question the same way for `ai-writer-asset://` links in
 *   imported markdown, and this is the same threat with the same shape.
 *
 * `.ai-writer/` stays *in* scope here, unlike {@link isWorkspacePath}: that
 * ban is about write tools not becoming a back door into lore, and an entity's
 * gallery lives in there — rendering one is exactly what the lore panels do.
 *
 * Pure so the containment rule can be tested without a DOM (vitest runs on
 * `environment: "node"`); the reading and the `<img>` live in AgentChat.
 */

import { isPathWithin, resolveLinkPath } from "../paths";

/** Links that are already loadable as-is — left for the webview to fetch. */
const READY = /^(https?:|data:|blob:|ai-writer-asset:)/i;

export type ChatImageSource =
  /** Not ours to resolve: empty, or a URL the webview can load itself. */
  | { kind: "skip" }
  /** Read this absolute path and inline it. */
  | { kind: "read"; path: string }
  /** Points outside the project — show the gap, read nothing. */
  | { kind: "refuse" };

/**
 * Where an assistant turn's `<img src>` should get its pixels from.
 *
 * `projectPath` empty means no project is open, and then nothing local can be
 * resolved at all — every local link is refused rather than guessed at.
 */
export function chatImageSource(projectPath: string, raw: string): ChatImageSource {
  if (!raw || READY.test(raw)) return { kind: "skip" };
  if (!projectPath) return { kind: "refuse" };
  const abs = resolveLinkPath(projectPath, raw);
  return isPathWithin(projectPath, abs) ? { kind: "read", path: abs } : { kind: "refuse" };
}
