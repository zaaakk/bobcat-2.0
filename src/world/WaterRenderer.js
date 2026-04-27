import * as THREE from 'three';

/**
 * Builds the merged water-disc mesh + shader from a list of pools.
 *
 * Pure rendering: takes the analysis output (Array<{x, y, z, r, depth}>) and
 * produces a single drawcall covering all pools. No DEM access, no spatial
 * logic — that lives in WaterAnalysis.
 *
 * Shading model — Devils-River-ish:
 *   • Body colour: green-blue tint, shallow at edges → deep at centre.
 *   • Surface ripples: layered sin's perturbing the normal, used for both
 *     reflection direction and specular highlight.
 *   • Sky reflection: blend env state (sunColor + skyTop + haze) along the
 *     reflection direction. Cheap stand-in for a real cubemap reflection
 *     and stays in sync with the day/night cycle.
 *   • Fresnel: more reflection at glancing angles, more body at top-down —
 *     the "see-through-the-pool-when-overhead" feel.
 *   • Shoreline: rim vertices keep their depth=0 → mostly transparent body,
 *     smooth shoreline blend.
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
    // Devils River palette: pale green-teal shallow, deep teal-blue centre.
    uShallow:  { value: new THREE.Color('#9fd6c8') },
    uDeep:     { value: new THREE.Color('#1d3a4a') },
    uSunDir:   { value: new THREE.Vector3(0.5, 0.85, 0.2).normalize() },
    uSunColor: { value: new THREE.Color(1, 0.96, 0.85) },
    // Sky reflection sources. Updated each frame from env state.
    uSkyTop:   { value: new THREE.Color('#74c2ff') },
    uHaze:     { value: new THREE.Color('#94dcff') },
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
        p.y += sin(uTime * 1.6 + aSeed * 4.0 + p.x * 0.3 + p.z * 0.3) * 0.025 * aDepth;
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
      uniform vec3 uShallow, uDeep, uSunDir, uSunColor, uSkyTop, uHaze;

      // Two-octave rippled normal. Reused for reflection direction and spec.
      vec3 surfaceNormal(vec3 p, float t, float seedPhase) {
        float n1 = sin(p.x * 0.9 + t * 1.7 + seedPhase) * 0.5
                 + sin(p.z * 1.1 + t * 2.3 + seedPhase * 1.3) * 0.5;
        float n2 = sin((p.x + p.z) * 1.8 + t * 3.1) * 0.25
                 + sin((p.x - p.z) * 1.5 + t * 2.7) * 0.25;
        float dx = (n1 + n2) * 0.18;
        float dz = (n1 - n2) * 0.16;
        return normalize(vec3(dx, 1.0, dz));
      }

      // Cheap sky lookup along a view direction. Mixes haze (low) → top (high)
      // so reflections of upward-looking rays get the zenith blue, glancing
      // rays get horizon haze.
      vec3 skyAlong(vec3 dir) {
        float h = clamp(dir.y, 0.0, 1.0);
        return mix(uHaze, uSkyTop, h);
      }

      void main() {
        vec3 nrm = surfaceNormal(vWorldPos, uTime, vSeed * 0.5);
        vec3 viewDir = normalize(vWorldPos - cameraPosition);

        // Body colour — pale teal at the rim, deep at the centre.
        vec3 body = mix(uShallow, uDeep, vDepth);

        // Reflection sample along the reflected view direction.
        vec3 reflDir = reflect(viewDir, nrm);
        vec3 reflColor = skyAlong(reflDir);

        // Fresnel — Schlick approximation with water's ~2% normal reflectance,
        // saturating to ~80% at glancing angles.
        float cosTheta = clamp(-dot(viewDir, nrm), 0.0, 1.0);
        float fresnel = 0.02 + 0.98 * pow(1.0 - cosTheta, 5.0);
        fresnel = clamp(fresnel, 0.04, 0.85);

        // Specular highlight on the perturbed normal.
        vec3 sunReflDir = reflect(-uSunDir, nrm);
        float sunDot = max(dot(-viewDir, sunReflDir), 0.0);
        float spec = pow(sunDot, 80.0);

        vec3 col = mix(body, reflColor, fresnel);
        col += uSunColor * spec * 1.4;

        // Alpha — clearer at top-down (low Fresnel) so the bottom shows through;
        // more opaque at glancing angles where reflection takes over.
        float alpha = mix(0.42, 0.85, vDepth);
        alpha = mix(alpha, 0.92, fresnel * 0.55);

        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  const mesh = new THREE.Mesh(geom, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;     // after terrain so transparency sorts cleanly
  scene.add(mesh);

  /**
   * Per-frame tick. ctx fields used:
   *   ctx.sunDir, ctx.sunColor — for spec.
   *   ctx.skyTop, ctx.haze     — for sky reflection.
   * Falls back to the shader's defaults when a field is missing.
   */
  function update(dt, t, ctx) {
    uniforms.uTime.value = t;
    if (ctx) {
      if (ctx.sunDir)   uniforms.uSunDir.value.copy(ctx.sunDir);
      if (ctx.sunColor) uniforms.uSunColor.value.copy(ctx.sunColor);
      if (ctx.skyTop)   uniforms.uSkyTop.value.copy(ctx.skyTop);
      if (ctx.haze)     uniforms.uHaze.value.copy(ctx.haze);
    }
  }

  function dispose() {
    scene.remove(mesh);
    geom.dispose();
    material.dispose();
  }

  return { mesh, update, dispose };
}
