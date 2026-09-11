/**
 * The stream watchdog (docs/feature/agent/window-edge-plan.md D7).
 *
 * Without it a stream the endpoint stopped feeding was awaited forever. With it
 * a dead stream ends in a named error — and, just as important, a slow one does
 * not: on a local server minutes of silence are normal (prefill, and tool-call
 * arguments that arrive in one piece at the end).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_CHUNK_BASE_MS, STREAM_IDLE_MS, firstChunkDeadlineMs, streamCompletion,
  type StreamChunk,
} from "../ai";

const encoder = new TextEncoder();

/** A 200 whose body streams what `feed` pushes, and errors the way fetch does on abort. */
function stubFetch(feed: (push: (raw: string) => void, close: () => void) => void) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const signal = init.signal ?? undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
          feed((raw) => controller.enqueue(encoder.encode(raw)), () => controller.close());
        },
      });
      return new Response(stream, { status: 200 });
    }),
  );
}

const delta = (text: string) => `data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`;

function start(signal?: AbortSignal) {
  const received: StreamChunk[] = [];
  let settled = false;
  const done = streamCompletion({
    baseUrl: "http://localhost:1234/v1",
    apiKey: "",
    standard: "openai_compat",
    modelId: "local",
    messages: [{ role: "user", content: "hi" }],
    signal,
    onChunk: (c) => received.push(c),
  }).finally(() => {
    settled = true;
  });
  // Attached now so a rejection that lands during a timer advance is not "unhandled".
  done.catch(() => {});
  return { done, received, isSettled: () => settled };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("stream watchdog", () => {
  it("scales the first-chunk wait with the size of the request", () => {
    expect(firstChunkDeadlineMs(0)).toBe(FIRST_CHUNK_BASE_MS);
    // 30k tokens at the assumed 150 tokens/s of prefill: 200 s more.
    expect(firstChunkDeadlineMs(30_000)).toBe(FIRST_CHUNK_BASE_MS + 200_000);
  });

  it("gives up on a stream that never sends anything, and not before its deadline", async () => {
    stubFetch(() => {});
    const run = start();

    await vi.advanceTimersByTimeAsync(FIRST_CHUNK_BASE_MS - 1_000);
    expect(run.isSettled()).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(run.done).rejects.toMatchObject({ name: "StreamStallError", phase: "first-chunk" });
  });

  it("gives up when output started and then stopped", async () => {
    stubFetch((push) => push(delta("开头")));
    const run = start();

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_MS - 1_000);
    expect(run.isSettled()).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(run.done).rejects.toMatchObject({ name: "StreamStallError", phase: "idle" });
    // What arrived before the stall still reached the caller.
    expect(run.received).toContainEqual({ text: "开头" });
  });

  it("does not give up on a stream that is merely slow", async () => {
    // First chunk after 90 s of prefill, then a chunk every five minutes — the
    // shape of a local model writing long tool arguments.
    stubFetch((push, close) => {
      let i = 0;
      const next = () => {
        if (i < 3) {
          push(delta(`段${i++}`));
          setTimeout(next, 300_000);
        } else {
          push("data: [DONE]\n\n");
          close();
        }
      };
      setTimeout(next, 90_000);
    });
    const run = start();

    await vi.advanceTimersByTimeAsync(90_000 + 3 * 300_000 + 1_000);

    await expect(run.done).resolves.toBeUndefined();
    const text = run.received.flatMap((c) => ("text" in c ? [c.text] : [])).join("");
    expect(text).toBe("段0段1段2");
  });

  it("leaves an author's stop an AbortError, not a stall", async () => {
    stubFetch(() => {});
    const controller = new AbortController();
    const run = start(controller.signal);

    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort();

    await expect(run.done).rejects.toMatchObject({ name: "AbortError" });
  });
});
