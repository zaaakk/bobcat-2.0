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
import { createHUD, setLoadingProgress, hideLoading, ensureSpritesLoaded, initLoadingScreen } from './ui/HUD.js';
import { createDebugMenu, panelRow, panelButton } from './ui/DebugMenu.js';

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
  const bobcatFill = new THREE.PointLight(0xfff7ea, 0, 4.2, 1.45);
  bobcatFill.castShadow = false;
  bobcatFill.layers.set(BOBCAT_LIGHT_LAYER);
  scene.add(bobcatFill);
  const bobcatTopFill = new THREE.PointLight(0xddeeff, 0, 4.8, 1.35);
  bobcatTopFill.castShadow = false;
  bobcatTopFill.layers.set(BOBCAT_LIGHT_LAYER);
  scene.add(bobcatTopFill);

  const environment = createEnvironment({
    renderer, sky, world,
    sun, hemi, ambient, lantern, bobcatFill, bobcatTopFill
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
