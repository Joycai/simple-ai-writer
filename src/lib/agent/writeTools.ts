/**
 * L1 ("write-auto") tool handlers: lore + story-memory writes.
 *
 * Policy (docs/feature/agent/unified-agent-plan.md §3.2): these writes apply automatically
 * but every overwrite is preceded by a backup into `.ai-writer/backups/`
 * (backup.ts), and each handler validates the model's payload against the
 * file's structural contract before touching disk — a malformed write comes
 * back as an error the model can read and correct, never a broken file:
 *
 *   - index.md must keep parseable frontmatter with a `name`, and may not
 *     change the entity's category (folder moves are an app-level operation)
 *   - a file that is currently a facet must stay a parseable facet, or the
 *     write is rejected (silently deactivating injection would be data loss)
 *   - images.md is refused outright — the gallery format is app-managed
 *   - memory updates go through rewriteMemorySegment, which preserves the
 *     segment ranges/hash protocol and only swaps summary text
 *
 * Direct manuscript edits are deliberately absent from the L1 tier: those are
 * L2 and go through the propose→diff→approve flow (`write/manuscript.ts`).
 *
 * The handlers live in `lib/agent/write/`, one module per former section
 * (docs/feature/code-structure-plan.md P6): `planGate` · `loreFiles` ·
 * `loreAssets` · `memory` · `manuscript`, with `shared` under them. This file
 * only re-exports, so the tool table and the other modules keep importing
 * from here.
 */

export * from "./write/planGate";
export * from "./write/loreFiles";
export * from "./write/loreAssets";
export * from "./write/memory";
export * from "./write/manuscript";
