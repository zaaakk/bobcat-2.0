/**
 * Water-pool analysis: pure functions over TerrainQuery that decide *where*
 * water sits. No Three.js, no scene access, no rendering.
 *
 * Pool shape (returned to the renderer + UI):
 *   { x, y, z, r, depth }
 *     x, z   — world coords of the pool centre
 *     y      — water surface elevation (groundY at centre + small offset)
 *     r      — disc radius in metres
 *     depth  — mean ring elevation minus floor (informational)
 *
 * Single-algorithm bowl detection:
 *   A cell qualifies as a pool centre only if it is **strictly lower** than
 *   ALL 8 ring neighbours at radius=3 cells (~50m). That guarantees raised
 *   terrain on every side; the water disc sits in a real depression instead
 *   of perching on a slope shelf or floating in space.
 *
 *   This unified test catches both the small "tinaja" rock-pools scattered
 *   across the desert AND the genuinely-low cells in the Devils River bed
 *   (which are local minima of their own valley). The result is fewer
 *   pools but each is a real bowl.
 */

const RING_RADIUS         = 3;       // cells; ~50m on our DEM (16m/cell)
const RING_OFFSETS = [
  [ RING_RADIUS, 0], [-RING_RADIUS, 0],
  [0,  RING_RADIUS], [0, -RING_RADIUS],
  [ RING_RADIUS,  RING_RADIUS], [-RING_RADIUS,  RING_RADIUS],
  [ RING_RADIUS, -RING_RADIUS], [-RING_RADIUS, -RING_RADIUS],
];
const INNER_OFFSETS = [             // 8 immediate neighbours (3×3)
  [ 1, 0], [-1, 0], [0,  1], [0, -1],
  [ 1, 1], [-1, 1], [ 1, -1], [-1, -1],
];

const MIN_DEPTH           = 0.40;   // metres; mean-ring above floor
const SPREAD_RADIUS_M     = 120;    // greedy thinning radius
const SURFACE_OFFSET      = 0.30;   // surface above the lowest cell

export function findWaterPools(terrainQuery, { maxPools = 30 } = {}) {
  const tq = terrainQuery;

  // Strict bowl test: ALL 8 ring neighbours strictly higher AND every
  // immediate neighbour also higher (3×3 local minimum). The dual test
  // rejects flat-bottomed plateaus where ring-3 happens to be higher but
  // the cell itself sits on a slope.
  const bowls = tq.findCells(c => {
    let ringSum = 0;
    for (const [di, dj] of RING_OFFSETS) {
      const nz = c.neighbourHeight(di, dj);
      if (nz <= c.height) return false;        // any ring neighbour ≤ → reject
      ringSum += nz;
    }
    for (const [di, dj] of INNER_OFFSETS) {
      if (c.neighbourHeight(di, dj) < c.height) return false; // local-min check
    }
    const depth = ringSum / RING_OFFSETS.length - c.height;
    return depth >= MIN_DEPTH;
  }, { margin: RING_RADIUS });

  // Decorate with depth + radius hint, sorted deepest first.
  const decorated = bowls.map(c => {
    const meanRing = RING_OFFSETS.reduce(
      (s, [di, dj]) => s + tq.cellHeight(c.i + di, c.j + dj),
      0
    ) / RING_OFFSETS.length;
    const depth = meanRing - c.height;
    // Radius scales with depth but capped so even rich bowls don't dominate.
    const r = Math.min(7, 1.8 + depth * 1.4);
    return { i: c.i, j: c.j, z: c.height, depth, r };
  }).sort((a, b) => b.depth - a.depth);

  // Greedy spread: each kept pool reserves SPREAD_RADIUS_M around itself so
  // pools distribute across the map rather than clustering in one canyon.
  const spreadCells = SPREAD_RADIUS_M / tq.pixelSize;
  const spreadR2 = spreadCells * spreadCells;
  const kept = [];
  for (const t of decorated) {
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

  return kept.map(p => {
    const { x, z } = tq.cellToWorld(p.i, p.j);
    // Ground sample uses the **base DEM** (no detail) — pools are co-located
    // with the detail-suppression mask in DetailNoise so the rendered surface
    // there equals the base DEM. Asking sampleGroundY would also work but
    // would mix in the detail's residual mask-fade; using _sampleDemHeight
    // keeps the surface elevation pinned to the actual bowl floor.
    const groundLow = tq._sampleDemHeight(x, z);
    return {
      x, z,
      y: groundLow + SURFACE_OFFSET,
      r: Math.max(2.0, p.r),
      depth: p.depth,
    };
  });
}
