import * as THREE from 'three';
import { SPECIES, MAX_SPECIES } from './species.js';

const DEFAULT_SETTINGS = {
  chunkSize: 512,
  activeRadius: 2400,
  unloadRadius: 3000,
  maxGeneratedPerFrame: 2,
  maxImpostorsPerChunk: 192
};

const SPECIES_INDEX = Object.fromEntries(SPECIES.map((s, i) => [s.name, i]));

export function createFoliageMassField({ scene, atlas, field, dem, groundY }) {
  const settings = { ...DEFAULT_SETTINGS };
  const group = new THREE.Group();
  group.name = 'foliage-mass-field';
  group.frustumCulled = false;
  if (scene) scene.add(group);

  const active = new Map();
  const queued = new Set();
  const generationQueue = [];
  const stats = {
    activeChunks: 0,
    visibleChunks: 0,
    activeImpostors: 0,
    visibleImpostors: 0,
    generatedChunks: 0
  };
  let enabled = true;

  const material = makeMaterial(atlas);
  const projScreen = new THREE.Matrix4();
  const frustum = new THREE.Frustum();
  const sphere = new THREE.Sphere();

  function update(time, cameraPosition, camera) {
    material.uniforms.uTime.value = time;
    if (!enabled || !cameraPosition) return;
    updateStreaming(cameraPosition);
    if (camera) {
      projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projScreen);
    }
    stats.visibleChunks = 0;
    stats.visibleImpostors = 0;
    for (const record of active.values()) {
      let visible = true;
      if (camera) {
        sphere.center.copy(record.center);
        sphere.radius = record.radius;
        visible = frustum.intersectsSphere(sphere);
      }
      record.mesh.visible = visible;
      if (visible) {
        stats.visibleChunks++;
        stats.visibleImpostors += record.count;
      }
    }
  }

  async function prewarm(cameraPosition) {
    const desired = desiredChunks(cameraPosition);
    for (let i = 0; i < desired.length; i++) {
      generateDesiredChunk(desired[i]);
      if (i % 4 === 3) await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  function setEnabled(v) {
    enabled = !!v;
    group.visible = enabled;
  }

  function setPalette(palette) {
    if (!palette) return;
    material.uniforms.uPlantHueColor.value.copy(palette.plantHueColor);
    material.uniforms.uPlantHueStrength.value = palette.plantHueStrength;
    material.uniforms.uPlantSaturation.value = palette.plantSaturation;
    material.uniforms.uPlantValueScale.value = palette.foliageValueScale;
    material.uniforms.uMassStrength.value = palette.foliageStrength;
  }

  function reloadChunks() {
    for (const key of [...active.keys()]) removeChunk(key);
    queued.clear();
    generationQueue.length = 0;
  }

  function updateStreaming(cameraPosition) {
    const desired = desiredChunks(cameraPosition);
    const desiredKeys = new Set(desired.map(d => d.key));
    for (const [key, record] of active) {
      if (desiredKeys.has(key)) continue;
      const d = Math.hypot(cameraPosition.x - record.center.x, cameraPosition.z - record.center.z);
      if (d > settings.unloadRadius) removeChunk(key);
    }

    for (const d of desired) {
      if (active.has(d.key) || queued.has(d.key)) continue;
      queued.add(d.key);
      generationQueue.push(d);
    }
    generationQueue.sort((a, b) => a.dist - b.dist);

    let made = 0;
    while (made < settings.maxGeneratedPerFrame && generationQueue.length) {
      const d = generationQueue.shift();
      queued.delete(d.key);
      if (active.has(d.key)) continue;
      if (generateDesiredChunk(d)) made++;
    }
  }

  function desiredChunks(cameraPosition) {
    const out = [];
    const cx0 = Math.floor(cameraPosition.x / settings.chunkSize);
    const cz0 = Math.floor(cameraPosition.z / settings.chunkSize);
    const r = Math.ceil(settings.activeRadius / settings.chunkSize);
    const halfW = dem.worldWidth * 0.5;
    const halfH = dem.worldHeight * 0.5;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = cx0 + dx;
        const cz = cz0 + dz;
        const minX = cx * settings.chunkSize;
        const minZ = cz * settings.chunkSize;
        const maxX = minX + settings.chunkSize;
        const maxZ = minZ + settings.chunkSize;
        if (maxX < -halfW || minX > halfW || maxZ < -halfH || minZ > halfH) continue;
        const centerX = minX + settings.chunkSize * 0.5;
        const centerZ = minZ + settings.chunkSize * 0.5;
        const dist = Math.hypot(cameraPosition.x - centerX, cameraPosition.z - centerZ);
        if (dist <= settings.activeRadius) out.push({ key: `${cx},${cz}`, cx, cz, dist });
      }
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  function generateDesiredChunk(d) {
    const instances = generateChunkInstances(d.cx, d.cz);
    const mesh = makeChunkMesh(instances, material);
    mesh.userData.foliageMassChunk = d.key;
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    group.add(mesh);
    const center = new THREE.Vector3(
      d.cx * settings.chunkSize + settings.chunkSize * 0.5,
      instances.centerY,
      d.cz * settings.chunkSize + settings.chunkSize * 0.5
    );
    active.set(d.key, {
      key: d.key,
      mesh,
      center,
      radius: Math.hypot(settings.chunkSize * 0.72, instances.maxHeight),
      count: instances.count
    });
    stats.generatedChunks++;
    updateStats();
    return true;
  }

  function generateChunkInstances(cx, cz) {
    const max = settings.maxImpostorsPerChunk;
    const positions = new Float32Array(max * 3);
    const scales = new Float32Array(max);
    const rotations = new Float32Array(max);
    const species = new Float32Array(max);
    const type = new Float32Array(max);
    const alpha = new Float32Array(max);
    let count = 0;
    let ySum = 0;
    let maxHeight = 1;
    const grid = 18;
    const cell = settings.chunkSize / grid;
    const minX = cx * settings.chunkSize;
    const minZ = cz * settings.chunkSize;

    for (let j = 0; j < grid && count < max; j++) {
      for (let i = 0; i < grid && count < max; i++) {
        const hx = hash01(cx, cz, i, j, 11);
        const hz = hash01(cx, cz, i, j, 17);
        const x = minX + (i + 0.16 + hx * 0.68) * cell;
        const z = minZ + (j + 0.16 + hz * 0.68) * cell;
        const s = field.sample(x, z);
        const mass = Math.max(s.grass * 0.84, s.woody);
        const accept = Math.min(0.82, mass * 0.95 + s.edge * 0.18);
        if (hash01(cx, cz, i, j, 23) > accept) continue;

        const woodyT = s.woody / Math.max(0.001, s.woody + s.grass * 0.75);
        const isWoody = woodyT > 0.45 && s.woody > 0.16;
        const r = hash01(cx, cz, i, j, 29);
        const y = groundY ? groundY(x, z) : 0;
        positions[count * 3 + 0] = x;
        positions[count * 3 + 1] = y;
        positions[count * 3 + 2] = z;
        rotations[count] = r * Math.PI * 2;
        alpha[count] = Math.min(1, 0.45 + mass * 0.7 + s.edge * 0.25);
        if (isWoody) {
          const tall = hash01(cx, cz, i, j, 31) > 0.68;
          species[count] = tall ? SPECIES_INDEX.velvetmesquite : SPECIES_INDEX.mesquite;
          scales[count] = 2.4 + s.height * 4.6 + hash01(cx, cz, i, j, 37) * 1.2;
          type[count] = 1;
        } else {
          species[count] = SPECIES_INDEX.bunchgrass;
          scales[count] = 0.62 + s.grass * 0.78 + s.edge * 0.32;
          type[count] = 0;
        }
        ySum += y;
        maxHeight = Math.max(maxHeight, scales[count]);
        count++;
      }
    }

    return {
      positions: positions.subarray(0, count * 3),
      scales: scales.subarray(0, count),
      rotations: rotations.subarray(0, count),
      species: species.subarray(0, count),
      type: type.subarray(0, count),
      alpha: alpha.subarray(0, count),
      count,
      centerY: count ? ySum / count + maxHeight * 0.5 : 0,
      maxHeight
    };
  }

  function removeChunk(key) {
    const record = active.get(key);
    if (!record) return;
    group.remove(record.mesh);
    record.mesh.geometry.dispose();
    active.delete(key);
    updateStats();
  }

  function updateStats() {
    stats.activeChunks = active.size;
    stats.activeImpostors = 0;
    for (const record of active.values()) stats.activeImpostors += record.count;
  }

  return { group, update, prewarm, settings, stats, setEnabled, setPalette, reloadChunks };
}

function makeChunkMesh(instances, material) {
  const geometry = makeCrossGeometry();
  geometry.setAttribute('aOffset', new THREE.InstancedBufferAttribute(instances.positions, 3));
  geometry.setAttribute('aScale', new THREE.InstancedBufferAttribute(instances.scales, 1));
  geometry.setAttribute('aRotation', new THREE.InstancedBufferAttribute(instances.rotations, 1));
  geometry.setAttribute('aSpecies', new THREE.InstancedBufferAttribute(instances.species, 1));
  geometry.setAttribute('aMassType', new THREE.InstancedBufferAttribute(instances.type, 1));
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(instances.alpha, 1));
  geometry.instanceCount = instances.count;
  return new THREE.Mesh(geometry, material);
}

function makeCrossGeometry() {
  const g = new THREE.InstancedBufferGeometry();
  const positions = new Float32Array([
    -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0,
    0, 0, -0.5, 0, 0, 0.5, 0, 1, 0.5, 0, 1, -0.5
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]);
  const quad = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1]);
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('aQuad', new THREE.BufferAttribute(quad, 1));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return g;
}

function makeMaterial(atlas) {
  const rects = new Float32Array(MAX_SPECIES * 4);
  const aspects = new Float32Array(MAX_SPECIES);
  SPECIES.forEach((s, idx) => {
    const r = atlas.uvRects[s.atlasIndex];
    rects[idx * 4 + 0] = r.uOffset;
    rects[idx * 4 + 1] = r.vOffset;
    rects[idx * 4 + 2] = r.uScale;
    rects[idx * 4 + 3] = r.vScale;
    aspects[idx] = s.aspect;
  });
  return new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: atlas.texture },
      uRects: { value: rects },
      uAspects: { value: aspects },
      uTime: { value: 0 },
      uPlantHueColor: { value: new THREE.Color('#bfa866') },
      uPlantHueStrength: { value: 0.22 },
      uPlantSaturation: { value: 0.86 },
      uPlantValueScale: { value: 1.0 },
      uMassStrength: { value: 0.0 }
    },
    vertexShader: MASS_VERT,
    fragmentShader: MASS_FRAG,
    transparent: false,
    alphaTest: 0.42,
    side: THREE.DoubleSide
  });
}

function hash01(a, b, c, d, seed) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^
    Math.imul(c | 0, 1442695041) ^ Math.imul(d | 0, 1013904223) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return (h & 0x00ffffff) / 0x01000000;
}

const MASS_VERT = /* glsl */`
  precision highp float;
  attribute vec3 aOffset;
  attribute float aScale;
  attribute float aRotation;
  attribute float aSpecies;
  attribute float aMassType;
  attribute float aAlpha;
  attribute float aQuad;
  uniform vec4 uRects[${MAX_SPECIES}];
  uniform float uAspects[${MAX_SPECIES}];
  uniform float uTime;
  varying vec2 vAtlasUv;
  varying float vAlpha;
  varying float vMassType;
  varying vec3 vWorldPos;

  void main() {
    int sp = int(aSpecies + 0.5);
    vec4 rect = uRects[sp];
    float aspect = uAspects[sp];
    vec3 lp = position;
    float woody = step(0.5, aMassType);
    float grassQuad = 1.0 - step(0.5, aQuad) * (1.0 - woody);
    lp.xz *= grassQuad;
    lp.x *= mix(1.55, aspect, woody);
    lp.y *= mix(0.72, 1.0, woody);
    lp *= aScale;
    float c = cos(aRotation), s = sin(aRotation);
    vec3 rp = vec3(c * lp.x - s * lp.z, lp.y, s * lp.x + c * lp.z);
    float sway = sin(uTime * 0.95 + aOffset.x * 0.035 + aOffset.z * 0.041) * 0.025;
    rp.x += sway * lp.y;
    vec3 worldPos = rp + aOffset;
    vWorldPos = worldPos;
    vMassType = aMassType;
    vAlpha = aAlpha;
    vAtlasUv = vec2(rect.x + uv.x * rect.z, rect.y + uv.y * rect.w);
    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
  }
`;

const MASS_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uAtlas;
  uniform vec3 uPlantHueColor;
  uniform float uPlantHueStrength;
  uniform float uPlantSaturation;
  uniform float uPlantValueScale;
  uniform float uMassStrength;
  varying vec2 vAtlasUv;
  varying float vAlpha;
  varying float vMassType;
  varying vec3 vWorldPos;

  vec3 paletteTint(vec3 color) {
    float lum = max(dot(color, vec3(0.299, 0.587, 0.114)), 0.001);
    vec3 tinted = normalize(max(uPlantHueColor, vec3(0.001))) * lum * 1.72;
    vec3 outCol = mix(color, tinted, clamp(uPlantHueStrength, 0.0, 1.0));
    float outLum = max(dot(outCol, vec3(0.299, 0.587, 0.114)), 0.001);
    outCol *= lum / outLum;
    outCol = mix(vec3(lum), outCol, uPlantSaturation) * uPlantValueScale;
    return outCol;
  }

  void main() {
    if (uMassStrength <= 0.001) discard;
    vec4 tex = texture2D(uAtlas, vAtlasUv);
    if (tex.a * vAlpha * uMassStrength < 0.42) discard;
    vec3 col = paletteTint(tex.rgb);
    float dist = length(cameraPosition - vWorldPos);
    float fadeNear = smoothstep(70.0, 180.0, dist);
    float fadeFar = 1.0 - smoothstep(2200.0, 2600.0, dist);
    if (fadeNear * fadeFar * uMassStrength < 0.35) discard;
    col *= mix(0.88, 0.72, vMassType);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
