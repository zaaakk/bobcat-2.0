import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

/**
 * Build two RGBA splatmaps from the DEM. Together they index seven ground
 * textures whose weights sum to 1 across both.
 *
 *   splatA: R=rock  G=grassdry  B=gravel       A=sand
 *   splatB: R=riparianbed  G=rocky-zone  B=sandywash  A=unused
 *
 * Two design rules baked in:
 *   - Near-vertical surfaces always render as rock (any other texture would
 *     stretch ugly across cliff faces).
 *   - Each non-rock texture has its own patch-noise so traversing the map
 *     shows multiple textures within short distances rather than one biome
 *     dominating for kilometres.
 *
 * Returns a handle with the two THREE.DataTextures, the underlying byte
 * buffers, and a `regenerate(partialParams)` function so the debug panel can
 * retune the weights live without re-allocating GPU storage.
 */

export const SPLAT_DEFAULTS = {
  // Per-texture weight multipliers.
  rockScale:    4.20,
  grassScale:   0.75,
  gravelScale:  3.35,
  sandScale:    2.00,
  ripBedScale:  3.05,
  rockyZScale:  3.00,
  sandyWScale:  3.00,
  // Per-texture patch frequencies (cycles across the map). Higher = smaller
  // patches = more variety per metre travelled.
  grassMacroFreq:   8.0,
  gravelMacroFreq:  7.0,
  sandMacroFreq:    6.5,
  ripBedMacroFreq: 23.8,
  rockyMacroFreq:  22.2,
  washMacroFreq:   20.3,
  // How strongly per-texture noise breaks zones into patches.
  // 0 = uniform-by-geology, 1 = mosaic, >1 amplifies further (the multiplier
  // is clamped at 0 so weights never go negative — peaks just get more
  // dominant while troughs stay at zero, producing sharper on/off mosaic).
  patchiness: 4.0,
};

export function generateSplatMap(dem, resolution = 512, params = {}) {
  const p = { ...SPLAT_DEFAULTS, ...params };
  const dataA = new Uint8Array(resolution * resolution * 4);
  const dataB = new Uint8Array(resolution * resolution * 4);

  fillSplatBuffers(dem, resolution, p, dataA, dataB);

  const splatA = makeTex(dataA, resolution);
  const splatB = makeTex(dataB, resolution);

  return {
    splatA, splatB,
    params: p,
    regenerate(patch) {
      Object.assign(p, patch);
      fillSplatBuffers(dem, resolution, p, dataA, dataB);
      splatA.needsUpdate = true;
      splatB.needsUpdate = true;
    }
  };
}

function fillSplatBuffers(dem, resolution, p, dataA, dataB) {
  const noise        = createNoise2D(() => 0.137);
  const grassNoise   = createNoise2D(() => 0.213);
  const gravelNoise  = createNoise2D(() => 0.347);
  const sandNoise    = createNoise2D(() => 0.519);
  const ripBedNoise  = createNoise2D(() => 0.677);
  const rockyNoise   = createNoise2D(() => 0.731);
  const washNoise    = createNoise2D(() => 0.413);

  const elevRange = Math.max(1, dem.maxZ - dem.minZ);
  const stepX = dem.width / resolution;
  const stepY = dem.height / resolution;

  for (let j = 0; j < resolution; j++) {
    for (let i = 0; i < resolution; i++) {
      const sx = Math.min(dem.width - 1, Math.floor(i * stepX));
      const sy = Math.min(dem.height - 1, Math.floor(j * stepY));
      const z = dem.data[sy * dem.width + sx];

      const xL = Math.max(0, sx - 1), xR = Math.min(dem.width - 1, sx + 1);
      const yD = Math.max(0, sy - 1), yU = Math.min(dem.height - 1, sy + 1);
      const hL = dem.data[sy * dem.width + xL];
      const hR = dem.data[sy * dem.width + xR];
      const hD = dem.data[yD * dem.width + sx];
      const hU = dem.data[yU * dem.width + sx];
      const dzdx = (hR - hL) / (2 * dem.pixelSizeX);
      const dzdy = (hU - hD) / (2 * dem.pixelSizeY);
      const slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
      const slopeT = Math.min(1, slope / (Math.PI / 2));

      const elevT = (z - dem.minZ) / elevRange;
      const concavity = (hL + hR + hU + hD) * 0.25 - z;
      const drainage = Math.max(0, Math.min(1, (concavity / 6) + (0.4 - elevT) * 0.6));

      const nx = i / resolution, ny = j / resolution;
      const noiseLow = (noise(nx * 14, ny * 14) + 1) * 0.5;

      // Per-texture macro-noise patch values [0..1]. Used to modulate weights
      // so the same geology produces different textures in different patches.
      const grassPatch  = (grassNoise (nx * p.grassMacroFreq,  ny * p.grassMacroFreq)  + 1) * 0.5;
      const gravelPatch = (gravelNoise(nx * p.gravelMacroFreq, ny * p.gravelMacroFreq) + 1) * 0.5;
      const sandPatch   = (sandNoise  (nx * p.sandMacroFreq,   ny * p.sandMacroFreq)   + 1) * 0.5;
      const ripBedPatch = (ripBedNoise(nx * p.ripBedMacroFreq, ny * p.ripBedMacroFreq) + 1) * 0.5;
      const rockyPatch  = (rockyNoise (nx * p.rockyMacroFreq,  ny * p.rockyMacroFreq)  + 1) * 0.5;
      const washPatch   = (washNoise  (nx * p.washMacroFreq,   ny * p.washMacroFreq)   + 1) * 0.5;

      // patchify(patch) returns a multiplier centred on 1 with swing
      // proportional to patchiness. Clamped at 0 so high patchiness produces
      // sharp on/off mosaic rather than negative weights.
      const pat = p.patchiness;
      const patchify = v => Math.max(0, 1 + pat * (2 * v - 1));

      // Verticality: 0 on flat ground, 1 on near-vertical cliffs. Used to
      // (a) boost rock dramatically and (b) suppress everything else so
      // cliffs read as bare rock.
      const verticality = smoothstep(0.50, 0.85, slopeT);
      const nonVert = 1.0 - verticality;

      let wRock   = smoothstep(0.18, 0.55, slopeT) * (0.6 + 0.4 * noiseLow) * p.rockScale;
      wRock += smoothstep(0.7, 1.0, elevT) * 0.2 * p.rockScale;
      // Hard-baked vertical dominance — independent of rockScale so a low
      // slider can't strip cliffs of texture.
      wRock += verticality * 6.0;

      let wSand   = (drainage * 1.0 + smoothstep(0.4, 0.0, slopeT) * smoothstep(0.5, 0.1, elevT) * 0.3)
                  * p.sandScale * nonVert * patchify(sandPatch);
      let wGravel = smoothstep(0.15, 0.0, slopeT) * (0.4 + 0.6 * gravelPatch) * (0.6 + 0.4 * (1 - elevT))
                  * p.gravelScale * nonVert * patchify(gravelPatch);
      let wGrass  = smoothstep(0.10, 0.0, slopeT) * (0.3 + 0.7 * elevT) * (0.5 + 0.5 * grassPatch)
                  * p.grassScale * nonVert * patchify(grassPatch);

      const ripBedKey = (drainage * 0.7 + 0.3) * smoothstep(0.65, 0.05, elevT) * smoothstep(0.45, 0.0, slopeT);
      let wRipBed = ripBedKey * p.ripBedScale * nonVert * patchify(ripBedPatch);

      const rockyMask = smoothstep(0.30, 0.65, rockyPatch);
      let wRockyZ = rockyMask
        * smoothstep(0.18, 0.85, elevT)
        * (0.4 + 0.6 * smoothstep(0.02, 0.55, slopeT))
        * p.rockyZScale * nonVert;

      let wSandyW = (drainage * 0.6 + 0.4 * smoothstep(0.55, 0.05, slopeT))
        * smoothstep(0.85, 0.1, elevT)
        * (0.4 + 0.6 * washPatch)
        * p.sandyWScale * nonVert;

      const total = wRock + wGrass + wGravel + wSand + wRipBed + wRockyZ + wSandyW + 1e-6;
      const inv = 1 / total;
      wRock *= inv; wGrass *= inv; wGravel *= inv; wSand *= inv;
      wRipBed *= inv; wRockyZ *= inv; wSandyW *= inv;

      const o = (j * resolution + i) * 4;
      dataA[o + 0] = Math.round(wRock * 255);
      dataA[o + 1] = Math.round(wGrass * 255);
      dataA[o + 2] = Math.round(wGravel * 255);
      dataA[o + 3] = Math.round(wSand * 255);
      dataB[o + 0] = Math.round(wRipBed * 255);
      dataB[o + 1] = Math.round(wRockyZ * 255);
      dataB[o + 2] = Math.round(wSandyW * 255);
      dataB[o + 3] = 0;
    }
  }
}

function makeTex(data, resolution) {
  const tex = new THREE.DataTexture(data, resolution, resolution, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
