import * as THREE from 'three';

import { loadDEM, heightmapTexture } from '../terrain/DEMLoader.js';
import { TerrainQuery } from '../terrain/TerrainQuery.js';
import { generateSplatMap } from '../terrain/SplatMapGenerator.js';
import { createTerrainMesh } from '../terrain/TerrainMesh.js';
import { loadGroundTextures } from '../terrain/GroundTextures.js';
import { generateDetailNoise } from '../terrain/DetailNoise.js';

import { buildSpriteAtlas } from '../vegetation/SpriteAtlas.js';
import { placeVegetation } from '../vegetation/PlacementEngine.js';
import { createInstancedPlants } from '../vegetation/InstancedPlants.js';
import { SPECIES } from '../vegetation/species.js';

import { createWaterPools } from './Water.js';

/**
 * The static world: terrain + landscape-derived features.
 *
 * Owns: dem, terrainQuery, terrain mesh, water, plants. Doesn't own the
 * player, mobs, environment/sky, or rendering — those compose with World
 * but live in their own modules.
 *
 * Lifecycle:
 *   const world = new World({ scene, renderer, onProgress });
 *   await world.init();          // loads DEM, builds meshes, places water + plants
 *   world.update(dt, t, ctx);    // ticks plants + water each frame
 *
 * `ctx` carries cross-cutting per-frame inputs (cameraPosition, sunDir,
 * sunColor) so World doesn't need to reach back into other systems.
 */
export class World {
  constructor({ scene, renderer, onProgress = () => {} }) {
    this.scene = scene;
    this.renderer = renderer;
    this._onProgress = onProgress;

    // Populated by init().
    this.dem = null;
    this.terrainQuery = null;
    this.terrain = null;
    this.water = null;
    this.plants = null;
    this.terrainSegments = 1280;
    this.terrainEdgePadding = 6000;
  }

  async init() {
    this._onProgress(0.05, 'Loading terrain…');
    this.dem = await loadDEM('/assets/dem/terrarium.png', '/assets/dem/terrarium.json',
      t => this._onProgress(0.05 + t * 0.30, 'Loading terrain…'));
    console.log(
      `DEM ${this.dem.width}x${this.dem.height}, ` +
      `${this.dem.worldWidth.toFixed(0)}x${this.dem.worldHeight.toFixed(0)}m, ` +
      `elev ${this.dem.minZ.toFixed(0)}–${this.dem.maxZ.toFixed(0)}m`
    );

    this._onProgress(0.40, 'Painting ground…');
    const heightTex = heightmapTexture(THREE, this.dem);
    const splatTex = generateSplatMap(this.dem, 1280);

    const ground = await loadGroundTextures(this.renderer);

    // Sub-DEM detail: ridged-multifractal caprock bumps + elevation-keyed
    // bedding-plane pulse. Reads as stratified limestone — sharp ridges,
    // horizontal benches at fixed vertical intervals — rather than the
    // smooth rolling blobs Perlin-style FBM produces. Sampled identically
    // on GPU (vertex shader) and CPU (TerrainQuery.sampleHeight) so
    // character grounding agrees with the rendered surface.
    this.detailNoise = generateDetailNoise({
      worldWidth:  this.dem.worldWidth,
      worldHeight: this.dem.worldHeight,
      resolution:  2048,
      ridgeAmp:    3.0,
      bedAmp:      2.0,
      bedPeriod:   18.0,
      bedWarpAmp:  6.0,
    });

    this._onProgress(0.55, 'Building terrain mesh…');
    const terrainPlaneSize = this.dem.worldWidth + this.terrainEdgePadding * 2;
    this.terrain = createTerrainMesh({
      dem: this.dem, heightTex, splatTex,
      groundTextures: ground.diffuse,
      groundNormals:  ground.normals,
      normalTex: ground.defaultNormal,
      detailNoise: this.detailNoise,
      segments: this.terrainSegments,
      edgePadding: this.terrainEdgePadding
    });
    this.scene.add(this.terrain.mesh);

    // Single shared landscape-query layer. Every feature that needs to ask
    // questions about the terrain (water, mobs, vegetation, spawn selection)
    // goes through this — no direct dem.data[] reads outside DEMLoader.
    this.terrainQuery = new TerrainQuery({
      dem: this.dem,
      terrainPlaneSize,
      terrainSegments: this.terrainSegments,
      detailNoise: this.detailNoise,
    });

    // Seasonal pools at low spots in the DEM. The bobcat can later drink
    // from nearby pools; positions are exposed via water.pools for proximity
    // checks and HUD dots.
    this.water = createWaterPools({
      terrainQuery: this.terrainQuery,
      scene: this.scene,
      maxPools: 80
    });

    this._onProgress(0.65, 'Loading flora…');
    const atlas = await buildSpriteAtlas(SPECIES, 512);

    this._onProgress(0.75, 'Placing vegetation…');
    const instances = placeVegetation({
      dem: this.dem,
      groundY: (x, z) => this.terrainQuery.sampleGroundY(x, z),
      cellSize: 4.0,
      globalDensity: 1.0,
      playRadius: 3500,
      maxInstances: 1_000_000
    });
    console.log(`placed ${instances.count} plant instances`);

    this.plants = createInstancedPlants({ atlas, instances, dem: this.dem });
    for (const tier of this.plants.tiers) this.scene.add(tier.mesh);
  }

  /** World-coordinate ground sampler — what character physics should grab. */
  groundY(x, z) {
    return this.terrainQuery.sampleGroundY(x, z);
  }

  /**
   * Per-frame tick. ctx carries cross-cutting per-frame inputs so World
   * doesn't have to reach back into the environment/lighting subsystem.
   *   ctx.cameraPosition — Three.Vector3 of the camera (for plant LOD).
   *   ctx.sunDir         — Three.Vector3 (normalized) of sun direction.
   *   ctx.sunColor       — Three.Color of current sunlight.
   */
  update(dt, t, ctx) {
    this.plants.update(t, ctx.cameraPosition);
    this.water.update(dt, t, ctx.sunDir, ctx.sunColor);
  }
}
