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
- **Typography**: `--font-serif` (body/editor), `--font-sans` (UI chrome/labels), `--font-mono` (code, numeric, prefix editor). Size scale `--font-size-xs` 11 → `--font-size-3xl` 44. Serif/sans are **swapped per font scheme** (see below); mono is fixed.

### 字体方案 (Font schemes — `data-font`)

User-switchable CJK × Western pairings, selected in Settings → 通用 → 外观. Chosen like themes: `<html data-font="…">` + override blocks in `tokens.css` that follow `:root` (equal specificity → later block wins). State + persistence live in `appStore` (`fontScheme` / `setFontScheme`, `localStorage["app:fontScheme"]`, re-applied on load). **System fonts only — nothing is bundled**, so every scheme ships a full Win/Mac/Linux fallback stack.

| `data-font` | 名称 | 西文 | 中文正文 | 观感 |
|-------------|------|------|----------|------|
| `manuscript` (default) | 手稿 | Spectral → Georgia | 宋体回退 | Current look, unchanged |
| `song` | 宋体书卷 | Georgia / Cambria | 思源宋 → 苹方宋 → SimSun | Printed-book serif |
| `hei` | 黑体清晰 | 系统无衬线 | 苹方 → 微软雅黑 → 思源黑 | All-sans, modern screen |
| `kai` | 楷体临帖 | Iowan / Georgia | 楷体 → STKaiti | Handwritten manuscript |

Each scheme overrides **both** `--font-serif` (editor body) and `--font-sans` (UI); `hei` points serif at a sans stack to make the whole app sans. To **add a scheme**: append a `[data-font="…"]` block in `tokens.css`, extend the `FontScheme` union + `FONT_SCHEMES` array in `appStore.ts`, add an entry (with a `previewFont` mirroring the serif stack) to `FONT_SCHEMES` in `SettingsModal.tsx`, and add `systemSettings.general.font*` labels to both locales.

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
- Reach for a JS animation library for element-level motion — hover/press/enter accents stay **pure CSS** (tokens + keyframes) to stay lightweight.

### 例外 · 转场与浮层 (Exception — transitions & overlays)
**Motion** (`motion`, ex-`framer-motion`) is the one sanctioned JS animation library, used **solely** where a surface must animate *out* while another animates *in* — something CSS mount-only animations can't do. Two uses only:
- **Screen / content switches** — `App.tsx` (main view crossfade/slide), `Sidebar.tsx` (tab crossfade), `LoreWall.tsx` (grid↔detail push), `AiPanel.tsx` (task/instruction config crossfade, `mode="wait"` keyed by selected task).
- **Overlay enter *and* exit** — `AiDrawer.tsx` (drawer slide-over), `CommandPalette.tsx` (search palette), `SettingsModal.tsx` (settings). Each pairs with `<AnimatePresence>` so dismissal animates instead of snapping; the old mount-only CSS `animation:` on those `.backdrop`/`.overlay`/`.drawer`/`.palette`/`.modal` classes was removed in favor of these.

Presets live in `src/lib/motion.ts` (`springScreen`/`springPanel`/`springDrawer`, `viewSlide`, `pushForward`/`pushBackdrop`, `panelFade`, `overlayFade`, `drawerSlide`, `modalPop`, `fillLayer`). `<MotionConfig reducedMotion="user">` at the app root keeps every transition honoring `prefers-reduced-motion` — keep it there. Do **not** spread Motion into buttons, hovers, list items, or other element-level motion; those remain pure CSS keyframes. New modals that don't need a custom exit can still use the plain `scaleIn`/`fadeIn` keyframes.

**Theme (light/dark) crossfade** is *not* Motion — it uses the native **View Transitions API** (`document.startViewTransition`) in `appStore.applyThemeAnimated`, so the whole UI cross-dissolves on a theme flip (CSS vars change instantly, so only a full-page snapshot can crossfade everything). Timing is tuned via `::view-transition-old/new(root)` in `global.css`; it no-ops on webviews without the API and is skipped under `prefers-reduced-motion`.
