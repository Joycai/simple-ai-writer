/** SSE framing shared by image transports; JSON never split across chunks. */
export async function* imageEvents(response: Response, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error("Image stream has no response body");
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done) buffer += "\n\n";
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        else if (!line && data.length) {
          const payload = data.join("\n"); data = [];
          if (payload === "[DONE]") return;
          const event = JSON.parse(payload);
          if (event && typeof event === "object") yield event;
        }
      }
      if (done) return;
    }
  } finally { signal?.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
