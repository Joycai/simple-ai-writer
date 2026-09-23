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
import { writePastedImage } from "../../lib/agent/chatStash";
import { classifyPaste, PASTE_IMAGE_EXT, pasteDisplayIndex } from "../../lib/agent/pasteImages";
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
    if (!projectPath) return;
    const stashId = useAgentStore.getState().ensureChatStash(chatKey);
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
    let failure: string | null = null;

    for (const { file, ext } of files) {
      // Full before the bytes are written: a refused picture leaves nothing
      // behind in the scratch area.
      if (images >= MAX_MESSAGE_IMAGES) { refused++; continue; }
      let path: string;
      try {
        path = await writePastedImage(projectPath, stashId, new Uint8Array(await file.arrayBuffer()), ext);
      } catch (e) {
        failure = t("ai.chat.pasteFailed", {
          defaultValue: "贴图没能存下来：{{error}}",
          error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      // The same picture again is the same file (content-named): already a chip.
      if (keys.has(`file:${path}`)) continue;
      const name = t("ai.chat.pastedImageName", {
        defaultValue: "粘贴的图片 {{n}}",
        n: pasteDisplayIndex(path, known),
      });
      const outcome = await attachProjectFile({ name, path, kind: "image" });
      if (!outcome.ok) {
        failure = outcome.reason === "too-large"
          ? t("ai.chat.imageTooLarge", {
              defaultValue: "{{name}} 太大（{{size}}MB，上限 {{max}}MB）",
              name, size: outcome.sizeMb, max: outcome.maxMb,
            })
          : t("ai.chat.refUnreadable", { defaultValue: "读不到 {{name}}", name });
        continue;
      }
      keys.add(`file:${path}`);
      known.push(path);
      images++;
      taken++;
      setRefs((prev) => [...prev, outcome.item]);
    }

    setError(
      refused > 0
        ? t("ai.chat.pasteOverCap", {
            defaultValue: "一条消息最多 {{max}} 张图：收了 {{taken}} 张，{{refused}} 张没收",
            max: MAX_MESSAGE_IMAGES, taken, refused,
          })
        : failure,
    );
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
    e.preventDefault();
    // `getAsFile` only answers during the event; the bytes are read after.
    const files = items.flatMap((i) => {
      const ext = i.kind === "file" ? PASTE_IMAGE_EXT[i.type] : undefined;
      const file = ext ? i.getAsFile() : null;
      return file && ext ? [{ file, ext }] : [];
    });
    queue.current = queue.current.then(() => take(files)).catch(() => {});
  }, [take, setError, t]);
}

