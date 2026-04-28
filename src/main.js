import * as THREE from 'three';

import { World } from './world/World.js';
import { createSky } from './world/Sky.js';
import { createEnvironment } from './world/Environment.js';
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
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1.0;

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
  if (sp.has('noplants')) {
    for (const t of world.plants.tiers) t.mesh.visible = false;
    if (world.shadows) world.shadows.setPlantEnabled(false);
  }
  if (sp.has('noterrain')) world.terrain.mesh.visible = false;
  if (sp.has('noshadows') && world.shadows) world.shadows.setEnabled(false);

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
  // Distant background kettles. 4 anchors at random bearings 700–2200m from
  // spawn — close enough that the wing-span sprite still subtends a few
  // pixels (5m sprite at 9km = sub-pixel, basically invisible), but far
  // enough to read as "off in the distance" rather than another personal
  // kettle. wingSpan is bumped to ~12m here for the same readability reason.
  const kettleAnchors = [];
  for (let k = 0; k < 4; k++) {
    const bearing = (k / 4) * Math.PI * 2 + Math.random() * 0.6;
    const dist = 700 + Math.random() * 1500;
    const ax = spawn.x + Math.cos(bearing) * dist;
    const az = spawn.z + Math.sin(bearing) * dist;
    const ay = world.terrainQuery.sampleGroundY(ax, az);
    kettleAnchors.push({ x: ax, y: ay, z: az });
  }
  for (const anchor of kettleAnchors) {
    const birdCount = 2 + Math.floor(Math.random() * 2); // 2 or 3
    const kRadius = 60 + Math.random() * 40;
    const kAltitude = 60 + Math.random() * 30;
    for (let i = 0; i < birdCount; i++) {
      mobs.spawnAt('vulture', anchor.x, anchor.y, anchor.z, {
        phase: (i / birdCount) * Math.PI * 2 + Math.random() * 0.5,
        radius: kRadius + i * 6,
        altitude: kAltitude + i * 3,
        angularSpeed: 0.10 + Math.random() * 0.06,
        wingSpan: 12,
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
          const postGradeMode = () => nightVision.uniforms.uPostGrade.value > 0.5 ? 'ON' : 'OFF';
          const postGradeBtn = panelButton(el, `Post grade: ${postGradeMode()}`, () => {
            nightVision.uniforms.uPostGrade.value = nightVision.uniforms.uPostGrade.value > 0.5 ? 0.0 : 1.0;
            postGradeBtn.textContent = `Post grade: ${postGradeMode()}`;
          });
          const toneMode = () => renderer.toneMapping === THREE.NoToneMapping ? 'OFF' : 'ACES';
          const toneBtn = panelButton(el, `Tone map: ${toneMode()}`, () => {
            renderer.toneMapping = renderer.toneMapping === THREE.NoToneMapping
              ? THREE.ACESFilmicToneMapping
              : THREE.NoToneMapping;
            toneBtn.textContent = `Tone map: ${toneMode()}`;
          });
          const u = world.terrain.uniforms;
          const gradeMode = () => u.uDebugTerrainGrade.value > 0.5 ? 'ON' : 'OFF';
          const gradeBtn = panelButton(el, `Terrain grade: ${gradeMode()}`, () => {
            u.uDebugTerrainGrade.value = u.uDebugTerrainGrade.value > 0.5 ? 0.0 : 1.0;
            gradeBtn.textContent = `Terrain grade: ${gradeMode()}`;
          });
          const rawFogMode = () => u.uDebugRawFarFog.value > 0.5 ? 'ON' : 'OFF';
          const rawFogBtn = panelButton(el, `Raw far fog: ${rawFogMode()}`, () => {
            u.uDebugRawFarFog.value = u.uDebugRawFarFog.value > 0.5 ? 0.0 : 1.0;
            rawFogBtn.textContent = `Raw far fog: ${rawFogMode()}`;
          });
          if (world.shadows) {
            const shadowsMode = () => world.shadows.enabled ? 'ON' : 'OFF';
            const shadowsBtn = panelButton(el, `Shadows: ${shadowsMode()}`, () => {
              world.shadows.setEnabled(!world.shadows.enabled);
              shadowsBtn.textContent = `Shadows: ${shadowsMode()}`;
            });
            const catShadowMode = () => world.shadows.catEnabled ? 'ON' : 'OFF';
            const catShadowBtn = panelButton(el, `Cat shadow: ${catShadowMode()}`, () => {
              world.shadows.setCatEnabled(!world.shadows.catEnabled);
              catShadowBtn.textContent = `Cat shadow: ${catShadowMode()}`;
            });
            const plantShadowMode = () => world.shadows.plantEnabled ? 'ON' : 'OFF';
            const plantShadowBtn = panelButton(el, `Plant shadows: ${plantShadowMode()}`, () => {
              world.shadows.setPlantEnabled(!world.shadows.plantEnabled);
              plantShadowBtn.textContent = `Plant shadows: ${plantShadowMode()}`;
            });
            const s = world.shadows.settings;
            panelRow(el, {
              label: 'Cat shadow dark', min: 0, max: 1.2, step: 0.01,
              value: s.catOpacity,
              onInput: v => s.catOpacity = v
            });
            panelRow(el, {
              label: 'Cat shadow lift', min: 0, max: 0.5, step: 0.005,
              value: s.catOffset,
              onInput: v => s.catOffset = v
            });
            panelRow(el, {
              label: 'Cat shadow width', min: 0.15, max: 1.2, step: 0.01,
              value: s.catWidth,
              onInput: v => s.catWidth = v
            });
            panelRow(el, {
              label: 'Cat shadow length', min: 0.3, max: 2.4, step: 0.01,
              value: s.catLength,
              onInput: v => s.catLength = v
            });
            panelRow(el, {
              label: 'Plant shadow dark', min: 0, max: 1.2, step: 0.01,
              value: s.plantOpacity,
              onInput: v => s.plantOpacity = v
            });
            panelRow(el, {
              label: 'Plant shadow lift', min: 0, max: 0.5, step: 0.005,
              value: s.plantOffset,
              onInput: v => s.plantOffset = v
            });
            panelRow(el, {
              label: 'Plant shadow size', min: 0.25, max: 2.5, step: 0.01,
              value: s.plantScale,
              onInput: v => s.plantScale = v
            });
            panelRow(el, {
              label: 'Plant shadow dist', min: 100, max: 1800, step: 10,
              value: s.plantMaxDistance,
              onInput: v => s.plantMaxDistance = v
            });
          }
        }
      },
      {
        // Live tuning for the sub-DEM detail layer. Both the base terrain
        // mesh and the high-res detail patch read these uniforms (they
        // share one uniform object), so changes apply everywhere instantly.
        id: 'detail', label: 'Detail',
        render(el) {
          const u = world.terrain.uniforms;
          panelRow(el, {
            label: 'Ridge amp (m)', min: 0, max: 12, step: 0.1,
            value: u.uRidgeAmp.value,
            onInput: v => u.uRidgeAmp.value = v,
          });
          panelRow(el, {
            // Mix factor on the cliff/bench transfer — 0 disables, 1 = full
            // staircase, >1 overshoots into super-vertical risers.
            label: 'Bench mix', min: 0, max: 1.5, step: 0.05,
            value: u.uBedAmp.value,
            onInput: v => u.uBedAmp.value = v,
          });
          panelRow(el, {
            label: 'Bench period (m)', min: 4, max: 40, step: 0.5,
            value: u.uBedPeriod.value,
            onInput: v => u.uBedPeriod.value = v,
          });
          panelRow(el, {
            label: 'Riser width', min: 0.05, max: 0.9, step: 0.01,
            value: u.uBedRiserWidth.value,
            onInput: v => u.uBedRiserWidth.value = v,
          });
          panelRow(el, {
            label: 'Bench warp (m)', min: 0, max: 30, step: 0.1,
            value: u.uBedWarpAmp.value,
            onInput: v => u.uBedWarpAmp.value = v,
          });
          panelRow(el, {
            label: 'Bench slope lo', min: 0, max: 0.3, step: 0.005,
            value: u.uBedSlopeLo.value,
            onInput: v => u.uBedSlopeLo.value = v,
          });
          panelRow(el, {
            label: 'Bench slope hi', min: 0, max: 0.4, step: 0.005,
            value: u.uBedSlopeHi.value,
            onInput: v => u.uBedSlopeHi.value = v,
          });
          panelRow(el, {
            label: 'Fine amp (m)', min: 0, max: 2.5, step: 0.01,
            value: u.uFineAmp.value,
            onInput: v => u.uFineAmp.value = v,
          });
          panelRow(el, {
            label: 'Fine tile (m)', min: 1, max: 40, step: 0.5,
            value: u.uFineTileSize.value,
            onInput: v => u.uFineTileSize.value = v,
          });
          panelRow(el, {
            label: 'Mask lo', min: 0, max: 1, step: 0.01,
            value: u.uMaskLo.value,
            onInput: v => u.uMaskLo.value = v,
          });
          panelRow(el, {
            label: 'Mask hi', min: 0, max: 1, step: 0.01,
            value: u.uMaskHi.value,
            onInput: v => u.uMaskHi.value = v,
          });
          panelRow(el, {
            label: 'Bench mask lo', min: 0, max: 1, step: 0.01,
            value: u.uBenchMaskLo.value,
            onInput: v => u.uBenchMaskLo.value = v,
          });
          panelRow(el, {
            label: 'Bench mask hi', min: 0, max: 1, step: 0.01,
            value: u.uBenchMaskHi.value,
            onInput: v => u.uBenchMaskHi.value = v,
          });
          panelButton(el, 'Reset', () => {
            u.uRidgeAmp.value = 1.5;
            u.uBedAmp.value = 0.62;
            u.uBedPeriod.value = 18.0;
            u.uBedRiserWidth.value = 0.62;
            u.uBedWarpAmp.value = 14.0;
            u.uBedSlopeLo.value = 0.10;
            u.uBedSlopeHi.value = 0.24;
            u.uFineAmp.value = 0.08;
            u.uFineTileSize.value = 24.0;
            u.uMaskLo.value = 0.20;
            u.uMaskHi.value = 0.55;
            u.uBenchMaskLo.value = 0.24;
            u.uBenchMaskHi.value = 0.50;
            el.parentElement.querySelector('.dbg-tab.active').click();
          });
          // Wireframe toggle — toggles on the base terrain AND the detail
          // patch so you can see both grid resolutions at once. Shows the
          // 26m base spacing vs. the 0.29m patch spacing where they overlap.
          const baseMat = world.terrain.material;
          const patchMats = (world.detailPatches && world.detailPatches.length
            ? world.detailPatches
            : [world.detailPatch]
          ).map(p => p.material);
          const wireBtn = panelButton(el, `Wireframe: ${baseMat.wireframe ? 'ON' : 'OFF'}`, () => {
            const next = !baseMat.wireframe;
            baseMat.wireframe = next;
            for (const patchMat of patchMats) patchMat.wireframe = next;
            wireBtn.textContent = `Wireframe: ${next ? 'ON' : 'OFF'}`;
          });
          // Note: TerrainQuery still uses the bake-time defaults for CPU
          // groundY, so cranking these in the panel changes only what the
          // GPU draws — the bobcat's grounding stays at the original ~5m
          // peak. That's intentional: visual exploration without making
          // the cat float/sink.
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

  const environment = createEnvironment({
    renderer, sky, world,
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
    // Find nearest water pool and gate the drink prompt on proximity. The
    // sim itself reads `canDrink` + `nearestPool` to decide whether E
    // triggers a drink and which pool to face. Distance is measured to the
    // pool's edge (not centre) so a 5m-radius pool is reachable from 1.5m
    // outside the rim, not 1.5m from the centre.
    {
      let nearestDist = Infinity;
      let nearestPool = null;
      for (const pool of world.water.pools) {
        const dx = bobcat.position.x - pool.x;
        const dz = bobcat.position.z - pool.z;
        const d = Math.hypot(dx, dz) - pool.r;
        if (d < nearestDist) { nearestDist = d; nearestPool = pool; }
      }
      bobcat.canDrink = nearestDist < 1.5;
      bobcat.nearestPool = bobcat.canDrink ? nearestPool : null;
    }
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
      camera,
      sunDir: environment.state.sunDir,
      sunColor: environment.state.sunColor,
      skyTop: environment.state.skyTop,
      haze: environment.state.haze,
      environment: environment.state,
    });
    // Slide the high-res detail patch to centre on the bobcat each frame.
    world.updateDetailPatch(bobcat.position.x, bobcat.position.z);
    if (world.shadows) world.shadows.updateCat(bobcat, environment.state);

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

    const prompt = bobcat.isDrinking ? 'DRINKING…'
                 : bobcat.canDrink   ? 'DRINK [E]'
                 : null;
    hud.update({ playerYaw: bobcat.yaw, playerPos: bobcat.position, fps: displayFps, prompt });
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
