/**
 * Rendering a project `.html` offscreen and collecting what the browser
 * measured.
 *
 * The frame is built exactly the way the preview pane builds its own — a
 * `blob:` URL and `sandbox="allow-scripts"` with no `allow-same-origin` — so
 * the page's scripts stay in an opaque origin that cannot reach this app, its
 * IPC, or the filesystem. Because of that isolation the app also cannot read
 * the frame's DOM, which is why the measuring code is *injected* and answers
 * by `postMessage` rather than being called.
 *
 * The message is trusted on two independent checks: it must come from this
 * frame's own `contentWindow`, and it must carry the one-time nonce this run
 * put on the script tag. A page that tries to answer on another page's behalf
 * has neither.
 *
 * ## Why the script is allowed to run at all
 *
 * A `blob:` document **inherits the CSP of the page that created it** — being
 * an opaque origin exempts it from same-origin access, not from policy. The
 * app ships `script-src 'self'`, so for a while this frame ran no script
 * whatsoever: every export timed out waiting for an answer that could never
 * come, on any page, including a blank one.
 *
 * The fix is the mechanism CSP hashes exist for: `tauri.conf.json` allows
 * `'sha256-<this file>'`, so *this* script runs and any other inline script —
 * including whatever the page brought with it — still does not. The threat
 * model is therefore unchanged and, if anything, stated more sharply than the
 * sandbox alone stated it.
 *
 * Two consequences to keep in mind when editing `harvester.js`:
 *
 * 1. **The hash is over its exact bytes.** Change the file and the hash in
 *    `tauri.conf.json` must change with it — `pptxHarvesterCsp.test.ts` fails
 *    when they drift, because the symptom otherwise is a silent 20-second
 *    timeout with nothing in any log.
 * 2. **Per-run data travels on attributes, never in the text.** The nonce is
 *    read from `data-nonce`; splicing it into the source would change the
 *    hash on every run.
 */

import { nanoid } from "nanoid";
import harvesterSource from "./harvester.js?raw";
import { inlineHtmlImages } from "../fs/htmlDoc";
import type { HarvestedDeck } from "./deck";

/**
 * The harvester exactly as it is hashed: newlines normalised, nothing else.
 *
 * Normalising is what keeps the hash stable across checkouts — a CRLF clone on
 * Windows would otherwise compute a different digest from the one in
 * `tauri.conf.json` and break the export for that machine only.
 */
export const HARVESTER_SOURCE = harvesterSource.replace(/\r\n/g, "\n");

/**
 * Viewport the page is laid out in.
 *
 * It decides the deck size only for pages written in viewport units
 * (`width: 100vw`); a deck with explicit slide dimensions ignores it. 16:9 at
 * 1280×720 is both the common case and the ratio a `vw`-based page should get
 * by default, and it makes 96px equal 1 inch — so `font-size: 32px` lands as
 * 24pt, the size the author would have picked in PowerPoint.
 */
const VIEWPORT = { width: 1280, height: 720 };

/** How long a page may take to lay out before the export gives up. */
const TIMEOUT_MS = 20_000;

interface HarvestMessage {
  type: string;
  nonce: string;
  ok: boolean;
  error?: string;
  deck?: HarvestedDeck;
}

/**
 * Lay `html` out offscreen and return what it measured.
 *
 * `baseDir` is the document's own folder: relative `<img src="assets/…">`
 * links resolve against nothing inside a blob document, so the pictures are
 * inlined first — the same preparation the preview pane does.
 */
export async function harvestDeck(
  html: string,
  baseDir: string | null,
): Promise<HarvestedDeck> {
  // A failed image walk must not sink the export: the deck still converts,
  // with the same holes the author already sees in the preview.
  const prepared = await inlineHtmlImages(html, baseDir).catch(() => html);
  const nonce = nanoid();
  // The nonce rides on an attribute: the script's text is what the CSP hash
  // covers, so it must be byte-identical every run.
  const script = `<script data-nonce="${nonce}">${HARVESTER_SOURCE}</script>`;
  const document_ = prepared.match(/<\/body>/i)
    ? prepared.replace(/<\/body>/i, `${script}</body>`)
    : `${prepared}\n${script}`;

  const url = URL.createObjectURL(new Blob([document_], { type: "text/html" }));
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("aria-hidden", "true");
  // Offscreen rather than `display: none` — a frame that is not laid out
  // measures every box as zero, which is precisely what this needs from it.
  frame.style.cssText =
    `position:fixed;left:-${VIEWPORT.width * 2}px;top:0;border:0;` +
    `width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;visibility:hidden;`;

  try {
    return await new Promise<HarvestedDeck>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMessage);
        clearTimeout(timer);
        fn();
      };

      const onMessage = (event: MessageEvent) => {
        // Both checks matter: the source proves it is *this* frame (the origin
        // of a blob document is opaque and identifies nothing), and the nonce
        // proves it is the script we injected rather than the page's own.
        if (event.source !== frame.contentWindow) return;
        const message = event.data as HarvestMessage | null;
        if (!message || message.type !== "saw-pptx-harvest" || message.nonce !== nonce) return;
        if (!message.ok || !message.deck) {
          finish(() => reject(new Error(message?.error || "the page could not be measured")));
          return;
        }
        const deck = message.deck;
        finish(() => resolve(deck));
      };

      const timer = setTimeout(() => {
        finish(() =>
          reject(new Error(`the page did not finish rendering within ${TIMEOUT_MS / 1000}s`)),
        );
      }, TIMEOUT_MS);

      window.addEventListener("message", onMessage);
      frame.src = url;
      document.body.appendChild(frame);
    });
  } finally {
    frame.remove();
    URL.revokeObjectURL(url);
  }
}
