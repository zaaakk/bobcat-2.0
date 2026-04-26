import { sampleHeight, sampleSlope } from '../terrain/DEMLoader.js';
import { createNoise2D } from 'simplex-noise';
import { SPECIES } from './species.js';

/**
 * Placement uses a per-species clump field so each species has its own spatial
 * pattern: bunchgrass forms broad carpets, prickly pear forms big patches,
 * juniper is sparse and isolated, etc. The candidate grid is shared; each cell
 * decides which species (if any) it spawns by combining habitat suitability
 * with that species's own clumping noise.
 *
 * Returns: { positions, scales, rotations, species, count }.
 */
export function placeVegetation({
  dem,
  groundY,
  cellSize = 5.0,
  globalDensity = 1.0,
  jitter = 1.0,
  playRadius = 5500,
  maxInstances = 350_000
}) {
  // One noise per species + one global "macro habitat" noise that biases the
  // suitability function (so different ecotypes appear in different regions).
  const macroNoise = createNoise2D(() => 0.137);
  const speciesClumpNoise = SPECIES.map(s => createNoise2D(() => s.clumpSeed));
  const acceptNoise = createNoise2D(() => 0.91);
  const jitterNoise = createNoise2D(() => 0.49);
  const sampleY = groundY || ((x, z) => sampleHeight(dem, x, z));

  const playSpan = Math.min(playRadius * 2, Math.min(dem.worldWidth, dem.worldHeight));
  const cols = Math.floor(playSpan / cellSize);
  const rows = Math.floor(playSpan / cellSize);
  const playOriginX = -playSpan * 0.5;
  const playOriginZ = -playSpan * 0.5;
  const r2 = playRadius * playRadius;

  const elevRange = Math.max(1, dem.maxZ - dem.minZ);

  const bufN = Math.min(maxInstances, cols * rows);
  const positions = new Float32Array(bufN * 3);
  const scales    = new Float32Array(bufN);
  const rotations = new Float32Array(bufN);
  const speciesId = new Uint8Array(bufN);
  let n = 0;

  const speciesScores = new Array(SPECIES.length);

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (n >= bufN) break;

      const baseX = playOriginX + (i + 0.5) * cellSize;
      const baseZ = playOriginZ + (j + 0.5) * cellSize;
      if (baseX * baseX + baseZ * baseZ > r2) continue;

      const jx = jitterNoise(i * 0.31, j * 0.27);
      const jz = jitterNoise(i * 0.19 + 7.1, j * 0.23 + 3.7);
      const x = baseX + jx * cellSize * jitter;
      const z = baseZ + jz * cellSize * jitter;

      const slope = sampleSlope(dem, x, z);
      const slopeT = Math.min(1, slope / (Math.PI / 2));
      const yDem = sampleHeight(dem, x, z);
      const elevT = (yDem - dem.minZ) / elevRange;

      const ds = 8 * dem.pixelSizeX;
      const hL = sampleHeight(dem, x - ds, z);
      const hR = sampleHeight(dem, x + ds, z);
      const hD = sampleHeight(dem, x, z - ds);
      const hU = sampleHeight(dem, x, z + ds);
      const concav = (hL + hR + hD + hU) * 0.25 - yDem;
      const drainage = Math.max(0, Math.min(1, concav / 4 + (0.3 - elevT) * 0.6));

      const macro = (macroNoise(x * 0.0008, z * 0.0008) + 1) * 0.5;

      // Per-species score = suitability × density × clump-field
      let bestScore = 0, bestK = -1, bestScaleHint = 0.5, sumScores = 0;
      for (let k = 0; k < SPECIES.length; k++) {
        const sp = SPECIES[k];
        const suit = sp.suitability(slopeT, elevT, drainage, macro);
        if (suit <= 0) { speciesScores[k] = 0; continue; }
        const cn = (speciesClumpNoise[k](x * sp.clumpFreq, z * sp.clumpFreq) + 1) * 0.5;
        const clump = sp.clumpFloor + (1 - sp.clumpFloor) * Math.pow(cn, sp.clumpSharpness);
        const score = suit * sp.densityScale * clump;
        speciesScores[k] = score;
        sumScores += score;
        if (score > bestScore) { bestScore = score; bestK = k; bestScaleHint = clump; }
      }
      if (bestK < 0 || sumScores <= 0) continue;

      // Acceptance: probability proportional to the dominant species' score,
      // clamped at 1 so the buffer doesn't fill before the scan finishes.
      const accept = Math.min(1, bestScore * globalDensity);
      const rand = (acceptNoise(i * 1.13 + 5.0, j * 1.07 + 9.0) + 1) * 0.5;
      if (rand > accept) continue;

      // Choose species weighted by score (winner usually takes it, but small
      // chance for less-suited ones makes mixed transitions feel natural).
      const pick = ((acceptNoise(i * 0.71 + 11.0, j * 0.69 + 13.0) + 1) * 0.5) * sumScores;
      let cum = 0, chosen = bestK;
      for (let k = 0; k < SPECIES.length; k++) {
        cum += speciesScores[k];
        if (pick <= cum) { chosen = k; break; }
      }

      const sp = SPECIES[chosen];
      const sizeRand = ((acceptNoise(i * 0.57, j * 0.61) + 1) * 0.5);
      const h = sp.height[0] + sizeRand * (sp.height[1] - sp.height[0]);
      const rot = ((acceptNoise(i * 0.33 + 17.0, j * 0.41 + 19.0) + 1) * Math.PI);

      positions[n * 3 + 0] = x;
      positions[n * 3 + 1] = sampleY(x, z);
      positions[n * 3 + 2] = z;
      scales[n] = h;
      rotations[n] = rot;
      speciesId[n] = chosen;
      n++;
    }
  }

  return {
    positions: positions.subarray(0, n * 3),
    scales: scales.subarray(0, n),
    rotations: rotations.subarray(0, n),
    species: speciesId.subarray(0, n),
    count: n
  };
}
