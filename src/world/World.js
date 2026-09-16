import { asset } from '../assetPath.js';
import * as THREE from 'three';

import { loadDEM, heightmapTexture } from '../terrain/DEMLoader.js';
import { TerrainQuery } from '../terrain/TerrainQuery.js';
import { generateSplatMap } from '../terrain/SplatMapGenerator.js';
import { createTerrainMesh } from '../terrain/TerrainMesh.js';
import { createDetailPatch } from '../terrain/DetailPatch.js';
import { loadGroundTextures } from '../terrain/GroundTextures.js';
import { generateDetailNoise } from '../terrain/DetailNoise.js';

import { buildSpriteAtlas } from '../vegetation/SpriteAtlas.js';
import { createInstancedPlants } from '../vegetation/InstancedPlants.js';
import { generateFoliageField } from '../vegetation/FoliageField.js';
import { createFoliageMassField } from '../vegetation/FoliageMassField.js';
import { SPECIES } from '../vegetation/species.js';

import { findWaterPools } from './WaterAnalysis.js';
import { createWaterPools } from './Water.js';
import { createGroundShadows } from './GroundShadows.js';

/**
 * The static world: terrain + landscape-derived features.
 *
 * Owns: dem, terrainQuery, terrain mesh, water, plants. Doesn't own the
 * player, mobs, environment/sky, or rendering — those compose with World
 * but live in their own modules.
 *
 * Init order matters because of cross-feature dependencies:
 *   1. DEM loaded.
 *   2. TerrainQuery built (without detail noise yet — pure DEM access).
 *   3. Pool detection runs against base DEM. Pools are world-space points.
 *   4. Detail noise generated WITH the pool list, suppressing the broad
 *      ridge inside each pool's radius so caprock bumps don't push up
 *      through the water surface.
 *   5. TerrainQuery's detailNoise reference is filled in, so subsequent
 *      groundY queries pick up the detail (everywhere except in pools).
 *   6. Terrain mesh + detail patch created.
 *   7. Water meshes built from the previously-detected pools.
 *   8. Vegetation placed.
 */
export class World {
  constructor({ scene, renderer, onProgress = () => {} }) {
    this.scene = scene;
    this.renderer = renderer;
    this._onProgress = onProgress;

    this.dem = null;
    this.terrainQuery = null;
    this.detailNoise = null;
    this.terrain = null;
    this.detailPatch = null;
    this.detailPatches = [];
    this.water = null;
    this.plants = null;
    this.foliageField = null;
    this.foliageMass = null;
    this.shadows = null;
    this.terrainSegments = 1280;
    // Padding ring around the DEM. Camera far plane is 25km, so any cat
    // position needs ~25km of terrain in every direction to never see the
    // plane's edge clipped against fog. With a ~21km DEM, half-extent is
    // ~10.5km, so padding = 15km guarantees ≥25km even from the DEM corner.
    this.terrainEdgePadding = 15000;
  }

  async init() {
    this._onProgress(0.05, 'Loading terrain…');
    this.dem = await loadDEM(asset('dem/terrarium.png'), asset('dem/terrarium.json'),
      t => this._onProgress(0.05 + t * 0.30, 'Loading terrain…'));
    console.log(
      `DEM ${this.dem.width}x${this.dem.height}, ` +
      `${this.dem.worldWidth.toFixed(0)}x${this.dem.worldHeight.toFixed(0)}m, ` +
      `elev ${this.dem.minZ.toFixed(0)}–${this.dem.maxZ.toFixed(0)}m`
    );

    const terrainPlaneSize = this.dem.worldWidth + this.terrainEdgePadding * 2;

    // (Step 2) TerrainQuery without detail/patch, so pool detection sees
    // the bare DEM. We mutate detailNoise + patchSpacing onto it later.
    this.terrainQuery = new TerrainQuery({
      dem: this.dem,
      terrainPlaneSize,
      terrainSegments: this.terrainSegments,
    });

    // (Step 3) Detect pool locations — strict bowl test.
    this._onProgress(0.38, 'Surveying water…');
    const pools = findWaterPools(this.terrainQuery, { maxPools: 30 });
    console.log(`water: ${pools.length} bowl pools`);

    // (Step 4) Detail noise, suppressed where the pools sit.
    this._onProgress(0.42, 'Painting ground…');
    const heightTex = heightmapTexture(THREE, this.dem);
    const splatPair = generateSplatMap(this.dem, 1280);
    this.splat = splatPair;
    this.foliageField = generateFoliageField({ dem: this.dem, splat: splatPair, resolution: 1280 });
    const regenerateSplat = splatPair.regenerate;
    splatPair.regenerate = patch => {
      regenerateSplat(patch);
      this.foliageField.regenerate();
    };
    const ground = await loadGroundTextures(this.renderer);

    this.detailNoise = generateDetailNoise({
      worldWidth:  this.dem.worldWidth,
      worldHeight: this.dem.worldHeight,
      resolution:  2048,
      pools,                  // suppress broad ridge + carve bowl
    });
    // (Step 5) Splice the freshly-baked noise into the existing query.
    this.terrainQuery.detailNoise = this.detailNoise;

    // (Step 6) Terrain meshes.
    this._onProgress(0.55, 'Building terrain mesh…');
    this.terrain = createTerrainMesh({
      dem: this.dem, heightTex, splatTex: splatPair,
      groundTextures: ground.diffuse,
      normalAtlas: ground.normalAtlas,
      groundDetail: ground.groundDetail,
      normalTex: ground.defaultNormal,
      detailNoise: this.detailNoise,
      foliageField: this.foliageField,
      segments: this.terrainSegments,
      edgePadding: this.terrainEdgePadding,
    });
    this.scene.add(this.terrain.mesh);

    const farPatchSize = 900, farPatchResolution = 384;
    this.terrain.uniforms.uPatchHalfSize.value = farPatchSize * 0.5;
    const farPatch = createDetailPatch({
      terrain: this.terrain,
      size: farPatchSize,
      resolution: farPatchResolution,
      renderOrder: 1,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
    });
    this.scene.add(farPatch.mesh);

    const patchSize = 300, patchResolution = 512;
    this.detailPatch = createDetailPatch({
      terrain: this.terrain,
      size: patchSize,
      resolution: patchResolution,
      renderOrder: 2,
      polygonOffsetFactor: -12,
      polygonOffsetUnits: -12,
    });
    this.scene.add(this.detailPatch.mesh);
    this.detailPatches = [farPatch, this.detailPatch];
    this.farDetailPatch = farPatch;
    this.terrainQuery.patchSpacing = patchSize / patchResolution;

    // (Step 7) Water — pools list is pre-computed so we just build the mesh.
    this.water = createWaterPools({
      terrainQuery: this.terrainQuery,
      scene: this.scene,
      pools,
    });

    // (Step 8) Vegetation.
    this._onProgress(0.65, 'Loading flora…');
    const atlas = await buildSpriteAtlas(SPECIES, 512);

    this._onProgress(0.75, 'Preparing flora…');
    this.shadows = createGroundShadows({
      scene: this.scene,
      groundY: (x, z) => this.terrainQuery.sampleGroundY(x, z)
    });
    this.plants = createInstancedPlants({
      atlas,
      dem: this.dem,
      groundY: (x, z) => this.terrainQuery.sampleGroundY(x, z),
      shadows: this.shadows,
      foliageField: this.foliageField
    });
    for (const tier of this.plants.tiers) this.scene.add(tier.mesh);
    this.foliageMass = createFoliageMassField({
      scene: this.scene,
      atlas,
      field: this.foliageField,
      dem: this.dem,
      groundY: (x, z) => this.terrainQuery.sampleGroundY(x, z)
    });
    console.log('vegetation streaming enabled');
  }

  /** World-coordinate ground sampler — what character physics should grab. */
  groundY(x, z) {
    return this.terrainQuery.sampleGroundY(x, z);
  }

  /** Move the high-res detail patch to centre on (x, z) — call each frame. */
  updateDetailPatch(x, z) {
    for (const patch of this.detailPatches) patch.update(x, z);
  }

  /**
   * Per-frame tick. ctx carries cross-cutting per-frame inputs:
   *   ctx.cameraPosition — Three.Vector3 of the camera (for plant LOD).
   *   ctx.camera         — Three.Camera (for plant chunk frustum culling).
   *   ctx.sunDir         — Three.Vector3 (normalized) of sun direction.
   *   ctx.sunColor       — Three.Color of current sunlight.
   *   ctx.skyTop         — Three.Color of zenith (water reflection).
   *   ctx.haze           — Three.Color of horizon haze (water reflection).
   */
  update(dt, t, ctx) {
    this.plants.update(t, ctx.cameraPosition, ctx.camera);
    if (this.foliageMass) this.foliageMass.update(t, ctx.cameraPosition, ctx.camera);
    if (this.shadows) this.shadows.updatePlants(ctx.cameraPosition, ctx.camera, ctx.environment);
    this.water.update(dt, t, ctx);
  }
}
