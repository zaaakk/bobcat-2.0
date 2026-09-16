#!/usr/bin/env python3
"""
Repair the white keying artifacts on the plant sprites.

The source sprites were cut out of a white background with a hard threshold,
which left two distinct problems:

  1. A halo of isolated near-white speckles floating around the silhouette,
     worst on juniper (~2.8k pixels). These are background, not plant.
  2. A pale fringe on the genuine edge pixels, where a partly transparent
     plant pixel still carries the white background blended into its colour.

They need different fixes. Deleting anything pale would eat yucca's cream
flower spike and bunchgrass's straw; the thing that actually separates
artifact from plant is not colour alone but colour *plus* isolation:

    attached px   median minRGB 44-96,  saturation 0.18-0.51
    isolated px   median minRGB 205-242, saturation 0.00-0.15

So speckles are killed only where a pixel is both pale-and-desaturated AND
unbacked by solid plant nearby. The surviving edge pixels are then un-matted
from white -- recovering c from the observed blend c*a + 1*(1-a) -- which
takes the pale tint off without removing anything.

Usage: python3 scripts/clean_plant_sprites.py [--dry-run] [--out DIR]
"""
import argparse, os, sys

try:
    from PIL import Image
except ImportError:
    sys.exit("needs Pillow:  pip3 install Pillow")

SRC = os.path.join(os.path.dirname(__file__), '..', 'public', 'assets', 'plants')

CORE_ALPHA = 200     # alpha above which a pixel counts as solid plant
NEIGH_RADIUS = 2     # window half-width for the isolation test
MIN_CORE = 4         # solid neighbours needed to be considered "attached"
PALE_MIN_RGB = 170   # darkest channel above this = pale
PALE_MAX_SAT = 0.22  # saturation below this = desaturated
UNMATTE = 1.0        # 0 = leave fringe colour alone, 1 = full un-matte
GROUND_MIN_RGB = 150 # pale enough to be the photo's ground, not the plant
GROUND_MAX_SAT = 0.28
GROUND_BAND = 0.35   # only flood from the bottom this fraction of the sprite


def clean(im):
    im = im.convert('RGBA')
    w, h = im.size
    px = im.load()
    alpha = [[px[x, y][3] for x in range(w)] for y in range(h)]
    core = [[alpha[y][x] > CORE_ALPHA for x in range(w)] for y in range(h)]

    killed = 0
    for y in range(h):
        for x in range(w):
            a = alpha[y][x]
            if a == 0 or core[y][x]:
                continue
            r, g, b, _ = px[x, y]
            mx, mn = max(r, g, b), min(r, g, b)
            sat = (mx - mn) / mx if mx else 0.0
            if mn < PALE_MIN_RGB or sat > PALE_MAX_SAT:
                continue
            n = 0
            for dy in range(-NEIGH_RADIUS, NEIGH_RADIUS + 1):
                yy = y + dy
                if yy < 0 or yy >= h:
                    continue
                for dx in range(-NEIGH_RADIUS, NEIGH_RADIUS + 1):
                    xx = x + dx
                    if (dx or dy) and 0 <= xx < w and core[yy][xx]:
                        n += 1
            if n < MIN_CORE:
                px[x, y] = (r, g, b, 0)
                killed += 1

    # The source photos were shot on ground, and each sprite kept a wedge of
    # pale caliche under the plant. It survives the speckle pass because it is
    # attached to the plant, but on a billboard it reads as a white smudge
    # exactly at the ground-contact line. It is a connected pale, desaturated
    # region reachable from the bottom of the frame, and the foliage is not
    # (leaves sit at minRGB 55-96, well under GROUND_MIN_RGB), so flooding it
    # from below lifts the ground out and stops at the plant.
    def groundish(x, y):
        r, g, b, a = px[x, y]
        if a == 0:
            return False
        mx, mn = max(r, g, b), min(r, g, b)
        sat = (mx - mn) / mx if mx else 0.0
        return mn >= GROUND_MIN_RGB and sat <= GROUND_MAX_SAT

    band_top = int(h * (1.0 - GROUND_BAND))
    stack = [(x, y) for y in range(band_top, h) for x in range(w) if groundish(x, y)]
    seen = set(stack)
    floodkilled = 0
    while stack:
        x, y = stack.pop()
        r, g, b, a = px[x, y]
        px[x, y] = (r, g, b, 0)
        floodkilled += 1
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            xx, yy = x + dx, y + dy
            if (0 <= xx < w and band_top <= yy < h and (xx, yy) not in seen
                    and groundish(xx, yy)):
                seen.add((xx, yy))
                stack.append((xx, yy))

    unmatted = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0 or a >= 250:
                continue
            af = a / 255.0
            out = []
            for c in (r, g, b):
                # observed = fg*a + white*(1-a)  ->  fg = (observed - (1-a))/a
                fg = ((c / 255.0) - (1.0 - af)) / af
                fg = min(1.0, max(0.0, fg))
                out.append(int(round(255 * ((1 - UNMATTE) * (c / 255.0) + UNMATTE * fg))))
            px[x, y] = (out[0], out[1], out[2], a)
            unmatted += 1

    return im, killed, floodkilled, unmatted


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--out', default=SRC)
    ap.add_argument('--only', default=None)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    for f in sorted(os.listdir(SRC)):
        if not f.endswith('.png') or (args.only and args.only not in f):
            continue
        im, killed, floodkilled, unmatted = clean(Image.open(os.path.join(SRC, f)))
        print(f'{f:20} speckles {killed:5}   ground patch {floodkilled:5}   un-matted {unmatted:5}')
        if not args.dry_run:
            im.save(os.path.join(args.out, f))


if __name__ == '__main__':
    main()
