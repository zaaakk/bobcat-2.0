import * as THREE from 'three';

import { SPECIES } from '../vegetation/species.js';

const SHADOW_CFG = {
  cat: {
    length: 0.40,
    width: 0.25,
    opacity: 0.76,
    yOffset: 0.09
  },
  plants: {
    chunkSize: 512,
    maxDistance: 3200,
    yOffset: 0.09,
    minHeight: 0.85,
    opacity: 0.74,
    speciesIds: new Set([0, 1, 2, 3, 5, 6, 8])
  }
};

export function createGroundShadows({ scene, instances, groundY }) {
  const settings = {
    catOpacity: SHADOW_CFG.cat.opacity,
    catOffset: SHADOW_CFG.cat.yOffset,
    catWidth: SHADOW_CFG.cat.width,
    catLength: SHADOW_CFG.cat.length,
    plantOpacity: SHADOW_CFG.plants.opacity,
    plantOffset: SHADOW_CFG.plants.yOffset,
    plantScale: 1.0,
    plantMaxDistance: SHADOW_CFG.plants.maxDistance
  };
  const cat = createCatShadow(settings);
  const plants = createPlantShadows(instances, settings, groundY);
  scene.add(cat.mesh);
  if (plants.group) scene.add(plants.group);

  let enabled = true;
  let catEnabled = true;
  let plantEnabled = true;

  function applyVisibility() {
    cat.mesh.visible = enabled && catEnabled;
    if (plants.group) plants.group.visible = enabled && plantEnabled;
  }

  function setEnabled(v) {
    enabled = !!v;
    applyVisibility();
  }

  function setCatEnabled(v) {
    catEnabled = !!v;
    applyVisibility();
  }

  function setPlantEnabled(v) {
    plantEnabled = !!v;
    applyVisibility();
  }

  function updateCat(bobcat, envState) {
    if (!enabled || !catEnabled) return;
    if (bobcat.airborne) {
      cat.mesh.visible = false;
      return;
    }
    cat.mesh.visible = true;
    cat.update(bobcat, envState);
  }

  function updatePlants(cameraPosition, camera, envState) {
    if (!enabled || !plantEnabled) return;
    plants.update(cameraPosition, camera, envState);
  }

  applyVisibility();

  return {
    updateCat,
    updatePlants,
    addPlantChunk: plants.addChunk,
    removePlantChunk: plants.removeChunk,
    setEnabled,
    setCatEnabled,
    setPlantEnabled,
    get enabled() { return enabled; },
    get catEnabled() { return catEnabled; },
    get plantEnabled() { return plantEnabled; },
    get visiblePlantChunks() { return plants.visibleChunks || 0; },
    get visiblePlantInstances() { return plants.visibleInstances || 0; },
    settings,
    get count() { return plants.count || 0; }
  };
}

function createCatShadow(settings) {
  const geometry = makeShadowQuadGeometry(false);
  const uniforms = makeShadowUniforms({
    uOpacity: { value: settings.catOpacity }
  });
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -12,
    vertexShader: SHADOW_VERT,
    fragmentShader: SHADOW_FRAG
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;

  function update(bobcat, envState) {
    mesh.position.set(
      bobcat.position.x,
      bobcat.position.y + settings.catOffset,
      bobcat.position.z
    );
    mesh.quaternion.copy(bobcat.pivot.quaternion);
    mesh.scale.set(settings.catWidth, 1, settings.catLength);
    uniforms.uOpacity.value = settings.catOpacity * shadowDayStrength(envState);
    pushFogUniforms(uniforms, envState);
  }

  return { mesh, update };
}

function createPlantShadows(instances, settings, groundY) {
  const uniforms = makeShadowUniforms({
    uOpacity: { value: settings.plantOpacity },
    uYOffset: { value: settings.plantOffset },
    uScale: { value: settings.plantScale }
  });
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -12,
    vertexShader: PLANT_SHADOW_VERT,
    fragmentShader: SHADOW_FRAG
  });
  const group = new THREE.Group();
  group.frustumCulled = false;
  const meshes = new Map();
  let totalCount = 0;

  function addChunk(key, chunkInstances) {
    removeChunk(key);
    const chunks = buildPlantShadowChunks(chunkInstances, SHADOW_CFG.plants.chunkSize, groundY);
    let added = 0;
    for (const chunk of chunks) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(chunk.uvs, 2));
    geometry.setAttribute('aCenter', new THREE.BufferAttribute(chunk.centers, 3));
    geometry.setIndex(new THREE.BufferAttribute(chunk.indices, 1));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    mesh.userData.shadowChunk = chunk;
    group.add(mesh);
      meshes.set(`${key}:${chunk.key || added}`, mesh);
      added += chunk.count;
    }
    totalCount += added;
  }

  function removeChunk(key) {
    for (const [meshKey, mesh] of meshes) {
      if (!meshKey.startsWith(`${key}:`)) continue;
      totalCount -= mesh.userData.shadowChunk.count;
      group.remove(mesh);
      mesh.geometry.dispose();
      meshes.delete(meshKey);
    }
  }

  const projScreen = new THREE.Matrix4();
  const frustum = new THREE.Frustum();
  const sphere = new THREE.Sphere();

  function update(cameraPosition, camera, envState) {
    uniforms.uOpacity.value = settings.plantOpacity * shadowDayStrength(envState);
    uniforms.uYOffset.value = settings.plantOffset;
    uniforms.uScale.value = settings.plantScale;
    pushFogUniforms(uniforms, envState);
    if (camera) {
      projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projScreen);
    }
    let visibleChunks = 0;
    let visibleInstances = 0;
    for (const mesh of meshes.values()) {
      const chunk = mesh.userData.shadowChunk;
      const dx = cameraPosition.x - chunk.center.x;
      const dz = cameraPosition.z - chunk.center.z;
      let visible = Math.hypot(dx, dz) - chunk.radiusXZ <= settings.plantMaxDistance;
      if (visible && camera) {
        sphere.center.copy(chunk.center);
        sphere.radius = chunk.radius;
        visible = frustum.intersectsSphere(sphere);
      }
      mesh.visible = visible;
      if (visible) {
        visibleChunks++;
        visibleInstances += chunk.count;
      }
    }
    api.visibleChunks = visibleChunks;
    api.visibleInstances = visibleInstances;
  }

  const api = {
    group,
    update,
    addChunk,
    removeChunk,
    get count() { return totalCount; },
    visibleChunks: 0,
    visibleInstances: 0
  };
  if (instances) addChunk('static', instances);
  return api;
}

function buildPlantShadowChunks(instances, chunkSize, groundY) {
  const meta = new Map();
  for (let i = 0; i < instances.count; i++) {
    const speciesId = instances.species[i];
    const scale = instances.scales[i];
    if (!SHADOW_CFG.plants.speciesIds.has(speciesId) || scale < SHADOW_CFG.plants.minHeight) continue;

    const x = instances.positions[i * 3 + 0];
    const y = instances.positions[i * 3 + 1];
    const z = instances.positions[i * 3 + 2];
    const cx = Math.floor(x / chunkSize);
    const cz = Math.floor(z / chunkSize);
    const key = `${cx},${cz}`;
    let chunk = meta.get(key);
    if (!chunk) {
      chunk = {
        key,
        count: 0,
        items: [],
        minX: Infinity, maxX: -Infinity,
        minY: Infinity, maxY: -Infinity,
        minZ: Infinity, maxZ: -Infinity
      };
      meta.set(key, chunk);
    }
    const sp = SPECIES[speciesId];
    const radiusX = Math.max(0.46, scale * sp.aspect * 0.42);
    const radiusZ = Math.max(0.38, scale * 0.32);
    const rot = instances.rotations[i] + 0.35;
    chunk.items.push({ x, y, z, radiusX, radiusZ, rot });
    chunk.count++;
    chunk.minX = Math.min(chunk.minX, x - radiusX);
    chunk.maxX = Math.max(chunk.maxX, x + radiusX);
    chunk.minY = Math.min(chunk.minY, y);
    chunk.maxY = Math.max(chunk.maxY, y + 0.1);
    chunk.minZ = Math.min(chunk.minZ, z - radiusZ);
    chunk.maxZ = Math.max(chunk.maxZ, z + radiusZ);
  }

  const chunks = [];
  for (const chunk of meta.values()) {
    const grid = buildChunkGridGeometry(chunk.items, groundY);
    chunk.positions = grid.positions;
    chunk.centers = grid.centers;
    chunk.uvs = grid.uvs;
    chunk.indices = grid.indices;
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
    delete chunk.items;
    chunks.push(chunk);
  }
  return chunks;
}

function buildChunkGridGeometry(items, groundY) {
  const gridN = 3;
  const vertsPerShadow = gridN * gridN;
  const cellsPerAxis = gridN - 1;
  const indicesPerShadow = cellsPerAxis * cellsPerAxis * 6;
  const positions = new Float32Array(items.length * vertsPerShadow * 3);
  const centers = new Float32Array(items.length * vertsPerShadow * 3);
  const uvs = new Float32Array(items.length * vertsPerShadow * 2);
  const indices = new Uint32Array(items.length * indicesPerShadow);
  let vWrite = 0;
  let uvWrite = 0;
  let iWrite = 0;
  const sampleY = groundY || ((x, z, fallback) => fallback);

  for (const item of items) {
    const baseVertex = vWrite / 3;
    const c = Math.cos(item.rot);
    const s = Math.sin(item.rot);
    for (let gz = 0; gz < gridN; gz++) {
      const vz = gz / (gridN - 1);
      const localZ = (vz * 2.0 - 1.0) * item.radiusZ;
      for (let gx = 0; gx < gridN; gx++) {
        const vx = gx / (gridN - 1);
        const localX = (vx * 2.0 - 1.0) * item.radiusX;
        const wx = item.x + c * localX - s * localZ;
        const wz = item.z + s * localX + c * localZ;
        const wy = sampleY(wx, wz, item.y);
        positions[vWrite + 0] = wx;
        positions[vWrite + 1] = wy;
        positions[vWrite + 2] = wz;
        centers[vWrite + 0] = item.x;
        centers[vWrite + 1] = item.y;
        centers[vWrite + 2] = item.z;
        vWrite += 3;
        uvs[uvWrite + 0] = vx;
        uvs[uvWrite + 1] = vz;
        uvWrite += 2;
      }
    }

    for (let gz = 0; gz < cellsPerAxis; gz++) {
      for (let gx = 0; gx < cellsPerAxis; gx++) {
        const i0 = baseVertex + gz * gridN + gx;
        const i1 = i0 + 1;
        const i2 = i0 + gridN;
        const i3 = i2 + 1;
        indices[iWrite++] = i0;
        indices[iWrite++] = i3;
        indices[iWrite++] = i1;
        indices[iWrite++] = i0;
        indices[iWrite++] = i2;
        indices[iWrite++] = i3;
      }
    }
  }

  return { positions, centers, uvs, indices };
}

function makeShadowQuadGeometry(instanced) {
  const geometry = instanced ? new THREE.InstancedBufferGeometry() : new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -1, 0, -1,
     1, 0, -1,
     1, 0,  1,
    -1, 0,  1
  ]), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 1
  ]), 2));
  geometry.setIndex([0, 2, 1, 0, 3, 2]);
  return geometry;
}

function shadowDayStrength(envState) {
  if (!envState) return 1;
  return THREE.MathUtils.clamp((envState.directT ?? 1) * 1.2 + (envState.twilightT ?? 0) * 0.25, 0, 1);
}

const SHADOW_VERT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const PLANT_SHADOW_VERT = /* glsl */`
  attribute vec3 aCenter;
  uniform float uYOffset;
  uniform float uScale;
  varying vec2 vUv;
  varying vec3 vWorldPos;

  void main() {
    vec3 p = position;
    p.xz = aCenter.xz + (p.xz - aCenter.xz) * uScale;
    p.y += uYOffset;
    vUv = uv;
    vWorldPos = p;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const SHADOW_FRAG = /* glsl */`
  precision mediump float;
  uniform float uOpacity;
  uniform float uFogDensity;
  uniform vec3 uFogColorFar;
  varying vec2 vUv;
  varying vec3 vWorldPos;

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r2 = dot(p, p);
    vec3 viewRay = normalize(vWorldPos - cameraPosition);
    float dist = length(cameraPosition - vWorldPos);
    float horizon = pow(clamp(1.0 - abs(viewRay.y), 0.0, 1.0), 1.7);
    float lowAir = 1.0 - smoothstep(520.0, 1500.0, vWorldPos.y);
    float densityBoost = 1.0 + horizon * 1.35 + lowAir * 0.45;
    float fog = 1.0 - exp(-dist * uFogDensity * densityBoost);
    fog = smoothstep(0.0, 1.0, clamp(fog, 0.0, 1.0));
    float horizonTakeover = smoothstep(0.85, 1.0, fog);
    fog = mix(fog, 1.0, horizonTakeover);
    float alpha = (1.0 - smoothstep(0.20, 1.0, r2)) * uOpacity * (1.0 - fog);
    if (alpha < 0.01) discard;
    vec3 shadowCol = mix(vec3(0.025, 0.020, 0.014), uFogColorFar, fog * 0.35);
    gl_FragColor = vec4(shadowCol, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function makeShadowUniforms(extra) {
  return {
    ...extra,
    uFogDensity: { value: 0.00017 },
    uFogColorFar: { value: new THREE.Color('#668db8') }
  };
}

function pushFogUniforms(uniforms, envState) {
  if (!envState) return;
  if (envState.fogFar) uniforms.uFogColorFar.value.copy(envState.fogFar);
  if (typeof envState.fogDensity === 'number') uniforms.uFogDensity.value = envState.fogDensity;
}
