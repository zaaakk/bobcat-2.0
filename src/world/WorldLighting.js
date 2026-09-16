import * as THREE from 'three';

/**
 * Light a standard three.js material with the world's own lighting model.
 *
 * The terrain, the plants and the ground shadows are all custom shaders that
 * light themselves analytically: one strong sun term, a hemisphere-ish ambient
 * fill, a shadow floor that stops surfaces crushing to black, a fixed exposure
 * lift, then aerial-perspective fog. The bobcat is a glTF character on
 * MeshStandardMaterial, lit instead by three's physical pipeline from the
 * scene's DirectionalLight + HemisphereLight + AmbientLight.
 *
 * Two lighting models in one scene do not merely differ by a constant — they
 * diverge, and the divergence is worst exactly where it is most visible.
 * Measured on a neutral surface facing the sun, bobcat brightness as a
 * fraction of world brightness:
 *
 *     noon 0.74x | low sun 0.51x | sunset 0.23x | night 0.06x
 *
 * The world floors out on its ambient + shadow floor (~1.07 at night) while
 * the PBR path falls away to near black. No retuning of light intensities
 * fixes that, because the two response curves have different shapes. The fix
 * is to make the character evaluate the same function the ground does.
 *
 * On top of that, `scene.fog` is never set in this project — every other
 * surface fogs itself in-shader, so the character was also the only thing in
 * the scene with no aerial perspective at all, staying fully saturated at any
 * distance while the ground behind it washed to sky colour.
 *
 * This patches a material in place via onBeforeCompile: three still does the
 * albedo, normal mapping and skinning, and only the final lighting
 * integration is replaced. Call `createWorldLightingUniforms()` once, share
 * the object across every material, and push the environment into it each
 * frame with `updateWorldLightingUniforms()`.
 *
 * Kept deliberately in sync with the block in TerrainMesh.js; if the terrain's
 * sun multiplier, shadow floor or fog curve changes, change it here too.
 */

export function createWorldLightingUniforms() {
  return {
    uSunDir:       { value: new THREE.Vector3(0.5, 0.85, 0.2).normalize() },
    // Direction the key light actually arrives FROM, and how strong it is.
    // Not the same as uSunDir: below the horizon the key flips to the moon,
    // exactly as Environment already flips the scene's DirectionalLight.
    // uSunDir keeps pointing down at night for night-aware code (and for the
    // fog's sun-scatter term), so using it raw as a light direction lights
    // the underside of anything with 3D normals. The terrain gets away with
    // it because its normals all face up; a character does not.
    uKeyDir:       { value: new THREE.Vector3(0.5, 0.85, 0.2).normalize() },
    uKeyStrength:  { value: 1.0 },
    uSunColor:     { value: new THREE.Color(1.0, 0.96, 0.85) },
    uAmbientColor: { value: new THREE.Color(0.42, 0.45, 0.55) },
    // Warm light bouncing up off the ground. The terrain's lighting model has
    // no such term because terrain normals never face down, but a character
    // has a whole underside, and dropping this was what left the belly
    // crushed at an 8:1 ratio to the back. This is the groundColor half of
    // the HemisphereLight the PBR path used to get.
    uGroundBounce: { value: new THREE.Color('#756042') },
    uGroundBounceStrength: { value: 0.45 },
    uExposure:     { value: 1.18 },
    uFogDensity:   { value: 0.00017 },
    uFogColorLow:  { value: new THREE.Color('#c9d1d8') },
    uFogColorMid:  { value: new THREE.Color('#96abc1') },
    uFogColorFar:  { value: new THREE.Color('#668db8') },
    uHorizonAlt:   { value: 1200.0 },
    uLanternPos:   { value: new THREE.Vector3() },
    uLanternColor: { value: new THREE.Color('#b8d2ff') },
    uLanternRange: { value: 22.0 },
    uLanternIntensity: { value: 0.0 },
    // 0 hands the surface back to three's own PBR lighting, for A/B.
    uWorldLightMix: { value: 1.0 }
  };
}

/** Push one frame of Environment state into a shared uniform block. */
export function updateWorldLightingUniforms(u, state, terrainUniforms) {
  if (!u || !state) return;
  u.uSunDir.value.copy(state.sunDir);
  // Mirror Environment's own sun/moon flip for the DirectionalLight.
  if (state.sunDir.y < 0) {
    u.uKeyDir.value.set(-state.sunDir.x, -state.sunDir.y, -state.sunDir.z);
    // Moonlight: a soft top key so the character keeps its form at night
    // instead of flattening into pure ambient. Same shape as the scene
    // light's own `moonStrength * 0.65` night term.
    u.uKeyStrength.value = Math.max(0, -state.sunDir.y) * 0.22;
  } else {
    u.uKeyDir.value.copy(state.sunDir);
    u.uKeyStrength.value = 1.0;
  }
  u.uSunColor.value.copy(state.sunColor);
  u.uAmbientColor.value.copy(state.terrainAmbient);
  u.uGroundBounce.value.copy(state.hemiGround);
  u.uFogColorLow.value.copy(state.fogLow);
  u.uFogColorMid.value.copy(state.fogMid);
  u.uFogColorFar.value.copy(state.fogFar);
  if (terrainUniforms) {
    u.uFogDensity.value = terrainUniforms.uFogDensity.value;
    u.uExposure.value = terrainUniforms.uExposure.value;
    u.uLanternPos.value.copy(terrainUniforms.uLanternPos.value);
    u.uLanternColor.value.copy(terrainUniforms.uLanternColor.value);
    u.uLanternRange.value = terrainUniforms.uLanternRange.value;
    u.uLanternIntensity.value = terrainUniforms.uLanternIntensity.value;
  }
}

const VERT_DECL = /* glsl */`
  varying vec3 vWorldLitPos;
`;

// `transformed` is post-skinning object space, so this is the real world
// position of the deformed vertex.
const VERT_BODY = /* glsl */`
  vWorldLitPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const FRAG_DECL = /* glsl */`
  uniform vec3 uSunDir;
  uniform vec3 uKeyDir;
  uniform float uKeyStrength;
  uniform vec3 uSunColor;
  uniform vec3 uAmbientColor;
  uniform vec3 uGroundBounce;
  uniform float uGroundBounceStrength;
  uniform float uExposure;
  uniform float uFogDensity;
  uniform vec3 uFogColorLow, uFogColorMid, uFogColorFar;
  uniform float uHorizonAlt;
  uniform vec3 uLanternPos;
  uniform vec3 uLanternColor;
  uniform float uLanternRange;
  uniform float uLanternIntensity;
  uniform float uWorldLightMix;
  varying vec3 vWorldLitPos;
`;

// Replaces the lighting integration only. `diffuseColor` is the albedo three
// has already resolved (map x colour x vertex colour); `normal` is the
// normal-mapped shading normal in VIEW space, so it is rotated back to world
// by the transpose of the view rotation — which is its inverse, the matrix
// being orthonormal.
const FRAG_BODY = /* glsl */`
  vec3 nWorld = normalize(normal * mat3(viewMatrix));
  vec3 albedoW = diffuseColor.rgb;

  float NdotL = clamp(dot(nWorld, uKeyDir), 0.0, 1.0) * uKeyStrength;
  float upT = clamp(nWorld.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 fill = uAmbientColor * mix(0.78, 1.25, upT)
            + uGroundBounce * (1.0 - upT) * uGroundBounceStrength;
  vec3 lit = albedoW * (uSunColor * NdotL * 1.55 + fill);
  lit = max(lit, albedoW * uAmbientColor * 0.85);

  vec3 toLantern = uLanternPos - vWorldLitPos;
  float lanternD = length(toLantern);
  float lanternAtt = clamp(1.0 - lanternD / uLanternRange, 0.0, 1.0);
  lanternAtt *= lanternAtt;
  float lanternNdl = clamp(dot(nWorld, toLantern / max(lanternD, 0.001)), 0.0, 1.0);
  lit += albedoW * uLanternColor * 0.9 * lanternAtt * lanternNdl * uLanternIntensity;

  lit *= uExposure;

  // Aerial perspective — same curve as TerrainMesh.
  vec3 viewRay = normalize(vWorldLitPos - cameraPosition);
  float distW = length(cameraPosition - vWorldLitPos);
  float horizon = pow(clamp(1.0 - abs(viewRay.y), 0.0, 1.0), 1.7);
  float lowAir = 1.0 - smoothstep(520.0, 1500.0, vWorldLitPos.y);
  float densityBoost = 1.0 + horizon * 1.35 + lowAir * 0.45;
  float fogT = 1.0 - exp(-distW * uFogDensity * densityBoost);
  fogT = smoothstep(0.0, 1.0, clamp(fogT, 0.0, 1.0));

  vec3 nearFog = mix(uFogColorLow, uFogColorMid, smoothstep(0.0, 0.45, fogT));
  vec3 fogCol = mix(nearFog, uFogColorFar, smoothstep(0.35, 0.85, fogT));
  float sunScatter = pow(max(dot(viewRay, uSunDir), 0.0), 10.0);
  fogCol += uSunColor * sunScatter * horizon * fogT * (1.0 - smoothstep(0.60, 0.95, fogT)) * 0.12;
  float altT = smoothstep(0.0, uHorizonAlt, vWorldLitPos.y - cameraPosition.y + 800.0);
  fogCol = mix(fogCol, uFogColorFar, altT * 0.15);
  float horizonTakeover = smoothstep(0.85, 1.0, fogT);
  fogCol = mix(fogCol, uFogColorFar, horizonTakeover);
  fogT = mix(fogT, 1.0, horizonTakeover);

  float litLum = dot(lit, vec3(0.299, 0.587, 0.114));
  lit = mix(lit, vec3(litLum), smoothstep(0.0, 0.7, fogT) * 0.45);
  lit = mix(lit, fogCol, fogT);

  outgoingLight = mix(outgoingLight, lit, uWorldLightMix);
`;

/**
 * Patch one material to use the world lighting model. Idempotent per material.
 * `uniforms` must come from createWorldLightingUniforms() and should be shared
 * across every material that is meant to match.
 */
export function applyWorldLighting(material, uniforms) {
  if (!material || material.userData.worldLit) return material;
  material.userData.worldLit = true;

  const prior = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prior) prior(shader, renderer);
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${VERT_DECL}\nvoid main() {`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${FRAG_DECL}\nvoid main() {`)
      // opaque_fragment (r152+) is where outgoingLight becomes final; the old
      // name is kept as a fallback so this survives a three downgrade.
      .replace(
        shader.fragmentShader.includes('#include <opaque_fragment>')
          ? '#include <opaque_fragment>'
          : '#include <output_fragment>',
        `${FRAG_BODY}\n#include <${shader.fragmentShader.includes('#include <opaque_fragment>')
          ? 'opaque_fragment' : 'output_fragment'}>`);
  };
  // three caches compiled programs by a key built from material parameters,
  // and onBeforeCompile edits are NOT part of that key. Without this, a
  // patched material and an unpatched one with otherwise identical settings
  // (the deer and goat are also MeshStandardMaterial) can share a program and
  // one of them silently gets the other's lighting. Give patched materials
  // their own bucket.
  const priorKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `worldLit|${priorKey ? priorKey() : ''}`;

  // Force a reprogram if the material was already compiled.
  material.needsUpdate = true;
  return material;
}

/** Apply to every material under an object. Returns the count patched. */
export function applyWorldLightingToObject(root, uniforms) {
  const seen = new Set();
  let n = 0;
  root.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      applyWorldLighting(m, uniforms);
      n++;
    }
  });
  return n;
}
