import * as THREE from 'three';

import { World } from './world/World.js';
import { createSky } from './world/Sky.js';
import { createAudio } from './world/Audio.js';
import { createNightVision } from './world/NightVision.js';
import { createDust } from './world/Dust.js';
import { createMobs, createVultureType } from './world/Mobs.js';
import { loadBobcat } from './player/Bobcat.js';
import { chooseSpawnPoint } from './player/Spawn.js';
import { createThirdPersonCamera } from './player/Camera.js';
import { createInput } from './player/Input.js';
import { createHUD, setLoadingProgress, hideLoading } from './ui/HUD.js';
import { createDebugMenu, panelRow, panelButton } from './ui/DebugMenu.js';

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

  let nightVision = null;
  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    if (nightVision) nightVision.resize(renderer.domElement.width, renderer.domElement.height);
  });

  // ---------- sky ----------
  const sky = createSky(scene);

  // ---------- world (terrain, water, vegetation) ----------
  const world = new World({ scene, renderer, onProgress: setLoadingProgress });
  await world.init();

  // Debug toggles for headless probing.
  const sp = new URLSearchParams(window.location.search);
  if (sp.has('noplants')) for (const t of world.plants.tiers) t.mesh.visible = false;
  if (sp.has('noterrain')) world.terrain.mesh.visible = false;

  // ---------- player ----------
  setLoadingProgress(0.88, 'Waking bobcat…');
  const bobcat = await loadBobcat({
    onProgress: t => setLoadingProgress(0.88 + t * 0.10, 'Waking bobcat…')
  });
  const spawn = chooseSpawnPoint(world.terrainQuery);
  bobcat.position.set(spawn.x, spawn.y, spawn.z);
  bobcat.yaw = spawn.yaw;
  bobcat.pivot.rotation.y = spawn.yaw;
  scene.add(bobcat.object);

  bobcat.setGroundFn((x, z) => world.groundY(x, z));
  const cam = createThirdPersonCamera({
    camera, target: bobcat,
    groundY: (x, z) => world.groundY(x, z),
    domElement: renderer.domElement
  });
  cam.state.yaw = bobcat.yaw + Math.PI;
  const input = createInput();

  if (sp.has('nocat')) setTimeout(() => bobcat.object.visible = false, 100);

  // Dust puffs at the cat's feet — on jump start, jump landing, and on every
  // running footfall (gated by speed so we don't puff during a quiet stalk).
  const dust = createDust(scene);
  bobcat.onJumpStart = pos => {
    dust.spawn(pos.x, pos.y, pos.z, {
      count: 5, size: 9, life: 0.6, speedT: 0.5,
      dir: bobcat.forward
    });
  };
  bobcat.onJumpLand = pos => {
    dust.spawn(pos.x, pos.y, pos.z, {
      count: 9, size: 11, life: 0.85, speedT: 0.9
    });
  };

  // ---------- mobs ----------
  // The mob registry is the entry point for every NPC in the world (vultures
  // now, javelina/roadkill/coyotes later). Each type registers a spawn
  // factory; main.js only knows about the registry, not individual mobs.
  const mobs = createMobs(scene);
  const texLoader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy?.() || 8;
  const vultureTex = await new Promise((res, rej) =>
    texLoader.load('/assets/mobs/turkeyvulture.png', t => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = maxAniso;
      res(t);
    }, undefined, rej)
  );
  mobs.registerType('vulture', createVultureType(vultureTex, {
    radius: 70,
    altitude: 38,
    angularSpeed: 0.16,
    // Real wingspan is ~1.8m, but at 60-70m distance that's ~20px on screen —
    // too easy to miss. ~5m reads clearly as a soaring bird without breaking
    // the silhouette.
    wingSpan: 5
  }));
  // The "personal" kettle of 3 above the bobcat, following the player as
  // they wander. Camera pitch clamps at +0.4 rad (~23° looking up), so the
  // altitude/radius are tuned to fit in frame from the default 3rd-person
  // view — sky-high vultures sit above the upper FOV cap.
  for (let i = 0; i < 3; i++) {
    mobs.spawnAt('vulture', spawn.x, spawn.y, spawn.z, {
      phase: (i * 2 * Math.PI) / 3,
      radius: 60 + i * 5,
      altitude: 36 + i * 2,
      followTarget: bobcat,
      followLerp: 0.25
    });
  }
  // Distant background kettles. Each anchored at a fixed spot in the desert,
  // 2-3 birds per kettle. The player sees them as far-off circling shapes
  // that grow if they wander toward them.
  const distantKettles = 4;
  for (let k = 0; k < distantKettles; k++) {
    let kx, kz;
    do {
      kx = (Math.random() - 0.5) * world.dem.worldWidth * 0.85;
      kz = (Math.random() - 0.5) * world.dem.worldHeight * 0.85;
    } while (Math.hypot(kx - spawn.x, kz - spawn.z) < 600);
    const ky = world.groundY(kx, kz);
    const birdCount = 2 + Math.floor(Math.random() * 2); // 2 or 3
    const kRadius = 60 + Math.random() * 40;
    const kAltitude = 60 + Math.random() * 30;
    for (let i = 0; i < birdCount; i++) {
      mobs.spawnAt('vulture', kx, ky, kz, {
        phase: (i / birdCount) * Math.PI * 2 + Math.random() * 0.5,
        radius: kRadius + i * 6,
        altitude: kAltitude + i * 3,
        angularSpeed: 0.10 + Math.random() * 0.06,
      });
    }
  }
  if (typeof window !== 'undefined') {
    window.__mobs = mobs;
    window.__cam = cam;
    window.__water = world.water;
    window.__bobcat = bobcat;
    window.__world = world;
  }

  const hud = createHUD({ dem: world.dem, water: world.water });

  // Night vision composite — initialised here so resolution matches the
  // current renderer size.
  nightVision = createNightVision(renderer);
  nightVision.resize(renderer.domElement.width, renderer.domElement.height);

  // ---------- debug menu ----------
  // Toggle with ` (backtick) or F1. First panel is "Filters" — saturation,
  // brightness and contrast applied in the night-vision composite.
  createDebugMenu({
    panels: [
      {
        id: 'filters', label: 'Filters',
        render(el) {
          panelRow(el, {
            label: 'Saturation', min: 0, max: 2, step: 0.01,
            value: nightVision.uniforms.uSaturation.value,
            onInput: v => nightVision.uniforms.uSaturation.value = v
          });
          panelRow(el, {
            label: 'Brightness', min: 0.4, max: 1.8, step: 0.01,
            value: nightVision.uniforms.uBrightness.value,
            onInput: v => nightVision.uniforms.uBrightness.value = v
          });
          panelRow(el, {
            label: 'Contrast', min: 0.6, max: 1.6, step: 0.01,
            value: nightVision.uniforms.uContrast.value,
            onInput: v => nightVision.uniforms.uContrast.value = v
          });
          panelButton(el, 'Reset', () => {
            nightVision.uniforms.uSaturation.value = 0.9;
            nightVision.uniforms.uBrightness.value = 1.1;
            nightVision.uniforms.uContrast.value = 0.9;
            el.parentElement.querySelector('.dbg-tab.active').click();
          });
        }
      },
      {
        id: 'world', label: 'World',
        render(el) {
          const intro = document.createElement('div');
          intro.style.cssText = 'font-size:11px; letter-spacing:0.18em; color:#b9aa8a; text-transform:uppercase; text-shadow:1px 1px 0 #000;';
          intro.textContent = '(reserved for time-of-day, fog, etc.)';
          el.appendChild(intro);
        }
      }
    ]
  });

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
  // day; fades on at dusk. Cool moonlight tone reads as wisp/spirit-light.
  const lantern = new THREE.PointLight(0xb8d2ff, 0, 22, 1.3);
  lantern.castShadow = false;
  scene.add(lantern);

  const environment = createDayNightEnvironment({
    renderer, sky, terrain: world.terrain, plants: world.plants,
    sun, hemi, ambient, lantern
  });
  environment.update(0);

  const audio = createAudio();
  // Browsers gate AudioContext until a user gesture; start the soundscape on
  // first interaction.
  const startAudioOnce = () => {
    audio.start();
    window.removeEventListener('pointerdown', startAudioOnce);
    window.removeEventListener('keydown', startAudioOnce);
  };
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
    if (inputs.toggleNightVision) nightVision.toggle();
    bobcat.update(dt, inputs, world.dem);
    cam.update(dt);
    dust.update(dt);
    mobs.update(dt, t);

    // Keep the sky sphere centred on the camera so its direction-based shading
    // doesn't drift when the player walks far from origin.
    sky.mesh.position.copy(camera.position);

    environment.update(t);
    world.update(dt, t, {
      cameraPosition: camera.position,
      sunDir: environment.state.sunDir,
      sunColor: environment.state.sunColor
    });

    // Park the lantern just above the bobcat with a slight bob.
    lantern.position.set(
      bobcat.position.x,
      bobcat.position.y + 1.6 + Math.sin(t * 1.4) * 0.05,
      bobcat.position.z
    );
    // Terrain and plant shaders are custom (not Three.js standard materials),
    // so PointLight doesn't reach them automatically — push the lantern as
    // plain uniforms so the ground catches the glow.
    world.terrain.uniforms.uLanternPos.value.copy(lantern.position);
    world.terrain.uniforms.uLanternIntensity.value = lantern.intensity * 0.42;
    for (const tier of world.plants.tiers) {
      tier.uniforms.uLanternPos.value.copy(lantern.position);
      tier.uniforms.uLanternIntensity.value = lantern.intensity * 0.45;
    }

    // Audio: keep the day/night cross-fade in sync with the *real* sun
    // direction (sun.position is moon-flipped at night, see environment.update).
    const dayT = THREE.MathUtils.smoothstep(environment.state.sunDir.y, -0.10, 0.10);
    audio.setDayMix(dayT);
    audio.tick(t);
    if (bobcat.speed > 1.2 && !bobcat.airborne) {
      // Map speed to a cadence — shorter at higher speeds. Walk (~3 m/s) ≈
      // 0.50 s between paws; full sprint (~15 m/s) ≈ 0.13 s.
      const speedT = THREE.MathUtils.clamp(bobcat.speed / bobcat.runSpeed, 0, 1);
      const cadence = 0.50 - 0.37 * speedT;
      if (t - lastFootAt > cadence) {
        audio.footstep(speedT);
        if (bobcat.speed > 4.0) {
          dust.spawn(bobcat.position.x, bobcat.position.y, bobcat.position.z, {
            count: 1 + Math.round(speedT * 2),
            size: 6 + speedT * 4,
            life: 0.45 + speedT * 0.3,
            speedT,
            dir: bobcat.forward
          });
        }
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

    // Render the world through the night-vision composite. At day the lens is
    // off (nightAmount = 0) and the composite is a near-passthrough; only the
    // central circle gets the green-tinted high-gain look at night.
    const trueSunY = environment.state.sunDir.y;
    const nightAmount = 1.0 - THREE.MathUtils.smoothstep(trueSunY, -0.18, 0.06);
    nightVision.render(scene, camera, t, nightAmount);

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

function createDayNightEnvironment({ renderer, sky, terrain, plants, sun, hemi, ambient, lantern }) {
  const cycleSeconds = 240;
  const phaseOffset = 0.18;
  const palette = {
    skyTopDay:    new THREE.Color('#74c2ff'),
    skyTopNight:  new THREE.Color('#1c2a44'),
    skyTopDusk:   new THREE.Color('#36547f'),
    horizonDay:   new THREE.Color('#94dcff'),
    horizonNight: new THREE.Color('#2a3b54'),
    hazeDay:      new THREE.Color('#94dcff'),
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
    sunNight:     new THREE.Color('#a3b6d8'),
    terrainAmbientDay:   new THREE.Color('#6b7486'),
    terrainAmbientNight: new THREE.Color('#3b4760'),
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
    const moonStrength = Math.max(0, -state.sunDir.y);
    sun.intensity = Math.pow(direct, 0.42) * 4.4 + twilightBand * 0.22 + moonStrength * 0.65;
    hemi.color.copy(state.hemiSky);
    hemi.groundColor.copy(state.hemiGround);
    hemi.intensity = THREE.MathUtils.lerp(0.32, 0.42, daylight) + twilightBand * 0.06;
    ambient.color.copy(state.ambient);
    ambient.intensity = THREE.MathUtils.lerp(0.14, 0.16, daylight) + night * 0.04;
    renderer.toneMappingExposure = THREE.MathUtils.lerp(0.82, 1.0, daylight) + twilightBand * 0.04;

    if (lantern) {
      lantern.intensity = night * 6.5 + twilightBand * 1.2;
    }
  }

  return { update, state };
}
