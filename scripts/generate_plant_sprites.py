#!/usr/bin/env python3
"""
Generate new plant billboard sprites via fal.ai, in the style of the existing set.

Pipeline per species: flux generates a single specimen on a plain background,
birefnet mattes it out, then it is trimmed to its own bounding box and laid
into a 256x256 cell bottom-aligned, which is the convention the sprite atlas
and the InstancedPlants shader already expect.

The prompts deliberately ask for no ground and no cast shadow. The original
sprite set was cut from photos shot on soil and every one of them kept a wedge
of pale caliche under the plant, which had to be flood-filled back out (see
clean_plant_sprites.py). Asking for a plain background avoids inheriting the
same problem.

Key is read from ~/Documents/amema-3d-2026/fal.ai.txt and never printed.

Usage: python3 scripts/generate_plant_sprites.py [--only NAME] [--seed N]
"""
import argparse, json, os, sys, urllib.request, io

try:
    from PIL import Image
except ImportError:
    sys.exit("needs Pillow:  pip3 install Pillow")

KEY_FILE = os.path.expanduser('~/Documents/amema-3d-2026/fal.ai.txt')
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'assets', 'plants')
CELL = 256
MARGIN = 6

# "no ground" alone does not hold -- the first pass asked for it and every
# species still came back planted in a mound of soil or gravel. Naming each
# unwanted object explicitly, and asking for the stem to be cut off at the
# frame edge, is what actually suppresses it.
STYLE = ("photographic botanical reference shot of one single isolated plant, "
         "entire plant fully in frame with space around it, evenly lit overcast "
         "daylight, pure plain white seamless background, floating cutout with "
         "nothing at all beneath the plant, stem cut off flat at the bottom edge "
         "of the frame, no soil, no dirt, no mound, no gravel, no pebbles, no "
         "rocks, no mulch, no pot, no roots, no grass, no ground plane, no cast "
         "shadow, no other plants, sharp focus, eye level, centred")

SPECIES = {
    'liveoak': "a mature Texas plateau live oak tree, Quercus fusiformis, broad spreading dense dark green canopy, short gnarled trunk",
    'cenizo': "a cenizo Texas sage shrub, Leucophyllum frutescens, dense rounded mound of small silver grey green leaves, a few purple flowers",
    'blackbrush': "a blackbrush acacia, Vachellia rigidula, a low wide multi-stemmed desert shrub in full summer leaf, dense mass of small fine dull green compound leaflets covering a tangle of stiff crooked thorny grey twigs, twice as wide as it is tall, no single trunk, not a tree, not bare, not dormant, no flowers",
    'persimmon': "a Texas persimmon small tree, Diospyros texana, multiple smooth pale grey peeling trunks, small glossy dark green leaves, sparse crown",
    'ocotillo': "an ocotillo, Fouquieria splendens, about eighteen tall slender straight spiny unbranched grey-green wands rising together from one point at the base and splaying outward into a wide vase shape, small green leaves along every stem, tips slightly curving",
    'agarita': "an agarita shrub, Mahonia trifoliolata, low stiff rounded shrub of holly-like spiny blue grey green leaflets",
}


# Seeds that produced a usable specimen, recorded so the set is reproducible.
# The defaults are not arbitrary: blackbrush first came back as a flowering
# tree and then as a bare dormant one, and ocotillo as a four-wand stub, so
# these two were re-rolled against reworked prompts until the form was right.
SEEDS = {
    'liveoak': 4200, 'cenizo': 4301, 'blackbrush': 293,
    'persimmon': 4503, 'ocotillo': 719, 'agarita': 4705,
}


def key():
    with open(KEY_FILE) as f:
        return f.read().strip()


def post(endpoint, payload, auth):
    req = urllib.request.Request(
        f'https://fal.run/{endpoint}',
        data=json.dumps(payload).encode(),
        headers={'Authorization': f'Key {auth}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


# Fraction of the plant's height, measured up from the bottom, that the base
# strip is allowed to touch. The billboard is planted into the terrain, so
# anything this low is at or below ground level in game anyway.
BASE_BAND = 0.25


def strip_base(img):
    """Delete the soil/gravel pad flux insists on putting under the plant.

    Prompting against it does not work -- naming every unwanted object still
    came back with gravel discs and root flares. Colour does work, because the
    debris is always warm earth tone (soil brown, tan pebbles) while the
    foliage is green or blue-grey, and it is always at the very bottom.

    So: inside the bottom BASE_BAND of the plant, drop anything warm and
    non-green. Foliage that dips into the band keeps its colour test and
    survives; a brown lower trunk inside the band goes, which costs nothing
    because that part is buried when the sprite is planted.
    """
    img = img.convert('RGBA')
    bbox = img.split()[3].getbbox()
    if not bbox:
        return img
    x0, y0, x1, y1 = bbox
    band_top = y1 - int((y1 - y0) * BASE_BAND)
    px = img.load()
    removed = 0
    for y in range(band_top, y1):
        for x in range(x0, x1):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            # warm (earth) and not green-dominant, or near-black, which is
            # what the contact shadow leaves behind once the soil is gone.
            if (r > b + 18 and g <= r) or max(r, g, b) < 70:
                px[x, y] = (r, g, b, 0)
                removed += 1
    return drop_floaters(img)


def drop_floaters(img, keep_frac=0.004):
    """Delete disconnected specks — the crumbs left behind by strip_base.

    Anything not joined to the plant's own silhouette is debris by definition,
    so this is a connectivity test rather than another colour threshold and it
    cannot eat foliage.
    """
    w, h = img.size
    px = img.load()
    seen = [[False] * w for _ in range(h)]
    comps = []
    for sy in range(h):
        for sx in range(w):
            if seen[sy][sx] or px[sx, sy][3] == 0:
                continue
            stack, comp = [(sx, sy)], []
            seen[sy][sx] = True
            while stack:
                x, y = stack.pop()
                comp.append((x, y))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    xx, yy = x + dx, y + dy
                    if 0 <= xx < w and 0 <= yy < h and not seen[yy][xx] and px[xx, yy][3] > 0:
                        seen[yy][xx] = True
                        stack.append((xx, yy))
            comps.append(comp)
    if not comps:
        return img
    biggest = max(len(c) for c in comps)
    for comp in comps:
        if len(comp) < biggest * keep_frac:
            for x, y in comp:
                r, g, b, _ = px[x, y]
                px[x, y] = (r, g, b, 0)
    return img


def fit(img):
    """Trim to content and stretch it to fill the whole cell. Returns (cell, aspect).

    Not the aspect-preserving fit the original sprites use. Those pad the plant
    into a square cell and leave 38-84% of it empty, which means a species'
    `height` is the height of the *card*, and the plant drawn on it comes out
    some unrelated fraction of that -- every one of the old height values had
    to be eyeballed against whatever padding its sprite happened to have.

    Filling the cell and recording the true content aspect instead lets the
    shader's existing per-species `aspect` do the un-stretching, so the card is
    `height` tall and `aspect * height` wide and the plant fills it exactly.
    `height` then means the plant's height in metres, which is what it reads as.
    The two conventions coexist: `aspect` is per species, and the atlas treats
    every 256x256 cell the same way regardless.
    """
    img = strip_base(img)
    bbox = img.split()[3].getbbox()
    if bbox:
        img = img.crop(bbox)
    aspect = img.width / img.height
    return img.resize((CELL, CELL), Image.LANCZOS), aspect


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only')
    ap.add_argument('--seed', type=int, default=None,
                    help='override; omit to use the recorded per-species seeds')
    ap.add_argument('--fix', action='store_true',
                    help='re-strip and re-fit sprites already on disk, no API calls')
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)

    if args.fix:
        for name in SPECIES:
            if args.only and args.only != name:
                continue
            path = os.path.join(OUT, f'{name}.png')
            if not os.path.exists(path):
                continue
            cell, aspect = fit(Image.open(path).convert('RGBA'))
            cell.save(path)
            print(f'{name:12} re-fit   aspect: {aspect:.2f}')
        return

    auth = key()

    for i, (name, desc) in enumerate(SPECIES.items()):
        if args.only and args.only != name:
            continue
        print(f'{name:12} generating...', flush=True)
        gen = post('fal-ai/flux/dev', {
            'prompt': f'{desc}, {STYLE}',
            'image_size': 'square_hd',
            'num_images': 1,
            'num_inference_steps': 34,
            'guidance_scale': 3.5,
            'seed': args.seed + i * 101 if args.seed is not None else SEEDS.get(name, 7),
        }, auth)
        url = gen['images'][0]['url']

        print(f'{name:12} matting...', flush=True)
        cut = post('fal-ai/birefnet/v2', {'image_url': url}, auth)
        with urllib.request.urlopen(cut['image']['url'], timeout=300) as r:
            img = Image.open(io.BytesIO(r.read()))

        path = os.path.join(OUT, f'{name}.png')
        cell, aspect = fit(img)
        cell.save(path)
        print(f'{name:12} -> {os.path.relpath(path)}   aspect: {aspect:.2f}', flush=True)


if __name__ == '__main__':
    main()
