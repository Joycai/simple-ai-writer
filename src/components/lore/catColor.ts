/**
 * Per-category accent color (设计稿 03 分类六色), shared by the card wall, the
 * detail breadcrumb and any other lore surface that shows a category dot.
 *
 * The novel built-ins map onto the --lore-cat-* tokens; ids from other
 * profiles (TTRPG npcs/locations, …) hash into the same palette so a
 * category keeps one color across renders and sessions without a
 * per-profile table. Two categories can share a color — acceptable for a
 * 6px dot that always sits next to its text label.
 */
const CAT_COLOR: Record<string, string> = {
  characters: "var(--lore-cat-character)",
  world:      "var(--lore-cat-location)",
  items:      "var(--lore-cat-item)",
  events:     "var(--lore-cat-event)",
  factions:   "var(--lore-cat-faction)",
  skills:     "var(--lore-cat-concept)",
  style:      "#A78BBA",
  custom:     "var(--color-text-muted)",
};

const CAT_PALETTE = Object.values(CAT_COLOR);

export function categoryColor(id: string): string {
  const override = CAT_COLOR[id];
  if (override) return override;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return CAT_PALETTE[Math.abs(h) % CAT_PALETTE.length];
}
