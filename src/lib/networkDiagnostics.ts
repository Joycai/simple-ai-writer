/** Rust HTTP diagnostics travel as a string so existing rejection handling stays intact. */
export function networkDiagnostics(error: unknown): Record<string, unknown> | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const marker = "\n[network-details] ";
  const offset = message.lastIndexOf(marker);
  if (offset < 0) return undefined;
  try {
    const value: unknown = JSON.parse(message.slice(offset + marker.length));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
