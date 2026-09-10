/**
 * `planImageReads` — the rule behind useImageDataUrls / useImageThumbnails.
 *
 * Those hooks used to re-read every path whenever the list changed and throw
 * the result away on arrival if the map already held it: adding the 21st
 * picture to a gallery re-read and re-encoded all 21, one new avatar on the
 * wall re-encoded every avatar on it. The decision now happens before the
 * read, and this pins what it decides.
 */
import { describe, expect, it } from "vitest";
import { planImageReads } from "../../components/lore/useImageDataUrl";

const held = { "/a.png": "data:a", "/b.png": "data:b" };

describe("planImageReads", () => {
  it("reads only the path it does not hold yet", () => {
    const { kept, toLoad } = planImageReads(held, ["/a.png", "/b.png", "/c.png"]);
    expect(toLoad).toEqual(["/c.png"]);
    expect(kept).toEqual(held);
  });

  it("drops what is no longer asked for and reads nothing", () => {
    const { kept, toLoad } = planImageReads(held, ["/b.png"]);
    expect(kept).toEqual({ "/b.png": "data:b" });
    expect(toLoad).toEqual([]);
  });

  it("an unchanged list means no reads at all", () => {
    expect(planImageReads(held, ["/b.png", "/a.png"]).toLoad).toEqual([]);
  });

  it("starts cold by reading everything, each path once", () => {
    const { kept, toLoad } = planImageReads({}, ["/a.png", "/a.png", "/b.png"]);
    expect(kept).toEqual({});
    expect(toLoad).toEqual(["/a.png", "/b.png"]);
  });
});
