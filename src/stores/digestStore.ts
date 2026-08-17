import { create } from "zustand";
import i18n from "../i18n";
import { streamCompletion } from "../lib/ai";
import {
  buildDigestInput,
  saveDigest,
  type CollectionDigest,
  type DigestSourceItem,
} from "../lib/context/collectionDigest";
import {
  checkFreshness,
  hashText,
  loadMemory,
  segmentTargetChars,
} from "../lib/context/memory";
import { chapterTitle, type Volume } from "../lib/context/outline";
import { readFile } from "../lib/fs/fileio";
import { costFor, type Model } from "../lib/ai/configDb";
import { persistUsage } from "../lib/ai/usage";
import { connOptions, resolveConn, type ConnResolution } from "../lib/ai/conn";
import { loadApiKey } from "../lib/keyStore";
import { useAiStore } from "./aiStore";
import { useProjectStore } from "./projectStore";
import { useEditorStore } from "./editorStore";

/**
 * Collection-digest generation (library view). One run at a time, per-volume,
 * mirroring memoryStore's chapterGen orchestration: the store only tracks the
 * in-flight run — loading digests and computing staleness stays with the view,
 * which already reads every chapter for the memory badges.
 */

/** Same model choice as story memory: the dedicated summary model, else active. */
function resolveModel(): ConnResolution {
  const { activeModelId, memoryModelId, models, providers } = useAiStore.getState();
  return resolveConn(models, providers, memoryModelId ?? activeModelId);
}

interface DigestState {
  /** Volume relPath of the in-flight generation, or null. */
  gen: string | null;
  genController: AbortController | null;
  error: string | null;
  /** Volume relPath the error belongs to, so it renders on the right card. */
  errorVol: string | null;
  /** Bumped after every saved digest so views can re-read files. */
  version: number;

  /** Generate (or regenerate) the digest for one volume's current chapters. */
  generateForVolume: (volume: Volume) => Promise<void>;
  abortGen: () => void;
}

export const useDigestStore = create<DigestState>((set, get) => ({
  gen: null,
  genController: null,
  error: null,
  errorVol: null,
  version: 0,

  generateForVolume: async (volume) => {
    if (get().gen !== null) return;
    const { projectPath, activeFilePath } = useProjectStore.getState();
    if (!projectPath || volume.chapters.length === 0) return;
    const resolved = resolveModel();
    if (!resolved.ok) { set({ error: resolved.error, errorVol: volume.relPath }); return; }
    const { model, provider } = resolved;

    const controller = new AbortController();
    set({ gen: volume.relPath, genController: controller, error: null, errorVol: null });

    try {
      // Read every chapter up front (live editor content for the open file, so
      // unsaved edits are both summarized and hashed — the digest must not be
      // born stale against what the author sees).
      const items: DigestSourceItem[] = [];
      const chapterMeta: { rel: string; hash: string }[] = [];
      for (const ch of volume.chapters) {
        const content = ch.path === activeFilePath
          ? useEditorStore.getState().content
          : await readFile(ch.path);
        const memory = await loadMemory(projectPath, ch.path);
        items.push({
          title: chapterTitle(ch),
          content,
          memory,
          memoryFresh: memory ? checkFreshness(content, memory).firstStaleIndex === -1 : false,
        });
        chapterMeta.push({ rel: ch.relPath, hash: hashText(content) });
      }

      const body = buildDigestInput(items, segmentTargetChars(model.contextSize));
      const apiKey = (await loadApiKey(provider.id)) ?? "";

      let summary = "";
      let usage = { in: 0, out: 0, cached: 0 };
      await streamCompletion({
        ...connOptions({ provider, model, apiKey }),
        messages: [
          { role: "system", content: i18n.t("ai.digest.systemPrompt") },
          { role: "user", content: `${body}\n\n${i18n.t("ai.digest.instruction")}` },
        ],
        signal: controller.signal,
        onChunk: (chunk) => {
          if ("done" in chunk) {
            usage = {
              in: chunk.inputTokens,
              out: chunk.outputTokens,
              cached: chunk.cachedTokens ?? 0,
            };
          } else if ("text" in chunk) {
            summary += chunk.text;
          }
        },
      });

      // Billing reflects what was generated even if the run was superseded.
      recordUsage(projectPath, model, usage);

      const digest: CollectionDigest = {
        volume: volume.relPath,
        chapters: chapterMeta,
        updatedAt: new Date().toISOString(),
        summary: summary.trim(),
      };
      await saveDigest(projectPath, digest);
      if (get().genController === controller) set((s) => ({ version: s.version + 1 }));
    } catch (e) {
      if ((e as Error).name !== "AbortError" && get().genController === controller) {
        set({ error: String(e), errorVol: volume.relPath });
      }
    } finally {
      if (get().genController === controller) {
        set({ gen: null, genController: null });
      }
    }
  },

  abortGen: () => {
    get().genController?.abort();
    set({ gen: null, genController: null });
  },
}));

/** Persist digest token usage (best-effort). */
function recordUsage(projectPath: string, model: Model, usage: { in: number; out: number; cached: number }): void {
  if (usage.in <= 0 && usage.out <= 0) return;
  const cost = costFor(model, usage.in, usage.out, usage.cached);
  void persistUsage(projectPath, model.id, usage.in, usage.out, cost, "digest", usage.cached);
}
