import * as THREE from 'three';
import { SPECIES } from './species.js';

/**
 * Three LOD tiers, all world-oriented (no per-frame camera billboarding):
 *   NEAR  (0..120m)    — three Y-axis-rotated quads forming a fan (3-quad rosette)
 *   MID   (120..400m)  — two crossed quads
 *   FAR   (400..2500m) — single quad facing world +Z (not camera)
 *
 * Each tier is a single InstancedMesh sharing one material. The shader picks an
 * atlas tile via the per-instance aSpecies attribute. Distance-based alpha at
 * tier boundaries hides LOD pops.
 */
export function createInstancedPlants({ atlas, instances, dem }) {
  const tiers = [];

  const sharedAttribs = {
    aOffset: new THREE.InstancedBufferAttribute(new Float32Array(instances.positions), 3),
    aScale: new THREE.InstancedBufferAttribute(new Float32Array(instances.scales), 1),
    aRotation: new THREE.InstancedBufferAttribute(new Float32Array(instances.rotations), 1),
    aSpecies: new THREE.InstancedBufferAttribute(new Float32Array(instances.species), 1)
  };

  // Build atlas-rect lookup as a Vec4 array uniform: [uOffset, vOffset, uScale, vScale].
  // Pad to MAX_SPECIES so the shader can use a fixed-size array uniform.
  const MAX_SPECIES = 8;
  const rects = new Float32Array(MAX_SPECIES * 4);
  SPECIES.forEach((s, idx) => {
    const r = atlas.uvRects[s.atlasIndex];
    rects[idx * 4 + 0] = r.uOffset;
    rects[idx * 4 + 1] = r.vOffset;
    rects[idx * 4 + 2] = r.uScale;
    rects[idx * 4 + 3] = r.vScale;
  });

  // Aspect ratio per species (width/height) — used so tall species aren't squashed.
  const aspects = new Float32Array(MAX_SPECIES);
  SPECIES.forEach((s, idx) => { aspects[idx] = s.aspect; });

  const sharedUniforms = {
    uAtlas: { value: atlas.texture },
    uRects: { value: rects },
    uAspects: { value: aspects },
    uSpeciesCount: { value: SPECIES.length },
    uSunDir: { value: new THREE.Vector3(0.5, 0.85, 0.2).normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.96, 0.85) },
    uAmbient: { value: new THREE.Color(0.55, 0.58, 0.66) },
    uTierMin: { value: 0 },
    uTierMax: { value: 0 },
    uFadeIn: { value: 12 },
    uFadeOut: { value: 30 },
    uFogNear: { value: 600.0 },
    uFogMid: { value: 4000.0 },
    uFogFar: { value: 18000.0 },
    uFogColorNear: { value: new THREE.Color(0.85, 0.82, 0.75) },
    uFogColorFar: { value: new THREE.Color(0.70, 0.78, 0.86) },
    uTime: { value: 0 }
  };

  // ---------------- NEAR tier: 3-quad rosette (Y-billboard family) ----------------
  {
    const geo = makeRosetteGeometry(3);
    attachInstancedAttribs(geo, sharedAttribs);
    const uniforms = THREE.UniformsUtils.clone(sharedUniforms);
    uniforms.uAtlas = sharedUniforms.uAtlas; // share texture object
    uniforms.uTierMin.value = 0;
    uniforms.uTierMax.value = 140;
    uniforms.uFadeIn.value = 0;
    uniforms.uFadeOut.value = 25;
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: false,
      alphaTest: 0.5,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    tiers.push({ mesh, material: mat, uniforms });
  }

  // ---------------- MID tier: crossed quads (two world-oriented planes at 90°)
  {
    const geo = makeCrossGeometry();
    attachInstancedAttribs(geo, sharedAttribs);
    const uniforms = THREE.UniformsUtils.clone(sharedUniforms);
    uniforms.uAtlas = sharedUniforms.uAtlas;
    uniforms.uTierMin.value = 110;
    uniforms.uTierMax.value = 420;
    uniforms.uFadeIn.value = 25;
    uniforms.uFadeOut.value = 60;
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: false,
      alphaTest: 0.5,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    tiers.push({ mesh, material: mat, uniforms });
  }

  // ---------------- FAR tier: single world-oriented quad
  {
    const geo = makeQuadGeometry();
    attachInstancedAttribs(geo, sharedAttribs);
    const uniforms = THREE.UniformsUtils.clone(sharedUniforms);
    uniforms.uAtlas = sharedUniforms.uAtlas;
    uniforms.uTierMin.value = 380;
    uniforms.uTierMax.value = 2800;
    uniforms.uFadeIn.value = 60;
    uniforms.uFadeOut.value = 200;
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: false,
      alphaTest: 0.5,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    tiers.push({ mesh, material: mat, uniforms });
  }

  // Set instance count on each tier (driven by shader-side discard).
  const N = instances.count;
  for (const t of tiers) {
    t.mesh.geometry.instanceCount = N;
  }

  function update(time, cameraPos) {
    for (const t of tiers) {
      t.uniforms.uTime.value = time;
    }
  }

  return { tiers, update, count: N };
}

function attachInstancedAttribs(geo, attribs) {
  for (const [name, attr] of Object.entries(attribs)) {
    geo.setAttribute(name, attr);
  }
}

/**
 * Quad in local space: width 1 (centered on x=0), height 1 (y in [0..1]).
 * The shader scales by per-instance scale and sets aspect via species table.
 */
function makeQuadGeometry() {
  const g = new THREE.InstancedBufferGeometry();
  const positions = new Float32Array([
    -0.5, 0, 0,
     0.5, 0, 0,
     0.5, 1, 0,
    -0.5, 1, 0
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const idx = [0, 1, 2, 0, 2, 3];
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

function makeCrossGeometry() {
  const g = new THREE.InstancedBufferGeometry();
  // Two quads, second rotated 90° about Y.
  const c = Math.cos(Math.PI / 2), s = Math.sin(Math.PI / 2);
  const positions = new Float32Array([
    -0.5, 0, 0,
     0.5, 0, 0,
     0.5, 1, 0,
    -0.5, 1, 0,
    // second quad (rotated 90° around Y)
     0, 0, -0.5,
     0, 0,  0.5,
     0, 1,  0.5,
     0, 1, -0.5
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]);
  const idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

function makeRosetteGeometry(quads) {
  const positions = [];
  const uvs = [];
  const idx = [];
  for (let q = 0; q < quads; q++) {
    const a = (q / quads) * Math.PI; // span 180° → 60° between quads for 3 quads
    const c = Math.cos(a), s = Math.sin(a);
    const base = positions.length / 3;
    positions.push(-0.5 * c, 0,  -0.5 * s);
    positions.push( 0.5 * c, 0,   0.5 * s);
    positions.push( 0.5 * c, 1,   0.5 * s);
    positions.push(-0.5 * c, 1,  -0.5 * s);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(idx);
  return g;
}

const VERT = /* glsl */`
  precision highp float;
  attribute vec3 aOffset;
  attribute float aScale;
  attribute float aRotation;
  attribute float aSpecies;
  uniform vec4 uRects[8];
  uniform float uAspects[8];
  uniform float uTierMin;
  uniform float uTierMax;
  uniform float uFadeIn;
  uniform float uFadeOut;
  uniform float uTime;
  varying vec2 vAtlasUv;
  varying float vFade;
  varying vec3 vWorldPos;
  varying vec3 vNormal;

  void main() {
    int sp = int(aSpecies + 0.5);
    vec4 rect = uRects[sp];
    float aspect = uAspects[sp];

    // Local quad in [-0.5..0.5] x [0..1]; species aspect widens.
    vec3 lp = position;
    lp.x *= aspect;
    lp *= aScale;

    // Y rotation per instance (world-oriented; not camera-facing).
    float c = cos(aRotation), s = sin(aRotation);
    vec3 rp = vec3(c * lp.x - s * lp.z, lp.y, s * lp.x + c * lp.z);

    // Subtle wind sway (only top of plant moves).
    float sway = sin(uTime * 1.2 + aOffset.x * 0.05 + aOffset.z * 0.04) * 0.04;
    rp.x += sway * lp.y * 0.4;

    vec3 worldPos = rp + aOffset;
    vWorldPos = worldPos;
    vNormal = normalize(vec3(s, 0.0, c));

    // Distance to camera, used for tier visibility.
    float dist = length(cameraPosition - aOffset);

    // Fade: discard outside [uTierMin - uFadeIn .. uTierMax + uFadeOut].
    float fadeIn  = smoothstep(uTierMin - uFadeIn, uTierMin + uFadeIn, dist);
    float fadeOut = 1.0 - smoothstep(uTierMax - uFadeOut, uTierMax + uFadeOut, dist);
    vFade = fadeIn * fadeOut;
    if (vFade <= 0.001) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off-screen
      vAtlasUv = vec2(0.0);
      return;
    }

    vAtlasUv = vec2(rect.x + uv.x * rect.z, rect.y + uv.y * rect.w);
    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uAtlas;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform float uFogNear, uFogMid, uFogFar;
  uniform vec3 uFogColorNear, uFogColorFar;
  varying vec2 vAtlasUv;
  varying float vFade;
  varying vec3 vWorldPos;
  varying vec3 vNormal;

  void main() {
    vec4 tex = texture2D(uAtlas, vAtlasUv);
    if (tex.a < 0.5) discard;
    if (vFade < 0.5) discard; // alpha-test fade approximation

    // Approximate top-lit foliage shading.
    float ndl = clamp(dot(vNormal, uSunDir), 0.0, 1.0);
    float topLight = clamp(uSunDir.y, 0.0, 1.0);
    vec3 lit = tex.rgb * (uSunColor * (0.4 + 0.6 * topLight) + uAmbient * 0.7);

    // Aerial perspective (matches terrain).
    float dist = length(cameraPosition - vWorldPos);
    float fNear = smoothstep(uFogNear, uFogMid, dist);
    float fFar  = smoothstep(uFogMid, uFogFar, dist);
    vec3 fogCol = mix(uFogColorNear, uFogColorFar, fFar);
    lit = mix(lit, fogCol, fNear * 0.4 + fFar * 0.6);

    gl_FragColor = vec4(lit, 1.0);
  }
`;
