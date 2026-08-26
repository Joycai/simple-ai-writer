/**
 * A ratchet on what the toolset costs every request.
 *
 * This number is not an incidental one. The assistant preset's schemas ride on
 * **every round** of a run — forty of them at the cap — and nothing about
 * adding a tool makes that cost visible in a diff. So it is pinned here: going
 * over means someone decides to, and the decision shows up as an edit to the
 * constant rather than as a slow drift nobody signed off on.
 *
 * Measured against the **whole preset**, before `routeTools` narrows it. The
 * routed set changes with the author's subagent switches and the pptx Beta
 * flag, so ratcheting on it would make flipping a switch look like a
 * regression.
 *
 * If a new tool genuinely belongs in the assistant, raise the cap in the same
 * commit and say why. If several are landing at once, that is the signal to
 * read docs/feature/agent/agent-tool-context-lld.md §5 instead — deferred loading is the
 * answer to "the toolset keeps growing", not a bigger number here.
 */
import { describe, expect, it, vi } from "vitest";

// The registry reaches the Tauri fs at import time through the write tools;
// nothing here executes one. Same mock set as agentToolSchema.test.ts.
vi.mock("../fs/fileio", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => {}),
  appendFile: vi.fn(async () => {}),
  writeBinaryFile: vi.fn(async () => {}),
  makeDir: vi.fn(async () => {}),
  fileExists: vi.fn(async () => false),
  removeDir: vi.fn(async () => {}),
  removeFile: vi.fn(async () => {}),
  renamePath: vi.fn(async () => {}),
  readDir: vi.fn(async () => []),
}));
vi.mock("../project", () => ({ readDirRecursive: vi.fn(async () => []) }));
vi.mock("../../i18n", () => ({ default: { t: (key: string) => key } }));

import { getToolDefinitions, partitionByGroup } from "../agent/registry";
import { AGENT_ASSIST_PRESET, CONTINUE_PRESET } from "../agent/presets";
import { NARRATOR_PRESET, ROLEPLAY_PRESET } from "../roleplay/presets";
import { estimateToolsTokens } from "../ai/tokenEstimate";

/**
 * Measured 9,609 at 1.22.0; 9,743 after read_workflow landed (134 tokens —
 * the price of the workflow-cards feature's second disclosure level, decided
 * in docs/feature/agent/workflow-cards-plan.md §3). Then one review of the
 * agent's tool surface landed in two halves, and both are priced here —
 * **11,388 measured with both in**:
 *   - the knowledge base's gallery tier (update_lore_image /
 *     delete_lore_image / set_lore_avatar / copy_lore_file, the lore review's
 *     F3/F4): ~1.4k tokens, ALL in the deferred `lore_write` group, so a run
 *     pays them only once the author has approved a lore plan — the exact
 *     moment they become callable.
 *   - the file tools (copy_file's `new_name`, and move/copy/delete now stating
 *     their real scope plus the extension and illustration-folder rules):
 *     ~430 tokens of pure wording, bought to stop wrong-tool calls and
 *     broken-image surprises.
 * Measured together rather than added: each half was 11,237 / 10,173 alone,
 * which sums 279 over the truth — the estimator is not linear in description
 * text, so a cap derived by arithmetic would be quietly wrong. Re-measure.
 *
 * 11,790 with `add_lore_image` (+402: ~330 for the tool, ~70 for the sentence
 * on generate_image that points at it). Bought to close a real hole rather
 * than to add a capability: filing a picture the project ALREADY has into an
 * entity's gallery had no tool at all, so the model reached for the one tool
 * whose effect was "a picture ends up in that gallery" — generate_image, which
 * draws a new one and charges for it. A wrong call every time, and the pointer
 * sentence is what stops it recurring.
 *
 * 12,452 after `edit_image` was split in two (+662). One tool named
 * `edit_image` accepted only an entity plus a gallery filename, so every
 * request to change an ordinary project image reached it and was refused with
 * an error about lore galleries — a wrong call every time, like add_lore_image
 * above. The fix is a PAIR (`edit_image` takes a file path,
 * `redraw_lore_image` takes an entry plus a filename) rather than one widened
 * tool, because one tool would have to infer from the source what the author
 * meant, and an inference is a second way to be wrong. Two names cost a second
 * schema (~510) and buy a choice the model can actually check, plus the errors
 * that name the sibling when it picks wrong.
 *
 * The cap is **11,790 measured, 15,000 pinned** — deliberately loose, on the
 * author's call. The tight cap was costing a commit of its own every time a
 * description gained a clarifying sentence, which is the change this file most
 * wants to be cheap: a sentence that stops a wrong call is worth more than the
 * tokens it costs, and making it expensive to write was the wrong incentive.
 *
 * 14,799 with `create_lore_facet` (+691 over the 14,108 measured just before
 * it: ~613 for the tool, ~78 for the sentences on update_lore_file and
 * update_facet_meta that now point at it). All of it deferred — the resident
 * half is unmoved at 9,457 — and bought to close a hole of the same shape as
 * add_lore_image's, only quieter: no tool created a facet, so "split this entry
 * into facets" reached update_lore_file, whose new .md arrives without `facet:`
 * frontmatter, scans as an inert attachment, and is reported back as a
 * successful write. A wrong call every time, with no error to learn from.
 * Note the headroom this leaves: ~200. The next tool to land here should be
 * read against docs/feature/agent/agent-tool-context-lld.md §5 rather than
 * against a bigger number.
 *
 * What the ratchet is still for is the thing it was always for — a NEW TOOL, or
 * a run of them, slipping in unpriced. At 15,000 that signal is weaker, so the
 * measured numbers above matter more, not less: record what you measured when
 * you change this surface, even when the assertion did not fail. If a change
 * pushes past 15,000, do not raise it again by reflex — read
 * docs/feature/agent/agent-tool-context-lld.md §5 first, because at that size
 * deferred loading is the answer and a bigger number is not.
 */
const AGENT_ASSIST_CAP = 15_000;
/** The read tier a 续写 carries. Measured 1,738. */
const CONTINUE_CAP = 2_000;
/** 旁白 reads other scenes and can write back; 扮演 is deliberately tiny. */
const NARRATOR_CAP = 7_000;
const ROLEPLAY_CAP = 2_500;

const tokensOf = (preset: { tools: readonly string[] }) =>
  estimateToolsTokens(getToolDefinitions(preset.tools as never));

describe("tool schema budget", () => {
  it.each([
    ["agent-assist", AGENT_ASSIST_PRESET, AGENT_ASSIST_CAP],
    ["continue", CONTINUE_PRESET, CONTINUE_CAP],
    ["roleplay-narrator", NARRATOR_PRESET, NARRATOR_CAP],
    ["roleplay-character", ROLEPLAY_PRESET, ROLEPLAY_CAP],
  ])("%s stays within its per-request budget", (_name, preset, cap) => {
    expect(tokensOf(preset)).toBeLessThanOrEqual(cap);
  });

  it("keeps the assistant's resident half well under the full toolset", () => {
    // What a conversation actually pays before it touches the knowledge base —
    // which is most conversations. Measured 7,067 of 9,609 at 1.22.0;
    // 7,201 of 9,743 with read_workflow (resident on purpose: the roster it
    // serves sits in the briefing from round one); 7,705 with both halves of
    // the tool-surface review in. The gallery tier's resident share is only
    // generate_image's `slot` parameter and the read-side wording — its four
    // new write tools are all deferred — whereas the file-tools wording is
    // resident in full, because the manuscript tools are. 7,774 with
    // add_lore_image: the tool itself is deferred, so all this half pays is
    // the sentence on generate_image telling it not to draw what already
    // exists — 69 tokens against a wrong, billable call. 8,435 with the
    // edit_image / redraw_lore_image pair: both are resident, because neither
    // is gated on an approved lore plan — what they spend is money, so their
    // gate is the illustrate card, the same one generate_image goes through.
    // 8,896 with export_docx: +296, and it is resident because routing — not
    // the preset — is what withholds it while the Beta switch is off, exactly
    // like export_pptx. The overrides object is where that money went, so it
    // is capped at five fields with one shared sentence instead of six
    // per-property descriptions (that phrasing alone was another 138). The
    // full DocFormat never enters a schema at all: the model names a preset id
    // and the app resolves it — see docs/feature/docx/01-agent-design.md I2.
    // 9,078 with read_doc_format: +182 for the other half of that trade. It is
    // what keeps the full format OUT of every schema — one string parameter
    // buys "tell me this preset's margins" and "copy that .docx's layout",
    // both answered as prose rather than as a JSON object the model would then
    // be tempted to write back.
    // 9,268 with the plan's second axis (`target` + `members` on a step, see
    // lib/agent/plan): +190, and it is the whole resident cost of collection
    // organising — the two tools that act on the plan sit in the deferred
    // `lore_organize` group and cost nothing until the author approves. What
    // the 190 buys is the difference between a reorganisation the author can
    // read and one they can only rubber-stamp: without a collection target,
    // 「把 200 条按作品归类」 is 200 entity steps. Most of it is the sentence on
    // `target` telling the model to write ONE step per collection rather than
    // one per entry — delete that and the schema gets cheaper while the card
    // gets useless.
    // 9,457 with `negative` on the three drawing tools: +189, paid by every
    // conversation including the ones with no ComfyUI model bound — which is
    // the honest price of the alternative being worse. Only the comfyui route
    // has negative conditioning on the wire, and folding "no watermark" into
    // the positive prompt instead is not a degraded version of the feature but
    // the opposite of it: SD draws what it reads. Three tools rather than one
    // because img2img runs the same sampler — a negative that works on
    // generate_image and silently does nothing on redraw_lore_image is a bug
    // report waiting to happen. The wording is the compact one on purpose;
    // the first draft explained the drop-for-other-models rule twice over and
    // cost 50 more for nothing.
    const { resident } = partitionByGroup(AGENT_ASSIST_PRESET.tools);
    const residentTokens = estimateToolsTokens(getToolDefinitions(resident));
    expect(residentTokens).toBeLessThanOrEqual(9_500);
    // A guard against the deferral quietly becoming a no-op: someone drops the
    // `group` tag off a tool and the only symptom is a bigger bill.
    expect(tokensOf(AGENT_ASSIST_PRESET) - residentTokens).toBeGreaterThan(2_000);
  });

  it("prices the tools that routing appends, which this file's preset caps cannot see", () => {
    // `delegate` and `translate` are added by `routeTools`, not listed in any
    // preset — they depend on the author's switches, which the preset layer
    // cannot know. That keeps them outside the caps above, so their cost is
    // pinned here instead. Without this, "append in routing" would be a way to
    // add tools that no ratchet ever measures.
    //
    // Measured 634 — delegate 287, translate 347. Note these are not additive
    // with the caps above in practice: a conversation carries at most the ones
    // its author has switched on.
    //
    // translate was 217 when it only took `text`; the whole-file form added
    // `path` + `reason` and the sentences that keep the model from reaching for
    // the wrong one. Paid deliberately: the alternative — two tools — costs a
    // second schema and a second name for one capability.
    const appended = estimateToolsTokens(getToolDefinitions(["delegate", "translate"]));
    expect(appended).toBeLessThanOrEqual(720);
  });

  it("gives every tool a description worth its place", () => {
    // A tool the model can see but can't tell apart from its neighbours is
    // worse than no tool: it costs schema tokens *and* buys a wrong call.
    for (const def of getToolDefinitions([...AGENT_ASSIST_PRESET.tools, "delegate", "translate"])) {
      expect(def.function.description.trim().length).toBeGreaterThan(40);
      // The category placeholder is substituted per call — one that survives
      // into the wire means the model is being shown literal `{{…}}`.
      expect(def.function.description).not.toContain("{{");
    }
  });
});
