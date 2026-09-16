import { asset } from './assetPath.js';
import * as THREE from 'three';

import { World } from './world/World.js';
import { createSky } from './world/Sky.js';
import { createEnvironment } from './world/Environment.js';
import { createAudio } from './world/Audio.js';
import { createNightVision } from './world/NightVision.js';
import { createDust } from './world/Dust.js';
import { createBloodDecals } from './world/BloodDecals.js';
import { createMobs, createVultureType, createVultureKettles } from './world/Mobs.js';
import { loadPreyAsset, createPreyType, createPreyHerds } from './world/Prey.js';
import { loadBobcat } from './player/Bobcat.js';
import { chooseSpawnPoint } from './player/Spawn.js';
import { createThirdPersonCamera } from './player/Camera.js';
import { createInput } from './player/Input.js';
import { createHUD, setLoadingProgress, hideLoading, ensureSpritesLoaded, initLoadingScreen } from './ui/HUD.js';
import { createDebugMenu, panelRow, panelButton, panelColor } from './ui/DebugMenu.js';

main().catch(err => {
  console.error(err);
  setLoadingProgress(1, 'Failed: ' + err.message);
});

async function main() {
  // Sprites must load before any UI renders (loading screen uses sprite font).
  await ensureSpritesLoaded();
  initLoadingScreen();
  const BOBCAT_LIGHT_LAYER = 1;

  // ---------- renderer ----------
  const canvas = document.createElement('canvas');
  document.getElementById('app').appendChild(canvas);
  let nightVision = null;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance'
  });
  const renderSettings = {
    scale: 1.0,
    auto: true,
    minScale: 0.60,
    maxScale: 1.0,
  };
  const basePixelRatio = () => Math.min(window.devicePixelRatio || 1, 1.6);
  const applyRenderScale = scale => {
    renderSettings.scale = THREE.MathUtils.clamp(scale, renderSettings.minScale, renderSettings.maxScale);
    renderer.setPixelRatio(basePixelRatio() * renderSettings.scale);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    if (nightVision) nightVision.resize(renderer.domElement.width, renderer.domElement.height);
  };
  applyRenderScale(renderSettings.scale);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 25000);
  camera.layers.enable(BOBCAT_LIGHT_LAYER);

  window.addEventListener('resize', () => {
    applyRenderScale(renderSettings.scale);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
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
    if (world.foliageMass) world.foliageMass.setEnabled(false);
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
  bobcat.object.traverse(o => o.layers.enable(BOBCAT_LIGHT_LAYER));
  scene.add(bobcat.object);

  if (!sp.has('noplants') && world.plants.prewarm) {
    setLoadingProgress(0.985, 'Growing brush…');
    await world.plants.prewarm(bobcat.position, t => {
      setLoadingProgress(0.985 + t * 0.012, 'Growing brush…');
    });
    if (world.foliageMass?.prewarm) await world.foliageMass.prewarm(bobcat.position);
  }

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
    texLoader.load(asset('mobs/turkeyvulture.png'), t => {
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
  // Streaming kettles: 4 columns of 5-9 circling vultures held in a
  // 450-1300m ring around the player and recycled as the player travels —
  // always something turning on the horizon, never parked over your head.
  // (Replaced the old fixed-anchor kettles, which got left behind within a
  // minute of walking, and the personal follow-kettle that hid above the
  // camera's pitch cap.)
  const vultureKettles = createVultureKettles({
    mobs,
    player: bobcat,
    groundY: (x, z) => world.terrainQuery.sampleGroundY(x, z),
  });
  // ---------- prey (deer herds) ----------
  // Skinned PZ models from the same cobra-tools pipeline as the bobcat.
  // Herds stream in a ring around the player: wander/graze when calm, flee
  // when the bobcat charges, die + despawn when caught.
  // (Goat was cut — the model variant looked off; its GLB/textures are still
  // in public/assets/mobs if it ever comes back.)
  // Blood reuses the dust particle system with droplet physics: small dense
  // points that hold their size, fall hard, and carry momentum — a spray,
  // not a puff.
  const bloodDecals = createBloodDecals(scene, (x, z) => world.groundY(x, z));
  const blood = createDust(scene, {
    max: 5000,
    color: 0x7d100c,
    pxScale: 13,
    alpha: 0.92,
    grow: [0.55, 0.8],
    gravity: 5.5,
    drag: 1.3,
  });

  const onPreyKilled = mob => {
    // Latch the bobcat onto the bite point: hold position just off the
    // prey's neck, facing it, for as long as the collapse animation runs —
    // reads as a bite instead of the cat sprinting through the corpse.
    const bp = mob.bitePoint ? mob.bitePoint() : { x: mob.position.x, z: mob.position.z };
    const dx = bobcat.position.x - bp.x;
    const dz = bobcat.position.z - bp.z;
    const d = Math.hypot(dx, dz) || 1;
    const lx = bp.x + (dx / d) * 0.55;
    const lz = bp.z + (dz / d) * 0.55;
    const latchYaw = Math.atan2(bp.x - lx, bp.z - lz);
    bobcat.startLatch(lx, lz, latchYaw, Math.min(2.0, (mob.deathDuration || 1.4) * 0.8));

    // Blood: arterial jet away from the cat + a hanging mist at the wound,
    // re-fired as weakening spurts through the hold. ~130 droplets per kill,
    // well within the emitter's 600-particle ring buffer.
    const ny = world.groundY(bp.x, bp.z) + 0.75;
    const jx = -(dx / d), jz = -(dz / d);     // away from the cat
    const spurt = strength => {
      blood.spawn(bp.x, ny, bp.z, {
        count: Math.round(220 * strength), size: 2.4, life: 0.65, speedT: 1.0,
        jet: { x: jx * 2.8 * strength, z: jz * 2.8 * strength, y: 2.2 * strength },
      });
      // Secondary fan in the cat's direction too — bites spray both ways.
      blood.spawn(bp.x, ny + 0.1, bp.z, {
        count: Math.round(70 * strength), size: 2.2, life: 0.5, speedT: 1.0,
        jet: { x: -jx * 1.2 * strength, z: -jz * 1.2 * strength, y: 1.8 * strength },
      });
      blood.spawn(bp.x, ny - 0.15, bp.z, {
        count: Math.round(110 * strength), size: 3.2, life: 0.95, speedT: 0.55,
      });
    };
    spurt(1.0);
    setTimeout(() => spurt(0.75), 150);
    setTimeout(() => spurt(0.55), 320);
    setTimeout(() => spurt(0.4), 520);
    setTimeout(() => spurt(0.28), 760);

    // Persistent splatter on the ground: one main pool under the bite, a
    // thrown streak where the arterial jet lands.
    bloodDecals.spawnAt(bp.x, bp.z, { size: 1.5 + Math.random() * 0.5 });
    bloodDecals.spawnAt(bp.x + jx * (0.9 + Math.random() * 0.6),
                        bp.z + jz * (0.9 + Math.random() * 0.6),
                        { size: 0.7 + Math.random() * 0.4 });

    audio.kill();
    audio.eat();
  };

  const deerAsset = await loadPreyAsset({
    url: asset('mobs/deer.glb'),
    targetLength: 1.9,
    textures: {
      antler: asset('mobs/deer_textures/deer_white_tailed_male_antlers.palbinobasecolourandmasktexture_RGB.png'),
      eye:    asset('mobs/deer_textures/deer_white_tailed_male_eyes.palbinobasecolourandmasktexture_RGB.png'),
      hair:   asset('mobs/deer_textures/deer_white_tailed_male_hair.palbinobasecolourandmasktexture_RGB.png'),
      fur:    asset('mobs/deer_textures/deer_white_tailed_male_fur.pbasecolourandmasktexture_RGB.png'),
      skin:   asset('mobs/deer_textures/deer_white_tailed_male_fur.pbasecolourandmasktexture_RGB.png'),
    },
  });
  const groundYFn = (x, z) => world.groundY(x, z);
  mobs.registerType('deer', createPreyType(deerAsset, groundYFn, {
    walkSpeed: 1.4, runSpeed: 11.0,
    // Walk to within ~11m undetected, then sprint the pounce; a full-speed
    // approach gives you away at ~44m. Bumped runSpeed so a straight chase
    // is a real commitment — stealth is the reliable route.
    stealthRadius: 11, alertRadius: 44, panicRadius: 7,
    calmRadius: 65, catchRadius: 1.4,
    onKilled: onPreyKilled,
  }));
  const preyHerds = createPreyHerds({
    mobs,
    groundY: groundYFn,
    player: bobcat,
    dem: world.dem,
    herdSpecs: [
      { typeId: 'deer', weight: 1, count: [3, 5] },
    ],
    opts: { maxHerds: 3, spawnMin: 200, spawnMax: 360, despawnRadius: 550 },
  });

  if (typeof window !== 'undefined') {
    window.__mobs = mobs;
    window.__preyHerds = preyHerds;
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
  let environment = null;

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
          panelRow(el, {
            label: 'Render scale', min: renderSettings.minScale, max: renderSettings.maxScale, step: 0.05,
            value: renderSettings.scale,
            format: v => `${Math.round(v * 100)}%`,
            onInput: v => {
              renderSettings.auto = false;
              applyRenderScale(v);
            }
          });
          const autoScaleMode = () => renderSettings.auto ? 'ON' : 'OFF';
          const autoScaleBtn = panelButton(el, `Auto render scale: ${autoScaleMode()}`, () => {
            renderSettings.auto = !renderSettings.auto;
            autoScaleBtn.textContent = `Auto render scale: ${autoScaleMode()}`;
          });
          panelButton(el, 'Diagnostic 100%', () => {
            renderSettings.auto = false;
            applyRenderScale(1.0);
            el.parentElement.querySelector('.dbg-tab.active').click();
          });
          panelButton(el, 'Reset', () => {
            nightVision.uniforms.uSaturation.value = 0.9;
            nightVision.uniforms.uBrightness.value = 1.1;
            nightVision.uniforms.uContrast.value = 0.9;
            renderSettings.auto = true;
            applyRenderScale(1.0);
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
            label: 'Texture quality', min: 0, max: 2, step: 1,
            value: u.uTextureQuality.value,
            onInput: v => u.uTextureQuality.value = v,
          });
          const terrainNormalsMode = () => u.uTerrainNormals.value > 0.5 ? 'ON' : 'OFF';
          const terrainNormalsBtn = panelButton(el, `Terrain normals: ${terrainNormalsMode()}`, () => {
            u.uTerrainNormals.value = u.uTerrainNormals.value > 0.5 ? 0.0 : 1.0;
            terrainNormalsBtn.textContent = `Terrain normals: ${terrainNormalsMode()}`;
          });
          const flatAlbedoMode = () => u.uTextureQuality.value < 0.5 ? 'ON' : 'OFF';
          const flatAlbedoBtn = panelButton(el, `Flat albedo: ${flatAlbedoMode()}`, () => {
            u.uTextureQuality.value = u.uTextureQuality.value < 0.5 ? 2.0 : 0.0;
            flatAlbedoBtn.textContent = `Flat albedo: ${flatAlbedoMode()}`;
          });
          panelRow(el, {
            label: 'Normal fade near', min: 0, max: 400, step: 5,
            value: u.uNormalFadeNear.value,
            onInput: v => u.uNormalFadeNear.value = v,
          });
          panelRow(el, {
            label: 'Normal fade far', min: 20, max: 1200, step: 10,
            value: u.uNormalFadeFar.value,
            onInput: v => u.uNormalFadeFar.value = v,
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
            u.uTextureQuality.value = 2.0;
            u.uTerrainNormals.value = 1.0;
            u.uNormalFadeNear.value = 90.0;
            u.uNormalFadeFar.value = 360.0;
            u.uDebugTextureContrast.value = 1.0;
            u.uDebugFarBlend.value = 1.0;
            u.uDebugPatchDither.value = 0.0;
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
          const visibleMode = obj => obj.visible ? 'ON' : 'OFF';
          const baseVisibleBtn = panelButton(el, `Base terrain: ${visibleMode(world.terrain.mesh)}`, () => {
            world.terrain.mesh.visible = !world.terrain.mesh.visible;
            baseVisibleBtn.textContent = `Base terrain: ${visibleMode(world.terrain.mesh)}`;
          });
          if (world.farDetailPatch) {
            const farPatchBtn = panelButton(el, `Far patch: ${visibleMode(world.farDetailPatch.mesh)}`, () => {
              world.farDetailPatch.mesh.visible = !world.farDetailPatch.mesh.visible;
              farPatchBtn.textContent = `Far patch: ${visibleMode(world.farDetailPatch.mesh)}`;
            });
          }
          const nearPatchBtn = panelButton(el, `Near patch: ${visibleMode(world.detailPatch.mesh)}`, () => {
            world.detailPatch.mesh.visible = !world.detailPatch.mesh.visible;
            nearPatchBtn.textContent = `Near patch: ${visibleMode(world.detailPatch.mesh)}`;
          });
          // Note: TerrainQuery still uses the bake-time defaults for CPU
          // groundY, so cranking these in the panel changes only what the
          // GPU draws — the bobcat's grounding stays at the original ~5m
          // peak. That's intentional: visual exploration without making
          // the cat float/sink.
        }
      },
      {
        id: 'ground', label: 'Ground',
        render(el) {
          const u = world.terrain.uniforms;
          const splat = world.splat;
          panelRow(el, {
            label: 'Tile size (m)', min: 4, max: 80, step: 0.5,
            value: u.uTextureScale.value,
            onInput: v => u.uTextureScale.value = v
          });
          panelRow(el, {
            label: 'Splat bias', min: 0.4, max: 4.0, step: 0.05,
            value: u.uSplatBias.value,
            onInput: v => u.uSplatBias.value = v
          });
          panelRow(el, {
            label: 'Detail strength', min: 0, max: 1.5, step: 0.01,
            value: u.uDetailStrength.value,
            onInput: v => u.uDetailStrength.value = v
          });
          panelRow(el, {
            label: 'Detail tile (m)', min: 0.2, max: 8, step: 0.05,
            value: u.uDetailTileSize.value,
            onInput: v => u.uDetailTileSize.value = v
          });
          panelRow(el, {
            label: 'Detail fade near', min: 1, max: 80, step: 0.5,
            value: u.uDetailFadeNear.value,
            onInput: v => u.uDetailFadeNear.value = v
          });
          panelRow(el, {
            label: 'Detail fade far', min: 10, max: 250, step: 1,
            value: u.uDetailFadeFar.value,
            onInput: v => u.uDetailFadeFar.value = v
          });
          panelRow(el, {
            label: 'Detail mip bias', min: -1, max: 3, step: 0.05,
            value: u.uDetailMipBias.value,
            onInput: v => u.uDetailMipBias.value = v
          });
          panelRow(el, {
            label: 'Detail AA', min: 0, max: 2, step: 0.05,
            value: u.uDetailAaStrength.value,
            onInput: v => u.uDetailAaStrength.value = v
          });
          const groundDetailMode = () => u.uDebugGroundDetail.value > 0.5 ? 'ON' : 'OFF';
          const groundDetailBtn = panelButton(el, `Ground detail: ${groundDetailMode()}`, () => {
            u.uDebugGroundDetail.value = u.uDebugGroundDetail.value > 0.5 ? 0.0 : 1.0;
            groundDetailBtn.textContent = `Ground detail: ${groundDetailMode()}`;
          });
          const detailAaMode = () => u.uDebugDetailAA.value > 0.5 ? 'ON' : 'OFF';
          const detailAaBtn = panelButton(el, `Detail AA guard: ${detailAaMode()}`, () => {
            u.uDebugDetailAA.value = u.uDebugDetailAA.value > 0.5 ? 0.0 : 1.0;
            detailAaBtn.textContent = `Detail AA guard: ${detailAaMode()}`;
          });
          const textureContrastMode = () => u.uDebugTextureContrast.value > 0.5 ? 'ON' : 'OFF';
          const textureContrastBtn = panelButton(el, `Texture contrast: ${textureContrastMode()}`, () => {
            u.uDebugTextureContrast.value = u.uDebugTextureContrast.value > 0.5 ? 0.0 : 1.0;
            textureContrastBtn.textContent = `Texture contrast: ${textureContrastMode()}`;
          });
          const farBlendMode = () => u.uDebugFarBlend.value > 0.5 ? 'ON' : 'OFF';
          const farBlendBtn = panelButton(el, `Far blend: ${farBlendMode()}`, () => {
            u.uDebugFarBlend.value = u.uDebugFarBlend.value > 0.5 ? 0.0 : 1.0;
            farBlendBtn.textContent = `Far blend: ${farBlendMode()}`;
          });
          const patchDitherMode = () => u.uDebugPatchDither.value > 0.5 ? 'ON' : 'OFF';
          const patchDitherBtn = panelButton(el, `Patch dither: ${patchDitherMode()}`, () => {
            u.uDebugPatchDither.value = u.uDebugPatchDither.value > 0.5 ? 0.0 : 1.0;
            patchDitherBtn.textContent = `Patch dither: ${patchDitherMode()}`;
          });
          if (splat) {
            const p = splat.params;
            const slider = (label, key, min, max, step) => panelRow(el, {
              label, min, max, step, value: p[key],
              onInput: v => splat.regenerate({ [key]: v })
            });
            slider('Patchiness',      'patchiness',   0, 8, 0.05);
            slider('Rock weight',     'rockScale',    0, 8, 0.05);
            slider('Grass weight',    'grassScale',   0, 8, 0.05);
            slider('Gravel weight',   'gravelScale',  0, 8, 0.05);
            slider('Sand weight',     'sandScale',    0, 8, 0.05);
            slider('Riparianbed wt',  'ripBedScale',  0, 8, 0.05);
            slider('Rocky-zone wt',   'rockyZScale',  0, 8, 0.05);
            slider('Sandywash wt',    'sandyWScale',  0, 8, 0.05);
            slider('Grass macro',     'grassMacroFreq',  0.5, 30, 0.1);
            slider('Gravel macro',    'gravelMacroFreq', 0.5, 30, 0.1);
            slider('Sand macro',      'sandMacroFreq',   0.5, 30, 0.1);
            slider('Riparianbed macro','ripBedMacroFreq',0.5, 30, 0.1);
            slider('Rocky macro',     'rockyMacroFreq',  0.5, 30, 0.1);
            slider('Wash macro',      'washMacroFreq',   0.5, 30, 0.1);
            panelButton(el, 'Reset', () => {
              splat.regenerate({
                rockScale: 4.20, grassScale: 0.75, gravelScale: 3.35, sandScale: 2.00,
                ripBedScale: 3.05, rockyZScale: 3.00, sandyWScale: 3.00,
                grassMacroFreq: 8.0, gravelMacroFreq: 7.0, sandMacroFreq: 6.5,
                ripBedMacroFreq: 23.8, rockyMacroFreq: 22.2, washMacroFreq: 20.3,
                patchiness: 4.0,
              });
              u.uTextureScale.value = 51.5;
              u.uSplatBias.value = 3.3;
              u.uDetailStrength.value = 1.50;
              u.uDetailTileSize.value = 3.95;
              u.uDetailFadeNear.value = 1.0;
              u.uDetailFadeFar.value = 10.0;
              u.uDetailMipBias.value = -1.0;
              u.uDetailAaStrength.value = 1.0;
              u.uDebugGroundDetail.value = 1.0;
              u.uDebugDetailAA.value = 1.0;
              u.uDebugTextureContrast.value = 1.0;
              u.uDebugFarBlend.value = 1.0;
              u.uDebugPatchDither.value = 0.0;
              el.parentElement.querySelector('.dbg-tab.active').click();
            });
          }
        }
      },
      {
        id: 'foliage', label: 'Foliage',
        render(el) {
          const u = world.terrain.uniforms;
          const field = world.foliageField;
          const mass = world.foliageMass;
          const palette = () => environment?.state?.foliagePalette;
          const colorHex = color => `#${color.getHexString()}`;
          const syncPalette = () => {
            const p = palette();
            if (!p) return;
            u.uGrassRootColor.value.copy(p.grassRootColor);
            u.uGrassTipColor.value.copy(p.grassTipColor);
            u.uWoodyUnderstoryColor.value.copy(p.woodyUnderstoryColor);
            u.uWoodyCanopyColor.value.copy(p.woodyCanopyColor);
            u.uFoliageValueScale.value = p.foliageValueScale;
            u.uFoliageStrength.value = p.foliageStrength;
            for (const tier of world.plants.tiers) {
              tier.uniforms.uPlantHueColor.value.copy(p.plantHueColor);
              tier.uniforms.uPlantHueStrength.value = p.plantHueStrength;
              tier.uniforms.uPlantSaturation.value = p.plantSaturation;
              tier.uniforms.uPlantValueScale.value = p.foliageValueScale;
            }
            if (mass) mass.setPalette(p);
          };

          const seasonButton = id => panelButton(el, `Season: ${id}`, () => {
            if (!environment) return;
            environment.setSeason(id);
            el.parentElement.querySelector('.dbg-tab.active').click();
          });
          seasonButton('summer_dry');
          seasonButton('late_spring');
          seasonButton('monsoon');
          seasonButton('winter_dormant');

          const foliageMode = () => u.uHasFoliageMass.value > 0.5 ? 'ON' : 'OFF';
          const foliageBtn = panelButton(el, `Terrain foliage: ${foliageMode()}`, () => {
            u.uHasFoliageMass.value = u.uHasFoliageMass.value > 0.5 ? 0.0 : 1.0;
            foliageBtn.textContent = `Terrain foliage: ${foliageMode()}`;
          });
          const debugMode = () => u.uDebugFoliageMass.value > 0.5 ? 'ON' : 'OFF';
          const debugBtn = panelButton(el, `Debug mass RGB: ${debugMode()}`, () => {
            u.uDebugFoliageMass.value = u.uDebugFoliageMass.value > 0.5 ? 0.0 : 1.0;
            debugBtn.textContent = `Debug mass RGB: ${debugMode()}`;
          });
          if (mass) {
            const massMode = () => mass.group.visible ? 'ON' : 'OFF';
            const massBtn = panelButton(el, `Mass impostors: ${massMode()}`, () => {
              mass.setEnabled(!mass.group.visible);
              massBtn.textContent = `Mass impostors: ${massMode()}`;
            });
          }

          // Near-camera dissolve. End must stay above the camera's 0.5m near
          // plane or plants get sliced open before they finish fading.
          const plantU = (name, v) => {
            for (const tier of world.plants.tiers) tier.uniforms[name].value = v;
          };
          for (const [label, name, min, max] of [
            ['Near fade start', 'uNearFadeStart', 1.0, 14],
            ['Near fade end', 'uNearFadeEnd', 0.5, 2],
            ['Near fade curve', 'uNearFadeCurve', 0.1, 2],
            ['Near blur', 'uNearBlur', 0, 5]
          ]) {
            panelRow(el, {
              label, min, max, step: 0.05,
              value: world.plants.tiers[0].uniforms[name].value,
              format: v => name.includes('Fade') && !name.includes('Curve') ? `${v.toFixed(2)}m` : v.toFixed(2),
              onInput: v => plantU(name, v)
            });
          }

          // Character lighting: 1 = world model (matches terrain), 0 = three's
          // PBR pipeline, for A/B against how it looked before.
          if (bobcat?.lightingUniforms) {
            panelRow(el, {
              label: 'Cat world-lit', min: 0, max: 1, step: 0.01,
              value: bobcat.lightingUniforms.uWorldLightMix.value,
              onInput: v => { bobcat.lightingUniforms.uWorldLightMix.value = v; }
            });
          }

          // Ground grade — the sampled limestone/soil palette. 0 shows the
          // raw splat textures for comparison.
          panelRow(el, {
            label: 'Ground grade', min: 0, max: 1, step: 0.01,
            value: u.uGroundGrade.value,
            onInput: v => u.uGroundGrade.value = v
          });
          for (const [label, name] of [
            ['Rock dark', 'uGroundRockDark'], ['Rock lit', 'uGroundRockLit'],
            ['Soil dark', 'uGroundSoilDark'], ['Soil lit', 'uGroundSoilLit']
          ]) {
            panelColor(el, {
              label, value: colorHex(u[name].value),
              onInput: v => u[name].value.set(v)
            });
          }

          // Canopy-normal shading (see species.js CANOPY). Strength 0 is the
          // old per-card flat lighting, for A/B-ing the effect in place.
          const plantUniform = (name, v) => {
            for (const tier of world.plants.tiers) tier.uniforms[name].value = v;
          };
          const canopyDial = (label, name, max) => panelRow(el, {
            label, min: 0, max, step: 0.01,
            value: world.plants.tiers[0].uniforms[name].value,
            onInput: v => plantUniform(name, v)
          });
          canopyDial('Canopy normals', 'uCanopyStrength', 1);
          canopyDial('Canopy wrap', 'uCanopyWrap', 1);
          canopyDial('Canopy contrast', 'uCanopyContrast', 4);
          canopyDial('Canopy backlight', 'uCanopyTrans', 2);

          panelRow(el, {
            label: 'Terrain strength', min: 0, max: 2, step: 0.01,
            value: palette()?.foliageStrength ?? u.uFoliageStrength.value,
            onInput: v => {
              const p = palette();
              if (p) {
                p.foliageStrength = v;
                syncPalette();
              } else {
                u.uFoliageStrength.value = v;
              }
            }
          });
          const blendName = v => ['HUE', 'MULT', 'OVER', 'DARK'][Math.max(0, Math.min(3, Math.round(v)))] || 'HUE';
          panelRow(el, {
            label: 'Grass blend', min: 0, max: 3, step: 1,
            value: u.uGrassBlendMode.value,
            format: blendName,
            onInput: v => u.uGrassBlendMode.value = v
          });
          panelRow(el, {
            label: 'Woody blend', min: 0, max: 3, step: 1,
            value: u.uWoodyBlendMode.value,
            format: blendName,
            onInput: v => u.uWoodyBlendMode.value = v
          });
          panelRow(el, {
            label: 'Woody darken', min: 0, max: 0.8, step: 0.01,
            value: u.uWoodyDarken.value,
            onInput: v => u.uWoodyDarken.value = v
          });
          const p = palette();
          if (p) {
            panelColor(el, {
              label: 'Grass root', value: colorHex(p.grassRootColor),
              onInput: v => { p.grassRootColor.set(v); syncPalette(); }
            });
            panelColor(el, {
              label: 'Grass tip', value: colorHex(p.grassTipColor),
              onInput: v => { p.grassTipColor.set(v); syncPalette(); }
            });
            panelColor(el, {
              label: 'Woody under', value: colorHex(p.woodyUnderstoryColor),
              onInput: v => { p.woodyUnderstoryColor.set(v); syncPalette(); }
            });
            panelColor(el, {
              label: 'Woody canopy', value: colorHex(p.woodyCanopyColor),
              onInput: v => { p.woodyCanopyColor.set(v); syncPalette(); }
            });
            panelColor(el, {
              label: 'Plant hue', value: colorHex(p.plantHueColor),
              onInput: v => { p.plantHueColor.set(v); syncPalette(); }
            });
            panelRow(el, {
              label: 'Plant hue mix', min: 0, max: 1, step: 0.01,
              value: p.plantHueStrength,
              onInput: v => { p.plantHueStrength = v; syncPalette(); }
            });
            panelRow(el, {
              label: 'Plant saturation', min: 0, max: 1.8, step: 0.01,
              value: p.plantSaturation,
              onInput: v => { p.plantSaturation = v; syncPalette(); }
            });
            panelRow(el, {
              label: 'Foliage value', min: 0.4, max: 1.6, step: 0.01,
              value: p.foliageValueScale,
              onInput: v => { p.foliageValueScale = v; syncPalette(); }
            });
          }

          if (field) {
            const fp = field.params;
            const fieldSlider = (label, key, min, max, step) => panelRow(el, {
              label, min, max, step, value: fp[key],
              onInput: v => fp[key] = v
            });
            fieldSlider('Grass density', 'grassScale', 0, 3, 0.01);
            fieldSlider('Grass open flats', 'grassOpenScale', 0, 2, 0.01);
            fieldSlider('Grass patch floor', 'grassPatchFloor', 0, 1, 0.01);
            fieldSlider('Grass drain cut', 'grassDrainageSuppress', 0, 1, 0.01);
            fieldSlider('Woody density', 'woodyScale', 0, 3, 0.01);
            fieldSlider('Drainage power', 'drainagePower', 0.2, 3, 0.01);
            fieldSlider('Slope cutoff', 'slopeCutoff', 0.05, 0.8, 0.01);
            fieldSlider('Edge strength', 'edgeStrength', 0, 4, 0.01);
            panelButton(el, 'Regenerate field', () => {
              field.regenerate();
              if (mass?.reloadChunks) mass.reloadChunks();
            });
            panelButton(el, 'Grassier field', () => {
              field.regenerate({
                grassScale: 2.25,
                grassNoiseFreq: 6.0,
                grassOpenScale: 1.15,
                grassPatchFloor: 0.58,
                grassDrainageSuppress: 0.18,
                slopeCutoff: 0.56
              });
              if (mass?.reloadChunks) mass.reloadChunks();
              el.parentElement.querySelector('.dbg-tab.active').click();
            });
          }

          if (mass) {
            const s = mass.settings;
            panelRow(el, {
              label: 'Mass active radius', min: 512, max: 5000, step: 64,
              value: s.activeRadius,
              onInput: v => s.activeRadius = v
            });
            panelRow(el, {
              label: 'Mass unload radius', min: 768, max: 6000, step: 64,
              value: s.unloadRadius,
              onInput: v => s.unloadRadius = v
            });
            panelRow(el, {
              label: 'Chunks / frame', min: 1, max: 8, step: 1,
              value: s.maxGeneratedPerFrame,
              onInput: v => s.maxGeneratedPerFrame = v
            });
            panelRow(el, {
              label: 'Impostors / chunk', min: 16, max: 512, step: 8,
              value: s.maxImpostorsPerChunk,
              onInput: v => s.maxImpostorsPerChunk = v
            });
            panelButton(el, 'Reload mass chunks', () => mass.reloadChunks());
          }
        }
      },
      {
        id: 'animation', label: 'Animation',
        render(el) {
          panelRow(el, {
            label: 'Sprint crop', min: 0, max: 0.4, step: 0.005,
            value: bobcat.getRunCrop ? bobcat.getRunCrop() : 0,
            format: v => `${Math.round(v * 100)}%`,
            onInput: v => bobcat.setRunCrop && bobcat.setRunCrop(v)
          });
          panelRow(el, {
            label: 'Sprint speed', min: 0.1, max: 1.5, step: 0.05,
            value: bobcat.getRunTimeScale ? bobcat.getRunTimeScale() : 1.0,
            format: v => v.toFixed(2),
            onInput: v => bobcat.setRunTimeScale && bobcat.setRunTimeScale(v)
          });
          const mirrorLabel = () => bobcat.getMirrorEnabled() ? 'Mirror: ON' : 'Mirror: OFF';
          const mirrorBtn = panelButton(el, mirrorLabel(), () => {
            bobcat.setMirrorEnabled(!bobcat.getMirrorEnabled());
            mirrorBtn.textContent = mirrorLabel();
          });
          const leadLabel = () => {
            const l = bobcat.getMirrorLeadLock();
            if (l === 0) return 'Lead lock: AUTO';
            if (l > 0)  return 'Lead lock: ORIGINAL';
            return 'Lead lock: MIRROR';
          };
          const leadBtn = panelButton(el, leadLabel(), () => {
            const cur = bobcat.getMirrorLeadLock();
            const next = cur === 0 ? 1 : cur > 0 ? -1 : 0;
            bobcat.setMirrorLeadLock(next);
            leadBtn.textContent = leadLabel();
          });

          // ---- Mirror exclude pattern ----
          // Regex matched against bone names (without .L/.R suffix removed).
          // Matching bones are kept at their original (un-mirrored) values.
          // Defaults exclude face. See console at load for available families.
          const excludeRow = document.createElement('div');
          excludeRow.className = 'dbg-row';
          excludeRow.innerHTML = `
            <div class="dbg-label" style="margin-bottom:4px;">
              <span>Mirror exclude (regex)</span>
              <span style="font-size:9px; color:#7a6d52;">SEE CONSOLE FOR BONES</span>
            </div>
          `;
          const excludeInput = document.createElement('input');
          excludeInput.type = 'text';
          excludeInput.value = bobcat.getMirrorExcludePattern ? bobcat.getMirrorExcludePattern() : '';
          excludeInput.style.cssText = `
            width: 100%; padding: 4px 6px;
            background: #08060a; color: #f0e6d0;
            border: 2px solid #0a0805;
            box-shadow: inset 0 0 0 1px #4f3a26;
            font-family: monospace; font-size: 11px;
            outline: none;
          `;
          excludeInput.addEventListener('change', () => {
            try { bobcat.setMirrorExcludePattern(excludeInput.value); }
            catch (e) { console.warn('[debug] bad regex:', e.message); }
          });
          excludeRow.appendChild(excludeInput);
          el.appendChild(excludeRow);

          // ---- Scrub & per-frame skip diagnostics ----
          const forceLabel = () => bobcat.getForceSprint() ? 'Force sprint: ON' : 'Force sprint: OFF';
          const forceBtn = panelButton(el, forceLabel(), () => {
            bobcat.setForceSprint(!bobcat.getForceSprint());
            forceBtn.textContent = forceLabel();
          });
          const pauseLabel = () => bobcat.getPaused() ? 'Pause: ON' : 'Pause: OFF';
          const pauseBtn = panelButton(el, pauseLabel(), () => {
            bobcat.setPaused(!bobcat.getPaused());
            pauseBtn.textContent = pauseLabel();
          });

          const frameCount = bobcat.getFrameCount() || 1;
          let currentFrame = 0;
          const frameRow = panelRow(el, {
            label: 'Frame', min: 0, max: Math.max(0, frameCount - 1), step: 1,
            value: 0,
            format: v => `${Math.floor(v)} / ${frameCount - 1}`,
            onInput: v => {
              currentFrame = Math.floor(v);
              bobcat.setRunTimeFraction(currentFrame / Math.max(1, frameCount - 1));
              updateSkipBtn();
            }
          });
          const skippedDiv = document.createElement('div');
          skippedDiv.style.cssText = 'font-size: 10px; color: #b9aa8a; padding: 4px 0 8px; letter-spacing: 0.1em; word-wrap: break-word;';
          const updateSkippedDiv = () => {
            const list = bobcat.getSkippedFrames();
            skippedDiv.textContent = `SKIPPED: ${list.length ? list.join(', ') : '(none)'}`;
          };
          const skipLabel = () => bobcat.isFrameSkipped(currentFrame)
            ? `Unskip frame ${currentFrame} (both clips)`
            : `Skip frame ${currentFrame} (both clips)`;
          const skipBtn = panelButton(el, skipLabel(), () => {
            bobcat.setFrameSkipped(currentFrame, !bobcat.isFrameSkipped(currentFrame));
            updateSkipBtn();
            updateSkippedDiv();
          });
          function updateSkipBtn() { skipBtn.textContent = skipLabel(); }
          panelButton(el, 'Clear all skipped', () => {
            bobcat.clearSkippedFrames();
            updateSkipBtn();
            updateSkippedDiv();
          });
          el.appendChild(skippedDiv);
          updateSkippedDiv();
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

  // Daylight fill for the bobcat. Terrain/plants are shader-lit separately;
  // this small local source keeps the animal readable when the sun is high or
  // behind the camera-facing side without washing out the whole desert.
  // Wider range + near-linear decay (1.0) so the fill covers the whole body
  // evenly instead of a hot spot near the lamp — the cat is ~0.85m long and
  // the lamp hovers ~1m off it, so a steep falloff left the far flank dark.
  const bobcatFill = new THREE.PointLight(0xfff7ea, 0, 8.0, 1.0);
  bobcatFill.castShadow = false;
  bobcatFill.layers.set(BOBCAT_LIGHT_LAYER);
  scene.add(bobcatFill);
  const bobcatTopFill = new THREE.PointLight(0xddeeff, 0, 8.0, 1.0);
  bobcatTopFill.castShadow = false;
  bobcatTopFill.layers.set(BOBCAT_LIGHT_LAYER);
  scene.add(bobcatTopFill);

  environment = createEnvironment({
    renderer, sky, world,
    sun, hemi, ambient, lantern, bobcatFill, bobcatTopFill, bobcat
  });
  if (typeof window !== 'undefined') window.__setSeason = id => environment.setSeason(id);
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
  let displayFps = 60;
  let lastFootAt = 0;
  const _lightVec = new THREE.Vector3();

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
    blood.update(dt);
    bloodDecals.update(dt);
    mobs.update(dt, t, { bobcat });
    preyHerds.update(dt);
    vultureKettles.update(dt);

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
    {
      const fillDir = _lightVec.subVectors(camera.position, bobcat.position);
      fillDir.y = 0;
      if (fillDir.lengthSq() < 1e-4) fillDir.set(0, 0, 1);
      fillDir.normalize();
      bobcatFill.position.set(
        bobcat.position.x + fillDir.x * 0.9,
        bobcat.position.y + 1.15,
        bobcat.position.z + fillDir.z * 0.9
      );
    }
    bobcatTopFill.position.set(
      bobcat.position.x,
      bobcat.position.y + 2.0,
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

    const prompt = bobcat.isDrinking ? 'DRINKING'
                 : bobcat.canDrink   ? 'DRINK (E)'
                 : null;
    hud.update({ playerYaw: bobcat.yaw, playerPos: bobcat.position, fps: displayFps, prompt, prey: mobs.mobs });
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

    // Adaptive resolution if frametime spikes. Manual changes in the debug
    // menu disable this so render scale stays exactly where the user put it.
    fpsAccum += dt; fpsFrames++;
    if (renderSettings.auto && fpsAccum > 1.0) {
      const fps = fpsFrames / fpsAccum;
      fpsAccum = 0; fpsFrames = 0;
      if (fps < 45 && renderSettings.scale > renderSettings.minScale) {
        applyRenderScale(renderSettings.scale - 0.05);
      } else if (fps > 58 && renderSettings.scale < renderSettings.maxScale) {
        applyRenderScale(renderSettings.scale + 0.05);
      }
    } else if (!renderSettings.auto && fpsAccum > 1.0) {
      fpsAccum = 0; fpsFrames = 0;
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
