import * as THREE from 'three';

/**
 * Small pools of water at low-elevation pockets in the DEM.
 *
 * The desert is dry, but seasonal washes and arroyos collect water in a few
 * low spots. We find the bottom-N percent of DEM cells, cluster the spatially
 * connected ones into "ponds", and place a single horizontal disc at each
 * pond's local water level. All discs go into one merged BufferGeometry =
 * one drawcall, so even a dozen pools cost nothing.
 *
 * Spatial queries go through TerrainQuery — no direct DEM access. That keeps
 * the same conventions (half-pixel correct, edge-clamped neighbours) shared
 * with every other landscape feature, and means a future change to terrain
 * sampling (e.g. switching to a streaming DEM) doesn't have to touch this
 * file.
 *
 * `update(dt, t)` advances a per-vertex shimmer in the shader.
 */
export function createWaterPools({ terrainQuery, scene, maxPools = 60 }) {
  const tq = terrainQuery;
  // ---------- pond detection ----------
  // Two flavours, both realistic for the Devil's River watershed:
  //   1. "river" — the actual lowest cells in the DEM (bottom 4%). Greedy-
  //      clustered by proximity, these become the perennial water in the
  //      Devil's River channel (and a couple of major arroyos).
  //   2. "tinaja" — local minima everywhere else. A cell is a tinaja anchor
  //      if 6+ of 8 ring neighbours at radius=3 are higher AND the mean ring
  //      is at least `minDepth` metres above. These represent the seasonal
  //      rock-pools scattered across the desert and give the player water
  //      within a reasonable walk of any spawn.
  const pixelSize = tq.pixelSize;
  const elevRange = tq.maxElevation - tq.minElevation;

  // ---- Type 1: river / major channel ----
  const riverThresh = tq.minElevation + elevRange * 0.04;
  const lowCells = tq.findCells(c => c.height < riverThresh)
    .map(c => ({ i: c.i, j: c.j, z: c.height }))
    .sort((a, b) => a.z - b.z);
  const mergeRadiusM = 30;
  const mergeRadiusCells = mergeRadiusM / pixelSize;
  const riverPools = [];
  for (const c of lowCells) {
    let attached = false;
    for (const p of riverPools) {
      const dx = c.i - p.i, dy = c.j - p.j;
      if (dx * dx + dy * dy < mergeRadiusCells * mergeRadiusCells) {
        p.i = (p.i * p.n + c.i) / (p.n + 1);
        p.j = (p.j * p.n + c.j) / (p.n + 1);
        p.z = Math.min(p.z, c.z);
        p.n += 1;
        p.r = Math.max(p.r, Math.sqrt(dx * dx + dy * dy));
        attached = true;
        break;
      }
    }
    if (!attached && riverPools.length < 12) {
      riverPools.push({ i: c.i, j: c.j, z: c.z, n: 1, r: 1.5, kind: 'river' });
    }
  }
  riverPools.sort((a, b) => b.n - a.n);
  riverPools.splice(8);

  // ---- Type 2: tinajas (concave depressions) ----
  // Strict local minima are rare in a smoothed DEM, so use a softer test: a
  // cell is a tinaja anchor if the average elevation of its surrounding
  // ring is `minDepth` metres higher than the cell itself. This finds bowls
  // / saddle-floors where water would naturally pool, not just isolated low
  // points. The 8-neighbour ring at radius=3 (~50m for our DEM) catches
  // mid-arroyo dips and rocky depressions across most of the map.
  const minimaRadius = 3;
  const minDepth = 0.40;
  // 8 sample offsets at radius = the four cardinals + four diagonals.
  const ringOffsets = [
    [ minimaRadius, 0], [-minimaRadius, 0], [0,  minimaRadius], [0, -minimaRadius],
    [ minimaRadius,  minimaRadius], [-minimaRadius,  minimaRadius],
    [ minimaRadius, -minimaRadius], [-minimaRadius, -minimaRadius],
  ];
  // Require *most* neighbours higher (≥6 of 8) but not strictly all — catches
  // concave bowls without missing those bordered by one slightly lower cell
  // on a downhill slope.
  const tinajaCells = tq.findCells(c => {
    let sum = 0, higherCount = 0;
    for (let k = 0; k < ringOffsets.length; k++) {
      const nz = c.neighbourHeight(ringOffsets[k][0], ringOffsets[k][1]);
      sum += nz;
      if (nz > c.height) higherCount++;
    }
    return higherCount >= 6 && (sum / ringOffsets.length - c.height) >= minDepth;
  }, { margin: minimaRadius });
  // Re-derive the per-cell depth on the keeps. Cheap (these are sparse) and
  // keeps findCells's result type a clean snapshot.
  const tinajas = tinajaCells.map(c => {
    const meanRing = ringOffsets.reduce(
      (s, [di, dj]) => s + tq.cellHeight(c.i + di, c.j + dj),
      0
    ) / ringOffsets.length;
    return { i: c.i, j: c.j, z: c.height, depth: meanRing - c.height, kind: 'tinaja' };
  });
  // Greedy spatial spread: thin out tinajas that are within `spreadRadius`
  // of an already-kept one, deepest first. This keeps tinajas spread across
  // the map rather than clustering in a few deep canyons.
  tinajas.sort((a, b) => b.depth - a.depth);
  // Tighter spread = more pools, distributed across the map. 120m is far
  // enough that adjacent tinajas don't visually merge but close enough to
  // get plenty of pools at this DEM scale.
  const spreadRadiusM = 120;
  const spreadRadiusCells = spreadRadiusM / pixelSize;
  const keptTinajas = [];
  for (const t of tinajas) {
    let tooClose = false;
    for (const k of keptTinajas) {
      const dx = t.i - k.i, dy = t.j - k.j;
      if (dx * dx + dy * dy < spreadRadiusCells * spreadRadiusCells) {
        tooClose = true; break;
      }
    }
    if (!tooClose) {
      // Approximate radius — bigger for deeper tinajas, capped at 9m.
      const r = Math.min(9, 2 + t.depth * 1.5);
      keptTinajas.push({ ...t, r, n: 1 });
      if (keptTinajas.length >= maxPools - riverPools.length) break;
    }
  }

  const pools = [...riverPools, ...keptTinajas];
  if (!pools.length) {
    return { mesh: null, pools: [], update: () => {}, dispose: () => {} };
  }
  console.log(`water: ${riverPools.length} river pools + ${keptTinajas.length} tinajas`);

  // ---------- build a single merged mesh ----------
  // Each pool becomes a 32-segment disc geometry. We pre-compute its world
  // position + radius and embed them as per-vertex attributes so a single
  // shader can shade all pools at once.
  const SEGMENTS = 32;
  const vertsPerDisc = SEGMENTS + 2;        // 1 center + (SEGMENTS+1) rim
  const trisPerDisc  = SEGMENTS;
  const totalVerts = pools.length * vertsPerDisc;
  const totalTris  = pools.length * trisPerDisc;

  const positions = new Float32Array(totalVerts * 3);
  const aDepth    = new Float32Array(totalVerts);   // 1 at centre, 0 at edge — for shimmer + alpha falloff
  const aSeed     = new Float32Array(totalVerts);   // per-pool seed for random shimmer
  const indices   = new Uint32Array(totalTris * 3);

  // Place each pool's water surface roughly 0.4m above its lowest cell so
  // the surface peeks just over the surrounding terrain. Radius is the
  // larger of the cluster spread or a small minimum (so single-cell pools
  // are still visible).
  const worldPools = [];
  let vi = 0, ti = 0;
  for (let pi = 0; pi < pools.length; pi++) {
    const p = pools[pi];
    const { x: wx, z: wz } = tq.cellToWorld(p.i, p.j);
    const groundLow = tq.sampleGroundY(wx, wz);
    const surfaceY = groundLow + 0.32;       // just above the bottom cell
    // River pools: radius derived from the cluster spread (cells × pixelSize).
    // Tinajas: precomputed `r` is already in metres.
    const radius = p.kind === 'tinaja'
      ? Math.max(2.5, p.r)
      : Math.max(4, p.r * pixelSize);
    worldPools.push({ x: wx, y: surfaceY, z: wz, r: radius });
    const seed = (pi * 13.37) % 100;

    // centre vertex
    positions[vi * 3 + 0] = wx;
    positions[vi * 3 + 1] = surfaceY;
    positions[vi * 3 + 2] = wz;
    aDepth[vi] = 1.0;
    aSeed[vi] = seed;
    const centreIdx = vi;
    vi++;
    // rim vertices
    const rimStart = vi;
    for (let s = 0; s <= SEGMENTS; s++) {
      const a = (s / SEGMENTS) * Math.PI * 2;
      const x = wx + Math.cos(a) * radius;
      const z = wz + Math.sin(a) * radius;
      // Drop the rim slightly below the centre so the surface dips at the
      // edge — reads as "shore" without needing a separate edge mesh.
      positions[vi * 3 + 0] = x;
      positions[vi * 3 + 1] = surfaceY - 0.04;
      positions[vi * 3 + 2] = z;
      aDepth[vi] = 0.0;
      aSeed[vi] = seed;
      vi++;
    }
    // triangles: fan from centre
    for (let s = 0; s < SEGMENTS; s++) {
      indices[ti * 3 + 0] = centreIdx;
      indices[ti * 3 + 1] = rimStart + s;
      indices[ti * 3 + 2] = rimStart + s + 1;
      ti++;
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('aDepth', new THREE.BufferAttribute(aDepth, 1));
  geom.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  geom.computeBoundingSphere();

  const uniforms = {
    uTime:        { value: 0 },
    uShallow:     { value: new THREE.Color('#7ab9c5') },   // edge tint — pale teal
    uDeep:        { value: new THREE.Color('#1f3548') },   // centre tint — dark blue
    uSunDir:      { value: new THREE.Vector3(0.5, 0.85, 0.2).normalize() },
    uSunColor:    { value: new THREE.Color(1, 0.96, 0.85) }
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      attribute float aDepth;
      attribute float aSeed;
      varying float vDepth;
      varying float vSeed;
      varying vec3 vWorldPos;
      uniform float uTime;
      void main() {
        vec3 p = position;
        // Subtle vertex bob — small wave on the centre, none on the rim
        // (preserves shoreline). The seed staggers each pool's wave phase.
        p.y += sin(uTime * 1.6 + aSeed * 4.0 + p.x * 0.3 + p.z * 0.3) * 0.03 * aDepth;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorldPos = wp.xyz;
        vDepth = aDepth;
        vSeed = aSeed;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying float vDepth;
      varying float vSeed;
      varying vec3 vWorldPos;
      uniform float uTime;
      uniform vec3 uShallow, uDeep, uSunDir, uSunColor;
      // Cheap value noise — enough texture to suggest ripples without an actual
      // texture sample. Two octaves of sin-based wibbles at different scales.
      float ripple(vec3 p, float t) {
        return sin(p.x * 0.9 + t * 1.7) * 0.5 +
               sin(p.z * 1.1 + t * 2.3) * 0.5 +
               sin((p.x + p.z) * 0.4 + t * 0.7) * 0.5;
      }
      void main() {
        // Body colour: deep-blue at centre, pale teal at edges. Adds the
        // "shallow water reads through to the bed" feel without sampling
        // the terrain texture.
        vec3 base = mix(uShallow, uDeep, vDepth);
        // Sunlight kick on a perturbed normal — fakes specular twinkle.
        float r = ripple(vWorldPos, uTime + vSeed);
        vec3 nrm = normalize(vec3(r * 0.3, 1.0, r * 0.3 * vDepth));
        float spec = pow(max(dot(nrm, normalize(uSunDir)), 0.0), 24.0);
        base += uSunColor * spec * 0.65;
        // Edge falls off in alpha so the disc doesn't read as a hard circle.
        float alpha = 0.55 + vDepth * 0.30;
        gl_FragColor = vec4(base, alpha);
      }
    `
  });

  const mesh = new THREE.Mesh(geom, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;     // after terrain so transparency sorts cleanly
  scene.add(mesh);

  function update(dt, t, sunDir, sunColor) {
    uniforms.uTime.value = t;
    if (sunDir)   uniforms.uSunDir.value.copy(sunDir);
    if (sunColor) uniforms.uSunColor.value.copy(sunColor);
  }

  function dispose() {
    scene.remove(mesh);
    geom.dispose();
    material.dispose();
  }

  return { mesh, pools: worldPools, update, dispose };
}
