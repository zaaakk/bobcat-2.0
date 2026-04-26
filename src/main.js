import * as THREE from 'three';

import { loadDEM, heightmapTexture, sampleRenderedHeight, sampleSlope } from './terrain/DEMLoader.js';
import { generateSplatMap } from './terrain/SplatMapGenerator.js';
import { createTerrainMesh } from './terrain/TerrainMesh.js';

import { buildSpriteAtlas } from './vegetation/SpriteAtlas.js';
import { placeVegetation } from './vegetation/PlacementEngine.js';
import { createInstancedPlants } from './vegetation/InstancedPlants.js';
import { SPECIES } from './vegetation/species.js';

import { createSky } from './world/Sky.js';
import { createAudio } from './world/Audio.js';
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
  const sky = createSky(scene);

  // ---------- DEM ----------
  setLoadingProgress(0.05, 'Loading terrain…');
  const dem = await loadDEM('/assets/dem/terrarium.png', '/assets/dem/terrarium.json',
    t => setLoadingProgress(0.05 + t * 0.30, 'Loading terrain…'));
  console.log(`DEM ${dem.width}x${dem.height}, ${dem.worldWidth.toFixed(0)}x${dem.worldHeight.toFixed(0)}m, elev ${dem.minZ.toFixed(0)}–${dem.maxZ.toFixed(0)}m`);

  setLoadingProgress(0.40, 'Painting ground…');
  const heightTex = heightmapTexture(THREE, dem);
  const splatTex = generateSplatMap(dem, 1280);

  // ---------- ground textures ----------
  const texLoader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy?.() || 8;
  function loadTex(url) {
    return new Promise((res, rej) => texLoader.load(url, t => {
      // Mirrored-repeat: each tile is flipped at the seam, so the texture's
      // own edges meet themselves and there are no bright wrap lines even
      // when the source PNGs aren't authored to be tileable.
      t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = maxAniso;
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
  const terrainSegments = 1280;
  const terrainEdgePadding = 6000;
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
    cellSize: 4.0,
    globalDensity: 1.0,
    playRadius: 3500,
    maxInstances: 1_000_000
  });
  console.log(`placed ${instances.count} plant instances`);

  const plants = createInstancedPlants({ atlas, instances, dem });
  for (const tier of plants.tiers) scene.add(tier.mesh);

  // Debug toggles for headless probing.
  const sp = new URLSearchParams(window.location.search);
  if (sp.has('noplants')) for (const t of plants.tiers) t.mesh.visible = false;
  if (sp.has('noterrain')) terrain.mesh.visible = false;
  if (sp.has('nocat')) setTimeout(() => bobcat.object.visible = false, 100);

  // ---------- player ----------
  setLoadingProgress(0.88, 'Waking bobcat…');
  const bobcat = await loadBobcat({
    onProgress: t => setLoadingProgress(0.88 + t * 0.10, 'Waking bobcat…')
  });
  const spawn = chooseSpawnPoint(dem, groundY);
  bobcat.position.set(spawn.x, spawn.y, spawn.z);
  bobcat.yaw = spawn.yaw;
  bobcat.pivot.rotation.y = spawn.yaw;
  scene.add(bobcat.object);

  bobcat.setGroundFn(groundY);
  const cam = createThirdPersonCamera({ camera, target: bobcat, groundY, domElement: renderer.domElement });
  cam.state.yaw = bobcat.yaw + Math.PI;
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

  // A small "lantern" point light that hovers above the bobcat. Off during the
  // day; fades on at dusk and stays on through the night so the player has a
  // local pool of warm light tracking with them.
  const lantern = new THREE.PointLight(0xffd9a8, 0, 18, 1.4);
  lantern.castShadow = false;
  scene.add(lantern);

  const environment = createDayNightEnvironment({ renderer, sky, terrain, plants, sun, hemi, ambient, lantern });
  environment.update(0);

  const audio = createAudio();
  // Browsers gate AudioContext until a user gesture; start the soundscape on
  // first interaction.
  const startAudioOnce = () => { audio.start(); window.removeEventListener('pointerdown', startAudioOnce); window.removeEventListener('keydown', startAudioOnce); };
  window.addEventListener('pointerdown', startAudioOnce);
  window.addEventListener('keydown', startAudioOnce);

  // ---------- render loop ----------
  const clock = new THREE.Clock();
  let last = performance.now();
  let fpsAccum = 0, fpsFrames = 0;
  let qualityLevel = 1; // 1 = full, can drop to 0.85
  let displayFps = 60;
  let lastFootAt = 0;

  function frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = clock.getElapsedTime();
    const instantFps = 1 / Math.max(dt, 1e-3);
    displayFps = THREE.MathUtils.lerp(displayFps, instantFps, 0.12);

    const inputs = input.sample(cam.yaw);
    bobcat.update(dt, inputs, dem);
    cam.update(dt);

    // Keep the sky sphere centred on the camera so its direction-based shading
    // doesn't drift when the player walks far from origin (otherwise the sun
    // disk and horizon haze peel away from the camera's actual view).
    sky.mesh.position.copy(camera.position);

    environment.update(t);
    plants.update(t, camera.position);
    // Park the lantern just above the bobcat with a slight bob so it reads as
    // a hovering will-o'-wisp rather than a baked-in glow.
    lantern.position.set(
      bobcat.position.x,
      bobcat.position.y + 1.6 + Math.sin(t * 1.4) * 0.05,
      bobcat.position.z
    );

    // Audio: keep the day/night cross-fade in sync with the sun, fire footsteps
    // when the bobcat is moving fast enough to plant a paw, and tick distant
    // animal calls.
    const sunY = sun.position.y; // mirrors state.sunDir.y * 1800
    const dayT = THREE.MathUtils.smoothstep(sunY, -300, 200);
    audio.setDayMix(dayT);
    audio.tick(t);
    if (bobcat.speed > 1.2) {
      // Map speed to a cadence — shorter (= more frequent) at higher speeds.
      // Walk (~3 m/s) ≈ 0.50 s between paws; full sprint (~15 m/s) ≈ 0.13 s.
      // Roughly 4× difference so walk and sprint sound clearly distinct.
      const speedT = THREE.MathUtils.clamp(bobcat.speed / bobcat.runSpeed, 0, 1);
      const cadence = 0.50 - 0.37 * speedT;
      if (t - lastFootAt > cadence) {
        audio.footstep(speedT);
        lastFootAt = t;
      }
    }

    hud.update({ playerYaw: bobcat.yaw, playerPos: bobcat.position, fps: displayFps });
    if (typeof window !== 'undefined') {
      window.__bobcatPos = {
        bobcat: { x: bobcat.position.x, y: bobcat.position.y, z: bobcat.position.z, yaw: bobcat.yaw },
        camera: { x: camera.position.x, y: camera.position.y, z: camera.position.z }
      };
    }

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

function chooseSpawnPoint(dem, groundY, maxRadius = 2800) {
  // Constrain to a circle so the bobcat always spawns inside the vegetation
  // zone. (The plant placer uses a finite playRadius around origin — spawning
  // far outside leaves the bobcat in a bare wasteland with no plants anywhere.)
  let fallback = { x: 0, y: groundY(0, 0), z: 0, yaw: Math.random() * Math.PI * 2 };
  let bestScore = -Infinity;

  for (let i = 0; i < 28; i++) {
    const r = Math.sqrt(Math.random()) * maxRadius;
    const a = Math.random() * Math.PI * 2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = groundY(x, z);
    const slope = sampleSlope(dem, x, z, 4);
    const edge = maxRadius - r;
    const score = edge - slope * 1400;
    if (score > bestScore) {
      bestScore = score;
      fallback = { x, y, z, yaw: Math.random() * Math.PI * 2 };
    }
    if (slope < 0.32 && r < maxRadius - 80) {
      return { x, y, z, yaw: Math.random() * Math.PI * 2 };
    }
  }
  return fallback;
}

function createDayNightEnvironment({ renderer, sky, terrain, plants, sun, hemi, ambient, lantern }) {
  const cycleSeconds = 240;
  const phaseOffset = 0.18;
  const palette = {
    skyTopDay:    new THREE.Color('#74c2ff'),  // zenith
    skyTopNight:  new THREE.Color('#1c2a44'),
    skyTopDusk:   new THREE.Color('#36547f'),
    horizonDay:   new THREE.Color('#94dcff'),  // bottom of azimuth
    horizonNight: new THREE.Color('#2a3b54'),
    hazeDay:      new THREE.Color('#94dcff'),  // matches the horizon so haze doesn't smear in a separate colour
    hazeNight:    new THREE.Color('#384c69'),
    hazeDusk:     new THREE.Color('#ef9c67'),
    fogLowDay:    new THREE.Color('#c9d1d8'),
    fogLowNight:  new THREE.Color('#3a4a64'),
    fogMidDay:    new THREE.Color('#96abc1'),
    fogMidNight:  new THREE.Color('#3f546f'),
    fogFarDay:    new THREE.Color('#668db8'),
    fogFarNight:  new THREE.Color('#28395a'),
    sunDay:       new THREE.Color('#fff0d1'),
    sunDusk:      new THREE.Color('#ff9a63'),
    sunNight:     new THREE.Color('#a3b6d8'),  // cool moonlight (used as the moon's glow)
    terrainAmbientDay:   new THREE.Color('#6b7486'),
    terrainAmbientNight: new THREE.Color('#3b4760'),  // moonlit ambient
    plantAmbientDay:     new THREE.Color('#68758a'),
    plantAmbientNight:   new THREE.Color('#3a4660'),
    hemiSkyDay:   new THREE.Color('#a8c4df'),
    hemiSkyNight: new THREE.Color('#4a5c80'),
    hemiGroundDay:new THREE.Color('#756042'),
    hemiGroundNight:new THREE.Color('#262a36'),
    ambientDay:   new THREE.Color('#ffffff'),
    ambientNight: new THREE.Color('#a8b8d6')
  };

  const state = {
    sunDir: new THREE.Vector3(),
    skyTop: new THREE.Color(),
    horizon: new THREE.Color(),
    haze: new THREE.Color(),
    fogLow: new THREE.Color(),
    fogMid: new THREE.Color(),
    fogFar: new THREE.Color(),
    sunColor: new THREE.Color(),
    terrainAmbient: new THREE.Color(),
    plantAmbient: new THREE.Color(),
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    ambient: new THREE.Color()
  };

  function update(timeSec) {
    const cycle = (timeSec / cycleSeconds + phaseOffset) % 1;
    const theta = cycle * Math.PI * 2;
    state.sunDir.set(Math.cos(theta) * 0.28, Math.sin(theta), Math.sin(theta) * 0.96).normalize();

    const daylight = THREE.MathUtils.smoothstep(state.sunDir.y, -0.14, 0.10);
    const night = 1.0 - THREE.MathUtils.smoothstep(state.sunDir.y, -0.24, 0.02);
    const twilightBand = THREE.MathUtils.smoothstep(state.sunDir.y, -0.22, 0.16) *
      (1.0 - THREE.MathUtils.smoothstep(Math.abs(state.sunDir.y), 0.16, 0.58));

    state.skyTop.lerpColors(palette.skyTopNight, palette.skyTopDay, daylight);
    state.skyTop.lerp(palette.skyTopDusk, twilightBand * 0.55);
    state.horizon.lerpColors(palette.horizonNight, palette.horizonDay, daylight);
    state.haze.lerpColors(palette.hazeNight, palette.hazeDay, daylight);
    state.haze.lerp(palette.hazeDusk, twilightBand * 0.9);
    state.fogLow.lerpColors(palette.fogLowNight, palette.fogLowDay, daylight);
    state.fogMid.lerpColors(palette.fogMidNight, palette.fogMidDay, daylight);
    state.fogFar.lerpColors(palette.fogFarNight, palette.fogFarDay, daylight);
    state.sunColor.lerpColors(palette.sunNight, palette.sunDay, daylight);
    state.sunColor.lerp(palette.sunDusk, twilightBand * 0.85);
    state.terrainAmbient.lerpColors(palette.terrainAmbientNight, palette.terrainAmbientDay, daylight);
    state.plantAmbient.lerpColors(palette.plantAmbientNight, palette.plantAmbientDay, daylight);
    state.hemiSky.lerpColors(palette.hemiSkyNight, palette.hemiSkyDay, daylight);
    state.hemiGround.lerpColors(palette.hemiGroundNight, palette.hemiGroundDay, daylight);
    state.ambient.lerpColors(palette.ambientNight, palette.ambientDay, daylight);

    sky.material.uniforms.uTopColor.value.copy(state.skyTop);
    sky.material.uniforms.uHorizonColor.value.copy(state.horizon);
    sky.material.uniforms.uHazeColor.value.copy(state.haze);
    sky.material.uniforms.uSunDir.value.copy(state.sunDir);
    sky.material.uniforms.uSunColor.value.copy(state.sunColor);

    terrain.uniforms.uSunDir.value.copy(state.sunDir);
    terrain.uniforms.uSunColor.value.copy(state.sunColor);
    terrain.uniforms.uAmbientColor.value.copy(state.terrainAmbient);
    terrain.uniforms.uFogColorLow.value.copy(state.fogLow);
    terrain.uniforms.uFogColorMid.value.copy(state.fogMid);
    terrain.uniforms.uFogColorFar.value.copy(state.fogFar);
    terrain.uniforms.uFogDensity.value = THREE.MathUtils.lerp(0.00008, 0.00018, daylight) + twilightBand * 0.00003;

    for (const tier of plants.tiers) {
      tier.uniforms.uSunDir.value.copy(state.sunDir);
      tier.uniforms.uSunColor.value.copy(state.sunColor);
      tier.uniforms.uAmbient.value.copy(state.plantAmbient);
      tier.uniforms.uFogColorLow.value.copy(state.fogLow);
      tier.uniforms.uFogColorMid.value.copy(state.fogMid);
      tier.uniforms.uFogColorFar.value.copy(state.fogFar);
      tier.uniforms.uFogDensity.value = terrain.uniforms.uFogDensity.value;
    }

    const direct = Math.max(0, state.sunDir.y);
    if (state.sunDir.y < 0) {
      sun.position.set(-state.sunDir.x, -state.sunDir.y, -state.sunDir.z).multiplyScalar(1800);
    } else {
      sun.position.copy(state.sunDir).multiplyScalar(1800);
    }
    sun.color.copy(state.sunColor);
    // Strong direct sun, weak fill — shapes form on the bobcat's PBR materials
    // the same way the terrain shader is already shading the ground.
    const moonStrength = Math.max(0, -state.sunDir.y);
    sun.intensity = Math.pow(direct, 0.42) * 4.4 + twilightBand * 0.22 + moonStrength * 0.65;
    hemi.color.copy(state.hemiSky);
    hemi.groundColor.copy(state.hemiGround);
    hemi.intensity = THREE.MathUtils.lerp(0.32, 0.42, daylight) + twilightBand * 0.06;
    ambient.color.copy(state.ambient);
    ambient.intensity = THREE.MathUtils.lerp(0.14, 0.16, daylight) + night * 0.04;
    renderer.toneMappingExposure = THREE.MathUtils.lerp(0.82, 1.0, daylight) + twilightBand * 0.04;

    // The lantern: only really on at night. We don't move it here — main.js
    // ticks it onto the bobcat's position each frame.
    if (lantern) {
      lantern.intensity = night * 6.5 + twilightBand * 1.2;
    }
  }

  return { update };
}
