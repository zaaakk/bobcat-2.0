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
  ridgeAmp       = 3.0,    // metres of caprock-style ridge displacement
  bedAmp         = 2.0,    // metres of bedding-plane bench lift
  bedPeriod      = 18.0,   // metres between bedding planes vertically
  bedWarpAmp     = 6.0,    // metres of wander on the bedding lines
  seed           = 0.137,
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

  // GPU half-float quantisation, mirrored back to a Float32 view so CPU
  // sampling sees the same values the shader sees.
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
    texture,
  };
}
