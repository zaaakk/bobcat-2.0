import * as THREE from 'three';
import { SPECIES } from './species.js';
import { generateVegetationChunk } from './PlacementEngine.js';

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
export function createInstancedPlants({ atlas, instances = null, dem, groundY = null, shadows = null }) {
  const tiers = [];
  const chunkSize = 512;
  const streaming = !instances;
  const activeChunks = new Map();
  const queued = new Map();
  const generationQueue = [];
  const streamCfg = {
    denseRadius: 3200,
    farRadius: 6500,
    unloadRadius: 7200,
    maxGeneratePerFrame: 3,
    dense: { cellSize: 4.0, globalDensity: 2.2, maxPerChunk: 14000 },
    far: { cellSize: 14.0, globalDensity: 1.45, maxPerChunk: 4200 }
  };

  // Build atlas-rect lookup as a Vec4 array uniform: [uOffset, vOffset, uScale, vScale].
  // Pad to MAX_SPECIES so the shader can use a fixed-size array uniform.
  const MAX_SPECIES = 12;
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
    uFogDensity:   { value: 0.00017 },
    uFogColorLow:  { value: new THREE.Color('#c9d1d8') },
    uFogColorMid:  { value: new THREE.Color('#96abc1') },
    uFogColorFar:  { value: new THREE.Color('#668db8') },
    uExposure:     { value: 1.18 },
    uLanternPos:   { value: new THREE.Vector3() },
    uLanternColor: { value: new THREE.Color('#b8d2ff') },  // cool moonlight
    uLanternRange: { value: 22.0 },
    uLanternIntensity: { value: 0.0 },
    uTime: { value: 0 }
  };

  const tierConfigs = [
    {
      geometry: () => makeRosetteGeometry(3),
      tierMin: 0,
      tierMax: 140,
      fadeIn: 0,
      fadeOut: 25,
    },
    {
      geometry: makeCrossGeometry,
      tierMin: 110,
      tierMax: 420,
      fadeIn: 25,
      fadeOut: 60,
    },
    {
      geometry: makeQuadGeometry,
      tierMin: 380,
      tierMax: 6500,
      fadeIn: 60,
      fadeOut: 500,
    }
  ];

  // ---------------- NEAR tier: 3-quad rosette (Y-billboard family) ----------------
  for (const cfg of tierConfigs) {
    const uniforms = THREE.UniformsUtils.clone(sharedUniforms);
    uniforms.uAtlas = sharedUniforms.uAtlas; // share texture object
    uniforms.uTierMin.value = cfg.tierMin;
    uniforms.uTierMax.value = cfg.tierMax;
    uniforms.uFadeIn.value = cfg.fadeIn;
    uniforms.uFadeOut.value = cfg.fadeOut;
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: false,
      alphaTest: 0.5,
      side: THREE.DoubleSide
    });

    const group = new THREE.Group();
    group.frustumCulled = false;
    tiers.push({ mesh: group, material: mat, uniforms, meshes: new Map(), config: cfg });
  }

  if (instances) {
    for (const chunk of buildPlantChunks(instances, chunkSize)) {
      addChunkInstances(chunk.key, chunk.instances, 'dense');
    }
  }

  const projScreen = new THREE.Matrix4();
  const frustum = new THREE.Frustum();
  const sphere = new THREE.Sphere();

  function update(time, cameraPos, camera) {
    if (streaming) updateStreaming(cameraPos);
    if (camera) {
      projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projScreen);
    }
    for (const t of tiers) {
      t.uniforms.uTime.value = time;
      const minD = Math.max(0, t.config.tierMin - t.config.fadeIn);
      const maxD = t.config.tierMax + t.config.fadeOut;
      let visibleCount = 0;
      for (const mesh of t.meshes.values()) {
        const chunk = mesh.userData.plantChunk;
        const dx = cameraPos.x - chunk.center.x;
        const dz = cameraPos.z - chunk.center.z;
        const distXZ = Math.hypot(dx, dz);
        let visible = distXZ + chunk.radiusXZ >= minD && distXZ - chunk.radiusXZ <= maxD;
        if (visible && camera) {
          sphere.center.copy(chunk.center);
          sphere.radius = chunk.radius;
          visible = frustum.intersectsSphere(sphere);
        }
        mesh.visible = visible;
        if (visible) visibleCount++;
      }
      t.visibleChunks = visibleCount;
    }
  }

  function updateStreaming(cameraPos) {
    const desired = desiredChunks(cameraPos);
    const desiredKeys = new Set(desired.map(d => d.key));

    for (const [key, record] of activeChunks) {
      if (desiredKeys.has(key)) continue;
      const dx = cameraPos.x - record.center.x;
      const dz = cameraPos.z - record.center.z;
      if (Math.hypot(dx, dz) > streamCfg.unloadRadius) removeChunk(key);
    }

    for (const d of desired) {
      const existing = activeChunks.get(d.key);
      if (existing) {
        if (existing.mode === d.mode) continue;
        if (existing.mode === 'dense' && d.mode === 'far' && d.dist < streamCfg.denseRadius + chunkSize) continue;
      }
      if (queued.has(d.key) && queued.get(d.key) === d.mode) continue;
      queued.set(d.key, d.mode);
      generationQueue.push(d);
    }

    generationQueue.sort((a, b) => a.dist - b.dist);
    let made = 0;
    while (made < streamCfg.maxGeneratePerFrame && generationQueue.length) {
      const d = generationQueue.shift();
      if (queued.get(d.key) !== d.mode) continue;
      queued.delete(d.key);
      if (generateDesiredChunk(d)) made++;
    }
  }

  function generateDesiredChunk(d) {
    const existing = activeChunks.get(d.key);
    if (existing && (existing.mode === 'dense' || existing.mode === d.mode)) return false;
    const cfg = streamCfg[d.mode];
    const chunkInstances = generateVegetationChunk({
      dem,
      groundY,
      chunkX: d.cx,
      chunkZ: d.cz,
      chunkSize,
      cellSize: cfg.cellSize,
      globalDensity: cfg.globalDensity,
      maxPerChunk: cfg.maxPerChunk
    });
    addChunkInstances(d.key, chunkInstances, d.mode);
    return true;
  }

  async function prewarm(cameraPos, onProgress = () => {}) {
    if (!streaming) return;
    const desired = desiredChunks(cameraPos);
    let done = 0;
    const total = desired.length || 1;
    for (const d of desired) {
      queued.delete(d.key);
      generateDesiredChunk(d);
      done++;
      if (done % 4 === 0) {
        onProgress(done / total);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    onProgress(1);
  }

  function desiredChunks(cameraPos) {
    const out = [];
    const cx0 = Math.floor(cameraPos.x / chunkSize);
    const cz0 = Math.floor(cameraPos.z / chunkSize);
    const rChunks = Math.ceil(streamCfg.farRadius / chunkSize);
    const halfW = dem.worldWidth * 0.5;
    const halfH = dem.worldHeight * 0.5;
    for (let dz = -rChunks; dz <= rChunks; dz++) {
      for (let dx = -rChunks; dx <= rChunks; dx++) {
        const cx = cx0 + dx;
        const cz = cz0 + dz;
        const minX = cx * chunkSize;
        const minZ = cz * chunkSize;
        const maxX = minX + chunkSize;
        const maxZ = minZ + chunkSize;
        if (maxX < -halfW || minX > halfW || maxZ < -halfH || minZ > halfH) continue;
        const centerX = minX + chunkSize * 0.5;
        const centerZ = minZ + chunkSize * 0.5;
        const dist = Math.hypot(cameraPos.x - centerX, cameraPos.z - centerZ);
        if (dist > streamCfg.farRadius) continue;
        out.push({
          key: `${cx},${cz}`,
          cx,
          cz,
          dist,
          mode: dist <= streamCfg.denseRadius ? 'dense' : 'far'
        });
      }
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  function addChunkInstances(key, chunkInstances, mode) {
    removeChunk(key);
    const chunk = makeChunkFromInstances(key, chunkInstances, chunkSize);
    const record = {
      key,
      mode,
      count: chunk.count,
      center: chunk.center,
      meshes: []
    };
    activeChunks.set(key, record);
    if (chunk.count <= 0) return;

    const tierIndices = mode === 'far' ? [2] : [0, 1, 2];
    for (const tierIndex of tierIndices) {
      const t = tiers[tierIndex];
      const geo = t.config.geometry();
      attachInstancedAttribs(geo, chunk.attribs);
      geo.instanceCount = chunk.count;
      const mesh = new THREE.Mesh(geo, t.material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      mesh.userData.plantChunk = chunk;
      t.mesh.add(mesh);
      t.meshes.set(key, mesh);
      record.meshes.push({ tierIndex, mesh });
    }
    if (shadows && mode === 'dense') shadows.addPlantChunk(key, chunkInstances, mode);
  }

  function removeChunk(key) {
    const record = activeChunks.get(key);
    if (!record) return;
    for (const { tierIndex, mesh } of record.meshes) {
      const t = tiers[tierIndex];
      t.mesh.remove(mesh);
      t.meshes.delete(key);
      mesh.geometry.dispose();
    }
    if (shadows) shadows.removePlantChunk(key);
    activeChunks.delete(key);
  }

  return {
    tiers,
    update,
    get count() {
      let n = 0;
      for (const c of activeChunks.values()) n += c.count;
      return n;
    },
    get chunkCount() { return activeChunks.size; },
    streamCfg,
    prewarm
  };
}

function buildPlantChunks(instances, chunkSize) {
  const meta = new Map();
  const N = instances.count;
  for (let i = 0; i < N; i++) {
    const x = instances.positions[i * 3 + 0];
    const y = instances.positions[i * 3 + 1];
    const z = instances.positions[i * 3 + 2];
    const scale = instances.scales[i];
    const cx = Math.floor(x / chunkSize);
    const cz = Math.floor(z / chunkSize);
    const key = `${cx},${cz}`;
    let chunk = meta.get(key);
    if (!chunk) {
      chunk = {
        key, cx, cz, count: 0,
        minX: Infinity, maxX: -Infinity,
        minY: Infinity, maxY: -Infinity,
        minZ: Infinity, maxZ: -Infinity,
      };
      meta.set(key, chunk);
    }
    chunk.count++;
    chunk.minX = Math.min(chunk.minX, x);
    chunk.maxX = Math.max(chunk.maxX, x);
    chunk.minY = Math.min(chunk.minY, y);
    chunk.maxY = Math.max(chunk.maxY, y + scale);
    chunk.minZ = Math.min(chunk.minZ, z);
    chunk.maxZ = Math.max(chunk.maxZ, z);
  }

  const chunks = [...meta.values()];
  for (const chunk of chunks) {
    chunk.positions = new Float32Array(chunk.count * 3);
    chunk.scales = new Float32Array(chunk.count);
    chunk.rotations = new Float32Array(chunk.count);
    chunk.species = new Float32Array(chunk.count);
    chunk.write = 0;
  }

  for (let i = 0; i < N; i++) {
    const x = instances.positions[i * 3 + 0];
    const z = instances.positions[i * 3 + 2];
    const cx = Math.floor(x / chunkSize);
    const cz = Math.floor(z / chunkSize);
    const chunk = meta.get(`${cx},${cz}`);
    const j = chunk.write++;
    chunk.positions[j * 3 + 0] = x;
    chunk.positions[j * 3 + 1] = instances.positions[i * 3 + 1];
    chunk.positions[j * 3 + 2] = z;
    chunk.scales[j] = instances.scales[i];
    chunk.rotations[j] = instances.rotations[i];
    chunk.species[j] = instances.species[i];
  }

  for (const chunk of chunks) {
    chunk.center = new THREE.Vector3(
      (chunk.minX + chunk.maxX) * 0.5,
      (chunk.minY + chunk.maxY) * 0.5,
      (chunk.minZ + chunk.maxZ) * 0.5
    );
    const hx = (chunk.maxX - chunk.minX) * 0.5;
    const hy = (chunk.maxY - chunk.minY) * 0.5;
    const hz = (chunk.maxZ - chunk.minZ) * 0.5;
    chunk.radiusXZ = Math.hypot(hx, hz);
    chunk.radius = Math.hypot(chunk.radiusXZ, hy);
    chunk.instances = {
      key: chunk.key,
      chunkX: chunk.cx,
      chunkZ: chunk.cz,
      positions: chunk.positions,
      scales: chunk.scales,
      rotations: chunk.rotations,
      species: chunk.species,
      count: chunk.count
    };
    delete chunk.write;
  }

  return chunks;
}

function makeChunkFromInstances(key, instances, chunkSize) {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < instances.count; i++) {
    const x = instances.positions[i * 3 + 0];
    const y = instances.positions[i * 3 + 1];
    const z = instances.positions[i * 3 + 2];
    const scale = instances.scales[i];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y + scale);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  if (instances.count === 0) {
    const [cx, cz] = key.split(',').map(Number);
    minX = cx * chunkSize;
    maxX = minX + chunkSize;
    minZ = cz * chunkSize;
    maxZ = minZ + chunkSize;
    minY = maxY = 0;
  }
  const center = new THREE.Vector3(
    (minX + maxX) * 0.5,
    (minY + maxY) * 0.5,
    (minZ + maxZ) * 0.5
  );
  const hx = (maxX - minX) * 0.5;
  const hy = (maxY - minY) * 0.5;
  const hz = (maxZ - minZ) * 0.5;
  return {
    key,
    count: instances.count,
    center,
    radiusXZ: Math.hypot(hx, hz),
    radius: Math.hypot(Math.hypot(hx, hz), hy),
    attribs: {
      aOffset: new THREE.InstancedBufferAttribute(instances.positions, 3),
      aScale: new THREE.InstancedBufferAttribute(instances.scales, 1),
      aRotation: new THREE.InstancedBufferAttribute(instances.rotations, 1),
      aSpecies: new THREE.InstancedBufferAttribute(new Float32Array(instances.species), 1)
    }
  };
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
  uniform vec4 uRects[12];
  uniform float uAspects[12];
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
  uniform float uFogDensity;
  uniform vec3 uFogColorLow, uFogColorMid, uFogColorFar;
  uniform float uExposure;
  uniform vec3 uLanternPos;
  uniform vec3 uLanternColor;
  uniform float uLanternRange;
  uniform float uLanternIntensity;
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
    vec3 lit = tex.rgb * (uSunColor * (0.55 + 0.55 * topLight) + uAmbient * 0.95);

    // Lantern pool — adds warm light to plants near the bobcat.
    vec3 toLantern = uLanternPos - vWorldPos;
    float lanternD = length(toLantern);
    float lanternAtt = clamp(1.0 - lanternD / uLanternRange, 0.0, 1.0);
    lanternAtt *= lanternAtt;
    lit += tex.rgb * uLanternColor * 0.9 * lanternAtt * uLanternIntensity;

    lit *= uExposure;

    // Aerial perspective — same monotonic far-colour takeover as terrain.
    vec3 viewRay = normalize(vWorldPos - cameraPosition);
    float dist = length(cameraPosition - vWorldPos);
    float horizon = pow(clamp(1.0 - abs(viewRay.y), 0.0, 1.0), 1.7);
    float lowAir = 1.0 - smoothstep(520.0, 1500.0, vWorldPos.y);
    float densityBoost = 1.0 + horizon * 1.35 + lowAir * 0.45;
    float fog = 1.0 - exp(-dist * uFogDensity * densityBoost);
    fog = smoothstep(0.0, 1.0, clamp(fog, 0.0, 1.0));
    vec3 nearFog = mix(uFogColorLow, uFogColorMid, smoothstep(0.0, 0.45, fog));
    vec3 fogCol = mix(nearFog, uFogColorFar, smoothstep(0.35, 0.85, fog));
    float sunScatter = pow(max(dot(viewRay, uSunDir), 0.0), 10.0);
    fogCol += uSunColor * sunScatter * horizon * fog * (1.0 - smoothstep(0.60, 0.95, fog)) * 0.12;
    float horizonTakeover = smoothstep(0.85, 1.0, fog);
    fogCol = mix(fogCol, uFogColorFar, horizonTakeover);
    fog = mix(fog, 1.0, horizonTakeover);
    lit = mix(lit, fogCol, fog);

    gl_FragColor = vec4(lit, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
