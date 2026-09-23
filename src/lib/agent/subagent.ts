/**
 * Subagents execution engine and delegate tool.
 *
 * The kinds, bindings and connection resolution live in `./subagentModel`;
 * this file is only the half that runs a nested agent (`executeDelegate`), and
 * is the only half that may import `./runtime`.
 *
 * Specialist agents (search, vision, longread) run on their own configured
 * model with a fresh, isolated 2-message context. Intermediate findings
 * and raw materials (search results, full documents, base64 images) are
 * written into notes in the task workspace, returning only a concise summary
 * and note path to the parent model.
 */

import i18n from "../../i18n";
import type { ContentPart, MessageContent, StreamMessage } from "../ai/types";
import { serverToolsSent } from "../ai/serverTools";
import { upstreamDropping } from "../ai/relayUpstream";
import { imagePart, imagesWithinBudget } from "../ai/imagePart";
import { canSeeImages, readsPdf, type Model, type Provider } from "../ai/configDb";
import { connOptions } from "../ai/conn";
import { recordUsage } from "../ai/usageRow";
import { withCurrentTime } from "../context/clock";
import { bytesToBase64, isImagePath } from "../fs/images";
import { fileExists, readBinaryFile } from "../fs/fileio";
import { isWorkspacePath, resolveRelativePath } from "../paths";
import type { AgentRunResult } from "./runtime";
import type { ToolContext } from "./registry";
import { loadProjectImage, shrunkNote, type ToolCall, type ToolResult } from "./tools";
import { writeTaskNote } from "./taskWorkspace";
import { baseName } from "../paths";
import {
  DELEGATE_KINDS, MAX_PDF_BYTES, MAX_PDF_FILES, SUB_PRESETS, searchReadsPages,
  type DelegateKind, type SubAgentKind,
} from "./subagentModel";

const DELEGATE_SUMMARY_CHARS = 800;

/**
 * How many pictures one vision delegation may carry in its first message.
 * Each one is a full image payload on a request that is rebuilt every round,
 * so a wide job is split rather than sent as one.
 */
const MAX_VISION_IMAGES = 8;

/**
 * Read one project PDF for a delegation, or say exactly why not.
 *
 * Containment mirrors `read_file`, not `read_image`: `.ai-writer/` is refused.
 * A PDF is a document the model reads as text, so the exfiltration argument
 * that keeps `read_file` out of the app's own data applies unchanged — and
 * unlike lore gallery images, nothing this tool serves legitimately lives
 * there.
 */
async function loadProjectPdf(
  projectPath: string,
  rawPath: string,
): Promise<{ dataUrl: string; name: string } | { error: string }> {
  // Empty prefix would contain every absolute path — same guard as the read tools.
  if (!projectPath) return { error: "no project is open — the pdf subagent cannot run here." };
  const wanted = rawPath.trim();
  if (!wanted.toLowerCase().endsWith(".pdf")) {
    return { error: `"${rawPath}" is not a .pdf file. The pdf subagent reads PDFs only; for text documents use the longread subagent or read_file.` };
  }
  const path = resolveRelativePath(projectPath, wanted);
  // `isWorkspacePath` is the tools' whole answer — inside the project AND not
  // in `.ai-writer/` — so the guard is its single negation, not a re-derivation.
  if (!isWorkspacePath(projectPath, path)) {
    return { error: `"${rawPath}" is outside the project's documents.` };
  }
  if (!(await fileExists(path))) {
    return { error: `no file at "${path}". Paths come from list_files (folder line + "/" + filename).` };
  }
  const bytes = await readBinaryFile(path);
  if (bytes.length > MAX_PDF_BYTES) {
    return { error: `"${rawPath}" is ${(bytes.length / 1024 / 1024).toFixed(0)}MB — over the 150MB per-file limit.` };
  }
  return {
    dataUrl: `data:application/pdf;base64,${bytesToBase64(bytes)}`,
    name: baseName(path) || "document.pdf",
  };
}

/** How much of the instruction survives into the note's filename. */
const SLUG_HINT_CHARS = 20;

function parseArgs<T>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return {} as T;
  }
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "…";
}

/**
 * Execute a delegate tool call: dispatch to a subagent on its own model.
 */
export async function executeDelegate(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const fail = (msg: string): ToolResult => ({
    toolCallId: call.id,
    content: `Error: ${msg}`,
  });

  if (!ctx.taskWorkspace || !ctx.signal || !ctx.onNestedEvent || !ctx.resolveSubAgent) {
    return fail("this surface cannot run subagents — do not call this tool here.");
  }

  // `refs` is the parameter's pre-1.28 spelling, still accepted.
  const args = parseArgs<{ kind?: string; task?: string; references?: string[]; refs?: string[] }>(
    call.arguments,
  );
  const kind = args.kind as DelegateKind;
  if (!DELEGATE_KINDS.includes(kind)) {
    if ((args.kind as SubAgentKind) === "imagegen") {
      return fail("images are not delegated — call generate_image, edit_image or redraw_lore_image directly.");
    }
    return fail(`unknown subagent kind "${args.kind}". Must be one of: search, vision, longread, pdf.`);
  }

  const task = args.task?.trim();
  if (!task) {
    return fail("'task' is required — state the whole job, the subagent cannot see this conversation.");
  }

  const conn = await ctx.resolveSubAgent(kind);
  if ("error" in conn) return fail(conn.error);

  // Capability preconditions, checked here rather than inside the sub-run: a
  // subagent bound to a model that cannot do its one job would otherwise burn a
  // whole round trip before reporting it, and report it as a failure rather
  // than as a configuration problem the author can fix.
  if (kind === "search" && !serverToolsSent(conn.model, [conn.provider])?.includes("web_search")) {
    const upstream = upstreamDropping("web_search", conn.model, conn.provider);
    return fail(
      upstream
        ? `the search subagent's model "${conn.model.name}" has web_search switched on, but the relay upstream behind it ("${upstream}") ` +
            `was measured dropping it, so nothing is sent. Tell the author to bind a model behind another upstream ` +
            `(Settings → Subagents), or answer without searching.`
        : conn.model.serverTools?.includes("web_search")
        ? `the search subagent's model "${conn.model.name}" has web_search switched on, but its provider "${conn.provider.name}" ` +
            `is on a platform with no server-side search, so nothing is sent. Tell the author to bind a model on a platform that searches ` +
            `(Settings → Subagents), or answer without searching.`
        : `the search subagent's model "${conn.model.name}" has no server-side web_search enabled. ` +
            `Tell the author to turn it on in Settings → Models, or answer without searching.`,
    );
  }
  if (kind === "vision" && !canSeeImages(conn.model)) {
    return fail(
      `the vision subagent's model "${conn.model.name}" is text-only and cannot read images. ` +
        `Tell the author to bind a multimodal model to it in Settings → Subagents.`,
    );
  }
  if (kind === "pdf" && !readsPdf(conn.model, conn.provider)) {
    const upstream = conn.model.pdfInput ? upstreamDropping("pdfInput", conn.model, conn.provider) : undefined;
    return fail(
      upstream
        ? `the pdf subagent's model "${conn.model.name}" accepts PDF input, but the relay upstream behind it ("${upstream}") ` +
            `was measured dropping the file. Tell the author to bind a model behind another upstream (Settings → Subagents), ` +
            `or read the document another way.`
        : `the pdf subagent's model "${conn.model.name}" is not declared to accept PDF files. ` +
            `Tell the author to enable PDF input on it in Settings → Models, or read the document another way.`,
    );
  }

  const refs = ((args.references ?? args.refs) ?? []).filter((r) => typeof r === "string" && r.trim());
  const preset = SUB_PRESETS[kind];

  // Two templates, not one with an interpolated blank: the refs-bearing key
  // carries its own 「参考资源」 heading, so reusing it with nothing to list
  // handed the subagent an empty section — an instruction to consult sources
  // that aren't there.
  let userContent: MessageContent = refs.length
    ? i18n.t("ai.instructions.subagentTaskWithRefs", {
        task,
        refs: refs.map((r) => `- ${r}`).join("\n"),
      })
    : i18n.t("ai.instructions.subagentTask", { task });

  // The pdf kind is the one whose refs are *payload*, not reading list: each
  // is loaded here and attached as a file part, because the sub-run has no
  // tool that could fetch a document later — the request is the whole job.
  // Files precede the instruction, matching the vendor's documented order.
  if (kind === "pdf") {
    const pdfRefs = refs.filter((r) => r.toLowerCase().endsWith(".pdf"));
    if (!pdfRefs.length) {
      return fail("the pdf subagent needs at least one .pdf path in 'refs' — pass the document's full path from list_files.");
    }
    if (pdfRefs.length > MAX_PDF_FILES) {
      return fail(`too many PDFs (${pdfRefs.length}) — delegate at most ${MAX_PDF_FILES} per call, splitting the job if needed.`);
    }
    const parts: ContentPart[] = [];
    for (const ref of pdfRefs) {
      const loaded = await loadProjectPdf(ctx.projectPath, ref);
      if ("error" in loaded) return fail(loaded.error);
      parts.push({ type: "file", file: { file_data: loaded.dataUrl, filename: loaded.name } });
    }
    parts.push({ type: "text", text: i18n.t("ai.instructions.subagentTask", { task }) });
    userContent = parts;
  }

  // The vision kind's image refs are payload too — read here and attached as
  // image parts ahead of the instruction, not left as paths for the sub-run to
  // fetch with read_image. The path-only form was tried first and is the bug
  // this replaces: the sub-run holds a filename and a tool, and its prompt says
  // "observe the reference pictures" — so a model that does not infer the tool
  // call answers, in good faith, that no image was provided. Handing over the
  // bytes makes the first request the whole job, as the pdf kind already does;
  // the tools stay for a lore entity's gallery and any follow-up look. A ref
  // that names an image but resolves to none fails the delegation up front,
  // with the tool's own error, rather than starting a run that cannot succeed.
  if (kind === "vision") {
    const imageRefs = refs.filter(isImagePath);
    if (imageRefs.length > MAX_VISION_IMAGES) {
      return fail(`too many images (${imageRefs.length}) — delegate at most ${MAX_VISION_IMAGES} per call, splitting the job if needed.`);
    }
    if (imageRefs.length) {
      const parts: ContentPart[] = [];
      const captions: string[] = [];
      let payload = 0;
      for (const ref of imageRefs) {
        const loaded = await loadProjectImage(ctx.projectPath, ref);
        if ("error" in loaded) return fail(loaded.error.replace(/^Error:\s*/, ""));
        // The count cap above is not a size cap: eight large screenshots pass
        // it and still build a body no endpoint takes (lib/ai/imagePart).
        // Refused as a split, like the count, rather than trimmed — the job
        // named these pictures, and a sub-run missing some would answer anyway.
        if (imagesWithinBudget([loaded.dataUrl.length], payload) === 0) {
          return fail(`images too large to send together (${parts.length} fit, stopped at ${loaded.name}) — delegate fewer per call, splitting the job if needed.`);
        }
        payload += loaded.dataUrl.length;
        captions.push(`- ${loaded.name} — ${loaded.path}${shrunkNote(loaded.downscaled)}`);
        parts.push(imagePart(loaded.dataUrl));
      }
      // Same two-template rule as above: a 「参考资源」 heading appears only
      // when there is something under it.
      const otherRefs = refs.filter((r) => !isImagePath(r));
      const text =
        i18n.t("ai.instructions.subagentTaskWithImages", { task, images: captions.join("\n") }) +
        (otherRefs.length
          ? i18n.t("ai.instructions.subagentRefsList", { refs: otherRefs.map((r) => `- ${r}`).join("\n") })
          : "");
      parts.push({ type: "text", text });
      userContent = parts;
    }
  }

  const messages: StreamMessage[] = [
    { role: "system", content: withCurrentTime(subagentSystemPrompt(kind, conn.model, conn.provider)) },
    { role: "user", content: userContent },
  ];

  // Injected by the runtime; see `SubRunner` for why this is not an import.
  if (!ctx.subRun) return fail("delegate needs the agent runtime to start a sub-run, and this call is not inside one.");

  let output = "";
  let result: AgentRunResult;

  try {
    result = await ctx.subRun.run({
      ...connOptions(conn),
      preset,
      messages,
      toolContext: {
        projectPath: ctx.projectPath,
        loreIndex: ctx.loreIndex,
        appState: ctx.appState,
        // 围栏跟着子对话走。不继承的话，把活派给子代理就成了绕过取材范围的方法
        // ——而那正是「委派」最不该有的副作用。
        loreScope: ctx.loreScope,
        multimodal: canSeeImages(conn.model),
        // Threaded through so this stays correct if a delegate preset ever
        // gains a lore write tool (none has one today). runAgent clones the
        // index per run, so a child's writes reach disk and the app but not the
        // parent's snapshot — self-healing, since the parent's next syncLore
        // re-reads disk.
        onLoreChanged: ctx.onLoreChanged,
        onMemoryChanged: ctx.onMemoryChanged,
        taskWorkspace: undefined,
        signal: ctx.signal,
      },
      signal: ctx.signal,
      onEvent: (e) => ctx.onNestedEvent!({ ...e, parentStep: call.id }),
      onOutputText: (text) => {
        output = text;
      },
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    return fail(`the ${kind} subagent failed: ${(e as Error).message}`);
  }

  // What this specialist spent, on the record where the author can see it.
  // The DB row below is the permanent ledger, but it is invisible until someone
  // opens Settings → 用量 — and a delegation is exactly the step whose cost the
  // author is deciding about *now*. `parentStep` keeps it out of the parent
  // run's own totals, which count the parent's model only.
  ctx.onNestedEvent({
    kind: "run-done",
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    at: Date.now(),
    parentStep: call.id,
  });

  await recordUsage(ctx.projectPath, {
    model: conn.model,
    task: `subagent:${kind}`,
    promptTokens: result.inputTokens,
    cachedTokens: result.cachedTokens,
    completionTokens: result.outputTokens,
  });

  if (!output.trim()) {
    return fail(`the ${kind} subagent returned nothing. Try a narrower task, or do it yourself.`);
  }

  // Generic title, never the delegated instruction. Naming the workspace after
  // whichever artefact happened to land first is the defect PR-A fixed for
  // write_note, and it reads worse here: a delegate task is a whole paragraph
  // by design, so it became the document's H1. The task's name belongs to
  // task_plan.
  const { taskId } = await ctx.taskWorkspace.ensure(i18n.t("ai.taskDoc.untitled"));
  const note = await writeTaskNote(ctx.projectPath, taskId, {
    // A filename, not a sentence — the full instruction is the note's title on
    // the first line, and `writeTaskNote` suffixes rather than overwrites when
    // two delegations share an opening.
    slug: `${kind}-${[...task].slice(0, SLUG_HINT_CHARS).join("")}`,
    title: task.slice(0, 80),
    content: output,
    sources: refs,
    origin: kind,
  });

  return {
    toolCallId: call.id,
    content: [
      `The ${kind} subagent finished. Full findings saved to: ${note.path}`,
      `Call read_note with that path when you need the detail.`,
      ``,
      `Summary:`,
      clip(output, DELEGATE_SUMMARY_CHARS),
    ].join("\n"),
  };
}

/**
 * A delegate sub-run's system prompt. The search kind says whether pages can
 * be opened, because the same task ("summarise this link") needs opposite
 * instructions: read it, or say plainly that it could not be read — a
 * search-only model otherwise reports a search hit's snippet as if it were
 * the page.
 */
function subagentSystemPrompt(kind: DelegateKind, model: Model, provider: Provider): string {
  const base = i18n.t(`ai.instructions.subagent.${kind}`);
  if (kind !== "search") return base;
  return base + "\n" + i18n.t(searchReadsPages(model, provider)
    ? "ai.instructions.subagentSearchPages"
    : "ai.instructions.subagentSearchNoPages");
}
