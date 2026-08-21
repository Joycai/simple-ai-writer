/**
 * The manuscript flavour of image generation: illustrate the passage you are
 * writing, and drop the picture in at the cursor.
 *
 * The source material is the surrounding prose rather than a knowledge-base
 * entry, so this works the same whether the document is a chapter, a 公众号
 * draft or a 标书 section — the profile's own vocabulary supplies the wording.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ImageGenModal } from "../ai/ImageGenModal";
import { insertAtCursor as insertIntoView } from "../../lib/editor/format";
import { imageMarkdown, saveDocumentAsset } from "../../lib/image/assets";
import type { ImageGenTarget } from "../../lib/image/target";
import { useEditorStore } from "../../stores/editorStore";
import { useTerms } from "../../stores/projectStore";
import { baseName } from "../../lib/paths";

interface Props {
  onClose: () => void;
}

/**
 * How much prose to hand the prompt writer when nothing is selected. Enough
 * for the scene at the cursor, short of the whole chapter — an image brief
 * drawn from 20k characters describes the book, not the moment.
 */
const CONTEXT_CHARS = 1200;

export function DocImageGenModal({ onClose }: Props) {
  const { t } = useTranslation();
  const terms = useTerms();
  const filePath = useEditorStore((s) => s.filePath);

  const target: ImageGenTarget = useMemo(() => {
    const docName = filePath ? baseName(filePath).replace(/\.md$/i, "") : terms.doc;

    return {
      key: filePath ?? "",
      subject: docName,
      subjectKind: terms.doc,
      material: async () => {
        // Read from the live editor, never from a captured `content`: this
        // runs when the author asks for a prompt, and the document is a
        // dependency that changes on every keystroke — depending on it would
        // rebuild the whole target (and everything memoised from it) per
        // character typed, for a value that is read fresh here anyway.
        const state = useEditorStore.getState().editorView?.state;
        const doc = state?.doc.toString() ?? useEditorStore.getState().content;
        const sel = state?.selection.main;
        if (sel && !sel.empty) return doc.slice(sel.from, sel.to);
        const at = sel?.head ?? doc.length;
        return doc.slice(Math.max(0, at - CONTEXT_CHARS), at + CONTEXT_CHARS / 2);
      },
      // A document has no gallery of earlier pictures to stay consistent with.
      references: [],
      save: {
        // The profile's own word for a document — 章节 / 文档 / 周报 — so a
        // 标书 project isn't told its picture goes "into the chapter".
        label: t("lore.imageGen.insertToDoc", { doc: terms.doc }),
        run: async ({ bytes, ext, note }) => {
          if (!filePath) throw new Error(t("lore.imageGen.noDocument"));
          const { absPath, relPath } = await saveDocumentAsset(filePath, bytes, ext);
          insertAtCursor(imageMarkdown(relPath, note));
          return absPath;
        },
      },
    };
  }, [filePath, terms, t]);

  /** Splice the link in through the live CodeMirror view, if there is one. */
  function insertAtCursor(text: string) {
    const v = useEditorStore.getState().editorView;
    if (v) insertIntoView(v, text);
  }

  return <ImageGenModal target={target} onClose={onClose} />;
}
