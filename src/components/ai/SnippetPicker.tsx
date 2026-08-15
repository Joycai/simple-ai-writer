/**
 * Quick-insert picker for snippet prompts (scene = SNIPPET_SCENE, managed in
 * Settings → Prompt like every other prompt). Renders nothing until the
 * author has defined at least one snippet, so the input rows carry no extra
 * chrome by default.
 *
 * Picking *inserts into the input box* rather than sending — a snippet is a
 * starting point the author completes ("检查以下条款的偏差：…"), and an
 * auto-send would fire it half-written.
 */

import { useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Zap } from "lucide-react";
import { SNIPPET_SCENE } from "../../lib/ai/configDb";
import { useAiStore } from "../../stores/aiStore";
import { ContextMenu } from "../common/ContextMenu";
import styles from "./SnippetPicker.module.css";

interface Props {
  /** Receives the snippet body; the caller appends it into its input state. */
  onPick: (content: string) => void;
}

export function SnippetPicker({ onPick }: Props) {
  const { t } = useTranslation();
  const prompts = useAiStore((s) => s.prompts);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const snippets = prompts.filter((p) => p.scene === SNIPPET_SCENE);
  if (snippets.length === 0) return null;

  const openMenu = (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.left, y: rect.bottom + 4 });
  };

  return (
    <>
      <button
        type="button"
        className={styles.snippetBtn}
        onClick={openMenu}
        title={t("ai.snippets.hint")}
      >
        <Zap size={11} strokeWidth={1.8} />
        {t("ai.snippets.button")}
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={snippets.map((s) => ({
            kind: "item" as const,
            label: s.name,
            /* Mono 角标 in the shortcut slot — marks the row as a snippet. */
            shortcut: "snippet",
            action: () => onPick(s.content),
          }))}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
