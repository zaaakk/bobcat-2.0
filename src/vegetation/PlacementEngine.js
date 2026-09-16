import { sampleHeight, sampleSlope } from '../terrain/DEMLoader.js';
import { createNoise2D } from 'simplex-noise';
import { SPECIES } from './species.js';

const STREAM_NOISE = {
  macro: createNoise2D(() => 0.137),
  accept: createNoise2D(() => 0.91),
  jitter: createNoise2D(() => 0.49),
  speciesClump: SPECIES.map(s => createNoise2D(() => s.clumpSeed))
};

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * How deep inside this species' own patch the point sits, 0..1.
 *
 * Two shapes. The default power curve gives a soft, gradual falloff — right
 * for things that thin out at the edges, like scattered yucca. A species with
 * `clumpBand` instead gets a smoothstep across a narrow band of the noise,
 * which saturates to 1 over most of the patch and falls to the floor within a
 * few tens of metres: a carpet with an edge, not a gradient. `clumpDetail`
 * mixes in a higher-frequency octave so that edge comes out ragged and
 * terrain-like rather than as a clean simplex oval.
 */
function clumpAt(sp, noise, x, z) {
  let cn = (noise(x * sp.clumpFreq, z * sp.clumpFreq) + 1) * 0.5;
  if (sp.clumpDetail) {
    const f = sp.clumpFreq * 3.7;
    const d = (noise(x * f + 91.3, z * f + 57.1) + 1) * 0.5;
    cn = cn * (1 - sp.clumpDetail) + d * sp.clumpDetail;
  }
  const shaped = sp.clumpBand
    ? smoothstep(sp.clumpBand[0], sp.clumpBand[1], cn)
    : Math.pow(cn, sp.clumpSharpness);
  return sp.clumpFloor + (1 - sp.clumpFloor) * shaped;
}

// Scratch result for scoreCell — reused so the per-cell scan (tens of
// thousands of cells per chunk) doesn't allocate.
const CELL = { bestScore: 0, bestK: -1, sumScores: 0 };

/**
 * Fill `scores` with each species' placement weight at (x, z).
 *
 * Stage one is the raw weight: habitat suitability x that species' density x
 * how deep inside its clump patch we are. Stage two is canopy suppression —
 * inside a juniper brake or a mesquite mott the canopy closes over and the
 * understory simply isn't there. Without it every cell is an independent
 * lottery draw and the result is an even salt-and-pepper mix of all nine
 * species no matter how the densities are tuned; with it the dominant woody
 * species takes whole hillsides and the rest retreat to the openings.
 *
 * Pressure is read off the clump field rather than off who won the lottery,
 * so neighbouring cells agree with each other and a brake gets a coherent
 * edge instead of a dithered one.
 */
function scoreCell(scores, clumpNoises, x, z, slopeT, elevT, drainage, macro, foliage) {
  // Track the two strongest canopies so a species is never shaded out by
  // itself — it feels the next canopy down instead.
  let topPress = 0, topK = -1, secondPress = 0;
  for (let k = 0; k < SPECIES.length; k++) {
    const sp = SPECIES[k];
    const suit = sp.suitability(slopeT, elevT, drainage, macro);
    if (suit <= 0) { scores[k] = 0; continue; }
    const clump = clumpAt(sp, clumpNoises[k], x, z);
    scores[k] = suit * sp.lotteryWeight * clump * foliageBias(sp, foliage);
    if (sp.canopyWeight > 0) {
      const press = Math.min(1, suit * 2) * clump * sp.canopyWeight;
      if (press > topPress) { secondPress = topPress; topPress = press; topK = k; }
      else if (press > secondPress) secondPress = press;
    }
  }

  let bestScore = 0, bestK = -1, sumScores = 0;
  for (let k = 0; k < SPECIES.length; k++) {
    let score = scores[k];
    if (score > 0 && topPress > 0) {
      const press = k === topK ? secondPress : topPress;
      score *= 1 - press * (1 - SPECIES[k].shadeTolerance);
      scores[k] = score;
    }
    sumScores += score;
    if (score > bestScore) { bestScore = score; bestK = k; }
  }
  CELL.bestScore = bestScore;
  CELL.bestK = bestK;
  CELL.sumScores = sumScores;
  return CELL;
}

/**
 * Placement uses a per-species clump field so each species has its own spatial
 * pattern: juniper closes into brakes, mesquite into motts, bunchgrass fills
 * the openings between them. The candidate grid is shared; each cell decides
 * which species (if any) it spawns by combining habitat suitability with that
 * species's own clumping noise, then letting any closed woody canopy overhead
 * shade out what can't live under it.
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
  maxInstances = 350_000,
  foliageField = null
}) {
  // One noise per species + one broad "macro habitat" noise that carries the
  // Edwards-Plateau-to-Chihuahuan ecotone axis (see HABITAT.desert in
  // species.js). Low frequency on purpose: the two floras interfinger over
  // kilometres, so this has to be much broader than any species' own clumping.
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

      const macro = (macroNoise(x * 0.00025, z * 0.00025) + 1) * 0.5;
      const foliage = foliageField ? foliageField.sample(x, z) : null;

      const { bestScore, bestK, sumScores } =
        scoreCell(speciesScores, speciesClumpNoise, x, z, slopeT, elevT, drainage, macro, foliage);
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

function setupVegetationChunk({
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
  maxPerChunk = 12000,
  foliageField = null
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

  // Visit cells in a deterministic shuffled order (same trick as
  // placeVegetation): if the chunk hits maxPerChunk, the cap then thins
  // density uniformly across the whole chunk instead of filling the
  // low-j rows and leaving a barren band across the rest.
  const spanI = maxI - minI + 1;
  const spanJ = maxJ - minJ + 1;
  const cellOrder = new Int32Array(spanI * spanJ);
  for (let k = 0; k < cellOrder.length; k++) cellOrder[k] = k;
  let prngState = ((chunkX * 73856093) ^ (chunkZ * 19349663) ^ 0x9E3779B1) >>> 0;
  if (prngState === 0) prngState = 0x9E3779B1;
  const prngU32 = () => {
    prngState = ((prngState ^ (prngState << 13)) | 0) >>> 0;
    prngState = ((prngState ^ (prngState >>> 17)) | 0) >>> 0;
    prngState = ((prngState ^ (prngState << 5)) | 0) >>> 0;
    return prngState;
  };
  for (let k = cellOrder.length - 1; k > 0; k--) {
    const swap = prngU32() % (k + 1);
    const tmp = cellOrder[k]; cellOrder[k] = cellOrder[swap]; cellOrder[swap] = tmp;
  }

  function processCell(cellK) {
    {
      const flat = cellOrder[cellK];
      const j = minJ + ((flat / spanI) | 0);
      const i = minI + (flat - ((flat / spanI) | 0) * spanI);
      if (n >= maxPerChunk) { stats.capped = true; return; }
      stats.candidates++;

      const baseX = (i + 0.5) * cellSize;
      const baseZ = (j + 0.5) * cellSize;
      if (baseX < -halfW || baseX > halfW || baseZ < -halfH || baseZ > halfH) {
        stats.rejectedOutsideDem++;
        return;
      }

      const jx = STREAM_NOISE.jitter(i * 0.31, j * 0.27);
      const jz = STREAM_NOISE.jitter(i * 0.19 + 7.1, j * 0.23 + 3.7);
      const x = baseX + jx * cellSize * jitter;
      const z = baseZ + jz * cellSize * jitter;
      if (x < -halfW || x > halfW || z < -halfH || z > halfH) {
        stats.rejectedOutsideDem++;
        return;
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
      const macro = (STREAM_NOISE.macro(x * 0.00025, z * 0.00025) + 1) * 0.5;
      const foliage = foliageField ? foliageField.sample(x, z) : null;

      const { bestScore, bestK, sumScores } =
        scoreCell(speciesScores, STREAM_NOISE.speciesClump, x, z, slopeT, elevT, drainage, macro, foliage);
      if (bestK < 0 || sumScores <= 0) {
        stats.rejectedSuitability++;
        return;
      }

      const acceptBase = Math.pow(Math.max(0, bestScore), acceptancePower) * globalDensity;
      const accept = Math.min(1, Math.max(acceptanceFloor, acceptBase));
      const rand = (STREAM_NOISE.accept(i * 1.13 + 5.0, j * 1.07 + 9.0) + 1) * 0.5;
      if (rand > accept) {
        stats.rejectedAcceptance++;
        return;
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

  function finalize() {
    stats.capped = n >= maxPerChunk;
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

  return {
    cellCount: cellOrder.length,
    processCell,
    finalize,
    isCapped: () => n >= maxPerChunk
  };
}

// Generate an entire chunk synchronously (used by prewarm during loading,
// where a loading screen hides the cost).
export function generateVegetationChunk(params) {
  const job = setupVegetationChunk(params);
  for (let k = 0; k < job.cellCount; k++) {
    if (job.isCapped()) break;
    job.processCell(k);
  }
  return job.finalize();
}

// Resumable variant for live streaming: step(maxCells) processes a slice of
// the chunk's cells and returns true when complete, so a dense chunk's
// ~60-90ms scan is spread across several frames instead of freezing one.
// Output is byte-identical to generateVegetationChunk for the same params —
// same shuffled cell order, same RNG stream — so pacing never changes layout.
export function createVegetationChunkJob(params) {
  const job = setupVegetationChunk(params);
  let k = 0;
  return {
    chunkX: params.chunkX,
    chunkZ: params.chunkZ,
    mode: params.mode,
    step(maxCells) {
      const end = Math.min(job.cellCount, k + maxCells);
      for (; k < end; k++) {
        if (job.isCapped()) { k = job.cellCount; break; }
        job.processCell(k);
      }
      return k >= job.cellCount;
    },
    result() { return job.finalize(); }
  };
}

function foliageBias(sp, foliage) {
  if (!foliage) return 1;
  if (sp.name === 'bunchgrass') return 0.35 + foliage.grass * 1.85 + foliage.edge * 0.20;
  if (sp.name === 'mesquite' || sp.name === 'velvetmesquite') {
    return 0.22 + foliage.woody * 2.35 + foliage.edge * 0.32;
  }
  // Juniper tracks the terrain's woody-mass field so the brakes land where
  // the ground is already tinted for canopy, but only mildly — the clump
  // band stays the primary thing deciding where a brake starts and stops.
  if (sp.name === 'juniper') return 0.72 + foliage.woody * 0.78;
  if (sp.name === 'creosote') return 0.75 + (1.0 - foliage.woody) * 0.35;
  return 0.82 + Math.max(foliage.grass, foliage.woody) * 0.32;
}
