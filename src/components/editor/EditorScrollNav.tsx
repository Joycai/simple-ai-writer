import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronsUp, ChevronsDown } from "lucide-react";
import { EditorView } from "@codemirror/view";
import { useEditorStore } from "../../stores/editorStore";
import styles from "./EditorScrollNav.module.css";

/** Distance (px) from an edge within which we consider the editor "already there"
 *  and hide the matching jump button — avoids offering a scroll that does nothing. */
const EDGE = 24;

/**
 * Floating jump-to-top / jump-to-end control that overlays the editor pane.
 * Long chapters otherwise force manual scrolling to reach the bottom before
 * continuing to write. The "end" button also drops the caret at the document
 * end and focuses, so the writer can start typing straight away.
 */
export function EditorScrollNav() {
  const { t } = useTranslation();
  const view = useEditorStore((s) => s.editorView);
  const [state, setState] = useState({ atTop: true, atBottom: true });

  useEffect(() => {
    if (!view) return;
    const scroller = view.scrollDOM;

    const update = () => {
      const max = scroller.scrollHeight - scroller.clientHeight;
      // A doc that fits the viewport has nothing to jump to — treat as both edges.
      const atTop = max <= EDGE || scroller.scrollTop <= EDGE;
      const atBottom = max <= EDGE || scroller.scrollTop >= max - EDGE;
      // Bail on unchanged values: this runs per scroll event, and a fresh
      // object every time re-rendered the control for the whole scroll.
      setState((prev) =>
        prev.atTop === atTop && prev.atBottom === atBottom ? prev : { atTop, atBottom },
      );
    };

    update();
    scroller.addEventListener("scroll", update, { passive: true });
    // Two different things move the edges, and they need two observations:
    //   • contentDOM — editing changes the document's height. The scroller
    //     itself is `height:100%` with `overflow:auto`, so its own box never
    //     resizes when text is added or deleted and observing it would miss
    //     every content edit (which is exactly the case with no scroll event).
    //   • scrollDOM — the pane resizes (split toggled, window resized, sidebar
    //     dragged), which changes clientHeight and therefore the max scroll.
    const ro = new ResizeObserver(update);
    ro.observe(view.contentDOM);
    ro.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [view]);

  if (!view) return null;

  const toTop = () => {
    // Let CodeMirror scroll rather than scrollDOM.scrollTo({behavior:"smooth"}):
    // the editor only renders lines near the viewport, so a native smooth scroll
    // across the whole doc gets cancelled mid-flight as off-screen lines render
    // and shift scrollHeight. scrollIntoView measures correctly. Caret untouched.
    view.dispatch({ effects: EditorView.scrollIntoView(0, { y: "start" }) });
  };

  const toEnd = () => {
    const end = view.state.doc.length;
    view.dispatch({
      selection: { anchor: end },
      effects: EditorView.scrollIntoView(end, { y: "end" }),
    });
    view.focus();
  };

  if (state.atTop && state.atBottom) return null;

  return (
    <div className={styles.nav}>
      {!state.atTop && (
        <button className={styles.btn} onClick={toTop} title={t("editorNav.toTop")} aria-label={t("editorNav.toTop")}>
          <ChevronsUp size={16} />
        </button>
      )}
      {!state.atBottom && (
        <button className={styles.btn} onClick={toEnd} title={t("editorNav.toEnd")} aria-label={t("editorNav.toEnd")}>
          <ChevronsDown size={16} />
        </button>
      )}
    </div>
  );
}
