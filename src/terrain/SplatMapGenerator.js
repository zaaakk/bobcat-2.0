import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

/**
 * Build an RGBA splatmap texture from the DEM.
 *   R = rock      (steep slope)
 *   G = grassdry  (flat, mid-elev)
 *   B = gravel    (flats)
 *   A = sand      (washes / drainage lines)
 *
 * One channel can dominate per texel; we softmax-mix four candidate weights so
 * the result blends smoothly under bilinear filtering.
 */
export function generateSplatMap(dem, resolution = 512) {
  const noise = createNoise2D(() => 0.137);
  const macroNoise = createNoise2D(() => 0.413);
  const data = new Uint8Array(resolution * resolution * 4);

  const elevRange = Math.max(1, dem.maxZ - dem.minZ);
  const stepX = dem.width / resolution;
  const stepY = dem.height / resolution;

  // Precompute slope for downsampled grid using central differences on the source DEM.
  for (let j = 0; j < resolution; j++) {
    for (let i = 0; i < resolution; i++) {
      const sx = Math.min(dem.width - 1, Math.floor(i * stepX));
      const sy = Math.min(dem.height - 1, Math.floor(j * stepY));
      const idx = sy * dem.width + sx;
      const z = dem.data[idx];

      // slope: sample neighbours one DEM-pixel away (clamp at edges).
      const xL = Math.max(0, sx - 1), xR = Math.min(dem.width - 1, sx + 1);
      const yD = Math.max(0, sy - 1), yU = Math.min(dem.height - 1, sy + 1);
      const hL = dem.data[sy * dem.width + xL];
      const hR = dem.data[sy * dem.width + xR];
      const hD = dem.data[yD * dem.width + sx];
      const hU = dem.data[yU * dem.width + sx];
      const dzdx = (hR - hL) / (2 * dem.pixelSizeX);
      const dzdy = (hU - hD) / (2 * dem.pixelSizeY);
      const slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)); // radians, 0..~pi/2
      const slopeT = Math.min(1, slope / (Math.PI / 2)); // 0..1

      const elevT = (z - dem.minZ) / elevRange; // 0..1

      // Drainage proxy: low elevation + low slope + concave neighbours.
      const concavity = (hL + hR + hU + hD) * 0.25 - z; // positive when lower than neighbours
      const drainage = Math.max(0, Math.min(1, (concavity / 6) + (0.4 - elevT) * 0.6));

      // Macro variation so the splat doesn't look uniform.
      const nx = i / resolution, ny = j / resolution;
      const noiseLow = (noise(nx * 14, ny * 14) + 1) * 0.5;
      const noiseMacro = (macroNoise(nx * 3, ny * 3) + 1) * 0.5;

      // Candidate weights.
      let wRock = smoothstep(0.18, 0.55, slopeT) * (0.6 + 0.4 * noiseLow);
      let wSand = drainage * 1.3 + smoothstep(0.4, 0.0, slopeT) * smoothstep(0.5, 0.1, elevT) * 0.4;
      let wGravel = smoothstep(0.15, 0.0, slopeT) * (0.4 + 0.6 * noiseMacro) * (0.6 + 0.4 * (1 - elevT));
      let wGrass = smoothstep(0.10, 0.0, slopeT) * (0.3 + 0.7 * elevT) * (0.5 + 0.5 * noiseMacro);

      // Bias rocky on highest peaks regardless of slope.
      wRock += smoothstep(0.7, 1.0, elevT) * 0.4;

      // Normalize.
      const total = wRock + wGrass + wGravel + wSand + 1e-6;
      wRock /= total; wGrass /= total; wGravel /= total; wSand /= total;

      const o = (j * resolution + i) * 4;
      data[o + 0] = Math.round(wRock * 255);
      data[o + 1] = Math.round(wGrass * 255);
      data[o + 2] = Math.round(wGravel * 255);
      data[o + 3] = Math.round(wSand * 255);
    }
  }

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
