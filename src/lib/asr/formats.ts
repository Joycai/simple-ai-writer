/**
 * 哪些文件能送去转写——按扩展名，和 `lib/fs/images` 判图片 / 文本是同一种判法。
 *
 * 住在这里而不是 `lib/fs/images`：那边的 `ProjectFileKind` 的含义是"能发给助手
 * 当附件"，而音频发不了（没有模型 API 收它，见 docs/feature/asr/00-research.md
 * §1.2）；把音频塞进那根轴会让 `@` 选择器和 `classifyProjectFile` 各开一个例外。
 * 这份清单只回答一个问题：这个文件**能不能转写**。
 *
 * 十七个格式来自平台的「非实时」音频规格表（研究稿 §1.1）：视频容器直接吃，
 * 服务端自己抽音轨。`pcm` 不在里面——它要求 16 kHz 且文件头里没有采样率，
 * 作者没法知道自己那份对不对，猜错的结果是一份全是噪音的文字稿。
 */

export const ASR_AUDIO_EXTENSIONS: readonly string[] =
  ["aac", "amr", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma"];

export const ASR_VIDEO_EXTENSIONS: readonly string[] =
  ["avi", "flv", "mkv", "mov", "mp4", "mpeg", "webm", "wmv"];

const ALL = new Set([...ASR_AUDIO_EXTENSIONS, ...ASR_VIDEO_EXTENSIONS]);

/** 转写工具拒绝时报给模型看的清单。 */
export const ASR_EXT_LIST = [...ALL].join(", ");

/** 小写扩展名（不带点），不能转写就 null。`path` 可以是完整路径也可以只是文件名。 */
export function transcribeExtOf(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return ALL.has(ext) ? ext : null;
}

/** 视频容器？（只影响确认卡上的措辞：「会抽取音轨」。） */
export function isVideoExt(ext: string): boolean {
  return ASR_VIDEO_EXTENSIONS.includes(ext.toLowerCase());
}
