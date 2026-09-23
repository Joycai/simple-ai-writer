/**
 * ⌘V a picture into the assistant's composer
 * (docs/feature/agent/chat-image-paste-plan.md §3).
 *
 * A pasted picture becomes a file in the conversation's scratch area the
 * moment it arrives, then an ordinary image attachment through
 * `attachProjectFile` — the same construction path as `@` and the file tree's
 * 发送到助手, so downscaling, the 12 MB refusal and everything after the send
 * are the ones that already exist. The decisions (text wins, which formats,
 * how many fit) are pure and live in `lib/agent/pasteImages`; this only moves
 * bytes and says what happened.
 *
 * A hook rather than inline so the roleplay and lore composers can take it up
 * later; their sessions die differently, which is why the plan covers only
 * the assistant.
 */

import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { MAX_MESSAGE_IMAGES } from "../../lib/agent/chatRefs";
import { pastedImagePath, writePastedImage } from "../../lib/agent/chatStash";
import { classifyPaste, PASTE_IMAGE_EXT, pasteNumber } from "../../lib/agent/pasteImages";
import { attachedKey, attachProjectFile, type AttachedItem } from "../../lib/lore/aiTask";
import { useAgentStore } from "../../stores/agentStore";
import { chatComposerOf, useComposerStore } from "../../stores/composerStore";
import { useProjectStore } from "../../stores/projectStore";

/**
 * Logs what the clipboard actually hands the webview, so the rules above can
 * be checked against WKWebView and WebView2 (plan §8 — they were written
 * before anyone measured). Run with `VITE_PASTE_PROBE=1 pnpm tauri dev`.
 */
function probe(dt: DataTransfer): void {
  if (!import.meta.env.VITE_PASTE_PROBE) return;
  console.info("[paste-probe]", {
    items: Array.from(dt.items ?? [], (i) => ({ kind: i.kind, type: i.type })),
    types: Array.from(dt.types ?? []),
    files: Array.from(dt.files ?? [], (f) => ({ name: f.name, type: f.type, size: f.size })),
    textLength: dt.getData("text/plain").length,
  });
}

/**
 * Numbers handed out this launch, per conversation — keyed by its scratch
 * id, not the tab, because a tab can be handed to another conversation and
 * one conversation can be reopened in another tab (see `pasteNumber`). Module
 * state because the composer remounts on tab switches.
 */
const assignedNumbers = new Map<string, Map<string, number>>();
function numbersFor(stashId: string): Map<string, number> {
  let m = assignedNumbers.get(stashId);
  if (!m) { m = new Map(); assignedNumbers.set(stashId, m); }
  return m;
}

export function usePasteImages(
  chatKey: string,
  setRefs: (update: (prev: AttachedItem[]) => AttachedItem[]) => void,
  setError: (message: string | null) => void,
): (e: React.ClipboardEvent<HTMLTextAreaElement>) => void {
  const { t } = useTranslation();
  // One paste at a time: two quick ⌘Vs would otherwise both count the chips
  // before either added its own, and walk past the cap together.
  const queue = useRef<Promise<void>>(Promise.resolve());

  const take = useCallback(async (files: { file: File; ext: string }[]) => {
    const projectPath = useProjectStore.getState().projectPath;
    // The tab can have closed while this paste waited its turn.
    if (!projectPath || !useAgentStore.getState().chats[chatKey]) return;
    // The directory id is made only when a file is about to be written: a
    // paste that turns out to be a duplicate or over the cap leaves the tab
    // as it was. Until then no pasted chip can exist, so no duplicate either.
    const stashNow = () => useAgentStore.getState().chats[chatKey]?.stashId ?? null;
    let stashId = stashNow();
    // The tab can be handed to another conversation while a file is being
    // read (opening a saved one reuses an empty tab). Past that point these
    // pictures would be chips of a conversation that does not claim their
    // directory — stop instead.
    const moved = () => stashId !== null && stashNow() !== stashId;
    // Read live, not from the render that registered the handler: a previous
    // paste in the queue may just have added chips.
    const current = chatComposerOf(useComposerStore.getState(), chatKey).refs;
    const turns = useAgentStore.getState().chats[chatKey]?.turns ?? [];
    const keys = new Set(current.map(attachedKey));
    const known = [
      ...turns.flatMap((tn) => tn.images ?? []),
      ...current.flatMap((r) => (r.kind === "image" ? [r.file.path] : [])),
    ];
    let images = current.filter((r) => r.kind === "image").length;
    let taken = 0;
    let refused = 0;
    const failures: string[] = [];

    for (const { file, ext } of files) {
      let path: string;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        // The same picture again is the same file (content-named): already a
        // chip, so neither taken nor refused.
        if (stashId && keys.has(`file:${await pastedImagePath(projectPath, stashId, bytes, ext)}`)) continue;
        // Full before the bytes are written: a refused picture leaves nothing
        // behind in the scratch area.
        if (images >= MAX_MESSAGE_IMAGES) { refused++; continue; }
        if (moved() || !useAgentStore.getState().chats[chatKey]) break;
        stashId ??= useAgentStore.getState().ensureChatStash(chatKey);
        path = await pastedImagePath(projectPath, stashId, bytes, ext);
        await writePastedImage(path, bytes);
      } catch (e) {
        failures.push(t("ai.chat.pasteFailed", {
          defaultValue: "贴图没能存下来：{{error}}",
          error: e instanceof Error ? e.message : String(e),
        }));
        continue;
      }
      const assigned = numbersFor(stashId);
      const n = pasteNumber(path, assigned, known);
      const name = t("ai.chat.pastedImageName", { defaultValue: "粘贴的图片 {{n}}", n });
      const outcome = await attachProjectFile({ name, path, kind: "image" });
      if (!outcome.ok) {
        failures.push(outcome.reason === "too-large"
          ? t("ai.chat.imageTooLarge", {
              defaultValue: "{{name}} 太大（{{size}}MB，上限 {{max}}MB）",
              name, size: outcome.sizeMb, max: outcome.maxMb,
            })
          : t("ai.chat.refUnreadable", { defaultValue: "读不到 {{name}}", name }));
        continue;
      }
      if (moved()) break;
      keys.add(`file:${path}`);
      known.push(path);
      assigned.set(path, n);
      images++;
      taken++;
      setRefs((prev) => [...prev, outcome.item]);
    }

    // Every reason, not the first or the last: a paste that hit the cap and
    // also had one picture fail must say both, or the author cannot tell
    // which picture is missing and why.
    const lines = [
      ...(refused > 0
        ? [t("ai.chat.pasteOverCap", {
            defaultValue: "一条消息最多 {{max}} 张图：收了 {{taken}} 张，{{refused}} 张没收",
            max: MAX_MESSAGE_IMAGES, taken, refused,
          })]
        : []),
      ...failures,
    ];
    setError(lines.length ? lines.join("；") : null);
  }, [chatKey, setRefs, setError, t]);

  return useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const dt = e.clipboardData;
    if (!dt) return;
    probe(dt);
    const items = Array.from(dt.items ?? []);
    const verdict = classifyPaste(items, dt.getData("text/plain").length > 0);
    if (verdict === "passthrough") return;
    // Without a project there is nowhere to put the file; the textarea's own
    // paste (nothing, for a picture) is as good as anything.
    if (!useProjectStore.getState().projectPath) return;
    if (verdict === "unsupported") {
      setError(t("ai.chat.pasteUnsupported", {
        defaultValue: "这种图片格式贴不进来（支持 PNG、JPEG、WebP、GIF）",
      }));
      return;
    }
    // `getAsFile` only answers during the event; the bytes are read after.
    const files = items.flatMap((i) => {
      const ext = i.kind === "file" ? PASTE_IMAGE_EXT[i.type] : undefined;
      const file = ext ? i.getAsFile() : null;
      return file && ext ? [{ file, ext }] : [];
    });
    // Announced as a picture, handed over as nothing (a WebView can do this —
    // plan §8): say so, and leave the paste to the textarea rather than
    // swallowing it silently.
    if (files.length === 0) {
      setError(t("ai.chat.pasteUnreadable", {
        defaultValue: "剪贴板里的图片读不出来——先存成文件再用 @ 附上",
      }));
      return;
    }
    e.preventDefault();
    queue.current = queue.current.then(() => take(files)).catch(() => {});
  }, [take, setError, t]);
}

