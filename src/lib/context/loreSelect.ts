/**
 * Layered lore selection — the facet-aware replacement for the old
 * "load index.md and hard-truncate" injection path.
 *
 * Selection runs in three layers under a single char budget:
 *   L0 summary — one-liner from frontmatter; every matched entity gets it
 *                (guaranteed even over budget: it's the floor, not a filler)
 *   L1 core    — index.md body, paragraph-boundary truncated to fit
 *   L2 facets  — sibling md files with `facet` frontmatter, activated by
 *                secondary keys (AND with the entity match), deduplicated
 *                through per-entity mutual-exclusion groups, then budget-
 *                filled whole — a facet never gets truncated, it either
 *                fits entirely or is dropped with a reported reason.
 *
 * Every decision (matched keys, group winners, drops) is captured in a
 * LoreActivationReport so the UI can show *why* something was or wasn't
 * injected — the author's main feedback loop for tuning facet keys.
 *
 * Facet/core content is re-read from disk on every call rather than cached
 * at scan time, so hand edits are never served stale. Facet *metadata*
 * (keys/group/priority/mode) comes from the scan (entity.facets) and
 * refreshes on the next rescan.
 */

import { readFile } from "../fs/fileio";
import { parseFrontmatter } from "../fs/markdown";
import type { LoreEntity, LoreFacet, LoreIndex } from "../lore";

/** Default total budget for the 【设定资料】 block: ~600 tokens ≈ 1800 chars. */
export const DEFAULT_LORE_BUDGET_CHARS = 600 * 3;

/** Max auto-matched entities (manual pins don't count against this). */
export const MAX_AUTO_LORE_ENTITIES = 5;

// ─── Pin format ───────────────────────────────────────────────────────────────

/**
 * A pin either references a whole entity ("<dirPath>") or a single facet
 * ("<dirPath>#<file>"). Facet pins imply their entity: summary + core ride
 * along so the facet is never injected without its subject.
 */
export interface LorePin {
  dirPath: string;
  facetFile: string | null;
}

/** Parse persisted pin strings (backwards compatible with bare dirPaths). */
export function parsePins(paths: string[]): LorePin[] {
  return paths.map((p) => {
    const hash = p.lastIndexOf("#");
    if (hash > 0 && hash < p.length - 1) {
      return { dirPath: p.slice(0, hash), facetFile: p.slice(hash + 1) };
    }
    return { dirPath: p, facetFile: null };
  });
}

// ─── Activation report ────────────────────────────────────────────────────────

export interface LoreLayerReport {
  kind: "summary" | "core" | "facet";
  /** Facet title (facet layers only). */
  title?: string;
  /** Facet filename (facet layers only). */
  file?: string;
  /** Chars actually injected. */
  chars: number;
  /** Keys that fired (auto-activated facets only). */
  matchedKeys?: string[];
  /** True when this layer was forced by a pin. */
  pinned?: boolean;
  /** True when the core was paragraph-truncated to fit the budget. */
  truncated?: boolean;
}

export type FacetDropReason = "no-key" | "group-lost" | "budget" | "manual-only";

export interface LoreEntityReport {
  name: string;
  dirPath: string;
  reason: "auto" | "pinned";
  layers: LoreLayerReport[];
  droppedFacets: { file: string; title: string; reason: FacetDropReason }[];
}

export interface LoreActivationReport {
  entities: LoreEntityReport[];
  budgetChars: number;
  usedChars: number;
}

export interface LoreSelection {
  /** Assembled 【设定资料】 content ("" when nothing activated). */
  text: string;
  report: LoreActivationReport;
}

// ─── Selection ────────────────────────────────────────────────────────────────

interface Selected {
  entity: LoreEntity;
  reason: "auto" | "pinned";
  pinnedFacets: Set<string>;
  summaryLine: string;
  coreText: string;
  coreTruncated: boolean;
  facetBlocks: { facet: LoreFacet; text: string; matchedKeys: string[]; pinned: boolean }[];
  report: LoreEntityReport;
}

/**
 * Select and assemble lore for one AI task.
 *
 * @param matchTarget  Text to match against (selection + recent tail)
 * @param loreIndex    Full lore index from loreStore
 * @param pinPaths     Persisted pin strings (dirPath or dirPath#facetFile)
 * @param budgetChars  Total char budget for the assembled block
 */
export async function selectLore(
  matchTarget: string,
  loreIndex: LoreIndex,
  pinPaths: string[],
  budgetChars: number = DEFAULT_LORE_BUDGET_CHARS,
): Promise<LoreSelection> {
  const lower = matchTarget.toLowerCase();

  // Index entities by dirPath for pin resolution.
  const byDir = new Map<string, LoreEntity>();
  for (const entities of Object.values(loreIndex)) {
    for (const e of entities ?? []) byDir.set(e.dirPath, e);
  }

  // Resolve pins: order-preserving, deduped; stale dirPaths are skipped
  // (matches the old behavior where a missing index.md read yielded "").
  const pins = parsePins(pinPaths);
  const pinnedFacetsByDir = new Map<string, Set<string>>();
  const pinnedDirs: string[] = [];
  for (const pin of pins) {
    if (!byDir.has(pin.dirPath)) continue;
    if (!pinnedFacetsByDir.has(pin.dirPath)) {
      pinnedFacetsByDir.set(pin.dirPath, new Set());
      pinnedDirs.push(pin.dirPath);
    }
    if (pin.facetFile) pinnedFacetsByDir.get(pin.dirPath)!.add(pin.facetFile);
  }

  // Auto-match entities by name/alias substring (CJK-friendly), capped.
  const autoDirs: string[] = [];
  outer: for (const entities of Object.values(loreIndex)) {
    for (const entity of entities ?? []) {
      if (pinnedFacetsByDir.has(entity.dirPath)) continue; // already pinned
      const terms = [entity.name, ...(entity.aliases ?? [])];
      if (terms.some((t) => t && lower.includes(t.toLowerCase()))) {
        autoDirs.push(entity.dirPath);
        if (autoDirs.length >= MAX_AUTO_LORE_ENTITIES) break outer;
      }
    }
  }

  const selected: Selected[] = [...pinnedDirs, ...autoDirs].map((dir) => {
    const entity = byDir.get(dir)!;
    const reason: "auto" | "pinned" = pinnedFacetsByDir.has(dir) ? "pinned" : "auto";
    return {
      entity,
      reason,
      pinnedFacets: pinnedFacetsByDir.get(dir) ?? new Set(),
      summaryLine: "",
      coreText: "",
      coreTruncated: false,
      facetBlocks: [],
      report: { name: entity.name, dirPath: dir, reason, layers: [], droppedFacets: [] },
    };
  });

  let used = 0;
  const fits = (len: number) => used + len <= budgetChars;

  // ── L0: summaries + headers. Guaranteed for every matched entity — they are
  // the floor the layering stands on, so they count against but ignore the cap.
  for (const s of selected) {
    used += `## ${s.entity.name}`.length + 1;
    const summary = (s.entity.summary ?? "").trim();
    if (summary) {
      s.summaryLine = `> ${summary}`;
      used += s.summaryLine.length + 1;
      s.report.layers.push({ kind: "summary", chars: summary.length });
    }
  }

  // ── L1: cores, paragraph-boundary truncated to fit the remaining budget.
  for (const s of selected) {
    const body = await readEntityBody(s.entity.dirPath);
    if (!body) continue;
    if (fits(body.length)) {
      s.coreText = body;
    } else {
      const paras = body.split(/\n{2,}/);
      const kept: string[] = [];
      let len = 0;
      for (const p of paras) {
        if (!fits(len + p.length + 2)) break;
        kept.push(p);
        len += p.length + 2;
      }
      if (kept.length === 0) continue; // no room at all — core omitted
      s.coreText = kept.join("\n\n");
      s.coreTruncated = true;
    }
    used += s.coreText.length + 1;
    s.report.layers.push({ kind: "core", chars: s.coreText.length, truncated: s.coreTruncated || undefined });
  }

  // ── L2: facets. Per entity: activate → resolve groups → collect candidates;
  // then fill the remaining budget globally (pinned first, then priority).
  interface Candidate {
    sel: Selected;
    facet: LoreFacet;
    matchedKeys: string[];
    pinned: boolean;
    entityIdx: number;
  }
  const candidates: Candidate[] = [];

  selected.forEach((s, entityIdx) => {
    const active: Candidate[] = [];
    for (const facet of s.entity.facets ?? []) {
      const pinned = s.pinnedFacets.has(facet.file);
      if (pinned) {
        active.push({ sel: s, facet, matchedKeys: [], pinned: true, entityIdx });
        continue;
      }
      if (facet.mode === "manual") {
        s.report.droppedFacets.push({ file: facet.file, title: facet.title, reason: "manual-only" });
        continue;
      }
      if (facet.mode === "always") {
        active.push({ sel: s, facet, matchedKeys: [], pinned: false, entityIdx });
        continue;
      }
      const matchedKeys = facet.keys.filter((k) => k && lower.includes(k.toLowerCase()));
      if (matchedKeys.length > 0) {
        active.push({ sel: s, facet, matchedKeys, pinned: false, entityIdx });
      } else {
        s.report.droppedFacets.push({ file: facet.file, title: facet.title, reason: "no-key" });
      }
    }

    // Mutual exclusion within each named group: pinned facets always survive
    // (pinning two same-group facets injects both — deliberate override for
    // e.g. mid-scene outfit changes); otherwise the highest priority wins,
    // ties broken by filename for determinism.
    const byGroup = new Map<string, Candidate[]>();
    for (const c of active) {
      if (!c.facet.group) {
        candidates.push(c);
        continue;
      }
      if (!byGroup.has(c.facet.group)) byGroup.set(c.facet.group, []);
      byGroup.get(c.facet.group)!.push(c);
    }
    for (const members of byGroup.values()) {
      const pinnedMembers = members.filter((m) => m.pinned);
      const winners = pinnedMembers.length > 0
        ? pinnedMembers
        : [members.slice().sort((a, b) =>
            b.facet.priority - a.facet.priority || a.facet.file.localeCompare(b.facet.file))[0]];
      for (const m of members) {
        if (winners.includes(m)) {
          candidates.push(m);
        } else {
          m.sel.report.droppedFacets.push({ file: m.facet.file, title: m.facet.title, reason: "group-lost" });
        }
      }
    }
  });

  // Budget fill: pinned before auto, then entity order, then priority.
  candidates.sort((a, b) =>
    Number(b.pinned) - Number(a.pinned) ||
    a.entityIdx - b.entityIdx ||
    b.facet.priority - a.facet.priority ||
    a.facet.file.localeCompare(b.facet.file));

  for (const c of candidates) {
    const content = await readFacetBody(c.sel.entity.dirPath, c.facet.file);
    if (!content) continue;
    const block = `### ${c.facet.title}\n${content}`;
    if (!fits(block.length + 2)) {
      c.sel.report.droppedFacets.push({ file: c.facet.file, title: c.facet.title, reason: "budget" });
      continue;
    }
    used += block.length + 2;
    c.sel.facetBlocks.push({ facet: c.facet, text: block, matchedKeys: c.matchedKeys, pinned: c.pinned });
    c.sel.report.layers.push({
      kind: "facet",
      title: c.facet.title,
      file: c.facet.file,
      chars: content.length,
      matchedKeys: c.matchedKeys.length ? c.matchedKeys : undefined,
      pinned: c.pinned || undefined,
    });
  }

  // ── Assemble. Entities that ended up with no content at all (unreadable
  // index.md, no facets) are omitted from the text but stay in the report.
  const blocks: string[] = [];
  for (const s of selected) {
    const parts = [`## ${s.entity.name}`];
    if (s.summaryLine) parts.push(s.summaryLine);
    if (s.coreText) parts.push(s.coreText);
    for (const fb of s.facetBlocks) parts.push(fb.text);
    if (parts.length > 1) blocks.push(parts.join("\n"));
  }

  return {
    text: blocks.join("\n\n---\n\n"),
    report: {
      entities: selected.map((s) => s.report),
      budgetChars,
      usedChars: used,
    },
  };
}

/** Read index.md body (frontmatter stripped); "" when missing/unreadable. */
async function readEntityBody(dirPath: string): Promise<string> {
  try {
    const raw = await readFile(`${dirPath}/index.md`);
    return parseFrontmatter(raw).content.trim();
  } catch {
    return "";
  }
}

/** Read a facet file's body (frontmatter stripped); "" when missing. */
async function readFacetBody(dirPath: string, file: string): Promise<string> {
  try {
    const raw = await readFile(`${dirPath}/${file}`);
    return parseFrontmatter(raw).content.trim();
  } catch {
    return "";
  }
}
