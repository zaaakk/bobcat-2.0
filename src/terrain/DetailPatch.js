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
 *   resolution 512 segments → 0.29m vertex spacing (Nyquist ≈ 0.6m features)
 *   cost       ~262k extra vertices (vs 1.6M base) — ~16% overhead
 *   surface    same height function as the base mesh, so the patch is
 *              co-planar with it. Detail-noise contribution fades to 0
 *              over the outer 15% of the patch so the seam where it meets
 *              the base mesh has no height discontinuity.
 *
 * Why 512: at 256 segments (0.59m spacing) the vertex grid was the
 * resolution bottleneck — even with sub-metre noise the geometry could
 * only express features ≥1.2m. Doubling segments halves the smallest
 * resolvable feature.
 *
 * Shares the terrain's uniforms object — env updates, lighting, fog all
 * stay in lockstep with the base mesh automatically. The patch material
 * adds `IS_PATCH` so the shader's `patchDetailFade()` activates and
 * `uPatchCenter` gets read.
 */
export function createDetailPatch({ terrain, size = 150, resolution = 512 }) {
  const geometry = new THREE.PlaneGeometry(size, size, resolution, resolution);
  geometry.rotateX(-Math.PI / 2);

  // Patch uniforms: shallow-copy the base's so env/sun/fog updates reach
  // both materials through the same `{ value: ... }` wrapper objects, but
  // OVERRIDE the entries that must differ per material:
  //
  //   uMeshSpacing — used by the vertex shader's finite-difference normal
  //                  computation. The base mesh's spacing (~26m) was being
  //                  reused here; result: patch geometry had fine detail
  //                  but its *lighting* averaged that detail over a 52m
  //                  window — the "low-poly look" feel. Setting this to
  //                  the patch's actual spacing makes normals capture the
  //                  fine bumps so the surface lights as bumpy as it is.
  //
  //   uPatchHalfSize — sized to this specific patch's extent so
  //                    patchDetailFade() ramps over the right region.
  //
  // uPatchCenter is shared by reference because update() writes to it and
  // both the base mesh's `IS_PATCH 0` path and the patch's `IS_PATCH 1`
  // path will see the latest value (only the patch shader actually reads
  // it, but having one source of truth is cleaner).
  const patchSpacing = size / resolution;
  const uniforms = {
    ...terrain.uniforms,
    uMeshSpacing:   { value: new THREE.Vector2(patchSpacing, patchSpacing) },
    uPatchHalfSize: { value: size * 0.5 },
  };

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
  // Disable frustum culling: the geometry's bounding sphere is computed
  // from its local positions (a flat plane at y=0), but the vertex shader
  // displaces vertices to terrain elevation (~500m). Three.js doesn't know
  // about that displacement, so it culls the patch as "below the camera"
  // even though the rendered geometry is right under the cat. Same reason
  // the base terrain mesh disables culling.
  mesh.frustumCulled = false;
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
