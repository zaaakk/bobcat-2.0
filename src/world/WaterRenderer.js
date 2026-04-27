import * as THREE from 'three';

/**
 * Builds the merged water-disc mesh + shader from a list of pools.
 *
 * Pure rendering: takes the analysis output (Array<{x, y, z, r, kind, depth}>)
 * and produces a single drawcall covering all pools. No DEM access, no
 * spatial logic — that lives in WaterAnalysis.
 *
 * Each pool is a 32-segment disc (1 centre + SEGMENTS+1 rim verts). Per-vertex
 * `aDepth` is 1 at centre / 0 at rim, used for shimmer + alpha falloff. Per-
 * pool `aSeed` staggers ripple phase.
 */
export function createWaterRenderer({ pools, scene }) {
  if (!pools.length) {
    return { mesh: null, update: () => {}, dispose: () => {} };
  }

  const SEGMENTS = 32;
  const vertsPerDisc = SEGMENTS + 2;
  const trisPerDisc  = SEGMENTS;
  const totalVerts = pools.length * vertsPerDisc;
  const totalTris  = pools.length * trisPerDisc;

  const positions = new Float32Array(totalVerts * 3);
  const aDepth    = new Float32Array(totalVerts);
  const aSeed     = new Float32Array(totalVerts);
  const indices   = new Uint32Array(totalTris * 3);

  let vi = 0, ti = 0;
  for (let pi = 0; pi < pools.length; pi++) {
    const p = pools[pi];
    const seed = (pi * 13.37) % 100;

    // centre vertex
    positions[vi * 3 + 0] = p.x;
    positions[vi * 3 + 1] = p.y;
    positions[vi * 3 + 2] = p.z;
    aDepth[vi] = 1.0;
    aSeed[vi] = seed;
    const centreIdx = vi;
    vi++;

    // rim vertices — slight Y dip so the surface tucks at the shoreline.
    const rimStart = vi;
    for (let s = 0; s <= SEGMENTS; s++) {
      const a = (s / SEGMENTS) * Math.PI * 2;
      positions[vi * 3 + 0] = p.x + Math.cos(a) * p.r;
      positions[vi * 3 + 1] = p.y - 0.04;
      positions[vi * 3 + 2] = p.z + Math.sin(a) * p.r;
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
    uTime:     { value: 0 },
    uShallow:  { value: new THREE.Color('#7ab9c5') },
    uDeep:     { value: new THREE.Color('#1f3548') },
    uSunDir:   { value: new THREE.Vector3(0.5, 0.85, 0.2).normalize() },
    uSunColor: { value: new THREE.Color(1, 0.96, 0.85) }
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
        // Subtle vertex bob — small wave on centre, none at rim (preserves
        // shoreline). Per-pool seed staggers wave phase.
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
      float ripple(vec3 p, float t) {
        return sin(p.x * 0.9 + t * 1.7) * 0.5 +
               sin(p.z * 1.1 + t * 2.3) * 0.5 +
               sin((p.x + p.z) * 0.4 + t * 0.7) * 0.5;
      }
      void main() {
        // Body colour: deep at centre, pale teal at edges.
        vec3 base = mix(uShallow, uDeep, vDepth);
        // Sunlight kick on a perturbed normal — fakes specular twinkle.
        float r = ripple(vWorldPos, uTime + vSeed);
        vec3 nrm = normalize(vec3(r * 0.3, 1.0, r * 0.3 * vDepth));
        float spec = pow(max(dot(nrm, normalize(uSunDir)), 0.0), 24.0);
        base += uSunColor * spec * 0.65;
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

  return { mesh, update, dispose };
}
