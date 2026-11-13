import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ContextMenuEntry } from "../common/ContextMenu";
import type { LoreEntityAddress } from "../../lib/lore/model";
import type { PresentationFormat } from "../../lib/lore/presentation";

/** Shared by the wall and both detail modes. */
export function usePresentationExport() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const run = async (entity: LoreEntityAddress, format: PresentationFormat) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const { exportEntryPresentation } = await import("../../lib/lore/presentation");
      await exportEntryPresentation(entity, format);
    } catch (error) {
      window.alert(`${t("lore.presentation.failed")}\n${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (entity: LoreEntityAddress, disabled = false): ContextMenuEntry[] =>
    (["html", "pdf", "md"] as const).map(format => ({
      kind: "item", label: t(`lore.presentation.${format}`), disabled: disabled || busy,
      action: () => void run(entity, format),
    }));
}
