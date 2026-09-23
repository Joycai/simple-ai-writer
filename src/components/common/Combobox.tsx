/**
 * Themed replacement for `<input list>` + `<datalist>`: free text with
 * suggestions. The native suggestion popup is OS furniture exactly like the
 * `<select>` popup `Select` replaced — it ignores every token, so a dark or
 * custom theme showed a white system pill under a themed field.
 *
 * The field stays a plain `<input>` styled by the caller's own class (each
 * surface keeps its input dialect); only the menu is ours, and it wears
 * `Select`'s menu classes so the two dropdowns are one family. It portals to
 * `<body>` for the same reason `Select`'s does: out of reach of the drawers'
 * `overflow-y: auto` clipping.
 *
 * Suggestions never constrain the value — typing anything is valid, the menu
 * only offers the spellings already in use. Filtering is a case-insensitive
 * substring test, as the native popup does; a suggestion that already equals
 * the text is not offered back.
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import styles from "./Select.module.css";

const ROW_HEIGHT = 30;
const MENU_MAX_HEIGHT = 288;
const GAP = 4;
const VIEWPORT_MARGIN = 8;

export function Combobox({
  value,
  suggestions,
  onChange,
  className,
  placeholder,
  disabled,
  ariaLabel,
}: {
  value: string;
  suggestions: string[];
  onChange: (value: string) => void;
  /** The input's own class — the caller's text-field look. */
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  // -1 = nothing highlighted: Enter then belongs to the surrounding form.
  const [active, setActive] = useState(-1);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [openUp, setOpenUp] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const q = value.trim().toLowerCase();
  const shown = suggestions.filter((s) => {
    const l = s.toLowerCase();
    return l !== q && l.includes(q);
  });
  const visible = open && shown.length > 0;

  const openMenu = () => {
    if (disabled || !inputRef.current) return;
    const rect = inputRef.current.getBoundingClientRect();
    const wanted = Math.min(suggestions.length * ROW_HEIGHT + 10, MENU_MAX_HEIGHT);
    const below = window.innerHeight - rect.bottom - GAP - VIEWPORT_MARGIN;
    const above = rect.top - GAP - VIEWPORT_MARGIN;
    const up = below < wanted && above > below;
    setOpenUp(up);
    setMenuStyle({
      left: rect.left,
      width: rect.width,
      maxHeight: Math.max(Math.min(wanted, up ? above : below), ROW_HEIGHT * 3),
      ...(up ? { bottom: window.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP }),
    });
    setActive(-1);
    setOpen(true);
  };

  const pick = (v: string) => {
    setOpen(false);
    if (v !== value) onChange(v);
  };

  useEffect(() => {
    if (!visible) return;
    // Escape closes the menu only — captured so it wins over the settings
    // page's own Escape routing, which would peel the drawer instead.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    // position: fixed — scrolling the surface underneath would strand it.
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node && menuRef.current?.contains(e.target))) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [visible]);

  useEffect(() => {
    if (visible && active >= 0) {
      document.getElementById(`${menuId}-${active}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [visible, active, menuId]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (!open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => Math.min(i + 1, shown.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(i - 1, -1));
        break;
      case "Enter":
        if (visible && shown[active]) {
          e.preventDefault();
          pick(shown[active]);
        }
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        className={className}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={visible}
        aria-controls={visible ? menuId : undefined}
        aria-activedescendant={visible && active >= 0 ? `${menuId}-${active}` : undefined}
        onFocus={openMenu}
        onClick={() => { if (!open) openMenu(); }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          onChange(e.target.value);
          if (!open) openMenu();
          else setActive(-1);
        }}
        onKeyDown={onKeyDown}
      />
      {visible &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="listbox"
            className={`${styles.menu} ${openUp ? styles.menuUp : ""}`}
            style={menuStyle}
          >
            {shown.map((s, i) => (
              <button
                key={s}
                id={`${menuId}-${i}`}
                type="button"
                role="option"
                aria-selected={i === active}
                tabIndex={-1}
                className={`${styles.option} ${i === active ? styles.optionActive : ""}`}
                // mousedown, not click: the input's blur would close the menu
                // before a click could land. preventDefault keeps focus put.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className={styles.optionLabel}>{s}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
