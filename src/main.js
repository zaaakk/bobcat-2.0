import * as THREE from 'three';

import { loadDEM, heightmapTexture, sampleHeight } from './terrain/DEMLoader.js';
import { generateSplatMap } from './terrain/SplatMapGenerator.js';
import { createTerrainMesh } from './terrain/TerrainMesh.js';
import { createSky } from './world/Sky.js';
import { buildSpriteAtlas } from './vegetation/SpriteAtlas.js';
import { placeVegetation } from './vegetation/PlacementEngine.js';
import { createInstancedPlants } from './vegetation/InstancedPlants.js';
import { SPECIES } from './vegetation/species.js';

main().catch(err => {
  console.error(err);
  const st = document.getElementById('loading-status');
  if (st) st.textContent = 'Failed: ' + err.message;
});

function setProgress(t, status) {
  const bar = document.getElementById('loading-bar');
  const st = document.getElementById('loading-status');
  if (bar) bar.style.width = `${Math.round(t * 100)}%`;
  if (st && status) st.textContent = status;
}

function hideLoading() {
  const el = document.getElementById('loading');
  if (el) { el.classList.add('hidden'); setTimeout(() => el.remove(), 700); }
}

async function main() {
  const canvas = document.createElement('canvas');
  document.getElementById('app').appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
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

  createSky(scene);

  setProgress(0.05, 'Loading terrain…');
  const dem = await loadDEM('/assets/dem/terrarium.png', '/assets/dem/terrarium.json',
    t => setProgress(0.05 + t * 0.25, 'Loading terrain…'));

  setProgress(0.32, 'Painting ground…');
  const heightTex = heightmapTexture(THREE, dem);
  const splatTex = generateSplatMap(dem, 768);

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

  setProgress(0.55, 'Building terrain mesh…');
  const terrain = createTerrainMesh({
    dem, heightTex, splatTex,
    groundTextures: { rock: tRock, grass: tGrass, gravel: tGravel, sand: tSand },
    normalTex: tNormal,
    segments: 512,
    edgePadding: 9000
  });
  scene.add(terrain.mesh);

  setProgress(0.65, 'Loading flora…');
  const atlas = await buildSpriteAtlas(SPECIES, 512);

  setProgress(0.80, 'Placing vegetation…');
  const instances = placeVegetation({
    dem,
    cellSize: 7.0,
    globalDensity: 0.40,
    playRadius: 3500,
    maxInstances: 500_000
  });
  console.log(`placed ${instances.count} plant instances`);

  const plants = createInstancedPlants({ atlas, instances, dem });
  for (const tier of plants.tiers) scene.add(tier.mesh);

  setProgress(1.0, 'Ready');
  hideLoading();

  // Idle camera orbit until player input is wired in.
  const center = new THREE.Vector3(0, sampleHeight(dem, 0, 0) + 1.5, 0);
  const clock = new THREE.Clock();
  let last = performance.now();
  function frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = clock.getElapsedTime();
    camera.position.set(Math.sin(t * 0.05) * 30, center.y + 8, Math.cos(t * 0.05) * 30);
    camera.lookAt(center);
    plants.update(t, camera.position);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
