import { DECK_LIMITS as L, type DeckSpec } from "./model";
import { DECK_THEMES } from "./theme";
import type { DeckDiagnostic, DeckDiagnosticCode, DeckValidation } from "./diagnostics";

const hasOwn = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);

type Rule = (value: unknown, path: string, report: Report) => void;
type Report = (code: DeckDiagnosticCode, path: string) => void;
const pointer = (path: string, key: string | number) => `${path}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const choice = (...values: unknown[]): Rule => (v, p, r) => { if (!values.includes(v)) r("invalid_value", p); };
const text = (max: number, empty = false): Rule => (v, p, r) => {
  if (typeof v !== "string") { r("invalid_type", p); return; }
  if (v.length > max) r("limit_exceeded", p);
  // XML 1.0 text must not contain illegal controls or unpaired UTF-16 surrogates.
  if ((!empty && !v.trim()) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)) r("invalid_value", p);
};
const id: Rule = (v, p, r) => {
  if (typeof v !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v)) r("invalid_value", p);
};
const list = (item: Rule, max: number, min = 1): Rule => (v, p, r) => {
  if (!Array.isArray(v)) { r("invalid_type", p); return; }
  if (v.length < min || v.length > max) { r("limit_exceeded", p); return; }
  // Index iteration also rejects sparse arrays supplied by non-JSON callers.
  for (let i = 0; i < v.length; i++) item(v[i], pointer(p, i), r);
};
const object = (required: Record<string, Rule>, optional: Record<string, Rule> = {}): Rule => (v, p, r) => {
  if (!record(v)) { r("invalid_type", p); return; }
  for (const key of Object.keys(v)) {
    if (!hasOwn(required, key) && !hasOwn(optional, key)) r("unknown_field", pointer(p, key));
  }
  for (const [key, rule] of Object.entries(required)) rule(hasOwn(v, key) ? v[key] : undefined, pointer(p, key), r);
  for (const [key, rule] of Object.entries(optional)) if (hasOwn(v, key)) rule(v[key], pointer(p, key), r);
};
const unit: Rule = (v, p, r) => { if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) r("invalid_value", p); };
const assetPath: Rule = (v, p, r) => {
  if (typeof v !== "string" || v.length > 1024 || !v.trim() ||
    /[\\:%?#\u0000-\u001F\u007F]/.test(v) ||
    v.split("/").some(part => !part || part === "." || part === ".." || part.trim() !== part) ||
    !/\.(png|jpe?g)$/i.test(v)) r("unsafe_path", p);
};
const bullets = list(text(L.text), L.bullets);
const column = object({ heading: text(L.title), bullets });
const common = { id, title: text(L.title) };
const optional = { notes: text(L.notes, true) };
const layouts: Record<string, Rule> = {
  title: object({ ...common, layout: choice("title") }, { ...optional, subtitle: text(L.text) }),
  bullets: object({ ...common, layout: choice("bullets"), bullets }, optional),
  comparison: object({ ...common, layout: choice("comparison"), left: column, right: column }, optional),
  "image-text": object({ ...common, layout: choice("image-text"), body: text(L.text), image: object({
    assetId: id, alt: text(L.text), fit: choice("contain", "cover"), anchor: object({ x: unit, y: unit }),
  }) }, optional),
  metrics: object({ ...common, layout: choice("metrics"), metrics: list(object({
    label: text(L.title), value: text(L.title),
  }, { detail: text(L.text) }), L.metrics) }, optional),
  table: object({ ...common, layout: choice("table"), columns: list(text(L.title), L.columns),
    rows: list(list(text(L.text, true), L.columns), L.rows) }, optional),
};
const slide: Rule = (v, p, r) => {
  if (!record(v)) { r("invalid_type", p); return; }
  if (typeof v.layout !== "string" || !hasOwn(layouts, v.layout)) { r("invalid_value", pointer(p, "layout")); return; }
  layouts[v.layout](v, p, r);
};
const deck = object({
  version: choice(1), language: choice("en-US", "zh-CN"), theme: choice(...Object.keys(DECK_THEMES)),
  assets: list(object({ id, path: assetPath }), L.assets, 0), slides: list(slide, L.slides),
});

/** Shape and semantic checks only: does not read images, discover fonts, or measure layout. */
export function validateDeckSpec(input: unknown): DeckValidation<DeckSpec> {
  const diagnostics: DeckDiagnostic[] = [];
  const report: Report = (code, path) => {
    const match = /^\/slides\/(\d+)(?:\/|$)/.exec(path);
    const entry = match && record(input) && Array.isArray(input.slides) ? input.slides[Number(match[1])] : null;
    diagnostics.push({ code, path, ...(record(entry) && typeof entry.id === "string" ? { slideId: entry.id } : {}) });
  };
  if (record(input) && input.version !== 1) {
    report("unsupported_version", "/version");
    return { ok: false, diagnostics };
  }
  deck(input, "", report);
  if (diagnostics.length) return { ok: false, diagnostics };
  // Only cast after all fields of the discriminated union have been validated.
  const value = input as DeckSpec;
  for (const key of ["assets", "slides"] as const) {
    const seen = new Set<string>();
    value[key].forEach((item, i) => {
      if (seen.has(item.id)) report("duplicate_id", `/${key}/${i}/id`);
      seen.add(item.id);
    });
  }
  const assets = new Set(value.assets.map(a => a.id));
  value.slides.forEach((s, i) => {
    if (s.layout === "image-text" && !assets.has(s.image.assetId)) report("missing_asset", `/slides/${i}/image/assetId`);
    if (s.layout === "table") s.rows.forEach((row, j) => {
      if (row.length !== s.columns.length) report("table_width", `/slides/${i}/rows/${j}`);
    });
  });
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value, diagnostics: [] };
}

/** Bound bytes before JSON parsing. No DOM, file system, or Office dependency. */
export function parseDeckSpec(source: string): DeckValidation<DeckSpec> {
  if (source.length > L.sourceBytes || new TextEncoder().encode(source).byteLength > L.sourceBytes)
    return { ok: false, diagnostics: [{ code: "source_limit", path: "" }] };
  let input: unknown;
  try { input = JSON.parse(source); }
  catch { return { ok: false, diagnostics: [{ code: "invalid_json", path: "" }] }; }
  return validateDeckSpec(input);
}
