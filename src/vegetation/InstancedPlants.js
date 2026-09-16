import * as THREE from 'three';
import { SPECIES, MAX_SPECIES } from './species.js';
import { generateVegetationChunk, createVegetationChunkJob } from './PlacementEngine.js';

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
export function createInstancedPlants({ atlas, instances = null, dem, groundY = null, shadows = null, foliageField = null }) {
  const tiers = [];
  const chunkSize = 512;
  const streaming = !instances;
  const activeChunks = new Map();
  const queued = new Map();
  const generationQueue = [];
  let activeJob = null;   // the chunk currently being generated, frame-sliced
  const streamStats = {
    dense: createEmptyStats('dense'),
    far: createEmptyStats('far'),
    activeDenseChunks: 0,
    activeFarChunks: 0,
    activeDenseInstances: 0,
    activeFarInstances: 0
  };
  const streamCfg = {
    denseRadius: 3200,
    farRadius: 6500,
    unloadRadius: 7200,
    // Cells of one chunk to generate per frame (frame-sliced streaming, see
    // updateStreaming). A dense chunk is ~16k cells; at 2000/frame it spreads
    // across ~8 frames (~130ms wall) so no single frame eats the ~60-90ms
    // full-chunk scan that caused the periodic hitch. Capacity is still
    // ~5 dense chunks/sec — far above the ~0.4/sec a sprint demands.
    cellsPerFrame: 2000,
    // maxPerChunk has to fit a fully closed canopy, or the cap thins the
    // carpet back into a scatter: a 512m chunk on a 4m grid is ~16.4k cells,
    // and inside a juniper brake essentially every one of them accepts.
    // globalDensity scales acceptance directly, so it is the contrast dial
    // between stand and opening: inside a brake juniper's score clamps
    // acceptance to 1 regardless, while out in the caliche the marginal
    // cells start failing. Lowering it opens the gaps without thinning the
    // carpets.
    dense: { cellSize: 4.0, globalDensity: 1.55, maxPerChunk: 24000 },
    far: { cellSize: 14.0, globalDensity: 1.65, acceptancePower: 0.82, acceptanceFloor: 0.035, maxPerChunk: 5000 }
  };

  // Build atlas-rect lookup as a Vec4 array uniform: [uOffset, vOffset, uScale, vScale].
  // Pad to MAX_SPECIES so the shader can use a fixed-size array uniform.
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

  // Canopy-normal params per species, packed as
  // [blend, centerY, radiusY, translucency]. See the CANOPY table in
  // species.js for what each one does.
  const canopies = new Float32Array(MAX_SPECIES * 4);
  SPECIES.forEach((s, idx) => {
    const c = s.canopy;
    canopies[idx * 4 + 0] = c.blend;
    canopies[idx * 4 + 1] = c.center;
    canopies[idx * 4 + 2] = c.radiusY;
    canopies[idx * 4 + 3] = c.translucency;
  });

  const sharedUniforms = {
    uAtlas: { value: atlas.texture },
    uRects: { value: rects },
    uAspects: { value: aspects },
    uCanopy: { value: canopies },
    // Master dials for the canopy-normal shading, tunable from the debug menu:
    // strength scales every species' blend, wrap softens the terminator,
    // contrast sets how far the lit/shadow sides spread apart (0 reproduces
    // the old flat lighting exactly), trans scales the backlight glow.
    uCanopyStrength: { value: 1.0 },
    uCanopyWrap:     { value: 0.35 },
    uCanopyContrast: { value: 2.0 },
    uCanopyTrans:    { value: 1.0 },
    // Near-camera dissolve. The camera's near plane is at 0.5m, so a plant
    // must be fully gone by a little beyond that or it gets sliced open and
    // you see the inside of the card. End is the clearance at which it has
    // vanished; start is where it begins to go.
    uNearFadeStart: { value: 5.5 },
    uNearFadeEnd:   { value: 0.55 },
    // Shapes the ramp. Below 1 it holds opacity high across most of the
    // range and then drops away steeply at the very end, so foliage only
    // reaches fully transparent right as it reaches the lens rather than
    // going half-ghostly several metres out the way a plain smoothstep does.
    uNearFadeCurve: { value: 0.35 },
    // Mip bias at full proximity — the softening that goes with the fade, so
    // near foliage defocuses instead of just thinning out.
    uNearBlur:      { value: 2.5 },
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
    uPlantHueColor: { value: new THREE.Color('#bfa866') },
    uPlantHueStrength: { value: 0.22 },
    uPlantSaturation: { value: 0.86 },
    uPlantValueScale: { value: 1.0 },
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
      // Alpha-to-coverage turns the fade alpha into MSAA sample coverage, so
      // a dissolving plant blends smoothly while the material stays in the
      // opaque pass — no sorting, no blend state, no dither grain. The
      // renderer is created with antialias:true and the normal path draws
      // straight to the default framebuffer, so the samples are there.
      alphaToCoverage: true,
      side: THREE.DoubleSide,
      // Ground-contact z-fighting fix. The high-res detail patch redraws the
      // ground the plant is rooted in and is itself pushed toward the camera
      // (polygonOffset -12) so it beats the base mesh. Without a matching bias
      // the plant's base shares the patch's depth at the contact line and the
      // patch's dense triangle grid shimmers through the sprite. Bias the
      // plants a little further forward than the patch so the sprite base wins
      // the depth test decisively. The offset is a near-constant depth nudge,
      // so it doesn't visibly float the cards.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -24,
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
      // Don't re-queue the chunk currently being generated.
      if (activeJob && activeJob.d.key === d.key && activeJob.d.mode === d.mode) continue;
      if (queued.has(d.key) && queued.get(d.key) === d.mode) continue;
      queued.set(d.key, d.mode);
      generationQueue.push(d);
    }

    // Frame-sliced generation: advance ONE in-progress chunk job by a bounded
    // number of cells per frame, then commit it when complete. A dense chunk
    // is ~16k cells / ~60-90ms of scan; processing it whole in one frame was
    // the periodic hitch. cellsPerFrame caps the per-frame cost (~a few ms);
    // the distance-sorted queue means the nearest chunk always generates
    // first, so plants still fill in underfoot before distant ones.
    if (!activeJob && generationQueue.length) {
      generationQueue.sort((a, b) => a.dist - b.dist);
      let d;
      while ((d = generationQueue.shift())) {
        if (queued.get(d.key) !== d.mode) { d = null; continue; }   // stale
        queued.delete(d.key);
        const existing = activeChunks.get(d.key);
        if (existing && (existing.mode === 'dense' || existing.mode === d.mode)) { d = null; continue; }
        break;
      }
      if (d) {
        const cfg = streamCfg[d.mode];
        activeJob = {
          d,
          job: createVegetationChunkJob({
            dem, groundY, chunkX: d.cx, chunkZ: d.cz, chunkSize,
            cellSize: cfg.cellSize,
            globalDensity: cfg.globalDensity,
            acceptancePower: cfg.acceptancePower ?? 1,
            acceptanceFloor: cfg.acceptanceFloor ?? 0,
            mode: d.mode,
            maxPerChunk: cfg.maxPerChunk,
            foliageField
          })
        };
      }
    }
    if (activeJob) {
      const done = activeJob.job.step(streamCfg.cellsPerFrame);
      if (done) {
        addChunkInstances(activeJob.d.key, activeJob.job.result(), activeJob.d.mode);
        activeJob = null;
      }
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
        acceptancePower: cfg.acceptancePower ?? 1,
        acceptanceFloor: cfg.acceptanceFloor ?? 0,
        mode: d.mode,
        maxPerChunk: cfg.maxPerChunk,
        foliageField
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
      stats: chunkInstances.stats,
      center: chunk.center,
      meshes: []
    };
    activeChunks.set(key, record);
    addStats(chunkInstances.stats);
    if (chunk.count <= 0) {
      updateActiveStats();
      return;
    }

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
    if (shadows) shadows.addPlantChunk(key, chunkInstances, mode);
    updateActiveStats();
  }

  function removeChunk(key) {
    const record = activeChunks.get(key);
    if (!record) return;
    subtractStats(record.stats);
    for (const { tierIndex, mesh } of record.meshes) {
      const t = tiers[tierIndex];
      t.mesh.remove(mesh);
      t.meshes.delete(key);
      mesh.geometry.dispose();
    }
    if (shadows) shadows.removePlantChunk(key);
    activeChunks.delete(key);
    updateActiveStats();
  }

  function addStats(stats) {
    if (!stats || !streamStats[stats.mode]) return;
    addStatsTo(streamStats[stats.mode], stats, 1);
  }

  function subtractStats(stats) {
    if (!stats || !streamStats[stats.mode]) return;
    addStatsTo(streamStats[stats.mode], stats, -1);
  }

  function updateActiveStats() {
    streamStats.activeDenseChunks = 0;
    streamStats.activeFarChunks = 0;
    streamStats.activeDenseInstances = 0;
    streamStats.activeFarInstances = 0;
    for (const record of activeChunks.values()) {
      if (record.mode === 'dense') {
        streamStats.activeDenseChunks++;
        streamStats.activeDenseInstances += record.count;
      } else {
        streamStats.activeFarChunks++;
        streamStats.activeFarInstances += record.count;
      }
    }
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
    streamStats,
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
    chunk.sourceModes = new Float32Array(chunk.count);
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
    chunk.sourceModes[j] = instances.sourceModes ? instances.sourceModes[i] : 0;
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
      sourceModes: chunk.sourceModes,
      count: chunk.count
    };
    chunk.attribs = {
      aOffset: new THREE.InstancedBufferAttribute(chunk.positions, 3),
      aScale: new THREE.InstancedBufferAttribute(chunk.scales, 1),
      aRotation: new THREE.InstancedBufferAttribute(chunk.rotations, 1),
      aSpecies: new THREE.InstancedBufferAttribute(chunk.species, 1),
      aSourceMode: new THREE.InstancedBufferAttribute(chunk.sourceModes, 1)
    };
    delete chunk.write;
  }

  return chunks;
}

function createEmptyStats(mode) {
  return {
    mode,
    chunks: 0,
    candidates: 0,
    rejectedOutsideDem: 0,
    rejectedSuitability: 0,
    rejectedAcceptance: 0,
    rejectedChunkOwnership: 0,
    acceptedParents: 0,
    emitted: 0,
    capped: 0
  };
}

function addStatsTo(target, stats, sign) {
  if (!stats) return;
  target.chunks += sign;
  target.candidates += stats.candidates * sign;
  target.rejectedOutsideDem += stats.rejectedOutsideDem * sign;
  target.rejectedSuitability += stats.rejectedSuitability * sign;
  target.rejectedAcceptance += stats.rejectedAcceptance * sign;
  target.rejectedChunkOwnership += stats.rejectedChunkOwnership * sign;
  target.acceptedParents += stats.acceptedParents * sign;
  target.emitted += stats.emitted * sign;
  target.capped += (stats.capped ? 1 : 0) * sign;
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
      aSpecies: new THREE.InstancedBufferAttribute(new Float32Array(instances.species), 1),
      aSourceMode: new THREE.InstancedBufferAttribute(instances.sourceModes || new Float32Array(instances.count), 1)
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
  // The card's own facing, per vertex. Blended against the canopy blob normal
  // in the shader (see VERT) — on its own it is what makes cards look like
  // cards, so it is never used alone except for genuinely flat species.
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const idx = [0, 1, 2, 0, 2, 3];
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('cardNormal', new THREE.BufferAttribute(normals, 3));
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
  // Each quad faces its own way — first spans X (normal +Z), second spans Z
  // (normal +X).
  const normals = new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0
  ]);
  const idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('cardNormal', new THREE.BufferAttribute(normals, 3));
  g.setIndex(idx);
  return g;
}

function makeRosetteGeometry(quads) {
  const positions = [];
  const uvs = [];
  const normals = [];
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
    // Quad width runs along (c, 0, s); its facing is that turned 90° in the
    // ground plane.
    for (let v = 0; v < 4; v++) normals.push(s, 0, -c);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  g.setAttribute('cardNormal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  g.setIndex(idx);
  return g;
}

const VERT = /* glsl */`
  precision highp float;
  attribute vec3 aOffset;
  attribute float aScale;
  attribute float aRotation;
  attribute float aSpecies;
  attribute float aSourceMode;
  attribute vec3 cardNormal;
  uniform vec4 uRects[${MAX_SPECIES}];
  uniform float uAspects[${MAX_SPECIES}];
  uniform vec4 uCanopy[${MAX_SPECIES}];
  uniform float uCanopyStrength;
  uniform float uTierMin;
  uniform float uTierMax;
  uniform float uFadeIn;
  uniform float uFadeOut;
  uniform float uTime;
  varying vec2 vAtlasUv;
  varying float vFade;
  varying float vFarSource;
  varying vec3 vWorldPos;
  varying vec3 vCardNormal;
  varying vec3 vCanopyNormal;
  varying vec2 vCanopyParams;   // x: blob/card blend, y: translucency

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
    vFarSource = clamp(aSourceMode, 0.0, 1.0);
    float sway = sin(uTime * 1.2 + aOffset.x * 0.05 + aOffset.z * 0.04) * 0.04 * (1.0 - vFarSource * 0.75);
    rp.x += sway * lp.y * 0.4;

    vec3 worldPos = rp + aOffset;
    vWorldPos = worldPos;

    // ---- canopy normals (the "transfer normals from a sphere" trick) ----
    // Build the normal of an implicit blob sitting inside the plant, in the
    // plant's unit local space: half-width 0.5 horizontally, canopy.z radius
    // vertically about height canopy.y. Every card vertex then borrows the
    // blob's normal, so a bush shades as one rounded volume with a lit side
    // and a shadow side instead of each card catching the sun on its own.
    // aspect and aScale are uniform scales along the card, so they cancel out
    // of the direction and are left out.
    vec4 canopy = uCanopy[sp];
    vec3 blobDir = vec3(
      position.x * 2.0,
      (position.y - canopy.y) / max(canopy.z, 0.02),
      position.z * 2.0
    );
    blobDir.y += 1e-4;   // keep the very centre from degenerating to zero
    vec3 blobN = normalize(blobDir);

    // Both normals live in the plant's local space — turn them with the
    // instance so a rotated plant is lit as a rotated plant.
    vCanopyNormal = vec3(c * blobN.x - s * blobN.z, blobN.y, s * blobN.x + c * blobN.z);
    vCardNormal = vec3(c * cardNormal.x - s * cardNormal.z, cardNormal.y, s * cardNormal.x + c * cardNormal.z);
    vCanopyParams = vec2(clamp(canopy.x * uCanopyStrength, 0.0, 1.0), canopy.w);

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
  uniform vec3 uPlantHueColor;
  uniform float uPlantHueStrength;
  uniform float uPlantSaturation;
  uniform float uPlantValueScale;
  uniform float uCanopyWrap;
  uniform float uCanopyContrast;
  uniform float uCanopyTrans;
  varying vec2 vAtlasUv;
  varying float vFade;
  varying float vFarSource;
  varying vec3 vWorldPos;
  varying vec3 vCardNormal;
  varying vec3 vCanopyNormal;
  varying vec2 vCanopyParams;
  uniform float uNearFadeStart;
  uniform float uNearFadeEnd;
  uniform float uNearFadeCurve;
  uniform float uNearBlur;

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
    // ---- near-camera dissolve ----
    // Per fragment, not per plant. Fading whole instances was the obvious
    // approach and it is wrong here: a plant's card can reach half its own
    // height sideways, so a 5m juniper would have to vanish entirely while
    // its trunk was still ~3m away, and in a closed brake that carves a
    // clearing that follows the camera around. Per fragment, only the
    // foliage actually at the lens melts and the bush itself stays put, so
    // the canopy parts around you instead of opening a hole.
    //
    // nearT runs 0 at the lens to 1 at uNearFadeStart and drives both the
    // opacity ramp and the defocus. uNearFadeEnd sits just past the 0.5m
    // near plane, so a fragment is gone a hair before the plane could slice
    // it open, and not before.
    float camDist = length(cameraPosition - vWorldPos);
    float nearT = smoothstep(uNearFadeEnd, uNearFadeStart, camDist);
    float nearFade = pow(nearT, uNearFadeCurve);

    // Sampled with a mip bias before any discard: biased sampling still
    // relies on implicit derivatives, which want uniform control flow.
    vec4 tex = texture2D(uAtlas, vAtlasUv, (1.0 - nearT) * uNearBlur);
    if (tex.a < 0.5) discard;
    if (vFade < 0.5) discard; // alpha-test fade approximation
    if (nearFade <= 0.002) discard;
    vec3 plantRgb = paletteTint(tex.rgb);

    // ---- canopy shading ----
    // Cards are double-sided, so the card's own normal has to be turned to
    // face the viewer before it means anything. The blob normal comes from
    // vertex position, not facing, so it needs no such fix — one of the
    // reasons this trick holds up on two-sided foliage.
    vec3 cardN = normalize(vCardNormal);
    if (!gl_FrontFacing) cardN = -cardN;
    vec3 N = normalize(mix(cardN, normalize(vCanopyNormal), vCanopyParams.x));

    vec3 viewRay = normalize(vWorldPos - cameraPosition);
    float sunAlign = max(dot(viewRay, uSunDir), 0.0);
    float topLight = clamp(uSunDir.y, 0.0, 1.0);

    // Wrapped diffuse: leaves are thin and bounce light around, so the
    // terminator sits past 90° rather than cutting hard at it.
    float wrap = max(uCanopyWrap, 0.0);
    float diff = clamp((dot(N, uSunDir) + wrap) / (1.0 + wrap), 0.0, 1.0);
    // uCanopyContrast 0 collapses this to the old flat 0.55 + 0.55 * topLight.
    float shade = mix(0.5, diff, uCanopyContrast);

    // Hemispheric ambient — upward-facing parts of the canopy see more sky
    // than the undersides. Averages out to the old flat 0.95 term.
    float skyFacing = N.y * 0.5 + 0.5;
    vec3 ambient = uAmbient * (0.72 + 0.46 * skyFacing);

    // Transmission: looking toward the sun through a leaf that faces away
    // from it. This is what makes backlit grass and thin shrubs glow.
    float transmit = pow(sunAlign, 3.0) * (1.0 - diff) * topLight *
      vCanopyParams.y * uCanopyTrans;

    float direct = max(0.0, 0.55 + 1.10 * shade * topLight) + transmit;
    vec3 lit = plantRgb * (uSunColor * direct + ambient);

    // Lantern pool — adds warm light to plants near the bobcat. Shaded by the
    // same canopy normal, so the near side of a bush catches the pool and the
    // far side falls away. mix(0.5, ...) * 2.0 is 1.0 at contrast 0, i.e. the
    // old unshaded pool.
    vec3 toLantern = uLanternPos - vWorldPos;
    float lanternD = length(toLantern);
    float lanternAtt = clamp(1.0 - lanternD / uLanternRange, 0.0, 1.0);
    lanternAtt *= lanternAtt;
    vec3 lanternDir = toLantern / max(lanternD, 0.001);
    float lanternNdl = clamp((dot(N, lanternDir) + wrap) / (1.0 + wrap), 0.0, 1.0);
    lanternAtt *= mix(0.5, lanternNdl, uCanopyContrast) * 2.0;
    lit += plantRgb * uLanternColor * 0.9 * lanternAtt * uLanternIntensity * (1.0 - vFarSource);

    lit *= uExposure;

    // Aerial perspective — same monotonic far-colour takeover as terrain.
    float dist = length(cameraPosition - vWorldPos);
    float horizon = pow(clamp(1.0 - abs(viewRay.y), 0.0, 1.0), 1.7);
    float lowAir = 1.0 - smoothstep(520.0, 1500.0, vWorldPos.y);
    float densityBoost = 1.0 + horizon * 1.35 + lowAir * 0.45;
    float fog = 1.0 - exp(-dist * uFogDensity * densityBoost);
    fog = smoothstep(0.0, 1.0, clamp(fog, 0.0, 1.0));
    vec3 nearFog = mix(uFogColorLow, uFogColorMid, smoothstep(0.0, 0.45, fog));
    vec3 fogCol = mix(nearFog, uFogColorFar, smoothstep(0.35, 0.85, fog));
    float sunScatter = pow(sunAlign, 10.0);
    fogCol += uSunColor * sunScatter * horizon * fog * (1.0 - smoothstep(0.60, 0.95, fog)) * 0.12;
    float horizonTakeover = smoothstep(0.85, 1.0, fog);
    fogCol = mix(fogCol, uFogColorFar, horizonTakeover);
    fog = mix(fog, 1.0, horizonTakeover);
    fog = mix(fog, min(1.0, fog + 0.16), vFarSource);
    lit = mix(lit, vec3(dot(lit, vec3(0.299, 0.587, 0.114))), vFarSource * 0.18);
    lit = mix(lit, fogCol, fog);

    // Alpha feeds sample coverage, not blending — see alphaToCoverage above.
    gl_FragColor = vec4(lit, nearFade);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
