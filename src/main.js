import * as THREE from 'three';

import { loadDEM, heightmapTexture, sampleHeight, sampleRenderedHeight } from './terrain/DEMLoader.js';
import { generateSplatMap } from './terrain/SplatMapGenerator.js';
import { createTerrainMesh } from './terrain/TerrainMesh.js';

import { buildSpriteAtlas } from './vegetation/SpriteAtlas.js';
import { placeVegetation } from './vegetation/PlacementEngine.js';
import { createInstancedPlants } from './vegetation/InstancedPlants.js';
import { SPECIES } from './vegetation/species.js';

import { createSky } from './world/Sky.js';
import { loadBobcat } from './player/Bobcat.js';
import { createThirdPersonCamera } from './player/Camera.js';
import { createInput } from './player/Input.js';
import { createHUD, setLoadingProgress, hideLoading } from './ui/HUD.js';

main().catch(err => {
  console.error(err);
  setLoadingProgress(1, 'Failed: ' + err.message);
});

async function main() {
  // ---------- renderer ----------
  const canvas = document.createElement('canvas');
  document.getElementById('app').appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 25000);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  // ---------- sky ----------
  createSky(scene);

  // ---------- DEM ----------
  setLoadingProgress(0.05, 'Loading terrain…');
  const dem = await loadDEM('/assets/dem/terrarium.png', '/assets/dem/terrarium.json',
    t => setLoadingProgress(0.05 + t * 0.30, 'Loading terrain…'));
  console.log(`DEM ${dem.width}x${dem.height}, ${dem.worldWidth.toFixed(0)}x${dem.worldHeight.toFixed(0)}m, elev ${dem.minZ.toFixed(0)}–${dem.maxZ.toFixed(0)}m`);

  setLoadingProgress(0.40, 'Painting ground…');
  const heightTex = heightmapTexture(THREE, dem);
  const splatTex = generateSplatMap(dem, 768);

  // ---------- ground textures ----------
  const texLoader = new THREE.TextureLoader();
  function loadTex(url) {
    return new Promise((res, rej) => texLoader.load(url, t => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      res(t);
    }, undefined, rej));
  }
  const [tRock, tGrass, tGravel, tSand, tNormal] = await Promise.all([
    loadTex('/assets/ground/rock.png'),
    loadTex('/assets/ground/grassdry.png'),
    loadTex('/assets/ground/gravel.png'),
    loadTex('/assets/ground/sand.png'),
    loadTex('/assets/ground/normal.png')
  ]);

  setLoadingProgress(0.55, 'Building terrain mesh…');
  // Vertex spacing should be close to the DEM pixel size (~16.5 m) so plants
  // and the bobcat sit on the same surface the rasterizer draws.
  const terrainSegments = 1024;
  const terrainEdgePadding = 7000;
  const terrainPlaneSize = dem.worldWidth + terrainEdgePadding * 2;
  const terrain = createTerrainMesh({
    dem, heightTex, splatTex,
    groundTextures: { rock: tRock, grass: tGrass, gravel: tGravel, sand: tSand },
    normalTex: tNormal,
    segments: terrainSegments,
    edgePadding: terrainEdgePadding
  });
  scene.add(terrain.mesh);

  const groundY = (x, z) => sampleRenderedHeight(dem, terrainPlaneSize, terrainSegments, x, z);

  // ---------- vegetation ----------
  setLoadingProgress(0.65, 'Loading flora…');
  const atlas = await buildSpriteAtlas(SPECIES, 512);

  setLoadingProgress(0.75, 'Placing vegetation…');
  const instances = placeVegetation({
    dem,
    groundY,
    cellSize: 5.0,
    globalDensity: 1.2,
    playRadius: 3500,
    maxInstances: 700_000
  });
  console.log(`placed ${instances.count} plant instances`);

  const plants = createInstancedPlants({ atlas, instances, dem });
  for (const tier of plants.tiers) scene.add(tier.mesh);

  // ---------- player ----------
  setLoadingProgress(0.88, 'Waking bobcat…');
  const bobcat = await loadBobcat({
    onProgress: t => setLoadingProgress(0.88 + t * 0.10, 'Waking bobcat…')
  });
  // Spawn at DEM centre, on the ground.
  bobcat.position.set(0, groundY(0, 0), 0);
  bobcat.yaw = 0;
  bobcat.pivot.rotation.y = 0;
  scene.add(bobcat.object);

  bobcat.setGroundFn(groundY);
  const cam = createThirdPersonCamera({ camera, target: bobcat, groundY, domElement: renderer.domElement });
  const input = createInput();

  const hud = createHUD({ dem });

  setLoadingProgress(1.0, 'Ready');
  hideLoading();

  // ---------- light ----------
  // Terrain and plants do their own lighting in shaders; these light the bobcat
  // (which has standard PBR materials from its GLB).
  const sun = new THREE.DirectionalLight(0xfff0d6, 2.6);
  sun.position.set(500, 850, 200);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0xb6c8e0, 0x6a5a3e, 0.7);
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(0xffffff, 0.25);
  scene.add(ambient);

  // ---------- render loop ----------
  const clock = new THREE.Clock();
  let last = performance.now();
  let fpsAccum = 0, fpsFrames = 0;
  let qualityLevel = 1; // 1 = full, can drop to 0.85

  function frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = clock.getElapsedTime();

    const inputs = input.sample(cam.yaw);
    bobcat.update(dt, inputs, dem);
    cam.update(dt);

    plants.update(t, camera.position);

    hud.update({ playerYaw: bobcat.yaw, playerPos: bobcat.position });

    renderer.render(scene, camera);

    // Adaptive resolution if frametime spikes.
    fpsAccum += dt; fpsFrames++;
    if (fpsAccum > 1.0) {
      const fps = fpsFrames / fpsAccum;
      fpsAccum = 0; fpsFrames = 0;
      if (fps < 45 && qualityLevel > 0.7) {
        qualityLevel = Math.max(0.7, qualityLevel - 0.05);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6) * qualityLevel);
      } else if (fps > 58 && qualityLevel < 1) {
        qualityLevel = Math.min(1, qualityLevel + 0.05);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6) * qualityLevel);
      }
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
