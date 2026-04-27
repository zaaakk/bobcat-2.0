import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

/**
 * Sub-DEM detail noise: a baked **ridged multifractal** lifted on top of the
 * raw DEM, plus an elevation-keyed bedding pulse computed at sample time.
 *
 * Why ridged, not Perlin/FBM:
 *   The Devil's River area is sedimentary limestone — horizontal bedding
 *   planes, hard caprock layers eroded into benches, sharp valley walls.
 *   Plain FBM gives smooth rolling blobs that read as "grassy hills", not
 *   "stratified rock." Ridged multifractal (`(1 - |noise|)²`) produces
 *   the inverse of that: sharp ridges, smooth between. That alone reads
 *   as caprock; combining with the bedding pulse (in the shader, not
 *   here) gives the horizontal-shelf look.
 *
 * Why baked, not procedural:
 *   An earlier attempt sampled procedural noise on both CPU and GPU and
 *   diverged at large args (commit 0fad182), making the bobcat float/sink
 *   versus the rendered surface. A texture lookup is bit-exact — same
 *   texel, same bilinear convention — on both sides.
 *
 * What's bit-exact:
 *   GPU samples a half-float DataTexture with LinearFilter. We round-trip
 *   through `toHalfFloat` and store the recovered Float32 as `renderData`;
 *   CPU bilinear lookups read `renderData` and use the same half-pixel-
 *   centred convention DEMLoader.sampleHeight already uses. So every CPU
 *   groundY query agrees with what the vertex shader displaced.
 *
 * Output:
 *   data        — Float32Array, ridged FBM in [0, 1].
 *   renderData  — Float32Array, post-half-float-quantisation; THIS is what
 *                 TerrainQuery samples on CPU so it matches the GPU.
 *   ridgeAmp    — metres; multiplied by the lookup to displace the surface.
 *   bedAmp      — metres; height of the bedding-pulse benches (added in
 *                 the shader from a sin of base elevation, not the texture).
 *   bedPeriod   — metres of vertical spacing between bedding planes.
 *   bedWarpAmp  — metres; how much the bedding planes wander off horizontal
 *                 (sampled from the same noise field, gives natural unevenness).
 */
export function generateDetailNoise({
  worldWidth,
  worldHeight,
  resolution     = 2048,
  // Wavelength of the largest ridge octave. With octaves=3 + lacunarity=2,
  // we get features at 80m / 40m / 20m. The 20m octave gets smoothed by
  // the terrain mesh's 26m vertex spacing — fine, the broader octaves
  // carry the read.
  baseWavelength = 80.0,
  octaves        = 3,
  lacunarity     = 2.0,
  gain           = 0.5,
  ridgeAmp       = 2.1,    // metres of caprock-style ridge displacement
  bedAmp         = 1.6,    // metres of bedding-plane bench lift
  bedPeriod      = 20.0,   // metres between bedding planes vertically
  bedWarpAmp     = 14.0,   // metres of wander on the bedding lines
  // ── Fine-tile layer ─────────────────────────────────────────────────
  // The broad layer is sampled across the whole world; its texture
  // resolution caps the finest visible feature at ~world/(res*0.5). At
  // 21km / (2048*0.5) ≈ 20m, that's *exactly* the "20-40 feet between
  // vertices" feel even though the patch vertex spacing is 0.59m.
  //
  // Fix: a small noise texture that *tiles* every fineTileSize metres of
  // world, captured at fineRes texels per tile. This gives effectively
  // sub-meter features (fineTileSize / fineRes texels per cycle) without
  // the memory cost of a giant world-aligned texture. Only the high-res
  // patch can resolve these wavelengths; the base mesh interpolates over
  // them harmlessly (same texture, same world coords, both meshes see
  // the same surface so there's no seam).
  fineRes        = 256,    // texels per tile
  fineTileSize   = 16.0,   // metres of world per tile repeat → 0.06m/texel
  fineOctaves    = 4,      // FBM octaves baked into the tile
  fineAmp        = 0.25,   // metres peak displacement (signed)
  fineSeed       = 0.911,
  seed           = 0.137,
  // Macro-mask thresholds. Detail multiplier = smoothstep(maskLo, maskHi, ridge).
  // Below maskLo ridge value, no detail; above maskHi, full detail; in between,
  // smooth blend. Result: smooth plains in low-ridge zones, full caprock
  // structure on actual ridges. Setting both to 0 disables the mask.
  maskLo         = 0.20,
  maskHi         = 0.55,
  // Water-pool exclusion list. After the broad ridge is baked, we scale the
  // ridge value to 0 within each pool's radius (and blend smoothly out over
  // poolFadeRadius beyond) so caprock bumps don't stick up through the
  // water surface. Pools shape: { x, z, r } in world coords.
  pools          = [],
  poolFadeRadius = 5.0,
} = {}) {
  const noise = createNoise2D(() => seed);
  const w = resolution, h = resolution;
  const data = new Float32Array(w * h);

  // Ridged-multifractal accumulator. Standard recipe:
  //   per octave: signal = (1 - |noise|)² * weight
  //              weight  = clamp(signal * 2, 0, 1)  // higher octaves
  //                                                 // dampened where lower
  //                                                 // octaves are flat
  // Output naturally lives in [0, 1].
  let normAmp = 0;
  let amp = 1;
  for (let o = 0; o < octaves; o++) {
    normAmp += amp;
    amp *= gain;
  }
  const inv = 1 / normAmp;
  const baseFreq = 1 / baseWavelength;

  for (let j = 0; j < h; j++) {
    const wz = ((j + 0.5) / h - 0.5) * worldHeight;
    for (let i = 0; i < w; i++) {
      const wx = ((i + 0.5) / w - 0.5) * worldWidth;
      let v = 0, freq = baseFreq, octAmp = 1.0, weight = 1.0;
      for (let o = 0; o < octaves; o++) {
        let n = noise(wx * freq, wz * freq);  // [-1, 1]
        n = 1.0 - Math.abs(n);                // [0, 1], peaks at noise=0
        n = n * n;                            // sharpen the ridge
        n *= weight;
        weight = Math.min(1.0, Math.max(0.0, n * 2.0));
        v += n * octAmp;
        freq *= lacunarity;
        octAmp *= gain;
      }
      data[j * w + i] = v * inv;              // [0, 1]
    }
  }

  // Pool exclusion: zero the broad ridge in a circle around each pool so
  // the detail can't push bumps up through the water surface. Smoothstep
  // fade over poolFadeRadius so the suppressed region tapers smoothly into
  // the surrounding ridge.
  if (pools.length) {
    const texelSize = worldWidth / w;
    for (const pool of pools) {
      const fullRadius = pool.r + poolFadeRadius;
      const cellRange = Math.ceil(fullRadius / texelSize) + 1;
      const cu = (pool.x / worldWidth + 0.5) * w - 0.5;
      const cv = (pool.z / worldHeight + 0.5) * h - 0.5;
      const ci = Math.round(cu);
      const cj = Math.round(cv);
      for (let dj = -cellRange; dj <= cellRange; dj++) {
        const j = cj + dj;
        if (j < 0 || j >= h) continue;
        const wz = ((j + 0.5) / h - 0.5) * worldHeight;
        for (let di = -cellRange; di <= cellRange; di++) {
          const i = ci + di;
          if (i < 0 || i >= w) continue;
          const wx = ((i + 0.5) / w - 0.5) * worldWidth;
          const dist = Math.hypot(wx - pool.x, wz - pool.z);
          if (dist >= fullRadius) continue;
          // 0 inside the pool, 1 at the fade edge.
          const t = Math.max(0, (dist - pool.r) / poolFadeRadius);
          const fade = t * t * (3 - 2 * t);
          data[j * w + i] *= fade;
        }
      }
    }
  }

  // GPU half-float quantisation, mirrored back to a Float32 view so CPU
  // sampling sees the same values the shader sees (post-pool-exclusion).
  const halfData = new Uint16Array(data.length);
  const renderData = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const hf = THREE.DataUtils.toHalfFloat(data[i]);
    halfData[i] = hf;
    renderData[i] = THREE.DataUtils.fromHalfFloat(hf);
  }

  const texture = new THREE.DataTexture(
    halfData, w, h,
    THREE.RedFormat, THREE.HalfFloatType
  );
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  // ── Fine-tile FBM ────────────────────────────────────────────────────
  // Smooth (not ridged) FBM in [-1, 1], baked once and tiled across the
  // world. Wraps repeat-style so the tile boundaries don't clamp to a
  // fixed value — natural continuity at the seams.
  const fine = bakeFineTile({
    res: fineRes, octaves: fineOctaves, lacunarity, gain, seed: fineSeed,
  });

  return {
    data,
    renderData,
    width: w,
    height: h,
    worldWidth,
    worldHeight,
    ridgeAmp,
    bedAmp,
    bedPeriod,
    bedWarpAmp,
    maskLo,
    maskHi,
    texture,
    fine: {
      ...fine,
      tileSize: fineTileSize,
      amp: fineAmp,
    }
  };
}

/**
 * Tileable FBM in [-1, 1]. Uses a periodic simplex sample by trigonometric
 * domain wrap — sample the noise on a torus parameterisation so the
 * texture wraps cleanly at the boundary. Cheap to bake at small sizes.
 */
function bakeFineTile({ res, octaves, lacunarity, gain, seed }) {
  const noise = createNoise2D(() => seed);
  const w = res, h = res;
  const data = new Float32Array(w * h);

  // Normalisation factor so summed FBM output is in [-1, 1].
  let norm = 0;
  for (let o = 0; o < octaves; o++) norm += Math.pow(gain, o);
  const inv = 1 / norm;

  // Toroidal wrap: sample noise on a 2D torus so the texture tiles
  // perfectly. We do that by mapping (i, j) → angles (αi, αj) and
  // sampling the noise function at (cos α, sin α) for both axes —
  // the noise field on a torus surface wraps trivially.
  for (let j = 0; j < h; j++) {
    const aj = (j / h) * Math.PI * 2;
    const cj = Math.cos(aj), sj = Math.sin(aj);
    for (let i = 0; i < w; i++) {
      const ai = (i / w) * Math.PI * 2;
      const ci = Math.cos(ai), si = Math.sin(ai);
      let v = 0, freq = 1.0, amp = 1.0;
      for (let o = 0; o < octaves; o++) {
        // 2D simplex on a 4D-projected torus — we feed a 2D noise function
        // varying inputs that come from 4 phase-locked angles. The trick:
        // each octave uses different multipliers to break symmetry but
        // stays periodic in (i, j). Cheap and good enough for tile FBM.
        const x = ci * freq + sj * (freq * 0.31);
        const y = si * freq + cj * (freq * 0.27);
        v += noise(x * 1.7, y * 1.7) * amp;
        freq *= lacunarity;
        amp *= gain;
      }
      data[j * w + i] = v * inv;
    }
  }

  const halfData = new Uint16Array(data.length);
  const renderData = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const hf = THREE.DataUtils.toHalfFloat(data[i]);
    halfData[i] = hf;
    renderData[i] = THREE.DataUtils.fromHalfFloat(hf);
  }

  const texture = new THREE.DataTexture(
    halfData, w, h,
    THREE.RedFormat, THREE.HalfFloatType
  );
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return { data, renderData, width: w, height: h, texture };
}
