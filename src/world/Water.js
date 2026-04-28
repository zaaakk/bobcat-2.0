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
// Surface height above the rendered (detail + carve) bowl floor. Devils-River
// pools are mostly shallow groundwater — keep this small so the cat barely
// wades, never accidentally swims.
const SURFACE_OFFSET = 0.12;

export function createWaterPools({ terrainQuery, scene, pools = null, maxPools = 30 }) {
  const detected = pools ?? findWaterPools(terrainQuery, { maxPools });

  if (!detected.length) {
    return { mesh: null, pools: [], update: () => {}, dispose: () => {} };
  }

  // Re-anchor each pool's surface to the *rendered* bowl floor. WaterAnalysis
  // runs before detailNoise is on the query (it has to — pool locations feed
  // into the detail-suppression mask), so its y is raw-DEM-based. By the time
  // we get here, terrainQuery.sampleGroundY includes the 3m carve and the
  // bedding/ridge masks, so it returns the actual rendered floor.
  for (const p of detected) {
    p.y = terrainQuery.sampleGroundY(p.x, p.z) + SURFACE_OFFSET;
  }

  const renderer = createWaterRenderer({ pools: detected, scene });
  return {
    mesh: renderer.mesh,
    pools: detected,
    update: renderer.update,
    dispose: renderer.dispose,
  };
}
