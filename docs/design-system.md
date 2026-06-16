# Design System & Theming

> Read this before building or restyling **any** UI. `src/styles/tokens.css` is the implementation of these rules.

## Theming

- **System** — CSS variables (dark/light modes) set via `data-theme` attribute
- **Tokens** — `src/styles/tokens.css` (all design tokens: color/space/radius/shadow/easing/glass)
- **Global** — `src/styles/global.css` (resets, scrollbar, focus ring, reusable keyframes, reduced-motion)
- **Components** — CSS Modules per component (`*.module.css`); read from tokens, never raw values
- **Theme Modes** — dark, light, system (auto-detect)

## Visual Language (视觉规范)

The UI targets a restrained, modern **Apple-like aesthetic**. These rules are the source of truth.

### 核心原则 (Principles)
1. **令牌优先** — Always consume tokens (`var(--…)`). Never hardcode colors, shadows, radii, or easing in component CSS. If a value is missing, add a token, don't inline it.
2. **单一克制强调色** — One System Blue accent (`--color-accent`, dark `#0A84FF` / light `#007AFF`). Tints via `--color-accent-tint` (base fills) and `--color-accent-tint-strong` (hover/selected fills). **No multi-color gradients on interactive elements.** Gradients are reserved for *decorative-only* surfaces: logo, `.gradient-text`, brand accent dot, icon badges.
3. **克制精致动画** — Short durations (120–320ms), Apple easing curves, subtle motion ("barely perceptible but smooth"). Avoid large/bouncy movement except brief spring accents.
4. **分层海拔** — Depth comes from the layered shadow scale, not borders alone. Pick the smallest shadow that reads.
5. **无障碍** — All motion must degrade under `prefers-reduced-motion` (handled globally — don't fight it). Keyboard focus uses the unified `:focus-visible` ring, not just a border-color swap.

### 令牌速查 (Token reference — `tokens.css`)
- **Easing**: `--ease-out` (enter/expand, default), `--ease-spring` (brief pop accents only), `--ease-in-out` (symmetric size/position).
- **Transitions**: `--transition-fast` (120ms, hover/press), `--transition-base` (200ms), `--transition-slow` (320ms, panels/drawers). All pre-bound to `--ease-out`.
- **Radius**: `--radius-sm` 6 / `--radius-md` 10 / `--radius-lg` 14 / `--radius-xl` 20 (modals).
- **Shadow (elevation)**: `--shadow-sm` (resting cards/inputs) → `--shadow-md` (raised) → `--shadow-lg` (popovers/menus/dropdowns) → `--shadow-xl` (modals). `--shadow-focus` for focus rings. Each theme defines its own set (dark deeper, light subtle).
- **Accent**: `--color-accent`, `--color-accent-hover`, `--color-accent-ring`, `--color-accent-tint`, `--color-accent-tint-strong`.
- **Glass**: `--glass-bg` (modals), `--glass-bg-strong` (large chrome), `--glass-blur`, `--glass-border`.

### 组件模式 (Required patterns)
- **Primary button**: solid `--color-accent`; hover → `--color-accent-hover` + `translateY(-1px)` + `--shadow-sm`; active → `translateY(0) scale(0.98)`; disabled → reduced opacity. Never opacity-only hover.
- **Tinted/secondary button**: `--color-accent-tint` bg + `--color-accent` text; hover → `--color-accent-tint-strong` (or solid accent + white text); active → `scale(0.96–0.98)`.
- **Icon/tab/control press**: `:active { transform: scale(0.92–0.96) }`.
- **Chrome surfaces** (sidebar, right panel, tab bar, status bar): `--glass-bg-strong` + `backdrop-filter: var(--glass-blur)` (always pair with `-webkit-backdrop-filter`).
- **Modals**: overlay `animation: fadeIn 200ms var(--ease-out)` + `backdrop-filter: blur(8px)`; panel `scaleIn 240ms`, `--radius-xl`, `--shadow-xl`.
- **Popovers / menus / dropdowns**: `slideUp 160ms var(--ease-out)` + `--shadow-lg`.
- **Reusable keyframes** (in `global.css`): `fadeIn`, `scaleIn`, `slideUp`, `slideInRight` — reuse these, don't redefine per component.
- **Selected/active list items**: `--color-accent-tint` fill + `--color-accent` text.

### 禁止 (Do NOT)
- Hardcode `rgba(…)` accent tints or `box-shadow: 0 …` — use tokens.
- Use gradient backgrounds on buttons/badges/active states.
- Add focus styles that only change `border-color` (use `:focus-visible` ring).
- Introduce a JS animation library — motion is pure CSS to stay lightweight.
