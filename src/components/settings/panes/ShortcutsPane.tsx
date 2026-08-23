import { useTranslation } from "react-i18next";
import { SHORTCUTS, comboLabel, type ShortcutCategory, type ShortcutDef } from "../../../lib/shortcuts";
import { Pane, PaneHeader, Section } from "./bits";
import ui from "../settingsUi.module.css";

const SHORTCUT_CATEGORY_ORDER: ShortcutCategory[] = ["global", "view", "file", "ai", "editor", "contextual"];

/**
 * One key box per binding. `combosLabel` joins alternates with " / " (⌘[ / ⌘←),
 * so splitting it back out gives the design's row of separate keycaps rather
 * than one box containing a slash.
 */
function keysFor(s: ShortcutDef): string[] {
  if (s.combo) return [comboLabel(s.combo)];
  return (s.keysLabel ?? "").split(" / ").filter(Boolean);
}

export function ShortcutsPane() {
  const { t } = useTranslation();
  return (
    <Pane width="compact">
      <PaneHeader title={t("systemSettings.tabs.shortcuts")} sub={t("systemSettings.shortcuts.paneSub")} />
      {SHORTCUT_CATEGORY_ORDER.map((cat) => {
        const items = SHORTCUTS.filter((s) => s.category === cat);
        if (items.length === 0) return null;
        return (
          <Section key={cat} label={t(`systemSettings.shortcuts.categories.${cat}`)}>
            {items.map((s) => (
              <div className={ui.kbdRow} key={s.id}>
                <span className={ui.kbdLabel}>{t(`systemSettings.shortcuts.items.${s.labelKey}`)}</span>
                <span className={ui.spacer} />
                {keysFor(s).map((k) => (
                  <span className={ui.kbd} key={k}>{k}</span>
                ))}
              </div>
            ))}
          </Section>
        );
      })}
    </Pane>
  );
}
