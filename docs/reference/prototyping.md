# Local UX/UI prototyping

> Status: `living`. The review workspace is `prototypes/`, separate from the app.

## Entry point

Run `pnpm prototypes:dev` and open <http://127.0.0.1:1430>. The
[studio README](../../prototypes/README.md) lists the screens, interactions,
commands, limitations, and extension steps. `pnpm prototypes:preview` serves
the standalone build from `prototypes/dist/`.

## Source of truth

[design-system.md](design-system.md) is still the normative visual contract.
`src/styles/tokens.css` supplies values; `src/lib/theme/contractData.ts` supplies
the generated token inventory. The studio consumes both, along with the app's
global focus/reduced-motion rules and bundled fonts. It calls `applyThemeId`
from `lib/theme/scheme.ts` for theme changes. It does not establish another
palette or another theme attribute writer.

The component gallery reuses the production Select and Slider. Other samples
and the writing workspace are simplified interactive prototypes, not copies
of every app feature. Sample state never loads author data or contacts AI.

## Design-to-implementation workflow

1. Put a brief in the corresponding `docs/feature/` dossier: user intent,
   constraints, interactions, empty/error/waiting states, and acceptance points.
2. Read the existing design rules and nearby production components. Build a
   fixture-driven prototype under `prototypes/src/` and register its hash route.
3. Review it in the browser: light and dark, narrow and wide, keyboard focus,
   reduced motion, and every action's result. Share the route and screenshots.
4. Have the author approve the design. Then implement it in the app's proper
   components, using real stores, terminology, persistence, and approval gates.
5. Record intentional deviations in the dossier and update living design rules
   only when the approved decision changes them.

The production app still needs `pnpm tauri dev` for native interactions. A
browser prototype is sufficient for layout and simulated flows, not proof of
filesystem, IPC, model, or billing behaviour.

## Initialization decision — 2026-10-01

The author chose local HTML/React prototypes as an alternative to generating
new screens in Claude Design. Historical Claude Design briefs are preserved;
their applicable decisions already live in the design-system reference.
The new studio makes those foundations inspectable and provides a small
interactive baseline for future briefs rather than redesigning the product.

A separate Vite root uses port 1430 to avoid the Tauri development server on
1420, while reusing the root dependencies. Prototype output has its own `dist`
directory, already covered by `.gitignore`. No extra dependencies or app
version change are required. `pnpm build` includes its strict type-check and
bundle so the existing frontend CI gate covers the review code; Tauri's app
output remains the root `dist/`.
