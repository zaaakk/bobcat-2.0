import { sampleHeight, sampleSlope } from '../terrain/DEMLoader.js';
import { createNoise2D } from 'simplex-noise';
import { SPECIES } from './species.js';

/**
 * Generate plant instances over the DEM extents using slope/elevation derived
 * from the heightmap (LANDFIRE substitute). No hand placement.
 *
 * Returns: { positions: Float32Array(N*3), scales: Float32Array(N), rotations:
 * Float32Array(N), species: Uint8Array(N), distances: Float32Array(N) }.
 */
export function placeVegetation({
  dem,
  cellSize = 5.0,        // metres between candidate samples
  globalDensity = 0.55,  // 0..1 — fraction of suitable cells that actually spawn
  jitter = 0.85,
  playRadius = 5500,     // metres from origin — outside this, no plants are placed
  maxInstances = 350_000
}) {
  const noise = createNoise2D(() => 0.71);
  const blueNoise = createNoise2D(() => 0.91);

  // Restrict the candidate grid to a square that bounds the play radius. For a
  // 21x21 km DEM with playRadius=5.5km this is ~14% of the area, so candidate
  // count stays manageable and density isn't diluted by terrain we'll never see.
  const playSpan = Math.min(playRadius * 2, Math.min(dem.worldWidth, dem.worldHeight));
  const cols = Math.floor(playSpan / cellSize);
  const rows = Math.floor(playSpan / cellSize);
  const playOriginX = -playSpan * 0.5;
  const playOriginZ = -playSpan * 0.5;
  const r2 = playRadius * playRadius;

  const elevRange = Math.max(1, dem.maxZ - dem.minZ);

  // upper-bound buffer; we'll truncate to N at the end.
  const bufN = Math.min(maxInstances, cols * rows);
  const positions = new Float32Array(bufN * 3);
  const scales    = new Float32Array(bufN);
  const rotations = new Float32Array(bufN);
  const speciesId = new Uint8Array(bufN);
  let n = 0;

  const speciesProbs = new Array(SPECIES.length);

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (n >= bufN) break;

      const baseX = playOriginX + (i + 0.5) * cellSize;
      const baseZ = playOriginZ + (j + 0.5) * cellSize;
      if (baseX * baseX + baseZ * baseZ > r2) continue;

      // jitter inside cell using deterministic noise
      const jx = blueNoise(i * 0.31, j * 0.27);
      const jz = blueNoise(i * 0.19 + 7.1, j * 0.23 + 3.7);
      const x = baseX + jx * cellSize * 0.5 * jitter;
      const z = baseZ + jz * cellSize * 0.5 * jitter;

      const y = sampleHeight(dem, x, z);
      const slope = sampleSlope(dem, x, z);
      const slopeT = Math.min(1, slope / (Math.PI / 2));
      const elevT = (y - dem.minZ) / elevRange;

      // drainage = local concavity
      const ds = 8 * dem.pixelSizeX;
      const hL = sampleHeight(dem, x - ds, z);
      const hR = sampleHeight(dem, x + ds, z);
      const hD = sampleHeight(dem, x, z - ds);
      const hU = sampleHeight(dem, x, z + ds);
      const concav = (hL + hR + hD + hU) * 0.25 - y;
      const drainage = Math.max(0, Math.min(1, concav / 4 + (0.3 - elevT) * 0.6));

      // Macro habitat noise so a region biases to one community.
      const macro = (noise(x * 0.0008, z * 0.0008) + 1) * 0.5;

      // Compute per-species suitability and aggregate density.
      let sumP = 0;
      for (let k = 0; k < SPECIES.length; k++) {
        const s = SPECIES[k];
        const suit = s.suitability(slopeT, elevT, drainage, macro);
        speciesProbs[k] = Math.max(0, suit) * s.densityScale;
        sumP += speciesProbs[k];
      }

      // Acceptance roll — analogous to Poisson density.
      const rand = (blueNoise(i * 1.13 + 5.0, j * 1.07 + 9.0) + 1) * 0.5;
      const accept = sumP * globalDensity;
      if (rand > accept) continue;

      // Pick species weighted by suit.
      const pick = ((blueNoise(i * 0.71 + 11.0, j * 0.69 + 13.0) + 1) * 0.5) * sumP;
      let cum = 0, chosen = 0;
      for (let k = 0; k < SPECIES.length; k++) {
        cum += speciesProbs[k];
        if (pick <= cum) { chosen = k; break; }
      }

      const sp = SPECIES[chosen];
      const sizeRand = ((blueNoise(i * 0.57, j * 0.61) + 1) * 0.5);
      const h = sp.height[0] + sizeRand * (sp.height[1] - sp.height[0]);
      const rot = ((blueNoise(i * 0.33 + 17.0, j * 0.41 + 19.0) + 1) * Math.PI);

      positions[n * 3 + 0] = x;
      positions[n * 3 + 1] = y;
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
