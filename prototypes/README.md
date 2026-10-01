# Manuscript Design Studio

A local React workspace for designing Simple AI Writer before changing its
production UI. It uses the existing pnpm installation; there is no second
package or dependency lockfile.

```bash
pnpm prototypes:dev     # http://127.0.0.1:1430
pnpm prototypes:check   # strict TypeScript check
pnpm prototypes:build   # standalone site in prototypes/dist/
pnpm prototypes:preview # serve the built site on :1430
```

## Initial review surfaces

- `/#overview`: the library index and the visual principles.
- `/#foundations`: palette, type, spacing, and searchable live token values.
- `/#components`: buttons, inputs, selection, a square switch, the app's actual
  Select and Slider, and a protected-change specimen.
- `/#workspace`: documents, editable text, preview/split modes, knowledge-base
  summaries, a fictional assistant proposal, explicit approval, dismissal,
  undo, and empty/read-error scenarios.

All six built-in appearances can be selected from the toolbar. Reset demo
state resets the current page's controls; reloading resets the whole studio.
Hash routes can be shared as review links. Browser back/forward changes pages.

## One design system

The normative rules remain in
[docs/reference/design-system.md](../docs/reference/design-system.md).
The studio imports the app's `tokens.css` through `global.css`, its bundled
fonts, its generated token contract, and its theme attribute writer. It does
not copy token values or change them. The token inspector reads names from
the contract and values from the active document's computed style.

Prototype-specific CSS is layout for this review environment, not a new
production component library. Select and Slider are reused directly; the
workspace shell, textarea editor, proposal card, and other specimens are
simplified designs. They do not claim implementation parity with the app.

## Safe review data

Fixtures are fictional and edits live in React state. There is no app boot,
Tauri IPC, database, preference persistence, provider request, filesystem
mutation, or credentials. The proposal replaces the opening with a fixed demo
suggestion; the prompt is not sent to a model. An edited document invalidates
a pending proposal, and undo is offered only while the applied text is still
current. No project files are touched.

The responsive studio can be viewed in a browser at small widths. Its stacked
mobile demo is a review convenience, not a proposed change to the desktop app's
minimum window size. At desktop widths the workspace follows the four-region
Manuscript layout.

## Extending it

Read [AGENTS.md](AGENTS.md), then the relevant design-system and subsystem
documents. Add a fixture-driven screen under `src/`, register a hash route in
`Studio.tsx`, and record the brief, states, and decisions in the corresponding
`docs/feature/` dossier. Compare it visually in light/dark appearances and at
900px and 1440px browser widths; exercise keyboard focus and reduced motion.

Approve a design before porting it into production components. Document the
intentional differences when it lands. Existing Claude Design briefs remain
historical references; starting this studio does not rewrite them.

`pnpm build` builds both the app and this studio, so the existing frontend CI
gate also type-checks and bundles prototypes. Its output stays separate in
`prototypes/dist/`; Tauri still packages only the app's root `dist/`.
