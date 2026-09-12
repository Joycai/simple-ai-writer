/**
 * The one builder for a picture's content part, and the author's detail knob.
 *
 * ## Why a builder rather than eight object literals
 *
 * Eight call sites hand a picture to a model — the chat composer's `@`
 * attachments, the tool loop's `read_image` follow-up, the vision subagent,
 * three lore paths, the image-review pass, the meta-improve modal — and every
 * one of them wrote `{ type: "image_url", image_url: { url } }` inline. That
 * was fine while the part had exactly one field. It stops being fine the
 * moment a second field exists that the author controls: seven sites honouring
 * it and one forgetting is invisible in review and invisible at runtime.
 *
 * ## What `detail` is
 *
 * Both OpenAI and DeepSeek accept an optional `detail` beside the URL, and
 * they agree on the two values that matter:
 *
 *   - `low`  — the endpoint scales the picture to 512×512 before looking at
 *              it. Fewer tokens, less time, and the first thing it destroys is
 *              small text: a screenshot's UI labels, a scanned table's cells.
 *   - `high` — full resolution, whatever the endpoint's own ceiling allows.
 *   - `auto` — the endpoint decides. This is also what *absence* means, which
 *              is why this module never sends the string: an omitted field and
 *              `"auto"` are the same request, and omitting it keeps every
 *              endpoint that never heard of `detail` byte-identical to before.
 *
 * DeepSeek documents a fourth value, `original`, and says in the same table
 * that `high` is provided for compatibility and is equivalent to it — so the
 * two-value vocabulary above reaches everything `original` would, without
 * sending an enum member that OpenAI would reject.
 *
 * ## Why the default is "send nothing"
 *
 * The knob is a real trade, not a free win. `low` is right for "read the
 * heading off this poster" and wrong for "why is this chart's third bar
 * misaligned" — and the app can't tell those apart from the call site. So the
 * author sets it, the setting's hint says plainly what it costs, and an author
 * who never opens that page gets exactly the requests they got before this
 * module existed.
 */

import { readPref } from "../prefs";
import type { ContentPart, ImageDetail } from "./types";

/** Where the author's detail preference is stored. */
export const IMAGE_DETAIL_KEY = "app:imageDetail";

/** The choices the settings page offers, in display order. "" = send nothing. */
export const IMAGE_DETAIL_CHOICES = ["", "low", "high"] as const;

/**
 * The author's choice, read at call time.
 *
 * A preference read here rather than an argument threaded from the UI, for the
 * same reason `imageMaxLongEdge()` is one: every path that sends a picture
 * would otherwise have to carry it, and the one that forgot would quietly
 * disagree with the others about how much of the picture to pay for.
 */
export function imageDetail(): ImageDetail | undefined {
  const raw = readPref(IMAGE_DETAIL_KEY);
  return raw === "low" || raw === "high" ? raw : undefined;
}

/**
 * A picture, as the wire carries it.
 *
 * `detail` is an explicit override for the rare call site that knows better
 * than the author's default; passing `"auto"` means "send nothing" and is how
 * a path opts out of the preference entirely.
 */
export function imagePart(url: string, detail?: ImageDetail | "auto"): ContentPart {
  const d = detail === undefined ? imageDetail() : detail === "auto" ? undefined : detail;
  return { type: "image_url", image_url: d ? { url, detail: d } : { url } };
}
