/** Explicit opt-ins; never enable additional paid operations from a model name. */
export interface ImageOptions {
  stream?: boolean;
  responsesModel?: string;
  seedreamMode?: "single" | "group" | "layers";
  webSearch?: boolean;
}
export function parseImageOptions(value: unknown): ImageOptions | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  const out: ImageOptions = {};
  if (typeof v.stream === "boolean") out.stream = v.stream;
  if (typeof v.webSearch === "boolean") out.webSearch = v.webSearch;
  if (typeof v.responsesModel === "string" && v.responsesModel.trim()) out.responsesModel = v.responsesModel.trim();
  if (v.seedreamMode === "single" || v.seedreamMode === "group" || v.seedreamMode === "layers") out.seedreamMode = v.seedreamMode;
  return Object.keys(out).length ? out : undefined;
}
