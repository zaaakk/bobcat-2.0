import { sampleHeight, sampleSlope } from '../terrain/DEMLoader.js';
import { createNoise2D } from 'simplex-noise';
import { SPECIES } from './species.js';

const STREAM_NOISE = {
  macro: createNoise2D(() => 0.137),
  accept: createNoise2D(() => 0.91),
  jitter: createNoise2D(() => 0.49),
  speciesClump: SPECIES.map(s => createNoise2D(() => s.clumpSeed))
};

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
  innerRadius = 0,
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
  const innerR2 = innerRadius * innerRadius;

  const elevRange = Math.max(1, dem.maxZ - dem.minZ);
  const maxClusterMul = Math.max(...SPECIES.map(s => s.clusterCount ? s.clusterCount[1] : 1));

  const bufN = Math.min(maxInstances, cols * rows * maxClusterMul);
  const positions = new Float32Array(bufN * 3);
  const scales    = new Float32Array(bufN);
  const rotations = new Float32Array(bufN);
  const speciesId = new Uint8Array(bufN);
  let n = 0;

  const speciesScores = new Array(SPECIES.length);

  // Build a shuffled cell-index list so when the buffer fills, accepted plants
  // are distributed across the whole play area instead of saturating one
  // corner. We shuffle deterministically (Fisher-Yates with a fixed PRNG) so
  // placement is reproducible.
  const cellOrder = new Int32Array(cols * rows);
  for (let k = 0; k < cellOrder.length; k++) cellOrder[k] = k;
  let prngState = 0x9E3779B1;
  function prngU32() {
    prngState = ((prngState ^ (prngState << 13)) | 0) >>> 0;
    prngState = ((prngState ^ (prngState >>> 17)) | 0) >>> 0;
    prngState = ((prngState ^ (prngState << 5)) | 0) >>> 0;
    return prngState;
  }
  for (let k = cellOrder.length - 1; k > 0; k--) {
    const swap = prngU32() % (k + 1);
    const tmp = cellOrder[k]; cellOrder[k] = cellOrder[swap]; cellOrder[swap] = tmp;
  }

  for (let cellIdx = 0; cellIdx < cellOrder.length; cellIdx++) {
    if (n >= bufN) break;
    const flat = cellOrder[cellIdx];
    const j = (flat / cols) | 0;
    const i = flat - j * cols;
    {

      const baseX = playOriginX + (i + 0.5) * cellSize;
      const baseZ = playOriginZ + (j + 0.5) * cellSize;
      const baseD2 = baseX * baseX + baseZ * baseZ;
      if (baseD2 > r2 || baseD2 < innerR2) continue;

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
      const clusterMin = sp.clusterCount ? sp.clusterCount[0] : 1;
      const clusterMax = sp.clusterCount ? sp.clusterCount[1] : 1;
      const clusterCount = Math.max(1, Math.round(clusterMin + ((acceptNoise(i * 0.79 + 23.0, j * 0.73 + 29.0) + 1) * 0.5) * (clusterMax - clusterMin)));

      for (let c = 0; c < clusterCount; c++) {
        if (n >= bufN) break;

        let px = x;
        let pz = z;
        if (c > 0 && sp.clusterRadius) {
          const ang = ((acceptNoise(i * 0.17 + c * 6.1 + 31.0, j * 0.13 + c * 4.7 + 37.0) + 1) * 0.5) * Math.PI * 2;
          const radiusT = ((acceptNoise(i * 0.29 + c * 7.3 + 41.0, j * 0.23 + c * 5.9 + 43.0) + 1) * 0.5);
          const radius = sp.clusterRadius[0] + radiusT * (sp.clusterRadius[1] - sp.clusterRadius[0]);
          px += Math.cos(ang) * radius;
          pz += Math.sin(ang) * radius;
          const pD2 = px * px + pz * pz;
          if (pD2 > r2 || pD2 < innerR2) continue;
        }

        const sizeRand = ((acceptNoise(i * 0.57 + c * 3.7, j * 0.61 + c * 2.9) + 1) * 0.5);
        const rot = ((acceptNoise(i * 0.33 + 17.0 + c * 5.3, j * 0.41 + 19.0 + c * 4.1) + 1) * 0.5) * Math.PI * 2;
        const h = sp.height[0] + sizeRand * (sp.height[1] - sp.height[0]);

        positions[n * 3 + 0] = px;
        positions[n * 3 + 1] = sampleY(px, pz);
        positions[n * 3 + 2] = pz;
        scales[n] = h;
        rotations[n] = rot;
        speciesId[n] = chosen;
        n++;
      }
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

export function mergeVegetation(...sets) {
  const valid = sets.filter(Boolean);
  const count = valid.reduce((sum, set) => sum + set.count, 0);
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count);
  const rotations = new Float32Array(count);
  const species = new Uint8Array(count);
  let pOff = 0;
  let iOff = 0;
  for (const set of valid) {
    positions.set(set.positions, pOff);
    scales.set(set.scales, iOff);
    rotations.set(set.rotations, iOff);
    species.set(set.species, iOff);
    pOff += set.count * 3;
    iOff += set.count;
  }
  return { positions, scales, rotations, species, count };
}

export function generateVegetationChunk({
  dem,
  groundY,
  chunkX,
  chunkZ,
  mode = 'dense',
  chunkSize = 512,
  cellSize = 4,
  globalDensity = 1,
  acceptancePower = 1,
  acceptanceFloor = 0,
  jitter = 1,
  maxPerChunk = 12000
}) {
  const sourceMode = mode === 'far' ? 1 : 0;
  const minX = chunkX * chunkSize;
  const minZ = chunkZ * chunkSize;
  const maxX = minX + chunkSize;
  const maxZ = minZ + chunkSize;
  const halfW = dem.worldWidth * 0.5;
  const halfH = dem.worldHeight * 0.5;
  const maxClusterRadius = Math.max(...SPECIES.map(s => s.clusterRadius ? s.clusterRadius[1] : 0));
  const halo = maxClusterRadius + cellSize;
  const minI = Math.floor((minX - halo) / cellSize - 0.5);
  const maxI = Math.floor((maxX + halo) / cellSize - 0.5);
  const minJ = Math.floor((minZ - halo) / cellSize - 0.5);
  const maxJ = Math.floor((maxZ + halo) / cellSize - 0.5);
  const sampleY = groundY || ((x, z) => sampleHeight(dem, x, z));
  const elevRange = Math.max(1, dem.maxZ - dem.minZ);

  const positions = new Float32Array(maxPerChunk * 3);
  const scales = new Float32Array(maxPerChunk);
  const rotations = new Float32Array(maxPerChunk);
  const speciesId = new Uint8Array(maxPerChunk);
  const sourceModes = new Float32Array(maxPerChunk);
  const speciesScores = new Array(SPECIES.length);
  const stats = {
    mode,
    candidates: 0,
    rejectedOutsideDem: 0,
    rejectedSuitability: 0,
    rejectedAcceptance: 0,
    rejectedChunkOwnership: 0,
    acceptedParents: 0,
    emitted: 0,
    capped: false
  };
  let n = 0;

  for (let j = minJ; j <= maxJ; j++) {
    for (let i = minI; i <= maxI; i++) {
      if (n >= maxPerChunk) { stats.capped = true; break; }
      stats.candidates++;

      const baseX = (i + 0.5) * cellSize;
      const baseZ = (j + 0.5) * cellSize;
      if (baseX < -halfW || baseX > halfW || baseZ < -halfH || baseZ > halfH) {
        stats.rejectedOutsideDem++;
        continue;
      }

      const jx = STREAM_NOISE.jitter(i * 0.31, j * 0.27);
      const jz = STREAM_NOISE.jitter(i * 0.19 + 7.1, j * 0.23 + 3.7);
      const x = baseX + jx * cellSize * jitter;
      const z = baseZ + jz * cellSize * jitter;
      if (x < -halfW || x > halfW || z < -halfH || z > halfH) {
        stats.rejectedOutsideDem++;
        continue;
      }

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
      const macro = (STREAM_NOISE.macro(x * 0.0008, z * 0.0008) + 1) * 0.5;

      let bestScore = 0, bestK = -1, sumScores = 0;
      for (let k = 0; k < SPECIES.length; k++) {
        const sp = SPECIES[k];
        const suit = sp.suitability(slopeT, elevT, drainage, macro);
        if (suit <= 0) { speciesScores[k] = 0; continue; }
        const cn = (STREAM_NOISE.speciesClump[k](x * sp.clumpFreq, z * sp.clumpFreq) + 1) * 0.5;
        const clump = sp.clumpFloor + (1 - sp.clumpFloor) * Math.pow(cn, sp.clumpSharpness);
        const score = suit * sp.densityScale * clump;
        speciesScores[k] = score;
        sumScores += score;
        if (score > bestScore) { bestScore = score; bestK = k; }
      }
      if (bestK < 0 || sumScores <= 0) {
        stats.rejectedSuitability++;
        continue;
      }

      const acceptBase = Math.pow(Math.max(0, bestScore), acceptancePower) * globalDensity;
      const accept = Math.min(1, Math.max(acceptanceFloor, acceptBase));
      const rand = (STREAM_NOISE.accept(i * 1.13 + 5.0, j * 1.07 + 9.0) + 1) * 0.5;
      if (rand > accept) {
        stats.rejectedAcceptance++;
        continue;
      }
      stats.acceptedParents++;

      const pick = ((STREAM_NOISE.accept(i * 0.71 + 11.0, j * 0.69 + 13.0) + 1) * 0.5) * sumScores;
      let cum = 0, chosen = bestK;
      for (let k = 0; k < SPECIES.length; k++) {
        cum += speciesScores[k];
        if (pick <= cum) { chosen = k; break; }
      }

      const sp = SPECIES[chosen];
      const clusterMin = sp.clusterCount ? sp.clusterCount[0] : 1;
      const clusterMax = sp.clusterCount ? sp.clusterCount[1] : 1;
      const clusterCount = Math.max(1, Math.round(clusterMin + ((STREAM_NOISE.accept(i * 0.79 + 23.0, j * 0.73 + 29.0) + 1) * 0.5) * (clusterMax - clusterMin)));

      for (let c = 0; c < clusterCount; c++) {
        if (n >= maxPerChunk) { stats.capped = true; break; }

        let px = x;
        let pz = z;
        if (c > 0 && sp.clusterRadius) {
          const ang = ((STREAM_NOISE.accept(i * 0.17 + c * 6.1 + 31.0, j * 0.13 + c * 4.7 + 37.0) + 1) * 0.5) * Math.PI * 2;
          const radiusT = ((STREAM_NOISE.accept(i * 0.29 + c * 7.3 + 41.0, j * 0.23 + c * 5.9 + 43.0) + 1) * 0.5);
          const radius = sp.clusterRadius[0] + radiusT * (sp.clusterRadius[1] - sp.clusterRadius[0]);
          px += Math.cos(ang) * radius;
          pz += Math.sin(ang) * radius;
        }

        if (px < minX || px >= maxX || pz < minZ || pz >= maxZ) {
          stats.rejectedChunkOwnership++;
          continue;
        }
        if (px < -halfW || px > halfW || pz < -halfH || pz > halfH) {
          stats.rejectedOutsideDem++;
          continue;
        }

        const sizeRand = ((STREAM_NOISE.accept(i * 0.57 + c * 3.7, j * 0.61 + c * 2.9) + 1) * 0.5);
        const rot = ((STREAM_NOISE.accept(i * 0.33 + 17.0 + c * 5.3, j * 0.41 + 19.0 + c * 4.1) + 1) * 0.5) * Math.PI * 2;
        const h = sp.height[0] + sizeRand * (sp.height[1] - sp.height[0]);

        positions[n * 3 + 0] = px;
        positions[n * 3 + 1] = sampleY(px, pz);
        positions[n * 3 + 2] = pz;
        scales[n] = h;
        rotations[n] = rot;
        speciesId[n] = chosen;
        sourceModes[n] = sourceMode;
        n++;
        stats.emitted++;
      }
    }
  }

  return {
    key: `${chunkX},${chunkZ}`,
    chunkX,
    chunkZ,
    positions: positions.subarray(0, n * 3),
    scales: scales.subarray(0, n),
    rotations: rotations.subarray(0, n),
    species: speciesId.subarray(0, n),
    sourceModes: sourceModes.subarray(0, n),
    stats,
    count: n
  };
}
