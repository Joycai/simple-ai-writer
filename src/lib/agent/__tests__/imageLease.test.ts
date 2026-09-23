import { describe, expect, it } from "vitest";
import type { StreamMessage } from "../../ai/types";
import { createSessionMeta, noteTurnStart } from "../compact";
import { elideExpiredTurnImages, IMAGE_LEASE_TURNS } from "../imageLease";
import { hasImageParts } from "../imageHistory";

const pic = (text: string): StreamMessage => ({
  role: "user",
  content: [
    { type: "text", text },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ],
});
const say = (text: string): StreamMessage => ({ role: "assistant", content: text });

/** A chat history of `n` turns; `withPicture` says which turns open with one. */
function chat(withPicture: boolean[]) {
  const meta = createSessionMeta();
  const history: StreamMessage[] = [{ role: "system", content: "s" }];
  const starts: StreamMessage[] = [];
  withPicture.forEach((p, i) => {
    const q = p ? pic(`【附图】\n1. 粘贴的图片 ${i + 1} — .ai-writer/tmp/chat/s/${i}.png`) : ({ role: "user", content: `q${i}` } as StreamMessage);
    noteTurnStart(meta, q);
    history.push(q, say(`a${i}`));
    starts.push(q);
  });
  return { history, meta, starts };
}

describe("elideExpiredTurnImages", () => {
  it("keeps one turn of lease", () => {
    expect(IMAGE_LEASE_TURNS).toBe(1);
  });

  it("keeps pixels for the turn they came in and the next, drops them on the one after", () => {
    // Turn 2 has just opened: turn 1's picture is still leased.
    const two = chat([true, false]);
    expect(elideExpiredTurnImages(two.history, two.meta)).toBe(0);
    expect(hasImageParts(two.starts[0])).toBe(true);

    // Turn 3 opens: turn 1's picture leaves, its words (and path) stay.
    const three = chat([true, false, false]);
    expect(elideExpiredTurnImages(three.history, three.meta)).toBe(1);
    expect(hasImageParts(three.starts[0])).toBe(false);
    const text = JSON.stringify(three.starts[0].content);
    expect(text).toContain(".ai-writer/tmp/chat/s/0.png");
    // No tool named: which one reads it back depends on the run.
    expect(text).toContain("read it again");
    expect(text).not.toContain("read_image it");
  });

  it("expires a turn's pictures together, tool reads included", () => {
    const { history, meta, starts } = chat([true, false, true]);
    // A read_image follow-up spliced into turn 1: not a turn start, same turn.
    history.splice(2, 0, pic("Visual reference for read_image: assets/x.png"));
    expect(elideExpiredTurnImages(history, meta)).toBe(2);
    expect(history.filter(hasImageParts)).toEqual([starts[2]]);
  });

  it("does not count a question that got no answer", () => {
    // Turn 2 failed before any reply; the author asks again as turn 3. The
    // picture is still leased: nothing has been answered since it arrived.
    const { history, meta, starts } = chat([true, false, false]);
    history.splice(history.indexOf(starts[1]) + 1, 1); // turn 2's answer never came
    expect(elideExpiredTurnImages(history, meta)).toBe(0);
    expect(hasImageParts(starts[0])).toBe(true);
  });

  it("leaves a history with no recorded turns alone", () => {
    const history: StreamMessage[] = [{ role: "system", content: "s" }, pic("seed")];
    expect(elideExpiredTurnImages(history, createSessionMeta())).toBe(0);
    expect(hasImageParts(history[1])).toBe(true);
  });

  it("does nothing more when called again within the same turn", () => {
    const { history, meta } = chat([true, true, false]);
    elideExpiredTurnImages(history, meta);
    const before = JSON.stringify(history);
    expect(elideExpiredTurnImages(history, meta)).toBe(0);
    expect(JSON.stringify(history)).toBe(before);
  });
});
