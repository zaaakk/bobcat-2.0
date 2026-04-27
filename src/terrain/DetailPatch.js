import * as THREE from 'three';
import { TERRAIN_VERT, TERRAIN_FRAG } from './TerrainMesh.js';

/**
 * High-resolution terrain mesh that follows the player.
 *
 * The base terrain mesh is 1280 segments over a ~33km plane → 26m vertex
 * spacing. That's coarse enough that the cat "feels giant vertices"
 * underfoot and the detail-noise wavelengths get averaged out before they
 * can show. Bumping the base mesh resolution scales the cost across the
 * whole world; instead we draw a small patch around the camera/cat.
 *
 *   size       150m × 150m around the cat
 *   resolution 256 segments → 0.59m vertex spacing
 *   cost       ~65k extra vertices (vs 1.6M base) — ~4% overhead
 *   surface    same height function as the base mesh, so the patch is
 *              co-planar with it. Detail-noise contribution fades to 0
 *              over the outer 15% of the patch so the seam where it meets
 *              the base mesh has no height discontinuity.
 *
 * Shares the terrain's uniforms object — env updates, lighting, fog all
 * stay in lockstep with the base mesh automatically. The patch material
 * adds `IS_PATCH` so the shader's `patchDetailFade()` activates and
 * `uPatchCenter` gets read.
 */
export function createDetailPatch({ terrain, size = 150, resolution = 256 }) {
  const geometry = new THREE.PlaneGeometry(size, size, resolution, resolution);
  geometry.rotateX(-Math.PI / 2);

  // Drive the patch from the same uniforms object the base mesh uses, so
  // every env-driven update (sunDir, fog, lantern, etc.) reaches both.
  const uniforms = terrain.uniforms;
  uniforms.uPatchHalfSize.value = size * 0.5;

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: TERRAIN_VERT,
    fragmentShader: TERRAIN_FRAG,
    defines: { IS_PATCH: 1 },
    side: THREE.FrontSide,
    fog: false,
    // Tiny depth bias so we win over the base mesh where they're co-planar.
    // No actual height shift — we only nudge the depth-buffer comparison.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const mesh = new THREE.Mesh(geometry, material);
  // Frustum-cull is fine — the patch is a small bounded mesh, Three handles
  // it. (The base mesh disables culling because it spans the whole world.)
  mesh.frustumCulled = true;
  mesh.receiveShadow = false;
  // Renders after the base mesh, so the polygon offset's depth-bias decides
  // who wins on overlapping pixels.
  mesh.renderOrder = 1;

  /**
   * Move the patch to centre on (x, z). Call once per frame with the
   * bobcat's (or camera's) ground position. The vertex shader uses
   * uPatchCenter (in world XZ) for both height-sampling neighbours and
   * the edge-fade calculation, so we update it in lockstep with mesh
   * position.
   */
  function update(x, z) {
    mesh.position.set(x, 0, z);
    uniforms.uPatchCenter.value.set(x, z);
  }

  return { mesh, material, update };
}
