export type DeckDiagnosticCode =
  | "invalid_json" | "source_limit" | "unsupported_version" | "invalid_type"
  | "unknown_field" | "invalid_value" | "limit_exceeded" | "duplicate_id"
  | "unsafe_path" | "missing_asset" | "table_width" | "invalid_image"
  | "image_limit";

/** RFC 6901 JSON pointer; empty path means the whole document. No UI prose yet. */
export interface DeckDiagnostic {
  code: DeckDiagnosticCode;
  path: string;
  slideId?: string;
}

export type DeckValidation<T> =
  | { ok: true; value: T; diagnostics: [] }
  | { ok: false; diagnostics: DeckDiagnostic[] };
