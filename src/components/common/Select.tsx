/**
 * Themed replacement for the native `<select>`: the browser's popup can't be
 * styled, so every dropdown rendered OS furniture in the middle of the
 * manuscript. The trigger reads as an input (inside Settings the `--stg-*`
 * remap reaches it through `--color-bg-surface`, so it matches the fields
 * beside it); the menu portals to `<body>` like ContextMenu — app chrome, and
 * out of reach of the drawers' `overflow-y: auto` clipping.
 *
 * An empty selection is expressed as an option with `value: ""` when it is a
 * real choice (自动 / 不启用), or left out entirely and named via `placeholder`
 * when it is merely the not-yet-chosen state.
 *
 * Surfaces with their own input dialect (the AI panel's inset/mono, the lore
 * modals' paper) re-skin the trigger by passing a class **doubled in its own
 * module** (`.x.x { … }`): 0-2-0 outranks the base `.trigger` deterministically,
 * where a single class would tie and win or lose on bundle order.
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import styles from "./Select.module.css";

export interface SelectOption {
  value: string;
  label: string;
  /** Consecutive options sharing a group get one non-interactive header —
   *  the flat-list spelling of `<optgroup>`. */
  group?: string;
}

const ROW_HEIGHT = 30;
const MENU_MAX_HEIGHT = 288;
const GAP = 4;
const VIEWPORT_MARGIN = 8;

export function Select({
  value,
  options,
  onChange,
  placeholder,
  disabled,
  ariaLabel,
  className,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Shown on the trigger while `value` matches no option. */
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /** Extends the trigger button (widths, flex behaviour in a row). */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [openUp, setOpenUp] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const selected = options.find((o) => o.value === value);

  const openMenu = () => {
    const rect = triggerRef.current!.getBoundingClientRect();
    const wanted = Math.min(options.length * ROW_HEIGHT + 10, MENU_MAX_HEIGHT);
    const below = window.innerHeight - rect.bottom - GAP - VIEWPORT_MARGIN;
    const above = rect.top - GAP - VIEWPORT_MARGIN;
    // Open upward only when the space below can't fit the list and above can
    // do better — a menu that fits stays below regardless of position.
    const up = below < wanted && above > below;
    setOpenUp(up);
    setMenuStyle({
      left: rect.left,
      width: rect.width,
      maxHeight: Math.max(Math.min(wanted, up ? above : below), ROW_HEIGHT * 3),
      ...(up ? { bottom: window.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP }),
    });
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  const pick = (v: string) => {
    setOpen(false);
    if (v !== value) onChange(v);
  };

  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) =>
      (t instanceof Node) &&
      (triggerRef.current?.contains(t) || menuRef.current?.contains(t) || false);
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) setOpen(false);
    };
    // Escape closes the menu only — captured so it wins over the settings
    // page's own Escape routing, which would peel the drawer instead.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    // The menu is position: fixed, so scrolling the surface underneath would
    // leave it floating over nothing — close it, as native popups do. Scrolls
    // inside the menu itself are its own scrollbar and don't count.
    const onScroll = (e: Event) => {
      if (!inside(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  // Keep the keyboard cursor visible while arrowing through a scrolled menu.
  // By id, not child index — group headers sit between the option buttons.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${menuId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, menuId]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => Math.min(i + 1, options.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(options.length - 1);
        break;
      case "Enter":
      case " ":
        // preventDefault also swallows the button's native click, which would
        // otherwise re-toggle the menu right after pick() closed it.
        e.preventDefault();
        if (options[active]) pick(options[active].value);
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ""} ${className ?? ""}`}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={open && options[active] ? `${menuId}-${active}` : undefined}
      >
        <span className={`${styles.value} ${selected ? "" : styles.placeholder}`}>
          {selected ? selected.label : placeholder ?? ""}
        </span>
        <ChevronDown size={13} className={styles.caret} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="listbox"
            className={`${styles.menu} ${openUp ? styles.menuUp : ""}`}
            style={menuStyle}
          >
            {options.map((o, i) => (
              <div key={`${o.value}-${i}`} className={styles.optionWrap}>
                {o.group && o.group !== options[i - 1]?.group && (
                  <div className={styles.group}>{o.group}</div>
                )}
                <button
                  id={`${menuId}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  className={`${styles.option} ${i === active ? styles.optionActive : ""} ${
                    o.value === value ? styles.optionSelected : ""
                  }`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(o.value)}
                >
                  <span className={styles.optionLabel}>{o.label}</span>
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
