import * as THREE from 'three';

import { loadDEM, heightmapTexture, sampleHeight } from './terrain/DEMLoader.js';
import { generateSplatMap } from './terrain/SplatMapGenerator.js';
import { createTerrainMesh } from './terrain/TerrainMesh.js';
import { createSky } from './world/Sky.js';

main().catch(err => {
  console.error(err);
  const st = document.getElementById('loading-status');
  if (st) st.textContent = 'Failed: ' + err.message;
});

async function setProgress(t, status) {
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
    t => setProgress(0.05 + t * 0.30, 'Loading terrain…'));

  setProgress(0.40, 'Painting ground…');
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

  setProgress(0.85, 'Building terrain mesh…');
  const terrain = createTerrainMesh({
    dem, heightTex, splatTex,
    groundTextures: { rock: tRock, grass: tGrass, gravel: tGravel, sand: tSand },
    normalTex: tNormal,
    segments: 512,
    edgePadding: 9000
  });
  scene.add(terrain.mesh);

  setProgress(1.0, 'Ready');
  hideLoading();

  // Idle camera orbit until the player module wires in real input.
  const center = new THREE.Vector3(0, sampleHeight(dem, 0, 0) + 5, 0);
  let last = performance.now();
  function frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now * 0.0001;
    camera.position.set(Math.sin(t) * 80, center.y + 30, Math.cos(t) * 80);
    camera.lookAt(center);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
