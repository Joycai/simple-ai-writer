/**
 * Turning the chat composer's `@` references into what the model receives.
 *
 * References are **inlined**, not merely named. The assistant has read_file and
 * read_lore_entity and could fetch them itself, but an author who typed
 * `@第三章` has already decided the assistant should be looking at it — making
 * that a suggestion the model may skip turns an explicit instruction into a
 * gamble, and costs a round-trip when it doesn't. The same argument carries an
 * `@`-referenced *picture* into the message as an `image_url` part rather than
 * leaving the model to find it with read_image.
 *
 * The cost of inlining is that chat history persists: whatever goes in stays in
 * context for the rest of the session. Hence the per-file cap — a long chapter
 * contributes its opening and a pointer to the tool that can read the rest,
 * instead of quietly eating the window — and, for pictures, both a per-message
 * count cap here and the running cap `trimHistory` enforces over the session.
 */

import i18n from "../../i18n";
import type { ContentPart, MessageContent } from "../ai/types";
import { imagePart, imagesWithinBudget, MAX_REQUEST_IMAGE_CHARS } from "../ai/imagePart";
import { noteVideoTokens } from "../ai/tokenEstimate";
import { estimateVideoTokens, videoPart } from "../ai/videoInput";
import { readEntityFile } from "../lore/entity";
import { projectRelative } from "../paths";
import { isChatStashPath } from "./pasteImages";
import type {
  AttachedImage, AttachedItem, AttachedLore, AttachedMedia, AttachedText, AttachedVideo,
} from "../lore/aiTask";

/**
 * Whether the composer holds something to send: words, or a picture.
 *
 * A picture on its own is a message — "screenshot, ⌘V, Enter" is the paste
 * feature's commonest path, and the picture is the question. Other chips are
 * not: a file or entry with no words is material with nothing asked of it
 * (docs/feature/agent/chat-image-paste-plan.md §10).
 */
export function hasMessage(text: string, refs: readonly AttachedItem[]): boolean {
  return !!text.trim() || refs.some((r) => r.kind === "image");
}

/**
 * Longest slice of one referenced file that is inlined. Generous enough for a
 * normal chapter, small enough that four of them don't dominate the window.
 */
export const REF_CHAR_CAP = 6000;

/**
 * Budget across *all* of one message's references.
 *
 * The per-file cap alone bounds nothing that matters: ten `@`s is 60k
 * characters, and because chat history persists it stays in the window for the
 * rest of the session. Past this, references are named rather than inlined —
 * the assistant still knows they exist and can read them on demand.
 */
const REF_TOTAL_CHAR_BUDGET = 18_000;

/**
 * Most pictures one message may carry — pasted and `@`-attached together.
 *
 * Separate from the session-wide cap in `trimHistory`: that one keeps a long
 * conversation's *accumulated* images bounded, and counts a message as one
 * entry however many pictures are on it. Without a per-message cap, ten
 * attachments would be ten base64 payloads in a single request body — the
 * request that has to succeed before any trimming ever runs.
 *
 * One number for both sources, never a separate paste cap: they are the same
 * base64 on the same wire (docs/feature/agent/chat-image-paste-plan.md §3.4).
 * The binding constraint on five is usually the request's byte budget, which
 * still sends what fits and lists the rest.
 */
export const MAX_MESSAGE_IMAGES = 5;

/**
 * Most video clips one message may carry: one.
 *
 * Not a guess at a vendor limit (none was measured for several clips) but two
 * measured facts: one data-URI item may be up to 20 MB, so two clips is a
 * 40 MB request body before anything else is on it; and a clip costs from
 * hundreds to tens of thousands of input tokens, re-billed every tool round
 * (`trimHistory` keeps only the newest clip for the same reason).
 */
const MAX_MESSAGE_VIDEOS = 1;

/** One reference, rendered for the prompt. `budget` is what is left for it. */
async function renderRef(item: AttachedLore | AttachedText, budget: number): Promise<string> {
  if (item.kind === "lore") {
    try {
      const body = await readEntityFile(item.entity.dirPath, "index.md");
      return clip(`## ${item.entity.name}`, body.trim(), budget, item.entity.dirPath);
    } catch {
      return `## ${item.entity.name}\n(读取失败 / unavailable)`;
    }
  }
  return clip(`--- ${item.file.name} ---`, item.content.trim(), budget, item.file.path);
}

/** Inline what fits under both caps; say where the rest is rather than truncating silently. */
function clip(header: string, content: string, budget: number, path: string): string {
  const cap = Math.min(REF_CHAR_CAP, Math.max(0, budget));
  if (cap === 0) {
    // Out of budget entirely: naming it still tells the assistant it was
    // asked for, and read_file is one round-trip away.
    return `${header}\n[not inlined — this message already carries several references. Read it from ${path} if you need it.]`;
  }
  if (content.length <= cap) return `${header}\n${content}`;
  return [
    header,
    content.slice(0, cap),
    `…[truncated — ${content.length - cap} more chars. Use read_file on ${path} for the full text.]`,
  ].join("\n");
}

/** What one composed chat message contributes to the turn. */
interface ChatMessagePayload {
  /**
   * The message as text.
   *
   * Not merely `content` narrowed: this is what the retrieval passes match on
   * (`assembleTurnInjection`'s matchTarget) and what the first turn's context
   * is assembled around. Those want words, and a picture has none — so the
   * text half stays a string whatever the wire form turns out to be.
   */
  text: string;
  /**
   * {@link text} with every picture reduced to its name (a pasted one, whose
   * name the app made up, to nothing) — what the knowledge
   * base's name matching and the retrieval expansion read. The paths and the
   * scratch note are for the model to go and fetch a picture again; to a
   * substring match they are noise that can name entries (`.ai-writer` holds
   * "AI", "deleted" holds "Ted", `assets/<文档名>/` a character's name).
   */
  matchText: string;
  /** What goes on the wire — the text alone, or the text plus image parts. */
  content: MessageContent;
  /** Absolute paths of the pictures actually attached, for the transcript. */
  imagePaths: string[];
}

/**
 * Append a standing directive (today: 计划模式) to the wire form of a composed
 * message, leaving its `text` alone.
 *
 * Two reasons it lands here rather than inside {@link buildChatMessage}'s
 * `parts`: the `text` half is what the retrieval passes match on, and a fixed
 * block of instructions repeated every turn is noise to match against; and the
 * directive is about *how* to work, not material for the request, so it reads
 * last — after the author's own words, before nothing.
 *
 * Appended to the existing text part rather than pushed as a new one, so
 * attached pictures stay at the end of the parts array where every provider
 * expects them (see the note on ordering above).
 */
export function withDirective(content: MessageContent, directive: string): MessageContent {
  const note = directive.trim();
  if (!note) return content;
  if (typeof content === "string") return `${content}\n\n${note}`;
  let appended = false;
  const parts = content.map((part): ContentPart => {
    if (appended || part.type !== "text") return part;
    appended = true;
    return { ...part, text: `${part.text}\n\n${note}` };
  });
  return appended ? parts : [...parts, { type: "text", text: note }];
}

/**
 * Compose the wire message: quoted selection, then references, then what the
 * author actually typed.
 *
 * The author's own words go last so they are the most recent thing the model
 * reads — everything above is material for carrying them out. Pictures go after
 * all of it, as parts: every provider reads a parts array in order, and an
 * image ahead of the instruction reads as the subject of a question not yet
 * asked.
 *
 * `allowImages` is the caller's answer to "is the active model multimodal" —
 * a text-only model is sent the attachment's *name and path* and told the
 * picture could not travel, which is the difference between the assistant
 * saying so and the assistant appearing to ignore what the author attached.
 *
 * `visionDelegate` says a vision subagent is standing by, which turns that
 * notice from an apology into an instruction: the path is exactly what
 * `delegate(vision, refs)` takes. Kept separate from `allowImages` on purpose —
 * base64 still must not go to a model that cannot read it, however capable the
 * chain is as a whole (docs/feature/agent/subagent-lld.md §6.1).
 */
export async function buildChatMessage(
  message: string,
  quote?: string,
  refs: AttachedItem[] = [],
  opts: {
    allowImages?: boolean;
    visionDelegate?: boolean;
    /** Whether this run holds `transcribe_audio` — decides what a mentioned recording is told to do. */
    transcribe?: boolean;
    /**
     * Whether an attached clip may travel as a `video_url` part — the caller's
     * `canReadVideo(model, standard)`. When false a clip is treated exactly
     * like any other recording: a path, and whatever `transcribe` says.
     */
    allowVideo?: boolean;
    /** The model's declared `videoFps`; absent sends no `fps`. */
    videoFps?: number;
    /** Lets the 【附图】 list name pictures by project-relative path; absent keeps them absolute. */
    projectPath?: string;
  } = {},
): Promise<ChatMessagePayload> {
  const parts: string[] = [];
  // Where `matchText` says something other than `text`: part index → its words.
  const forMatch = new Map<number, string>();

  const quoted = quote?.trim();
  if (quoted) {
    parts.push(`${i18n.t("ai.chat.quoteBlockLabel", { defaultValue: "【选中内容】" })}\n${quoted}`);
  }

  const referable = refs.filter(
    (r): r is AttachedLore | AttachedText => r.kind === "lore" || r.kind === "text",
  );
  if (referable.length) {
    // Sequential, not Promise.all: each reference's allowance depends on what
    // the ones before it used, so the first few arrive whole and the tail
    // degrades to pointers instead of every one being clipped to a stub.
    let spent = 0;
    const rendered: string[] = [];
    for (const item of referable) {
      const text = await renderRef(item, REF_TOTAL_CHAR_BUDGET - spent);
      spent += text.length;
      rendered.push(text);
    }
    parts.push(
      `${i18n.t("ai.chat.refBlockLabel", { defaultValue: "【引用资料】" })}\n${rendered.join("\n\n")}`,
    );
  }

  const images = refs.filter((r): r is AttachedImage => r.kind === "image");
  // Two ceilings, whichever bites first: the count, and the request's picture
  // budget (lib/ai/imagePart) — four large screenshots are under the first and
  // well over the second, and the request that carries them is this one.
  const capped = opts.allowImages ? images.slice(0, MAX_MESSAGE_IMAGES) : [];
  const sent = capped.slice(0, imagesWithinBudget(capped.map((a) => a.dataUrl.length)));
  const unsent = images.slice(sent.length);
  // Named, not just shown: "第二张图里的那件外套" only resolves if the model
  // knows which picture is which, and the parts array carries no filenames.
  // And located: the pixels leave the context after a turn or two (the image
  // lease, trimHistory's caps, the saved session), this text does not — with
  // the path in it, "read it again" has something to read. A pasted picture
  // is marked as scratch so the model never links it into the manuscript:
  // the file goes when the session does.
  const stashNote = (a: AttachedImage) => isChatStashPath(a.file.path)
    ? i18n.t("ai.chat.imageStashNote", { defaultValue: "（会话暂存，随会话删除）" })
    : "";
  // A pasted picture's name is made up by the app (「粘贴的图片 N」, "Pasted
  // image N" — which holds "ted"), not the author's word: left out of matching.
  const matchNames = (list: AttachedImage[]) =>
    list.filter((a) => !isChatStashPath(a.file.path)).map((a) => a.file.name).join("\n");
  if (sent.length) {
    forMatch.set(parts.length, matchNames(sent));
    parts.push(
      `${i18n.t("ai.chat.imageBlockLabel", { defaultValue: "【附图】" })}\n${
        sent.map((a, i) => {
          const where = (opts.projectPath && projectRelative(opts.projectPath, a.file.path)) || a.file.path;
          return `${i + 1}. ${a.file.name} — ${where}${stashNote(a)}`;
        }).join("\n")
      }`,
    );
  }
  if (unsent.length) {
    // Paths, not just names. A picture that cannot travel on this request can
    // still be *read* — by the vision subagent, which takes a path. Naming the
    // file alone left the model with something it could see was missing and no
    // way to go and get it.
    // The scratch note here too: a text-only model is told about a pasted
    // picture only through this list, and must not link it into the text.
    const listed = unsent.map((a) => `- ${a.file.name} — ${a.file.path}${stashNote(a)}`).join("\n");
    forMatch.set(parts.length, matchNames(unsent));
    parts.push(
      opts.visionDelegate
        ? i18n.t("ai.chat.imagesNotSentDelegate", {
            defaultValue:
              "（以下图片未能直接随本条消息发送，但已启用图像理解子代理——需要看图时用 delegate(kind:\"vision\", refs:[路径]) 让它读，并把结论用于回答：\n{{list}}）",
            list: listed,
          })
        : opts.allowImages
        ? i18n.t("ai.chat.imagesOverCap", {
            defaultValue:
              "（以下图片没有随本条消息发送——单条消息最多带 {{max}} 张图片，合计也不能超过 {{mb}} MB：\n{{list}}）",
            max: MAX_MESSAGE_IMAGES,
            mb: MAX_REQUEST_IMAGE_CHARS / 1024 / 1024,
            list: listed,
          })
        : i18n.t("ai.chat.imagesNotSent", {
            defaultValue: "（以下图片未能随本条消息发送——当前模型读不了图：\n{{list}}）",
            list: listed,
          }),
    );
  }

  // Video clips: a payload only for a model that declared it, one per message.
  const videos = refs.filter((r): r is AttachedVideo => r.kind === "video");
  const sentVideos = opts.allowVideo ? videos.slice(0, MAX_MESSAGE_VIDEOS) : [];
  if (sentVideos.length) {
    parts.push(
      `${i18n.t("ai.chat.videoBlockLabel", { defaultValue: "【附视频】" })}\n${
        sentVideos.map((v, i) => `${i + 1}. ${v.file.name}${
          v.durationSec ? `（${Math.round(v.durationSec)}s）` : ""
        }`).join("\n")
      }`,
    );
  }
  const overCap = opts.allowVideo ? videos.slice(sentVideos.length) : [];
  if (overCap.length) {
    parts.push(i18n.t("ai.chat.videosOverCap", {
      defaultValue: "（以下视频没有随本条消息发送——每条消息最多带 {{max}} 段视频：\n{{list}}）",
      max: MAX_MESSAGE_VIDEOS,
      list: overCap.map((v) => `- ${v.file.name} — ${v.file.path}`).join("\n"),
    }));
  }

  // Recordings: never a payload, always a pointer. The model is told the path
  // and — only when this run actually holds the tool (tool-presence.md) —
  // which tool turns it into text; otherwise what the author has to switch on.
  // A clip read for a video model that is no longer the one sending lands here
  // too: to this model it is a recording like any other.
  const media: { file: AttachedMedia["file"] }[] = [
    ...refs.filter((r): r is AttachedMedia => r.kind === "media"),
    ...(opts.allowVideo ? [] : videos),
  ];
  if (media.length) {
    const listed = media.map((a) => `- ${a.file.name} — ${a.file.path}`).join("\n");
    parts.push(
      opts.transcribe
        ? i18n.t("ai.chat.mediaRefs", {
            defaultValue:
              "（以下是音频 / 视频文件，模型读不了它们的内容——需要时用 transcribe_audio 转写成文字稿（作者会先看到一张确认卡），再用 read_file 读文字稿：\n{{list}}）",
            list: listed,
          })
        : i18n.t("ai.chat.mediaRefsNoTool", {
            defaultValue:
              "（以下是音频 / 视频文件，模型读不了它们的内容，本次运行也没有转写工具——告诉作者需要在 实验室 开启「音频转写」并在 子代理 里绑定模型：\n{{list}}）",
            list: listed,
          }),
    );
  }

  // A picture sent on its own has no words to put last; the 【附图】 block is
  // the whole question, and an empty part would only leave a trailing gap.
  if (message) parts.push(message);
  const text = parts.join("\n\n");

  const videoParts = sentVideos.map((v) => {
    const part = videoPart(v.dataUrl, opts.videoFps);
    // Beside the part, never on it: openai.ts sends parts verbatim.
    const estimate = estimateVideoTokens({ ...v, fps: opts.videoFps });
    if (estimate !== null) noteVideoTokens(part, estimate);
    return part;
  });

  return {
    text,
    matchText: parts.map((p, i) => forMatch.get(i) ?? p).join("\n\n"),
    content: sent.length || videoParts.length
      ? [
          { type: "text", text },
          ...sent.map((a) => imagePart(a.dataUrl)),
          ...videoParts,
        ]
      : text,
    imagePaths: sent.map((a) => a.file.path),
  };
}
