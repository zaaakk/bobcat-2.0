import { findWaterPools } from './WaterAnalysis.js';
import { createWaterRenderer } from './WaterRenderer.js';

/**
 * Public entry for the water feature. Three steps, each in its own module:
 *
 *   1. analysis  — findWaterPools(terrainQuery)         WaterAnalysis.js
 *   2. (future)  — carve basins into a sidecar displacement layer so each
 *                  pool sits in a real depression instead of perching on a
 *                  slope shelf. Will go between (1) and (3).
 *   3. renderer  — createWaterRenderer({ pools, scene }) WaterRenderer.js
 *
 * Returns { mesh, pools, update, dispose } — `pools` is the analysis output
 * (world-space {x,y,z,r,kind,depth}) so HUD/interaction can query it without
 * touching the renderer.
 */
export function createWaterPools({ terrainQuery, scene, maxPools = 60 }) {
  const pools = findWaterPools(terrainQuery, { maxPools });
  const rivers = pools.filter(p => p.kind === 'river').length;
  const tinajas = pools.filter(p => p.kind === 'tinaja').length;
  console.log(`water: ${rivers} river pools + ${tinajas} tinajas`);

  if (!pools.length) {
    return { mesh: null, pools: [], update: () => {}, dispose: () => {} };
  }

  const renderer = createWaterRenderer({ pools, scene });
  return {
    mesh: renderer.mesh,
    pools,
    update: renderer.update,
    dispose: renderer.dispose
  };
}
