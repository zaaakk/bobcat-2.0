# Bobcat

An open-world Three.js sketch: you play a bobcat in the west-Texas borderland
where the Edwards Plateau breaks down into the Chihuahuan Desert — roughly the
country around the Devils River in Val Verde County.

The terrain is real. It's built from a Terrarium-encoded DEM of the Pandale
quad, about 21 km across, so the canyons, benches and drainages you run through
are the ones that are actually there.

## Play locally

```sh
npm install
npm run dev          # http://localhost:5173
```

Node 18+. No build step needed for development.

## Controls

| | |
|---|---|
| `W` `A` `S` `D` / arrows | move |
| `Shift` | sprint |
| `Space` | jump (double-jump available) |
| `E` | drink, at water |
| `N` | night vision |
| drag mouse | orbit camera |
| scroll | zoom |
| `` ` `` | debug menu — lighting, foliage, terrain, gait |

## How it's put together

Almost nothing here uses three's stock materials. The terrain, the vegetation
and the character all evaluate one shared analytic lighting model so they agree
with each other across the day/night cycle:

- **`src/terrain/`** — streamed chunks off the DEM, a 7-way splat blend with a
  close-up detail tap, and a per-tile normal atlas. The lighting block here is
  the source of truth the others mirror.
- **`src/vegetation/`** — 15 species placed by a score-weighted per-cell lottery
  over slope, elevation, drainage and a low-frequency ecotone axis, with canopy
  dominance suppressing understory under saturated juniper and mesquite. Plants
  are instanced billboard cards whose normals are transferred from an enclosing
  blob, so a shrub shades as one soft volume instead of three flat intersecting
  planes. Foliage within a few metres of the camera dissolves and defocuses
  rather than clipping through it.
- **`src/world/WorldLighting.js`** — patches the glTF character's
  `MeshStandardMaterial` via `onBeforeCompile` so it runs the terrain's lighting
  function instead of three's PBR pipeline. The two don't differ by a constant,
  they diverge: the character was measured at 0.74x world brightness at noon and
  0.06x at night. See the comments in that file.
- **`src/player/`** — sim and rig are separate; `scripts/repair_run_cycle.mjs`
  rebuilds the gallop cycle from the pre-repair rig (kept in `asset-archive/`).

## Deploying

The app is base-path agnostic. Every asset URL goes through
`src/assetPath.js`, which resolves against Vite's `BASE_URL`, so one codebase
serves from a domain root or from a subdirectory.

```sh
npm run build                         # serves from /
BASE_PATH=/bobcat-2.0/ npm run build  # serves from /bobcat-2.0/
```

Output lands in `dist/` and is fully static — any static host will do.

Note that it is a heavy page: ~63 MB of assets, most of it the bobcat and deer
GLBs. Mesh compression on those is the obvious next win.

## Repository layout

`public/assets/` holds only what the game loads at runtime. Source material —
Blender files, mod archives, superseded model exports, the full-resolution
normal maps that were baked down into `ground/normal-atlas.png` — lives in
`asset-archive/` and is not tracked or shipped.

## Credits

- Terrain elevation: USGS 3DEP, Pandale quad (public domain).
- Wind ambience: [jorge0000 on Freesound](https://freesound.org/people/jorge0000/sounds/361054/), CC0.
- Plant sprites: generated with FLUX, matted and cleaned by
  `scripts/generate_plant_sprites.py` and `scripts/clean_plant_sprites.py`.
- Animal models (bobcat, deer) are converted from Planet Zoo community mods and
  are **not** licensed for redistribution. They are here for a personal
  prototype; if this repo goes public they need replacing with models that
  carry a license permitting it.
