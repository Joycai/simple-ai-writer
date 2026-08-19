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
 * frame's own `contentWindow`, and it must carry the one-time nonce that was
 * compiled into the script. A page that tries to answer on another page's
 * behalf has neither.
 */

import { nanoid } from "nanoid";
import harvesterSource from "./harvester.js?raw";
import { inlineHtmlImages } from "../fs/htmlDoc";
import type { HarvestedDeck } from "./deck";

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
  const script = `<script>${harvesterSource.replace("__SAW_NONCE__", nonce)}</script>`;
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
