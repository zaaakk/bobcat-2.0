import { findWaterPools } from './WaterAnalysis.js';
import { createWaterRenderer } from './WaterRenderer.js';

/**
 * Public entry for the water feature. Three steps, each in its own module:
 *
 *   1. analysis  — findWaterPools(terrainQuery)         WaterAnalysis.js
 *   2. detail    — DetailNoise suppresses caprock bumps inside pool radii so
 *                  the surface stays clean (handled in World.init via the
 *                  `pools` arg to generateDetailNoise). The pool list is
 *                  passed in pre-detected so we don't repeat the work.
 *   3. renderer  — createWaterRenderer({ pools, scene }) WaterRenderer.js
 *
 * Returns { mesh, pools, update, dispose } — `pools` is the analysis output
 * (world-space {x,y,z,r,depth}) so HUD/interaction can query it without
 * touching the renderer.
 */
export function createWaterPools({ terrainQuery, scene, pools = null, maxPools = 30 }) {
  const detected = pools ?? findWaterPools(terrainQuery, { maxPools });

  if (!detected.length) {
    return { mesh: null, pools: [], update: () => {}, dispose: () => {} };
  }

  const renderer = createWaterRenderer({ pools: detected, scene });
  return {
    mesh: renderer.mesh,
    pools: detected,
    update: renderer.update,
    dispose: renderer.dispose,
  };
}
