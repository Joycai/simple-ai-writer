/**
 * `transcribe_audio` —— 助手对转写模型的**唯一**接口。
 *
 * 形态照 `convert_document`（lib/agent/convertTools.ts）的六步，但第 3 步换位：
 * 那张卡是「已经转好了，看一眼再落盘」，这张是「**要不要花这笔钱**」——转写
 * 本身就是计费的那一步，所以提案时只读文件头（大小、WAV 能算出的时长、有单价
 * 就给的估价），批准之后才上传、提交、轮询、写盘（执行方案 §1 不变量 4）。
 * 进度走 `requestApproval` 的第二个参数，卡片原地变成三阶段。
 *
 * 命中缓存的文件（同内容同参数转写过）不再付费，卡上照样出——作者点的头是
 * 「写这份文字稿」，不只是「花这笔钱」。
 */

import { fileExists, readFileHead } from "../fs/fileio";
import { baseName, projectRelative, resolveWorkspacePath } from "../paths";
import type { ToolContext, TranscribeProposal } from "../agent/registry";
import type { ToolResult } from "../agent/tools";
import { estimateCost, wavDurationSeconds } from "./cost";
import { isAsrDiarizationDefault } from "./flag";
import { transcribeExtOf, ASR_EXT_LIST } from "./formats";
import { isAsrUnavailable, resolveAsrConn } from "./conn";
import { MAX_TRANSCRIBE_BYTES, transcriptTargetFor } from "./run";

let proposalCounter = 0;

/** 只读文件头够算 WAV 时长；整个文件进内存留给批准之后。 */
const HEADER_BYTES = 64 * 1024;

export interface TranscribeArgs {
  path?: string;
  /** 本次要不要说话人分离；缺席 = 子代理里的默认值。作者在卡上还能改。 */
  diarization?: boolean;
  speaker_count?: number;
  /** 语言提示，`["zh"]` 这种，最多 4 个。 */
  language_hints?: string[];
  reason?: string;
}

export async function transcribeAudioTool(
  toolCallId: string,
  args: TranscribeArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.requestApproval) {
    return {
      toolCallId,
      content: "Error: this surface cannot review a transcription — do not call this tool here.",
    };
  }
  const raw = args.path?.trim();
  if (!raw) {
    return { toolCallId, content: "Error: 'path' is required — the audio or video file to transcribe." };
  }
  const source = resolveWorkspacePath(ctx.projectPath, raw);
  if (!source) {
    return { toolCallId, content: "Error: Path is outside the project (the app's .ai-writer data is off-limits)." };
  }
  const ext = transcribeExtOf(source);
  if (!ext) {
    return {
      toolCallId,
      content: `Error: "${source}" is not an audio or video file. This tool transcribes ${ASR_EXT_LIST}; a text file needs read_file, a .docx/.pdf needs read_document.`,
    };
  }
  if (!(await fileExists(source))) {
    return { toolCallId, content: `Error: there is no file at ${source}. Check the path with list_files.` };
  }
  const conn = await resolveAsrConn();
  if (isAsrUnavailable(conn)) {
    return { toolCallId, content: `Error: ${conn.error}` };
  }

  // 大小 + 能算出的时长 + 估价。整个文件**不读**：`readFileHead` 一次往返带回真实
  // 大小和前 64KB，一份 1.5GB 的视频不会为了画一张卡就整个穿过 IPC 进 webview 堆。
  // 上限也在这里拦——`transcribeFile` 里那道闸在批准**之后**，那时钱已经要花了。
  let bytes = 0;
  let seconds: number | null = null;
  try {
    const head = await readFileHead(source, HEADER_BYTES);
    bytes = head.size;
    if (ext === "wav") seconds = wavDurationSeconds(head.head, head.size);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { toolCallId, content: `Error reading "${source}": ${msg}.` };
  }
  if (bytes === 0) {
    return { toolCallId, content: `Error: "${source}" is empty — there is nothing to transcribe.` };
  }
  if (bytes > MAX_TRANSCRIBE_BYTES) {
    return {
      toolCallId,
      content:
        `Error: "${source}" is ${(bytes / 1024 / 1024).toFixed(0)}MB, over the ` +
        `${MAX_TRANSCRIBE_BYTES / 1024 / 1024}MB transcription limit. Ask the author to split or re-encode it.`,
    };
  }
  const price = conn.model.pricePerSecond;
  const hints = (args.language_hints ?? []).filter((h): h is string => typeof h === "string" && !!h).slice(0, 4);

  const proposal: TranscribeProposal = {
    kind: "transcribe",
    id: `transcribe-${++proposalCounter}`,
    path: await transcriptTargetFor(source),
    sourcePath: source,
    sourceLabel: projectRelative(ctx.projectPath, source) ?? baseName(source),
    ext,
    bytes,
    seconds,
    pricePerSecond: price,
    estimate: seconds === null ? null : estimateCost(seconds, price),
    diarization: args.diarization ?? isAsrDiarizationDefault(),
    ...(args.speaker_count && args.speaker_count >= 2 ? { speakerCount: Math.floor(args.speaker_count) } : {}),
    ...(hints.length ? { languageHints: hints } : {}),
    modelName: conn.model.name,
    reason: args.reason,
  };

  const decision = await ctx.requestApproval(proposal);
  if (!decision.approved) {
    return {
      toolCallId,
      content: `The user REJECTED this transcription${decision.reason ? ` — reason: ${decision.reason}` : "."} Do not retry it; the audio cannot be read any other way, so work without it or ask the author.`,
    };
  }
  return { toolCallId, content: decision.backupPath ?? `Transcribed to ${decision.resultPath ?? proposal.path}. Read it with read_file.` };
}
