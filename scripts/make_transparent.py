#!/usr/bin/env python3
"""Key the white backing out of the brand marks.

The source art was flattened onto white, which is invisible on the light pages
and a white brick on the pine sidebar. This removes the *outside* white only.

Why flood fill rather than "make every white pixel transparent": the fish body,
the grill highlights and the foam on the waves are also white. Keying by colour
alone punches holes through the middle of the mark. Filling inward from the
border keeps any white that is enclosed by artwork.

    python3 scripts/make_transparent.py          # rewrite the marks in place
    python3 scripts/make_transparent.py --check  # report only, change nothing

Idempotent: a file that already carries an alpha channel is left alone.
"""
import os
import sys

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.exists(os.path.join(ROOT, "index.html")):
    ROOT = os.path.dirname(os.path.abspath(__file__))

CHECK = "--check" in sys.argv

# icon-180.png is deliberately absent. It is the apple-touch-icon, and iOS
# composites transparency onto black rather than onto the home screen, so a
# keyed-out version would come back as a black tile. Opaque is correct there.
TARGETS = [
    "site-icon.png",
    "icon-16.png",
    "icon-32.png",
    "icon-48.png",
    "icon-192.png",
    "icon-512.png",
]

# A pixel counts as backing if every channel is at least this bright. Set just
# below pure white: the source has JPEG-ish noise around 253-255, and anything
# lower starts eating the pale grey in the fish.
WHITE = 244


def key_out(path):
    im = Image.open(path)
    if im.mode in ("RGBA", "LA") or "transparency" in im.info:
        return "already transparent"

    rgb = im.convert("RGB")
    a = np.asarray(rgb).astype(np.int16)

    near_white = (a.min(axis=2) >= WHITE)

    # Label the near-white regions and keep only those touching the border.
    # Anything enclosed by artwork stays opaque.
    labels, n = ndimage.label(near_white)
    if n == 0:
        return "no backing found"

    edge = np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]])
    outside = np.unique(edge[edge > 0])
    if outside.size == 0:
        return "no backing found"

    backing = np.isin(labels, outside)

    alpha = np.where(backing, 0, 255).astype(np.uint8)

    # The original edges were anti-aliased against white, so a hard cut leaves
    # a stair-stepped fringe. A sub-pixel blur softens it; at 34px in the
    # sidebar this is the difference between a clean mark and a jagged one.
    alpha_img = Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(0.6))
    alpha = np.asarray(alpha_img)

    # Two things keep the file from tripling in size, both of which matter
    # because these load on every page.
    #
    # The blur produces a continuous ramp of alpha values, and PNG compresses
    # a handful of levels far better than 256 of them. Sixteen steps is well
    # past what the eye resolves on a 1px edge.
    alpha = (np.rint(alpha / 17.0) * 17).clip(0, 255).astype(np.uint8)

    # Under a fully transparent pixel the colour is invisible but still gets
    # stored. The source is white noise there; flattening it to one value
    # gives the compressor a long run of identical bytes instead.
    flat = a.astype(np.uint8).copy()
    flat[alpha == 0] = 255

    out = Image.fromarray(np.dstack([flat, alpha]), "RGBA")

    # Flat illustration, so a 256-colour palette is visually lossless and a
    # fraction of the size of truecolour RGBA. Pillow's own encoder is not
    # competitive with what produced the source files, so oxipng finishes the
    # job losslessly if it is installed; without it the palette alone still
    # keeps these close to where they started.
    out = out.quantize(colors=256, method=Image.FASTOCTREE)

    if not CHECK:
        out.save(path, "PNG", optimize=True)
        try:
            import oxipng
            oxipng.optimize(path, level=4)
        except ImportError:
            pass

    pct = 100.0 * backing.sum() / backing.size
    return "keyed out %.0f%% of the canvas" % pct


def main():
    changed = 0
    for name in TARGETS:
        path = os.path.join(ROOT, name)
        if not os.path.exists(path):
            print("  missing  %s" % name)
            continue
        result = key_out(path)
        if result.startswith("keyed"):
            changed += 1
        print("  %-16s %s" % (name, result))

    if CHECK:
        print("\n--check: nothing written. %d file(s) would change." % changed)
    else:
        print("\n%d file(s) rewritten." % changed)


if __name__ == "__main__":
    main()
