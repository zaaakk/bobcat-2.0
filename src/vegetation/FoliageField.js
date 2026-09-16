import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { sampleHeight } from '../terrain/DEMLoader.js';

const DEFAULTS = {
  grassScale: 1.85,
  woodyScale: 1.35,
  grassNoiseFreq: 7.5,
  woodyNoiseFreq: 13.0,
  fineNoiseFreq: 66.0,
  drainagePower: 1.25,
  slopeCutoff: 0.50,
  edgeStrength: 1.65,
  grassOpenScale: 0.86,
  grassPatchFloor: 0.42,
  grassDrainageSuppress: 0.30
};

export function generateFoliageField({ dem, splat, resolution = 1280, params = {} }) {
  const p = { ...DEFAULTS, ...params };
  const data = new Uint8Array(resolution * resolution * 4);
  fillFoliageField(dem, splat, resolution, p, data);
  const texture = makeTexture(data, resolution);

  function regenerate(patch = {}) {
    Object.assign(p, patch);
    fillFoliageField(dem, splat, resolution, p, data);
    texture.needsUpdate = true;
  }

  return {
    texture,
    data,
    params: p,
    resolution,
    sample: (x, z) => sampleField(data, resolution, dem, x, z),
    regenerate
  };
}

function fillFoliageField(dem, splat, resolution, p, data) {
  const macroGrass = createNoise2D(() => 0.714);
  const macroWoody = createNoise2D(() => 0.291);
  const fine = createNoise2D(() => 0.513);
  const elevRange = Math.max(1, dem.maxZ - dem.minZ);
  const halfW = dem.worldWidth * 0.5;
  const halfH = dem.worldHeight * 0.5;

  for (let j = 0; j < resolution; j++) {
    const zWorld = ((j + 0.5) / resolution - 0.5) * dem.worldHeight;
    for (let i = 0; i < resolution; i++) {
      const xWorld = ((i + 0.5) / resolution - 0.5) * dem.worldWidth;
      const h = sampleHeight(dem, xWorld, zWorld);
      const elevT = clamp01((h - dem.minZ) / elevRange);

      const ds = Math.max(dem.pixelSizeX, dem.pixelSizeY) * 3.0;
      const hL = sampleHeight(dem, Math.max(-halfW, xWorld - ds), zWorld);
      const hR = sampleHeight(dem, Math.min(halfW, xWorld + ds), zWorld);
      const hD = sampleHeight(dem, xWorld, Math.max(-halfH, zWorld - ds));
      const hU = sampleHeight(dem, xWorld, Math.min(halfH, zWorld + ds));
      const dzdx = (hR - hL) / (ds * 2.0);
      const dzdz = (hU - hD) / (ds * 2.0);
      const slopeT = clamp01(Math.atan(Math.hypot(dzdx, dzdz)) / (Math.PI * 0.5));
      const nonCliff = 1.0 - smoothstep(p.slopeCutoff, 0.72, slopeT);
      const concavity = (hL + hR + hD + hU) * 0.25 - h;
      const drainage = clamp01(concavity / 5.0 + (0.36 - elevT) * 0.72);

      const spl = sampleSplat(splat, i, j, resolution);
      const grassTex = spl.grass * 0.70 + spl.gravel * 0.34 + spl.sand * 0.18 + spl.sandyWash * 0.22;
      const washTex = spl.riparianbed * 0.55 + spl.sandyWash * 0.45 + spl.sand * 0.18;

      const nx = (i + 0.5) / resolution;
      const ny = (j + 0.5) / resolution;
      const grassPatch = noise01(macroGrass, nx * p.grassNoiseFreq, ny * p.grassNoiseFreq);
      const woodyPatch = noise01(macroWoody, nx * p.woodyNoiseFreq, ny * p.woodyNoiseFreq);
      const finePatch = noise01(fine, nx * p.fineNoiseFreq, ny * p.fineNoiseFreq);

      const flatGrass = smoothstep(0.42, 0.035, slopeT) * (0.64 + 0.36 * elevT);
      const openGrassland = smoothstep(0.30, 0.02, slopeT)
        * (1.0 - smoothstep(0.20, 0.72, drainage) * p.grassDrainageSuppress)
        * (0.76 + 0.24 * (1.0 - spl.rock));
      // Mesa-top grassland: plateau caps (flat + high) carry grama grass in
      // west Texas. Matches the equivalent term in SplatMapGenerator.
      const mesaGrass = smoothstep(0.14, 0.03, slopeT) * smoothstep(0.50, 0.72, elevT);
      let grass = (grassTex * 0.54 + flatGrass * 0.48 + openGrassland * p.grassOpenScale
        + mesaGrass * 0.30) * nonCliff;
      // Mesa tops keep a higher patch floor so noise troughs thin the grass
      // rather than stripping the summit bare — but only moderately, or the
      // field saturates and placement acceptance goes to 1 everywhere (which
      // blows each chunk's instance budget and caps into bare bands).
      const patchFloor = Math.min(0.60, p.grassPatchFloor + mesaGrass * 0.20);
      grass *= patchFloor + (1.0 - patchFloor + 0.28) * Math.pow(grassPatch, 1.05);
      grass *= 0.82 + finePatch * 0.28;
      grass = clamp01(grass * p.grassScale);

      const drainKey = Math.pow(drainage, p.drainagePower);
      let woody = (drainKey * 0.72 + washTex * 0.52) * nonCliff;
      woody *= smoothstep(0.92, 0.10, elevT);
      woody *= 0.35 + 0.85 * Math.pow(woodyPatch, 1.55);
      woody = clamp01(woody * p.woodyScale);

      const canopy = clamp01(woody * (0.55 + 0.45 * drainage) + grass * 0.13);
      const o = (j * resolution + i) * 4;
      data[o + 0] = Math.round(grass * 255);
      data[o + 1] = Math.round(woody * 255);
      data[o + 2] = 0;
      data[o + 3] = Math.round(canopy * 255);
    }
  }

  const tmp = new Uint8Array(resolution * resolution);
  for (let j = 0; j < resolution; j++) {
    for (let i = 0; i < resolution; i++) {
      const o = (j * resolution + i) * 4;
      const c = data[o] * 0.45 + data[o + 1] * 0.80;
      const l = combinedMass(data, resolution, Math.max(0, i - 1), j);
      const r = combinedMass(data, resolution, Math.min(resolution - 1, i + 1), j);
      const d = combinedMass(data, resolution, i, Math.max(0, j - 1));
      const u = combinedMass(data, resolution, i, Math.min(resolution - 1, j + 1));
      const edge = clamp01((Math.abs(r - l) + Math.abs(u - d)) * p.edgeStrength + c / 255 * 0.12);
      tmp[j * resolution + i] = Math.round(edge * 255);
    }
  }
  for (let k = 0; k < tmp.length; k++) data[k * 4 + 2] = tmp[k];
}

function sampleSplat(splat, i, j, resolution) {
  const out = { rock: 0, grass: 0, gravel: 0, sand: 0, riparianbed: 0, rockyZone: 0, sandyWash: 0 };
  if (!splat?.dataA) return out;
  const sx = Math.min((splat.resolution || resolution) - 1, Math.floor(i * (splat.resolution || resolution) / resolution));
  const sy = Math.min((splat.resolution || resolution) - 1, Math.floor(j * (splat.resolution || resolution) / resolution));
  const o = (sy * (splat.resolution || resolution) + sx) * 4;
  out.rock = splat.dataA[o] / 255;
  out.grass = splat.dataA[o + 1] / 255;
  out.gravel = splat.dataA[o + 2] / 255;
  out.sand = splat.dataA[o + 3] / 255;
  if (splat.dataB) {
    out.riparianbed = splat.dataB[o] / 255;
    out.rockyZone = splat.dataB[o + 1] / 255;
    out.sandyWash = splat.dataB[o + 2] / 255;
  }
  return out;
}

function sampleField(data, resolution, dem, x, z) {
  const u = clamp01(x / dem.worldWidth + 0.5) * resolution - 0.5;
  const v = clamp01(z / dem.worldHeight + 0.5) * resolution - 0.5;
  const x0 = Math.floor(u), y0 = Math.floor(v);
  const fx = u - x0, fy = v - y0;
  const s00 = read(data, resolution, x0, y0);
  const s10 = read(data, resolution, x0 + 1, y0);
  const s01 = read(data, resolution, x0, y0 + 1);
  const s11 = read(data, resolution, x0 + 1, y0 + 1);
  return {
    grass: bilerp(s00[0], s10[0], s01[0], s11[0], fx, fy),
    woody: bilerp(s00[1], s10[1], s01[1], s11[1], fx, fy),
    edge: bilerp(s00[2], s10[2], s01[2], s11[2], fx, fy),
    height: bilerp(s00[3], s10[3], s01[3], s11[3], fx, fy)
  };
}

function read(data, resolution, x, y) {
  const cx = Math.max(0, Math.min(resolution - 1, x));
  const cy = Math.max(0, Math.min(resolution - 1, y));
  const o = (cy * resolution + cx) * 4;
  return [data[o] / 255, data[o + 1] / 255, data[o + 2] / 255, data[o + 3] / 255];
}

function combinedMass(data, resolution, x, y) {
  const o = (y * resolution + x) * 4;
  return (data[o] * 0.45 + data[o + 1] * 0.8) / 255;
}

function makeTexture(data, resolution) {
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

function bilerp(a, b, c, d, x, y) {
  return (a * (1 - x) + b * x) * (1 - y) + (c * (1 - x) + d * x) * y;
}

function noise01(noise, x, y) {
  return (noise(x, y) + 1) * 0.5;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
