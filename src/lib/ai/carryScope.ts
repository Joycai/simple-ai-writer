/** Opaque history belongs to a route and credential, never just a model name. */
import type { ConnOptions } from "./conn";
import type { StreamMessage } from "./types";

/** Persist only the digest, never the credential or a URL that might contain it. */
export async function carryScope(opts: ConnOptions): Promise<string> {
  const identity = JSON.stringify([
    opts.standard, opts.baseUrl.trim().replace(/\/+$/, ""), opts.modelId,
    opts.platform ?? "", opts.authMode ?? "default", opts.relayUpstream ?? "", opts.apiKey,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Request-local projection; switching back must not erase the saved original. */
export function projectCarry(messages: StreamMessage[], scope: string): StreamMessage[] {
  return messages.flatMap((message): StreamMessage[] => {
    if (message.role !== "assistant" || message._carryScope === scope) return [message];
    // Legacy histories have no verifiable origin either. Keep visible content
    // and bare tool calls/results; the target adapter rebuilds its own spelling.
    const copy = { ...message };
    delete copy._responseItems;
    delete copy._carryScope;
    if ("tool_calls" in copy) {
      delete copy._geminiModelParts;
      delete copy._thinkingBlocks;
      // Legacy plain reasoning was already replayed before origin metadata
      // existed. Preserve that contract (e.g. DeepSeek tool turns), but never
      // grandfather ciphertext or a known foreign route's private fields.
      if (!message._carryScope && copy._reasoning) {
        copy._reasoning = { field: copy._reasoning.field, text: copy._reasoning.text };
      } else {
        delete copy._reasoning;
      }
    }
    // A reasoning-only Responses turn has no portable visible message after
    // its carrier is removed. Omit only the request copy, preserving the stored
    // original for switching back. Tool calls and media are real content.
    const hasCalls = "tool_calls" in copy && copy.tool_calls.length > 0;
    const hasContent = typeof copy.content === "string"
      ? copy.content.trim().length > 0
      : Array.isArray(copy.content) && copy.content.some(p => p.type !== "text" || p.text.trim().length > 0);
    return hasCalls || hasContent ? [copy] : [];
  });
}
