/**
 * Water-pool analysis: pure functions over TerrainQuery that decide *where*
 * water sits. No Three.js, no scene access, no rendering — this layer is the
 * single source of truth for "the world has these pools".
 *
 * Pool shape (returned to the renderer + UI):
 *   { x, y, z, r, kind, depth }
 *     x, z   — world coords of the pool centre
 *     y      — water surface elevation (groundY at centre + a small offset)
 *     r      — disc radius in metres
 *     kind   — 'river' (perennial) | 'tinaja' (seasonal rock-pool)
 *     depth  — for tinajas, mean ring elevation minus floor; for rivers, 0.
 *              Informational — the renderer doesn't need it, but features that
 *              want to deepen-tint or carve a basin can read it.
 *
 * Two flavours, both realistic for the Devil's River watershed:
 *   1. river  — actual lowest cells (bottom 4%), greedy-clustered. Devil's
 *               River main channel + a couple of major arroyos.
 *   2. tinaja — concave depressions (≥6 of 8 ring neighbours higher AND mean
 *               ring is at least minDepth metres above). Seasonal rock-pools
 *               scattered across the desert.
 */

const RIVER_LOWEST_PERCENTILE = 0.04;     // bottom 4% of elevation = "river"
const RIVER_MERGE_RADIUS_M    = 30;
const RIVER_HARD_CAP          = 8;
const TINAJA_RING_RADIUS      = 3;        // cells; ~50m for our DEM
const TINAJA_MIN_DEPTH        = 0.40;     // mean-ring metres above floor
const TINAJA_MIN_HIGHER       = 6;        // of 8 ring neighbours
const TINAJA_SPREAD_RADIUS_M  = 120;      // greedy thinning radius
const SURFACE_OFFSET          = 0.32;     // surface above lowest cell

const TINAJA_RING_OFFSETS = [
  [ TINAJA_RING_RADIUS, 0], [-TINAJA_RING_RADIUS, 0],
  [0,  TINAJA_RING_RADIUS], [0, -TINAJA_RING_RADIUS],
  [ TINAJA_RING_RADIUS,  TINAJA_RING_RADIUS], [-TINAJA_RING_RADIUS,  TINAJA_RING_RADIUS],
  [ TINAJA_RING_RADIUS, -TINAJA_RING_RADIUS], [-TINAJA_RING_RADIUS, -TINAJA_RING_RADIUS],
];

export function findWaterPools(terrainQuery, { maxPools = 60 } = {}) {
  const rivers = findRiverPools(terrainQuery);
  const tinajaBudget = Math.max(0, maxPools - rivers.length);
  const tinajas = findTinajaPools(terrainQuery, { maxPools: tinajaBudget });
  return [...rivers, ...tinajas];
}

function findRiverPools(tq) {
  const elevRange = tq.maxElevation - tq.minElevation;
  const riverThresh = tq.minElevation + elevRange * RIVER_LOWEST_PERCENTILE;
  const lowCells = tq.findCells(c => c.height < riverThresh)
    .map(c => ({ i: c.i, j: c.j, z: c.height }))
    .sort((a, b) => a.z - b.z);

  const mergeRadiusCells = RIVER_MERGE_RADIUS_M / tq.pixelSize;
  const mergeR2 = mergeRadiusCells * mergeRadiusCells;
  const clusters = [];
  for (const c of lowCells) {
    let attached = false;
    for (const p of clusters) {
      const di = c.i - p.i, dj = c.j - p.j;
      if (di * di + dj * dj < mergeR2) {
        p.i = (p.i * p.n + c.i) / (p.n + 1);
        p.j = (p.j * p.n + c.j) / (p.n + 1);
        p.z = Math.min(p.z, c.z);
        p.n += 1;
        p.r = Math.max(p.r, Math.sqrt(di * di + dj * dj));
        attached = true;
        break;
      }
    }
    if (!attached && clusters.length < 12) {
      clusters.push({ i: c.i, j: c.j, z: c.z, n: 1, r: 1.5 });
    }
  }
  // Keep the largest clusters first; cap at the hard limit.
  clusters.sort((a, b) => b.n - a.n);
  clusters.length = Math.min(clusters.length, RIVER_HARD_CAP);

  return clusters.map(p => clusterToPool(tq, p, 'river'));
}

function findTinajaPools(tq, { maxPools }) {
  if (maxPools <= 0) return [];
  // Scan: keep cells where 6+ ring neighbours are higher AND mean ring is
  // at least minDepth metres above. Margin avoids the edge of the DEM.
  const tinajaCells = tq.findCells(c => {
    let sum = 0, higherCount = 0;
    for (const [di, dj] of TINAJA_RING_OFFSETS) {
      const nz = c.neighbourHeight(di, dj);
      sum += nz;
      if (nz > c.height) higherCount++;
    }
    return higherCount >= TINAJA_MIN_HIGHER &&
           (sum / TINAJA_RING_OFFSETS.length - c.height) >= TINAJA_MIN_DEPTH;
  }, { margin: TINAJA_RING_RADIUS });

  // Decorate with depth + radius hint, then thin by greedy spread so they
  // distribute across the map instead of clustering in the deepest canyon.
  const cells = tinajaCells.map(c => {
    const meanRing = TINAJA_RING_OFFSETS.reduce(
      (s, [di, dj]) => s + tq.cellHeight(c.i + di, c.j + dj),
      0
    ) / TINAJA_RING_OFFSETS.length;
    const depth = meanRing - c.height;
    return { i: c.i, j: c.j, z: c.height, depth, r: Math.min(9, 2 + depth * 1.5), n: 1 };
  });
  cells.sort((a, b) => b.depth - a.depth);

  const spreadCells = TINAJA_SPREAD_RADIUS_M / tq.pixelSize;
  const spreadR2 = spreadCells * spreadCells;
  const kept = [];
  for (const t of cells) {
    let tooClose = false;
    for (const k of kept) {
      const di = t.i - k.i, dj = t.j - k.j;
      if (di * di + dj * dj < spreadR2) { tooClose = true; break; }
    }
    if (!tooClose) {
      kept.push(t);
      if (kept.length >= maxPools) break;
    }
  }
  return kept.map(p => clusterToPool(tq, p, 'tinaja'));
}

/**
 * Convert an analysis cluster (cell-space) into a renderer-ready pool.
 *
 *   river  pools — radius from the cluster spread (cells × pixelSize), floor
 *                  at 4m so single-cell pools still read.
 *   tinaja pools — `r` is already in metres (scaled from depth).
 */
function clusterToPool(tq, p, kind) {
  const { x, z } = tq.cellToWorld(p.i, p.j);
  const groundLow = tq.sampleGroundY(x, z);
  const r = kind === 'tinaja'
    ? Math.max(2.5, p.r)
    : Math.max(4, p.r * tq.pixelSize);
  return {
    x, z,
    y: groundLow + SURFACE_OFFSET,
    r,
    kind,
    depth: p.depth || 0
  };
}
