import * as THREE from 'three';

/**
 * Environment / day-night cycle. Owns:
 *   • the celestial state (sun direction over a 4-min cycle, moon at night)
 *   • palette interpolation (sky, fog, sun, hemi, ambient)
 *   • per-frame push of those values into every rendering subsystem that
 *     needs them (sky shader, terrain shader, plant shaders, the actual
 *     directional/hemi/ambient lights, tone-mapping exposure, lantern)
 *
 * Public interface:
 *   const env = createEnvironment({ renderer, sky, world, sun, hemi, ambient, lantern });
 *   env.update(timeSec);                 // call each frame
 *   env.state.sunDir, env.state.sunColor // read by water + night-vision + audio
 *
 * Why "shared state" rather than push-only:
 *   Other subsystems (audio cross-fade, water specular, night-vision lens
 *   gating) consume sunDir/sunColor by *reading* env.state. Internally we
 *   still push to terrain/plants/sky uniforms because those are tightly
 *   coupled to per-shader uniform names; future weather state (wind, cloud
 *   coverage, precip) can extend env.state and consumers pull from there.
 */
export function createEnvironment({ renderer, sky, world, sun, hemi, ambient, lantern }) {
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
    hemiSkyDay:     new THREE.Color('#a8c4df'),
    hemiSkyNight:   new THREE.Color('#4a5c80'),
    hemiGroundDay:  new THREE.Color('#756042'),
    hemiGroundNight:new THREE.Color('#262a36'),
    ambientDay:     new THREE.Color('#ffffff'),
    ambientNight:   new THREE.Color('#a8b8d6')
  };

  // Live state — read by other systems each frame. Future weather fields
  // (wind vector, cloud cover, precip rate) will land here.
  const state = {
    sunDir:    new THREE.Vector3(),
    skyTop:    new THREE.Color(),
    horizon:   new THREE.Color(),
    haze:      new THREE.Color(),
    fogLow:    new THREE.Color(),
    fogMid:    new THREE.Color(),
    fogFar:    new THREE.Color(),
    sunColor:  new THREE.Color(),
    terrainAmbient: new THREE.Color(),
    plantAmbient:   new THREE.Color(),
    hemiSky:    new THREE.Color(),
    hemiGround: new THREE.Color(),
    ambient:    new THREE.Color(),
    /** 0 at night → 1 at full day. Smoothstep over the horizon transition. */
    dayT: 0,
    /** 0 at day → 1 at full night. Sharper smoothstep so dusk reads. */
    nightT: 0,
    /** Bell curve peaking around horizon angles; drives dusk colour blends. */
    twilightT: 0,
    /** 0 below horizon, > 0 once the sun is up; plain max(0, sunDir.y). */
    directT: 0
  };

  function update(timeSec) {
    // ---- celestial geometry ----
    const cycle = (timeSec / cycleSeconds + phaseOffset) % 1;
    const theta = cycle * Math.PI * 2;
    state.sunDir.set(Math.cos(theta) * 0.28, Math.sin(theta), Math.sin(theta) * 0.96).normalize();

    state.dayT      = THREE.MathUtils.smoothstep(state.sunDir.y, -0.14, 0.10);
    state.nightT    = 1.0 - THREE.MathUtils.smoothstep(state.sunDir.y, -0.24, 0.02);
    state.twilightT = THREE.MathUtils.smoothstep(state.sunDir.y, -0.22, 0.16) *
      (1.0 - THREE.MathUtils.smoothstep(Math.abs(state.sunDir.y), 0.16, 0.58));
    state.directT   = Math.max(0, state.sunDir.y);

    const dayT = state.dayT;
    const nightT = state.nightT;
    const twilightBand = state.twilightT;

    // ---- palette interpolation ----
    state.skyTop.lerpColors(palette.skyTopNight, palette.skyTopDay, dayT);
    state.skyTop.lerp(palette.skyTopDusk, twilightBand * 0.55);
    state.horizon.lerpColors(palette.horizonNight, palette.horizonDay, dayT);
    state.haze.lerpColors(palette.hazeNight, palette.hazeDay, dayT);
    state.haze.lerp(palette.hazeDusk, twilightBand * 0.9);
    state.fogLow.lerpColors(palette.fogLowNight, palette.fogLowDay, dayT);
    state.fogMid.lerpColors(palette.fogMidNight, palette.fogMidDay, dayT);
    state.fogFar.lerpColors(palette.fogFarNight, palette.fogFarDay, dayT);
    state.sunColor.lerpColors(palette.sunNight, palette.sunDay, dayT);
    state.sunColor.lerp(palette.sunDusk, twilightBand * 0.85);
    state.terrainAmbient.lerpColors(palette.terrainAmbientNight, palette.terrainAmbientDay, dayT);
    state.plantAmbient.lerpColors(palette.plantAmbientNight, palette.plantAmbientDay, dayT);
    state.hemiSky.lerpColors(palette.hemiSkyNight, palette.hemiSkyDay, dayT);
    state.hemiGround.lerpColors(palette.hemiGroundNight, palette.hemiGroundDay, dayT);
    state.ambient.lerpColors(palette.ambientNight, palette.ambientDay, dayT);

    // ---- push to subsystems ----
    sky.material.uniforms.uTopColor.value.copy(state.skyTop);
    sky.material.uniforms.uHorizonColor.value.copy(state.horizon);
    sky.material.uniforms.uHazeColor.value.copy(state.haze);
    sky.material.uniforms.uSunDir.value.copy(state.sunDir);
    sky.material.uniforms.uSunColor.value.copy(state.sunColor);

    const terrain = world.terrain;
    terrain.uniforms.uSunDir.value.copy(state.sunDir);
    terrain.uniforms.uSunColor.value.copy(state.sunColor);
    terrain.uniforms.uAmbientColor.value.copy(state.terrainAmbient);
    terrain.uniforms.uFogColorLow.value.copy(state.fogLow);
    terrain.uniforms.uFogColorMid.value.copy(state.fogMid);
    terrain.uniforms.uFogColorFar.value.copy(state.fogFar);
    terrain.uniforms.uFogDensity.value = THREE.MathUtils.lerp(0.00008, 0.00018, dayT) + twilightBand * 0.00003;

    for (const tier of world.plants.tiers) {
      tier.uniforms.uSunDir.value.copy(state.sunDir);
      tier.uniforms.uSunColor.value.copy(state.sunColor);
      tier.uniforms.uAmbient.value.copy(state.plantAmbient);
      tier.uniforms.uFogColorLow.value.copy(state.fogLow);
      tier.uniforms.uFogColorMid.value.copy(state.fogMid);
      tier.uniforms.uFogColorFar.value.copy(state.fogFar);
      tier.uniforms.uFogDensity.value = terrain.uniforms.uFogDensity.value;
    }

    // Sun is moon-flipped at night — light direction reverses but sun.position
    // points at where the *light source* is, so it can illuminate scene normals
    // correctly while state.sunDir still reports "down" for night-aware code.
    if (state.sunDir.y < 0) {
      sun.position.set(-state.sunDir.x, -state.sunDir.y, -state.sunDir.z).multiplyScalar(1800);
    } else {
      sun.position.copy(state.sunDir).multiplyScalar(1800);
    }
    sun.color.copy(state.sunColor);
    const moonStrength = Math.max(0, -state.sunDir.y);
    sun.intensity = Math.pow(state.directT, 0.42) * 4.4 + twilightBand * 0.22 + moonStrength * 0.65;

    hemi.color.copy(state.hemiSky);
    hemi.groundColor.copy(state.hemiGround);
    hemi.intensity = THREE.MathUtils.lerp(0.32, 0.42, dayT) + twilightBand * 0.06;

    ambient.color.copy(state.ambient);
    ambient.intensity = THREE.MathUtils.lerp(0.14, 0.16, dayT) + nightT * 0.04;

    renderer.toneMappingExposure = THREE.MathUtils.lerp(0.82, 1.0, dayT) + twilightBand * 0.04;

    if (lantern) {
      lantern.intensity = nightT * 6.5 + twilightBand * 1.2;
    }
  }

  return { update, state };
}
