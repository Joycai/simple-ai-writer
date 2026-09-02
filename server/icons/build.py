"""Icon build for the knowledge-base server (`aiw-kb-server` / `aiw-kb-tray`).

    python build.py            # needs Pillow only

Writes, next to this file (all of it is committed — the build.rs embeds the
.ico files, nothing at build time needs Python):

    app.ico             exe icon of both binaries, 16…256 px
    tray-running.ico    tray glyph while the server is up,    16…64 px
    tray-stopped.ico    tray glyph while it is stopped
    app.svg             the exe icon as a vector, for docs / previews

Design
------
The app's mark is a stack seen from above — a solid diamond (the top sheet)
with one open chevron under it. The server is *where the stack is kept*, so
its mark is the same stack, three tiers deep: a rack, or a pile of bound
volumes — and it sits on ink rather than paper, the night-side twin of the
desk-side app. Same sienna, same slopes; nobody should need a label to see
they belong together, and nobody should mistake one for the other.

The tray glyph is that stack pixel-fitted to 16 px (the only size Windows
shows at 100 %): a 16×8 diamond and two 2 px chevrons, so every edge lands
on a pixel boundary where it matters. State lives in the glyph, not in a
badge: running = solid diamond in sienna, stopped = hollow diamond in grey.
Two channels (fill and colour) so it reads on a dark and on a light taskbar.

Everything is drawn from the numbers below at 8× and box-filtered down, so
each .ico frame is rendered for its size rather than scaled from 256.
"""

from __future__ import annotations

import struct
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
SS = 8  # supersampling factor

# ---- palette (design tokens; see src/styles/tokens.css) --------------------
INK = (31, 27, 22)  # --color-paper, dark theme
AMBER = (201, 150, 106)  # --color-amber
SIENNA_ON_INK = (217, 146, 91)  # --color-sienna, dark theme
FACET_SHADE = (107, 52, 23)  # the app icon's darker right facet, at 0.32
TRAY_RUNNING = (201, 122, 71)
TRAY_STOPPED = (140, 129, 114)  # between the two themes' muted text


def blend(base, over, a):
    return tuple(round(b * (1 - a) + o * a) for b, o in zip(base, over))


# ---- geometry, in a 256-unit box -------------------------------------------
def diamond(cx, top, half_w, half_h):
    return [(cx, top), (cx + half_w, top + half_h), (cx, top + 2 * half_h), (cx - half_w, top + half_h)]


def chevron_band(x0, x1, cx, y0, drop, t):
    """A V of constant *vertical* thickness t whose upper edge starts at y0 on
    both ends and drops by `drop` at the apex cx. Ends are cut vertically, so
    each tier ends flush under the diamond's corners."""
    return [
        (x0, y0),
        (cx, y0 + drop),
        (x1, y0),
        (x1, y0 + t),
        (cx, y0 + drop + t),
        (x0, y0 + t),
    ]


# The exe icon. Slope 50/84 ≈ 0.595 is the app icon's; stroke 15 perpendicular
# → vertical thickness 15 / cos(30.8°) = 17.5; perpendicular gap 24 → vertical
# offset 28. Margins come out at 32 top / 33 bottom.
APP = {
    "radius": 52,
    "diamond": diamond(128, 32, 84, 50),
    "facet": [(128, 32), (212, 82), (128, 132)],
    "bands": [
        chevron_band(44, 212, 128, 110.0, 50, 17.5),
        chevron_band(44, 212, 128, 155.5, 50, 17.5),
    ],
}

# The tray glyph: 16 units = 1 px at 16 px, and every horizontal edge sits on
# a pixel row there. Diamond 16×8 (rows 0–8, slope 0.5); each band is 2 px
# tall at its ends (rows 6–8 and 10–12) and 2 px lower at the apex, so the
# stack fills the 16 px box exactly. Perpendicular: 1.8 px bands, 1.8 px gaps.
TRAY = {
    "diamond": diamond(128, 0, 128, 64),
    "hole": diamond(128, 32, 128 - 64, 64 - 32),
    "bands": [
        chevron_band(0, 256, 128, 96, 64, 32),
        chevron_band(0, 256, 128, 160, 64, 32),
    ],
}


# ---- rasteriser --------------------------------------------------------------
class Canvas:
    def __init__(self, px: int):
        self.px = px
        self.k = px * SS / 256
        self.im = Image.new("RGBA", (px * SS, px * SS), (0, 0, 0, 0))
        self.draw = ImageDraw.Draw(self.im)

    def pts(self, poly):
        return [(x * self.k, y * self.k) for x, y in poly]

    def polygon(self, poly, fill):
        self.draw.polygon(self.pts(poly), fill=fill + (255,))

    def rounded_square(self, radius, fill):
        n = self.px * SS
        self.draw.rounded_rectangle((0, 0, n - 1, n - 1), radius=radius * self.k, fill=fill + (255,))

    def radial_glow(self, cx, cy, r, colour, alpha):
        """A soft highlight fading from `alpha` at (cx, cy) to 0 at radius r,
        applied only where the canvas is already painted."""
        n = self.px * SS
        g = Image.radial_gradient("L").resize((int(2 * r * self.k), int(2 * r * self.k)))
        mask = Image.new("L", (n, n), 0)
        mask.paste(g, (int((cx - r) * self.k), int((cy - r) * self.k)))
        mask = mask.point(lambda v: round((255 - v) * alpha))
        # clip to the painted area
        mask = Image.composite(mask, Image.new("L", (n, n), 0), self.im.getchannel("A"))
        layer = Image.new("RGBA", (n, n), colour + (255,))
        self.im.paste(layer, (0, 0), mask)
        self.draw = ImageDraw.Draw(self.im)

    def result(self) -> Image.Image:
        return self.im.reduce(SS)


def render_app(px: int) -> Image.Image:
    c = Canvas(px)
    c.rounded_square(APP["radius"], INK)
    c.radial_glow(128, 90, 150, AMBER, 0.14)
    c.polygon(APP["diamond"], SIENNA_ON_INK)
    c.polygon(APP["facet"], blend(SIENNA_ON_INK, FACET_SHADE, 0.32))
    for band in APP["bands"]:
        c.polygon(band, SIENNA_ON_INK)
    return c.result()


def render_tray(px: int, running: bool) -> Image.Image:
    c = Canvas(px)
    colour = TRAY_RUNNING if running else TRAY_STOPPED
    c.polygon(TRAY["diamond"], colour)
    if not running:
        # punch the hole: draw it fully transparent
        c.draw.polygon(c.pts(TRAY["hole"]), fill=(0, 0, 0, 0))
    for band in TRAY["bands"]:
        c.polygon(band, colour)
    return c.result()


# ---- .ico writer -------------------------------------------------------------
def dib_frame(im: Image.Image) -> bytes:
    """A 32-bpp BITMAPINFOHEADER frame (XOR pixels bottom-up + 1-bpp AND mask),
    the form every Windows version reads for the small sizes."""
    w, h = im.size
    px = im.load()
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, w * h * 4, 0, 0, 0, 0)
    xor = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[x, y]
            xor += bytes((b, g, r, a))
    stride = ((w + 31) // 32) * 4
    mask = bytearray()
    for y in range(h - 1, -1, -1):
        row = bytearray(stride)
        for x in range(w):
            if px[x, y][3] == 0:
                row[x // 8] |= 0x80 >> (x % 8)
        mask += row
    return header + bytes(xor) + bytes(mask)


def png_frame(im: Image.Image) -> bytes:
    from io import BytesIO

    buf = BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def write_ico(path: Path, frames: list[Image.Image]):
    entries = []
    for im in frames:
        w, h = im.size
        data = dib_frame(im) if w <= 64 else png_frame(im)
        entries.append((w, h, data))
    offset = 6 + 16 * len(entries)
    out = bytearray(struct.pack("<HHH", 0, 1, len(entries)))
    body = bytearray()
    for w, h, data in entries:
        out += struct.pack(
            "<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32, len(data), offset + len(body)
        )
        body += data
    path.write_bytes(bytes(out + body))


# ---- svg ---------------------------------------------------------------------
def write_svg(path: Path):
    def poly(pts, fill, extra=""):
        d = " ".join(f"{x:g},{y:g}" for x, y in pts)
        return f'  <polygon points="{d}" fill="{fill}"{extra}/>'

    def hexc(c):
        return "#%02X%02X%02X" % c

    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">',
        "  <defs>",
        '    <radialGradient id="glow" cx="50%" cy="35%" r="59%">',
        f'      <stop offset="0%" stop-color="{hexc(AMBER)}" stop-opacity="0.14"/>',
        f'      <stop offset="100%" stop-color="{hexc(AMBER)}" stop-opacity="0"/>',
        "    </radialGradient>",
        "  </defs>",
        f'  <rect width="256" height="256" rx="{APP["radius"]}" fill="{hexc(INK)}"/>',
        f'  <rect width="256" height="256" rx="{APP["radius"]}" fill="url(#glow)"/>',
        poly(APP["diamond"], hexc(SIENNA_ON_INK)),
        poly(APP["facet"], hexc(FACET_SHADE), ' fill-opacity="0.32"'),
        *(poly(b, hexc(SIENNA_ON_INK)) for b in APP["bands"]),
        "</svg>",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


# ---- main --------------------------------------------------------------------
APP_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
TRAY_SIZES = [16, 20, 24, 28, 32, 40, 48, 64]


def main():
    write_ico(HERE / "app.ico", [render_app(s) for s in APP_SIZES])
    write_ico(HERE / "tray-running.ico", [render_tray(s, True) for s in TRAY_SIZES])
    write_ico(HERE / "tray-stopped.ico", [render_tray(s, False) for s in TRAY_SIZES])
    write_svg(HERE / "app.svg")
    print("wrote app.ico, tray-running.ico, tray-stopped.ico, app.svg")


if __name__ == "__main__":
    main()
