import { describe, expect, it } from "vitest";
import {
  clearMentionReadFailures,
  failMentionRead,
  isMentionReading,
  mentionReadFailure,
  takeMentionReadFailure,
  trackMentionRead,
} from "../mentionReads";

describe("a draft with a pick's file still reading", () => {
  /** A read the test settles by hand. */
  function deferred<T>() {
    let resolve!: (v: T) => void, reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it("counts from the read's start until it settles, and passes its result through", async () => {
    const read = deferred<string>();
    const tracked = trackMentionRead("chat:c1", () => read.promise);
    expect(isMentionReading("chat:c1")).toBe(true);
    read.resolve("潮汐.png");
    await expect(tracked).resolves.toBe("潮汐.png");
    expect(isMentionReading("chat:c1")).toBe(false);
  });

  it("stops counting a read that fails, and passes the failure through", async () => {
    const read = deferred<string>();
    const tracked = trackMentionRead("roleplay:沈砚", () => read.promise);
    read.reject(new Error("读不到"));
    await expect(tracked).rejects.toThrow("读不到");
    expect(isMentionReading("roleplay:沈砚")).toBe(false);
  });

  it("keeps drafts apart, and holds one until every read in it is done", async () => {
    const a = deferred<void>(), b = deferred<void>(), other = deferred<void>();
    const ta = trackMentionRead("chat:c2", () => a.promise);
    const tb = trackMentionRead("chat:c2", () => b.promise);
    const to = trackMentionRead("chat:c3", () => other.promise);
    a.resolve();
    await ta;
    expect(isMentionReading("chat:c2")).toBe(true);
    other.resolve();
    await to;
    expect(isMentionReading("chat:c3")).toBe(false);
    expect(isMentionReading("chat:c2")).toBe(true);
    b.resolve();
    await tb;
    expect(isMentionReading("chat:c2")).toBe(false);
  });

  it("holds the draft until the pick has landed, not just until the file is read", async () => {
    // Dropping the count re-renders at once — a render that let a queued
    // send through before the landing would send the draft without it.
    const read = deferred<string>();
    let draft = "看看@潮";
    const seen: boolean[] = [];
    const tracked = trackMentionRead("lore:r1", async () => {
      const name = await read.promise;
      seen.push(isMentionReading("lore:r1"));
      draft = `看看@[${name}]`;
    });
    read.resolve("潮汐.png");
    await tracked;
    expect(seen).toEqual([true]);
    expect(isMentionReading("lore:r1")).toBe(false);
    expect(draft).toBe("看看@[潮汐.png]");
  });
});

describe("a pick's read that failed", () => {
  it("stays on the draft until an instance showing it takes it", () => {
    failMentionRead("chat:f1", "读不到 潮汐.png");
    const failure = mentionReadFailure("chat:f1");
    expect(failure?.message).toBe("读不到 潮汐.png");
    // Read again (a render, a remount) it is the same one, until taken.
    expect(mentionReadFailure("chat:f1")).toBe(failure);
    takeMentionReadFailure("chat:f1", failure!);
    expect(mentionReadFailure("chat:f1")).toBeNull();
  });

  it("never lets taking an older failure drop a newer one", () => {
    failMentionRead("chat:f2", "读不到 潮汐.png");
    const older = mentionReadFailure("chat:f2")!;
    failMentionRead("chat:f2", "读不到 雾港.md");
    const newer = mentionReadFailure("chat:f2");
    takeMentionReadFailure("chat:f2", older);
    expect(mentionReadFailure("chat:f2")).toBe(newer);
    expect(newer?.message).toBe("读不到 雾港.md");
  });

  it("keeps drafts apart", () => {
    failMentionRead("roleplay:林汀", "读不到 潮汐.png");
    expect(mentionReadFailure("roleplay:林汀")).not.toBeNull();
    expect(mentionReadFailure("roleplay:沈砚")).toBeNull();
    takeMentionReadFailure("roleplay:林汀", mentionReadFailure("roleplay:林汀")!);
  });

  it("is already there when the count drops, recorded inside the pick", async () => {
    // The render that lets a queued send through is the one the count drop
    // brings; it must see the failure too, or the send goes out bare.
    let finish!: () => void;
    const read = new Promise<void>((res) => { finish = res; });
    const tracked = trackMentionRead("chat:f3", async () => {
      await read;
      failMentionRead("chat:f3", "潮汐.png 太大");
      // Recorded while the draft still counts as reading — the order a host
      // keeps by calling `fail` inside the pick it hands to `track`.
      expect(isMentionReading("chat:f3")).toBe(true);
    });
    expect(mentionReadFailure("chat:f3")).toBeNull();
    finish();
    await tracked;
    expect(isMentionReading("chat:f3")).toBe(false);
    expect(mentionReadFailure("chat:f3")?.message).toBe("潮汐.png 太大");
  });
});

describe("dropping every failure with every draft", () => {
  it("clears the failures and leaves reads still running counted", async () => {
    failMentionRead("roleplay:林汀", "读不到 潮汐.png");
    failMentionRead("chat:g1", "读不到 雾港.md");
    let finish!: () => void;
    const tracked = trackMentionRead("chat:g2", () => new Promise<void>((res) => { finish = res; }));
    clearMentionReadFailures();
    expect(mentionReadFailure("roleplay:林汀")).toBeNull();
    expect(mentionReadFailure("chat:g1")).toBeNull();
    expect(isMentionReading("chat:g2")).toBe(true);
    finish();
    await tracked;
    expect(isMentionReading("chat:g2")).toBe(false);
  });
});
