/**
 * Layered lore selection — the facet-aware replacement for the old
 * "load index.md and hard-truncate" injection path.
 *
 * Selection runs in three layers under a single char budget:
 *   L0 summary — one-liner from frontmatter; every matched entity gets it
 *                (guaranteed even over budget: it's the floor, not a filler)
 *   L0.5 gallery — one bounded line naming the entity's pictures and what each
 *                one shows; never the pictures themselves (see galleryNotice)
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
 * Two of the caller's options say "this is already in the conversation, don't
 * send it twice", at the two granularities that exist: `coreDone` for an
 * entity's summary + gallery + core, `excludeFacets` for one facet. Neither
 * removes the entity from selection — it still matches, still activates facets,
 * still reports. That separation is what lets a roleplay agent keep its own
 * entry permanently in the system layer while its facets keep arriving turn by
 * turn (docs/feature/roleplay/11-lore-binding-lld.md).
 *
 * Facet/core content is re-read from disk on every call rather than cached
 * at scan time, so hand edits are never served stale. Facet *metadata*
 * (keys/group/priority/mode) comes from the scan (entity.facets) and
 * refreshes on the next rescan.
 */

import i18n from "../../i18n";
import { FALLBACK_CHARS_PER_TOKEN } from "./budget";
import { readFile } from "../fs/fileio";
import { parseFrontmatter } from "../fs/markdown";
import { inScope, type LoreEntity, type LoreFacet, type LoreIndex, type LoreScope } from "../lore";

/**
 * Default total budget for the 【设定资料】 block, used only when no caller
 * passes a planned budget. Converted with the *same* conservative ratio the
 * budget planner falls back to, so the codebase has exactly one token↔char rule
 * — an optimistic local constant here would silently plan a block the pre-flight
 * check then rejects. See lib/context/budget.
 */
export const DEFAULT_LORE_BUDGET_CHARS = 600 * FALLBACK_CHARS_PER_TOKEN;

/**
 * Max auto-matched entities (manual pins don't count against this). A loose cap:
 * the char budget is the real limiter, this only stops a pathological match
 * (a common alias hitting half the index) from flooding the L0 floor.
 */
export const MAX_AUTO_LORE_ENTITIES = 20;

/**
 * Share of the whole budget the gallery notices may take **together**. A notice
 * is bounded per entity, but a match that fires on twenty entities is not: at
 * 180 chars each they would fill a default budget on their own and every core
 * would be starved by metadata. Past the cap the remaining notices are dropped
 * and reported, exactly like a facet that didn't fit.
 */
export const GALLERY_BUDGET_SHARE = 0.2;

/** Ceiling for one entity's gallery notice, including its label. */
const GALLERY_ENTITY_CHARS = 180;

/** Ceiling for one picture's description inside the notice. */
const GALLERY_DESC_CHARS = 48;

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

/**
 * The one spelling of "this facet, of this entity" — the key `excludeFacets`
 * takes and the injection ledger stores. Same shape as a facet pin, on purpose:
 * one string format for "a facet, named from outside the entity".
 */
export function facetKey(dirPath: string, file: string): string {
  return `${dirPath}#${file}`;
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
  kind: "summary" | "core" | "facet" | "gallery";
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
  /** Pictures the entity has (gallery layers only) — listed or not. */
  count?: number;
}

/**
 * Why a facet the entity owns did not get injected.
 *
 * `resident` is not a failure: the facet is already in the conversation on a
 * layer that persists (a roleplay agent's bound block, an earlier turn that has
 * not been folded), so sending it again would be a duplicate. It is reported
 * beside the real drops because the author's question is the same one — "why is
 * this not in there?" — and "it already is" has to be an answer the UI can give.
 */
export type FacetDropReason = "no-key" | "group-lost" | "budget" | "manual-only" | "resident";

export interface LoreEntityReport {
  name: string;
  /** Frontmatter aliases, joined — the other names this entity answers to.
   *  Shown beside the name so an entry indexed under a translation or a
   *  nickname is recognisable in the injection report. "" when it has none. */
  aliases: string;
  dirPath: string;
  reason: "auto" | "pinned";
  /**
   * The entity's summary + core were already in context, so this selection
   * contributed facets only (see `coreDone`). Without this flag the report
   * reads as "matched, injected nothing" — the one reading that is wrong.
   */
  coreResident?: boolean;
  layers: LoreLayerReport[];
  droppedFacets: { file: string; title: string; reason: FacetDropReason }[];
  /** Pictures this entity has when its gallery notice didn't fit the budget. */
  droppedImages?: number;
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

// ─── Gallery notice ───────────────────────────────────────────────────────────

/**
 * i18n with the Chinese wording as the built-in fallback (see docFocus).
 *
 * Its own namespace, not `ai.instructions.lore.*` — that path is already the
 * lore *generator's* system prompt (a string), and a sibling object there would
 * be a duplicate JSON key silently shadowing it.
 */
function loreWord(key: string, fallback: string): string {
  return i18n.t(`ai.instructions.galleryNotice.${key}`, { defaultValue: fallback });
}

/** First line of a description, whitespace-collapsed and cut to fit. */
function briefDesc(desc: string): string {
  const line = desc.replace(/\s+/g, " ").trim();
  if (line.length <= GALLERY_DESC_CHARS) return line;
  return `${line.slice(0, GALLERY_DESC_CHARS).trimEnd()}…`;
}

/**
 * One line naming an entity's pictures and what each one shows:
 *
 *     配图：avatar.png（头像）· portrait.png（银发，黑色立领窄袖…）
 *
 * **Words, never pixels.** Encoding a gallery into the injected block would put
 * megabytes of base64 on every request that merely *mentions* a character, for
 * a picture the task may not need at all — the same cost `read_lore_entity`
 * refuses to pay (lib/agent/tools). What the line carries instead is the two
 * things a model cannot otherwise obtain: that the pictures exist, and the
 * filenames `read_lore_image` takes. The descriptions do double duty — they are
 * the only visual detail a text-only model will ever get, and for a multimodal
 * one they are what makes "is this picture worth looking at?" answerable before
 * paying for it.
 *
 * The **slot** is deliberately left out. A category's image slots are authoring
 * metadata (docs/feature/lore/lore-entry-type-plan.md: slots never reach the injection path),
 * and an id whose pack is currently disabled would inject a word that means
 * nothing to the model.
 *
 * Bounded on both axes — per description and per entity — because this is a
 * pointer, not content: a gallery of thirty stills must not be able to outweigh
 * the entity's own prose.
 */
export function galleryNotice(entity: LoreEntity): { text: string; count: number } {
  const items: { file: string; desc: string }[] = [];
  const avatar = entity.avatarPath?.split(/[\\/]/).pop();
  if (avatar) items.push({ file: avatar, desc: loreWord("avatar", "头像") });
  for (const img of entity.images ?? []) items.push({ file: img.file, desc: img.desc ?? "" });
  if (items.length === 0) return { text: "", count: 0 };

  const label = loreWord("label", "配图");
  const parts: string[] = [];
  let len = label.length + 1;
  for (const item of items) {
    const snippet = briefDesc(item.desc);
    const piece = snippet ? `${item.file}（${snippet}）` : item.file;
    const cost = piece.length + (parts.length > 0 ? 3 : 0);
    // The first picture always goes in: a notice listing none of them would
    // spend chars saying nothing.
    if (parts.length > 0 && len + cost > GALLERY_ENTITY_CHARS) break;
    parts.push(piece);
    len += cost;
  }
  const rest = items.length - parts.length;
  const more = rest > 0
    ? ` ${i18n.t("ai.instructions.galleryNotice.more", { defaultValue: "（另有 {{n}} 张）", n: rest })}`
    : "";
  return { text: `${label}：${parts.join(" · ")}${more}`, count: items.length };
}

// ─── Selection ────────────────────────────────────────────────────────────────

interface Selected {
  entity: LoreEntity;
  reason: "auto" | "pinned";
  /** Summary + gallery + core are already in context; only facets may be added. */
  coreResident: boolean;
  /** Whether `## Name` has been charged against the budget yet. */
  headerCharged: boolean;
  pinnedFacets: Set<string>;
  summaryLine: string;
  galleryLine: string;
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
 * @param opts.excludeDirs  Entity dirs to skip during *auto*-matching — the
 *                     whole entity, every layer. Pins are exempt: an explicit
 *                     pin is the author insisting.
 * @param opts.coreDone  Entity dirs whose summary + gallery + core are already
 *                     in the conversation on a layer that persists. They skip
 *                     L0/L0.5/L1 and contribute **facets only** — the entity
 *                     still matches, still activates facets, still counts as
 *                     selected. This is the difference between "the model has
 *                     already been told who this is" and "do not mention this
 *                     entity", which `excludeDirs` cannot tell apart.
 * @param opts.excludeFacets  `dirPath#facetFile` keys ({@link facetKey}) whose
 *                     text is already in the conversation. Such a facet is
 *                     treated as **activated and holding its mutual-exclusion
 *                     group** — it just contributes no text. A pinned facet is
 *                     exempt, same rule as `excludeDirs`.
 * @param opts.scope   The author's 取材范围 — a collection name, or null for
 *                     the whole knowledge base (lib/lore/collections). Like
 *                     `excludeDirs` it narrows **auto-matching only**: an entry
 *                     the author pinned is injected whether or not it is filed
 *                     in the active collection, because the fence exists to
 *                     stop the wrong material drifting in on its own, not to
 *                     overrule a deliberate act.
 */
export async function selectLore(
  matchTarget: string,
  loreIndex: LoreIndex,
  pinPaths: string[],
  budgetChars: number = DEFAULT_LORE_BUDGET_CHARS,
  opts?: {
    excludeDirs?: ReadonlySet<string>;
    coreDone?: ReadonlySet<string>;
    excludeFacets?: ReadonlySet<string>;
    scope?: LoreScope;
  },
): Promise<LoreSelection> {
  const lower = matchTarget.toLowerCase();
  const coreDone = opts?.coreDone;
  const residentFacets = opts?.excludeFacets;

  // Index entities by dirPath for pin resolution.
  const byDir = new Map<string, LoreEntity>();
  for (const entities of Object.values(loreIndex)) {
    for (const e of entities ?? []) byDir.set(e.dirPath, e);
  }

  // Resolve pins: order-preserving, deduped. Resolution is index-aware:
  // a raw string that matches an existing entity dirPath verbatim is a bare
  // entity pin even if it contains '#' (paths may legally contain '#'); only
  // otherwise is it split as "dirPath#facetFile". Stale pins are skipped
  // entirely — including facet pins whose facet file no longer exists, which
  // must NOT degrade into an invisible whole-entity pin.
  const pinnedFacetsByDir = new Map<string, Set<string>>();
  const pinnedDirs: string[] = [];
  const registerDir = (dirPath: string) => {
    if (!pinnedFacetsByDir.has(dirPath)) {
      pinnedFacetsByDir.set(dirPath, new Set());
      pinnedDirs.push(dirPath);
    }
  };
  for (const raw of pinPaths) {
    if (byDir.has(raw)) {
      registerDir(raw);
      continue;
    }
    const [pin] = parsePins([raw]);
    if (!pin.facetFile) continue; // bare pin to a deleted entity — stale
    const entity = byDir.get(pin.dirPath);
    if (!entity || !(entity.facets ?? []).some((f) => f.file === pin.facetFile)) {
      continue; // facet pin whose entity or facet is gone — stale
    }
    registerDir(pin.dirPath);
    pinnedFacetsByDir.get(pin.dirPath)!.add(pin.facetFile);
  }

  // Auto-match entities by name/alias substring (CJK-friendly), capped.
  const autoDirs: string[] = [];
  outer: for (const entities of Object.values(loreIndex)) {
    for (const entity of entities ?? []) {
      if (pinnedFacetsByDir.has(entity.dirPath)) continue; // already pinned
      if (opts?.excludeDirs?.has(entity.dirPath)) continue; // already in context
      if (!inScope(entity, opts?.scope ?? null)) continue;  // outside 取材范围
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
    const coreResident = coreDone?.has(dir) ?? false;
    return {
      entity,
      reason,
      coreResident,
      headerCharged: false,
      pinnedFacets: pinnedFacetsByDir.get(dir) ?? new Set(),
      summaryLine: "",
      galleryLine: "",
      coreText: "",
      coreTruncated: false,
      facetBlocks: [],
      report: {
        name: entity.name,
        aliases: (entity.aliases ?? []).join(" · "),
        dirPath: dir,
        reason,
        ...(coreResident ? { coreResident: true } : {}),
        layers: [],
        droppedFacets: [],
      },
    };
  });

  let used = 0;
  const fits = (len: number) => used + len <= budgetChars;
  const headerCost = (e: LoreEntity) => `## ${e.name}`.length + 1;

  // ── L0: summaries + headers. Guaranteed for every matched entity — they are
  // the floor the layering stands on, so they count against but ignore the cap.
  //
  // A core-resident entity is charged for **nothing** here, its header included:
  // it may well contribute no block at all this turn, and twenty resident
  // entities paying for headers of blocks that are never emitted would eat a
  // default budget between them. Its header is charged in the fill loop below,
  // on the first facet that actually survives.
  for (const s of selected) {
    if (s.coreResident) continue;
    s.headerCharged = true;
    used += headerCost(s.entity);
    const summary = (s.entity.summary ?? "").trim();
    if (summary) {
      s.summaryLine = `> ${summary}`;
      used += s.summaryLine.length + 1;
      s.report.layers.push({ kind: "summary", chars: summary.length });
    }
  }

  // ── L0.5: gallery notices. Filled *before* the cores, not after the facets,
  // because the entities this matters for are exactly the ones whose prose is
  // long enough to eat the budget: run last, the notice would be missing from
  // every well-written entry and present only on stubs. A core is truncatable
  // by design and pays at most a paragraph for it; the notice is not divisible
  // and is worth more than that paragraph, since it is the only thing that
  // makes the pictures reachable at all.
  const galleryCap = Math.floor(budgetChars * GALLERY_BUDGET_SHARE);
  let galleryUsed = 0;
  for (const s of selected) {
    // The notice rides with the core: it is entity-level metadata, and a
    // core-resident entity was given it when the core went in. Repeating it
    // would spend the gallery share on a line the model already has.
    if (s.coreResident) continue;
    const { text, count } = galleryNotice(s.entity);
    if (count === 0) continue;
    const cost = text.length + 1;
    if (galleryUsed + cost > galleryCap || !fits(cost)) {
      s.report.droppedImages = count;
      continue;
    }
    s.galleryLine = text;
    galleryUsed += cost;
    used += cost;
    s.report.layers.push({ kind: "gallery", chars: text.length, count });
  }

  // ── L1: cores, paragraph-boundary truncated to fit the remaining budget.
  // Skipped entirely for a core-resident entity — that is what `coreDone` is.
  for (const s of selected) {
    if (s.coreResident) continue;
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
    /** Already in the conversation: holds its group, contributes no text. */
    resident: boolean;
    entityIdx: number;
  }
  const candidates: Candidate[] = [];

  selected.forEach((s, entityIdx) => {
    const active: Candidate[] = [];
    for (const facet of s.entity.facets ?? []) {
      const pinned = s.pinnedFacets.has(facet.file);
      if (pinned) {
        active.push({ sel: s, facet, matchedKeys: [], pinned: true, resident: false, entityIdx });
        continue;
      }
      // Resident is checked before mode and keys, deliberately. The facet IS in
      // the conversation, so its group slot is taken whether or not this turn's
      // words would have activated it — test the keys first and on a turn the
      // resident facet doesn't match, the group's runner-up walks in and the
      // model reads two outfits for one character.
      if (residentFacets?.has(facetKey(s.entity.dirPath, facet.file))) {
        active.push({ sel: s, facet, matchedKeys: [], pinned: false, resident: true, entityIdx });
        continue;
      }
      if (facet.mode === "manual") {
        s.report.droppedFacets.push({ file: facet.file, title: facet.title, reason: "manual-only" });
        continue;
      }
      if (facet.mode === "always") {
        active.push({ sel: s, facet, matchedKeys: [], pinned: false, resident: false, entityIdx });
        continue;
      }
      const matchedKeys = facet.keys.filter((k) => k && lower.includes(k.toLowerCase()));
      if (matchedKeys.length > 0) {
        active.push({ sel: s, facet, matchedKeys, pinned: false, resident: false, entityIdx });
      } else {
        s.report.droppedFacets.push({ file: facet.file, title: facet.title, reason: "no-key" });
      }
    }

    // A winner either goes to the budget fill or, if it is already in the
    // conversation, is reported and contributes nothing. Both count as "this
    // group is served" — which is the whole point of letting a resident facet
    // compete at all.
    const take = (c: Candidate) => {
      if (c.resident) {
        c.sel.report.droppedFacets.push({ file: c.facet.file, title: c.facet.title, reason: "resident" });
      } else {
        candidates.push(c);
      }
    };

    // Mutual exclusion within each named group: pinned facets always survive
    // (pinning two same-group facets injects both — deliberate override for
    // e.g. mid-scene outfit changes); then a resident member, which occupies
    // the slot it already fills; otherwise the highest priority wins, ties
    // broken by filename for determinism.
    const byGroup = new Map<string, Candidate[]>();
    for (const c of active) {
      if (!c.facet.group) {
        take(c);
        continue;
      }
      if (!byGroup.has(c.facet.group)) byGroup.set(c.facet.group, []);
      byGroup.get(c.facet.group)!.push(c);
    }
    for (const members of byGroup.values()) {
      const pinnedMembers = members.filter((m) => m.pinned);
      const residentMembers = members.filter((m) => m.resident);
      const winners = pinnedMembers.length > 0
        ? pinnedMembers
        : residentMembers.length > 0
          ? residentMembers
          : [members.slice().sort((a, b) =>
              b.facet.priority - a.facet.priority || a.facet.file.localeCompare(b.facet.file))[0]];
      for (const m of members) {
        if (winners.includes(m)) {
          take(m);
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
    // The header a core-resident entity did not pay for in L0 — charged here,
    // once, on the first of its facets that actually fits.
    const header = c.sel.headerCharged ? 0 : headerCost(c.sel.entity);
    if (!fits(block.length + 2 + header)) {
      c.sel.report.droppedFacets.push({ file: c.facet.file, title: c.facet.title, reason: "budget" });
      continue;
    }
    used += block.length + 2 + header;
    c.sel.headerCharged = true;
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
    // Above the core rather than under the last facet: the notice is about the
    // entity, and a trailing line reads as part of whatever block precedes it.
    if (s.galleryLine) parts.push(s.galleryLine);
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
