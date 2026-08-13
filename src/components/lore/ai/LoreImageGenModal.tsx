/**
 * The lore-entity flavour of image generation: what the shared modal reads as
 * source material, and where a kept picture goes.
 *
 * Everything here is entity-specific by design — the facet picker, the gallery
 * as a destination, the automatic description — so the modal itself never has
 * to know a lore entity exists. See lib/image/target.ts.
 */

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImageGenModal } from "../../ai/ImageGenModal";
import { readFile } from "../../../lib/fs/fileio";
import { parseFrontmatter } from "../../../lib/fs/markdown";
import type { ImageGenTarget, SaveInput } from "../../../lib/image/target";
import { addLoreImage, readEntityFile, setEntityAvatar, updateLoreImageDesc, type LoreEntity } from "../../../lib/lore";
import { resolveConn } from "../../../lib/ai/conn";
import { describeLoreImage } from "../../../lib/lore/vision";
import { categoryLabel, findCategory } from "../../../lib/profile";
import { loadApiKey } from "../../../lib/keyStore";
import { useAiStore } from "../../../stores/aiStore";
import i18n from "../../../i18n";
import styles from "../LoreImproveModal.module.css";
import gen from "../../ai/ImageGenModal.module.css";

interface Props {
  entity: LoreEntity;
  onClose: () => void;
  /** Called after an image landed on disk, so the detail view rescans. */
  onSaved: () => void;
}

export function LoreImageGenModal({ entity, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const { models, providers, activeModelId } = useAiStore();
  /** Facet files to feed the prompt writer, keyed by filename. */
  const [pickedFacets, setPickedFacets] = useState<Set<string>>(new Set());

  /**
   * Facets carry the visual specifics — an outfit, a form, a scar — that
   * index.md deliberately leaves out, so a prompt drafted without them
   * describes a generic version of the subject.
   */
  // Memoised because it goes into `target`, which is itself memoised: freshly
  // built JSX is a new object every render, so as a plain value it defeated
  // the target memo entirely — and with it the `describe` callback and every
  // consumer downstream.
  const extras = useMemo(() => entity.facets.length > 0 && (
    <div className={styles.section}>
      <label className={styles.label}>{t("lore.imageGen.facetsLabel")}</label>
      <div className={gen.facets}>
        {entity.facets.map((f) => {
          const on = pickedFacets.has(f.file);
          return (
            <button
              key={f.file}
              className={`${gen.facetChip} ${on ? gen.facetChipOn : ""}`}
              onClick={() => setPickedFacets((prev) => {
                const next = new Set(prev);
                if (on) next.delete(f.file); else next.add(f.file);
                return next;
              })}
              title={f.group ? `${f.title} · ${f.group}` : f.title}
            >
              {f.title}
            </button>
          );
        })}
      </div>
      <div className={gen.hint}>{t("lore.imageGen.facetsHint")}</div>
    </div>
  ), [entity.facets, pickedFacets, t]);

  /**
   * Describe a freshly saved picture with the active multimodal model. Until
   * this runs, the image is invisible to every text-only model in the app —
   * which is most of them. A failure here is a note, not a failed save.
   */
  const describe = useCallback(async (file: string, dataUrl: string) => {
    const vision = resolveConn(models, providers, activeModelId);
    if (!vision.ok || vision.model.type !== "multimodal") return;
    try {
      const apiKey = (await loadApiKey(vision.provider.id)) ?? "";
      const desc = await describeLoreImage({
        dataUrl,
        entityName: entity.name,
        entitySummary: entity.summary,
        language: i18n.language,
        baseUrl: vision.provider.baseUrl,
        apiKey,
        standard: vision.provider.apiStandard,
        authMode: vision.provider.authMode,
        safetySettings: vision.provider.safetySettings,
        modelId: vision.model.modelId,
        prefix: vision.model.prefix,
        contextSize: vision.model.contextSize,
        maxOutput: vision.model.maxOutput,
      });
      await updateLoreImageDesc(entity.dirPath, file, desc);
      onSaved();
    } catch {
      // Already on disk; the author can write a description by hand.
    }
  }, [models, providers, activeModelId, entity, onSaved]);

  const target: ImageGenTarget = useMemo(() => {
    const saveToGallery = async ({ bytes, ext, dataUrl, note }: SaveInput) => {
      // `note` seeds the description so the picture is legible to text-only
      // models even before (or instead of) the vision pass.
      const file = await addLoreImage(entity.dirPath, `ai-${Date.now()}.${ext}`, bytes, note);
      onSaved();
      void describe(file, dataUrl);
      return `${entity.dirPath}/${file}`;
    };

    return {
      key: entity.dirPath,
      subject: entity.name,
      // The category's display name — 角色 / 场景 / 产品 — is what tells the
      // prompt writer whether it is briefing a portrait or a diagram.
      subjectKind: (() => {
        const cat = findCategory(entity.category);
        return cat ? categoryLabel(cat, i18n.language.startsWith("zh")) : undefined;
      })(),
      material: async () => {
        const body = await readFile(`${entity.dirPath}/index.md`)
          .then((raw) => parseFrontmatter(raw).content.trim())
          .catch(() => "");
        // Read the chosen facets lazily: the author picks a couple out of what
        // can be dozens, and only when they ask for a prompt.
        const facets = await Promise.all(
          entity.facets
            .filter((f) => pickedFacets.has(f.file))
            .map(async (f) => {
              try {
                const raw = await readEntityFile(entity.dirPath, f.file);
                return `## ${f.title}\n${parseFrontmatter(raw).content.trim()}`;
              } catch {
                return "";
              }
            }),
        );
        return [entity.summary, body, ...facets].filter(Boolean).join("\n\n");
      },
      references: entity.images.map((img) => img.desc).filter((d) => d.trim()),
      save: { label: t("lore.imageGen.saveToGallery"), run: saveToGallery },
      altSave: {
        label: t("lore.imageGen.saveAsAvatar"),
        closeAfter: true,
        run: async (input) => {
          const path = await saveToGallery(input);
          await setEntityAvatar(entity.dirPath, input.bytes, input.ext);
          onSaved();
          return path;
        },
      },
      extras,
    };
  }, [entity, pickedFacets, onSaved, describe, extras, t]);

  return <ImageGenModal target={target} onClose={onClose} />;
}
