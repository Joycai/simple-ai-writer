/**
 * The layout harvester — the only code in this app that runs inside the
 * sandboxed preview iframe.
 *
 * It exists because the webview has already done the hard part. Turning HTML
 * into slides does not require reimplementing CSS: the browser has laid the
 * page out, and `getBoundingClientRect` will say exactly where every box and
 * every line of text ended up. This file asks those questions and posts the
 * answers back; every judgement about what the answers *mean* lives in
 * `deck.ts`, which is testable.
 *
 * Constraints that shape the code:
 *
 * - **Another realm.** The frame is `blob:` + `sandbox="allow-scripts"` with no
 *   `allow-same-origin` (see HtmlPreview), so the app cannot reach in and this
 *   cannot reach out except by `postMessage`. That isolation is the security
 *   model and is not negotiable: nothing here is allowed to import from the
 *   app, and the app never executes the page's own scripts.
 * - **Plain ES5-ish JavaScript**, injected as text (`?raw`). No TypeScript, no
 *   modules, no build step — it has to survive being pasted into a document
 *   this app did not write.
 * - **Untested by the suite.** jsdom has no layout engine, so every
 *   `getBoundingClientRect` there returns zeros and a unit test would only
 *   prove the mock works. This file is therefore kept as dumb as possible —
 *   measure and classify, decide nothing — and verified against real pages.
 */

(function () {
  var NONCE = "__SAW_NONCE__";

  /** Selectors tried in order; the first that matches anything wins. */
  var SLIDE_SELECTORS = [
    "[data-slide]",
    "section.slide",
    ".slide",
    "section",
    "article",
  ];

  /** Rasterized pictures are drawn at this multiple for a crisp result. */
  var RASTER_SCALE = 2;

  /** Text smaller than this is a layout artefact rather than content. */
  var MIN_FONT_PX = 1;

  function slideRoots() {
    for (var i = 0; i < SLIDE_SELECTORS.length; i++) {
      var found = document.querySelectorAll(SLIDE_SELECTORS[i]);
      if (found.length) return Array.prototype.slice.call(found);
    }
    // A page with no sections at all is one slide: the body.
    return [document.body];
  }

  function isHidden(el, style) {
    return (
      style.visibility === "hidden" ||
      style.display === "none" ||
      parseFloat(style.opacity || "1") === 0 ||
      el.hasAttribute("data-pptx-skip")
    );
  }

  /** Does this element paint a background or a border of its own? */
  function paints(style) {
    var bg = style.backgroundColor;
    var opaque = bg && bg !== "transparent" && !/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(bg);
    var borderWidth = Math.max(
      parseFloat(style.borderTopWidth) || 0,
      parseFloat(style.borderRightWidth) || 0,
      parseFloat(style.borderBottomWidth) || 0,
      parseFloat(style.borderLeftWidth) || 0,
    );
    var borderVisible = borderWidth > 0 && style.borderTopStyle !== "none";
    return { fill: opaque ? bg : null, borderWidth: borderVisible ? borderWidth : 0 };
  }

  /**
   * Average the colour stops of a gradient.
   *
   * OOXML has gradient fills but pptxgenjs does not expose them, and a
   * gradient panel dropped entirely would leave white holes where the design
   * had colour. The average keeps the page's weight and colour family; the
   * caller records it as a degradation so the author is told rather than
   * discovering it in front of a client.
   */
  function averageColor(cssImage) {
    var found = cssImage.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}/g);
    if (!found || !found.length) return null;
    var probe = document.createElement("span");
    document.body.appendChild(probe);
    var r = 0, g = 0, b = 0, n = 0;
    for (var i = 0; i < found.length; i++) {
      probe.style.color = "";
      probe.style.color = found[i];
      var parts = getComputedStyle(probe).color.match(/[\d.]+/g);
      if (!parts) continue;
      // A fully transparent stop contributes position, not colour.
      if (parts[3] !== undefined && parseFloat(parts[3]) === 0) continue;
      r += parseFloat(parts[0]); g += parseFloat(parts[1]); b += parseFloat(parts[2]); n++;
    }
    document.body.removeChild(probe);
    if (!n) return null;
    return "rgb(" + Math.round(r / n) + ", " + Math.round(g / n) + ", " + Math.round(b / n) + ")";
  }

  function firstFamily(fontFamily) {
    if (!fontFamily) return undefined;
    return fontFamily.split(",")[0].replace(/^\s*["']|["']\s*$/g, "").trim() || undefined;
  }

  function transformText(text, style) {
    switch (style.textTransform) {
      case "uppercase": return text.toUpperCase();
      case "lowercase": return text.toLowerCase();
      case "capitalize": return text.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
      default: return text;
    }
  }

  /**
   * The list marker in front of a `<li>`, and how much room it takes.
   *
   * The marker is not a text node — it is drawn by the browser outside the
   * item's own box — so a bulleted list harvested naively arrives in PowerPoint
   * as a stack of unbulleted lines, which is the one thing a deck's audience
   * would notice immediately. It is emitted as literal text (rather than as a
   * PowerPoint bullet) because that way the glyph stays exactly where the page
   * put it: the box is widened leftwards by the marker's measured width, so
   * nothing else on the slide shifts.
   */
  function markerFor(el, style) {
    if (style.display.indexOf("list-item") < 0) return null;
    if (style.listStyleType === "none") return null;
    var text = /^(decimal|lower|upper)/.test(style.listStyleType) ? null : "• ";
    if (!text) {
      // An ordered list needs its own number, which only the marker knows.
      var index = 1;
      var sibling = el;
      while ((sibling = sibling.previousElementSibling)) index++;
      text = index + ". ";
    }
    var probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    probe.style.font = style.font || (style.fontSize + " " + style.fontFamily);
    probe.textContent = text;
    document.body.appendChild(probe);
    var width = probe.getBoundingClientRect().width;
    document.body.removeChild(probe);
    return { text: text, width: width };
  }

  /** Does this element directly contain text worth emitting? */
  function hasOwnText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var node = el.childNodes[i];
      if (node.nodeType === 3 && node.nodeValue && node.nodeValue.trim()) return true;
    }
    return false;
  }

  /**
   * Flatten an element's inline content into formatting runs.
   *
   * Run-level rather than element-level so a `<strong>` mid-sentence survives
   * as bold text in one PowerPoint paragraph instead of becoming a second text
   * box positioned next to the first.
   */
  function collectRuns(el) {
    var runs = [];
    (function walk(node) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var child = node.childNodes[i];
        if (child.nodeType === 3) {
          var raw = child.nodeValue.replace(/\s+/g, " ");
          if (!raw.trim()) {
            // Whitespace between inline elements is real spacing, but leading
            // and trailing whitespace is just source formatting.
            if (runs.length && raw === " ") runs[runs.length - 1].text += " ";
            continue;
          }
          var parent = child.parentElement || el;
          var style = getComputedStyle(parent);
          var size = parseFloat(style.fontSize) || 0;
          if (size < MIN_FONT_PX) continue;
          runs.push({
            text: transformText(raw, style),
            bold: parseInt(style.fontWeight, 10) >= 600,
            italic: style.fontStyle === "italic",
            underline: (style.textDecorationLine || style.textDecoration || "").indexOf("underline") >= 0,
            color: style.color,
            sizePx: size,
            font: firstFamily(style.fontFamily),
          });
        } else if (child.nodeType === 1) {
          var childStyle = getComputedStyle(child);
          if (isHidden(child, childStyle)) continue;
          if (child.tagName === "BR") {
            if (runs.length) runs[runs.length - 1].text += " ";
            continue;
          }
          walk(child);
        }
      }
    })(el);
    return runs;
  }

  /**
   * The tight box around an element's text, and how many lines it took.
   *
   * A Range rather than the element's own rect: a heading inside a flex
   * container that centres it has an element box the width of the container
   * and text sitting somewhere in the middle of it. PowerPoint would then be
   * told to put a left-aligned text box where the *container* is. The range
   * measures the glyphs.
   */
  function textBox(el) {
    var range = document.createRange();
    range.selectNodeContents(el);
    var box = range.getBoundingClientRect();
    var rects = range.getClientRects();
    var lines = 0;
    var lastTop = null;
    for (var i = 0; i < rects.length; i++) {
      if (rects[i].width === 0 && rects[i].height === 0) continue;
      // Client rects come one per line fragment, so inline children split a
      // line into several — count distinct baselines, not fragments.
      if (lastTop === null || Math.abs(rects[i].top - lastTop) > 1) {
        lines++;
        lastTop = rects[i].top;
      }
    }
    range.detach && range.detach();
    return { box: box, lines: Math.max(1, lines) };
  }

  function rasterizeSvg(svg, rect) {
    return new Promise(function (resolve) {
      try {
        var clone = svg.cloneNode(true);
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        clone.setAttribute("width", String(rect.width));
        clone.setAttribute("height", String(rect.height));
        var source = new XMLSerializer().serializeToString(clone);
        var img = new Image();
        img.onload = function () {
          try {
            var canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(rect.width * RASTER_SCALE));
            canvas.height = Math.max(1, Math.round(rect.height * RASTER_SCALE));
            var ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/png"));
          } catch (e) {
            resolve(null);
          }
        };
        img.onerror = function () { resolve(null); };
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(source);
      } catch (e) {
        resolve(null);
      }
    });
  }

  function rasterizeImg(img, rect) {
    // Already self-contained: the app inlines every local picture as a data
    // URL before the frame loads (lib/fs/htmlDoc), so this is the normal path.
    if (img.currentSrc && img.currentSrc.indexOf("data:") === 0) {
      return Promise.resolve(img.currentSrc);
    }
    return new Promise(function (resolve) {
      try {
        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(rect.width * RASTER_SCALE));
        canvas.height = Math.max(1, Math.round(rect.height * RASTER_SCALE));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        // A remote picture taints the canvas and this throws — the honest
        // outcome is "this one is missing", not a blank rectangle.
        resolve(canvas.toDataURL("image/png"));
      } catch (e) {
        resolve(null);
      }
    });
  }

  function harvestSlide(root) {
    var origin = root.getBoundingClientRect();
    var blocks = [];
    var degraded = [];
    var pending = [];

    function push(block, rect) {
      block.x = rect.left - origin.left;
      block.y = rect.top - origin.top;
      block.w = rect.width;
      block.h = rect.height;
      blocks.push(block);
    }

    (function walk(el, insideText) {
      var style = getComputedStyle(el);
      if (isHidden(el, style)) return;
      var rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      var tag = el.tagName;

      if (tag === "IMG") {
        var imgRect = rect;
        pending.push(
          rasterizeImg(el, imgRect).then(function (data) {
            if (data) push({ kind: "image", data: data }, imgRect);
            else degraded.push("a picture could not be embedded (" + (el.getAttribute("alt") || el.src.slice(0, 40)) + ")");
          }),
        );
        return;
      }

      if (tag === "svg" || tag === "SVG") {
        var svgRect = rect;
        pending.push(
          rasterizeSvg(el, svgRect).then(function (data) {
            if (data) push({ kind: "image", data: data }, svgRect);
            else degraded.push("an inline SVG could not be rasterized");
          }),
        );
        return;
      }

      if (tag === "CANVAS") {
        try {
          push({ kind: "image", data: el.toDataURL("image/png") }, rect);
        } catch (e) {
          degraded.push("a <canvas> could not be read");
        }
        return;
      }

      // The slide root itself contributes its background, nothing else.
      var paint = paints(style);
      var fill = paint.fill;
      if (style.backgroundImage && style.backgroundImage !== "none") {
        var average = averageColor(style.backgroundImage);
        if (average) {
          fill = average;
          degraded.push("a gradient/image background became a solid colour");
        } else {
          degraded.push("a background image was dropped");
        }
      }
      if (fill || paint.borderWidth) {
        push(
          {
            kind: "rect",
            fill: fill || undefined,
            line: paint.borderWidth
              ? { color: style.borderTopColor, widthPx: paint.borderWidth }
              : undefined,
            radiusPx: parseFloat(style.borderTopLeftRadius) || 0,
          },
          rect,
        );
      }

      var ownText = !insideText && hasOwnText(el);
      if (ownText) {
        var measured = textBox(el);
        var runs = collectRuns(el);
        if (runs.length && measured.box.width > 0) {
          var box = measured.box;
          var marker = markerFor(el, style);
          if (marker && runs.length) {
            runs[0] = {
              text: marker.text + runs[0].text,
              bold: runs[0].bold,
              italic: runs[0].italic,
              underline: runs[0].underline,
              color: runs[0].color,
              sizePx: runs[0].sizePx,
              font: runs[0].font,
            };
            box = {
              left: box.left - marker.width,
              top: box.top,
              width: box.width + marker.width,
              height: box.height,
            };
          }
          push(
            {
              kind: "text",
              runs: runs,
              align: normalizeAlign(style.textAlign, style.direction),
              lines: measured.lines,
            },
            box,
          );
        }
      }

      for (var i = 0; i < el.children.length; i++) {
        walk(el.children[i], insideText || ownText);
      }
    })(root, false);

    return Promise.all(pending).then(function () {
      return { blocks: blocks, degraded: unique(degraded) };
    });
  }

  function normalizeAlign(align, direction) {
    switch (align) {
      case "center": return "center";
      case "right": return "right";
      case "justify": return "justify";
      case "end": return direction === "rtl" ? "left" : "right";
      case "start": return direction === "rtl" ? "right" : "left";
      default: return "left";
    }
  }

  function unique(list) {
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (seen[list[i]]) continue;
      seen[list[i]] = true;
      out.push(list[i]);
    }
    return out;
  }

  function send(payload) {
    payload.type = "saw-pptx-harvest";
    payload.nonce = NONCE;
    parent.postMessage(payload, "*");
  }

  function run() {
    try {
      var roots = slideRoots();
      if (!roots.length) {
        send({ ok: false, error: "no slides found in this page" });
        return;
      }
      var first = roots[0].getBoundingClientRect();
      if (first.width <= 0 || first.height <= 0) {
        send({ ok: false, error: "the first slide has no size" });
        return;
      }
      Promise.all(roots.map(harvestSlide)).then(
        function (slides) {
          send({
            ok: true,
            deck: {
              canvas: { width: first.width, height: first.height },
              slides: slides,
            },
          });
        },
        function (e) { send({ ok: false, error: String(e) }); },
      );
    } catch (e) {
      send({ ok: false, error: String(e) });
    }
  }

  /**
   * Measure only once everything that affects layout has settled: web fonts
   * shift every text box, and a picture without intrinsic size shifts the
   * boxes around it. The extra tick afterwards gives late script-driven layout
   * (a chart library, a `DOMContentLoaded` handler) a chance to finish.
   *
   * Timers rather than `requestAnimationFrame`, which is what this originally
   * used and why it originally never returned: the export frame is deliberately
   * offscreen and hidden, and a frame that is not being painted has its
   * animation callbacks suspended — the measurement simply never ran. Layout
   * has already happened by `load`; the wait is for fonts, not for a frame.
   *
   * The fallback timer is not belt-and-braces either: `document.fonts.ready`
   * can stay pending in a document whose font requests never settle, and an
   * export that hangs forever is worse than one measured a beat early.
   */
  function whenSettled() {
    var done = false;
    function go() {
      if (done) return;
      done = true;
      run();
    }
    var fonts = document.fonts && document.fonts.ready;
    if (fonts && fonts.then) {
      fonts.then(function () { setTimeout(go, 32); }, function () { setTimeout(go, 32); });
    } else {
      setTimeout(go, 32);
    }
    setTimeout(go, 1500);
  }

  if (document.readyState === "complete") whenSettled();
  else window.addEventListener("load", whenSettled);
})();
