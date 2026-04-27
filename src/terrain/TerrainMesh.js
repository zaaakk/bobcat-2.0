import * as THREE from 'three';

/**
 * A single shader-displaced terrain mesh covering the DEM extents (and a fade ring
 * beyond, set by edgePadding, so the world doesn't look like a card on a table).
 *
 * Vertex grid is fixed (segments x segments); the heightmap texture is sampled in
 * the vertex shader. Splatmap blends four ground textures in the fragment shader.
 */
export function createTerrainMesh({ dem, heightTex, splatTex, groundTextures, groundNormals, normalTex, detailNoise = null, segments = 512, edgePadding = 8000 }) {
  const planeWidth = dem.worldWidth + edgePadding * 2;
  const planeHeight = dem.worldHeight + edgePadding * 2;
  const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight, segments, segments);
  geometry.rotateX(-Math.PI / 2);

  const uniforms = {
    uHeightmap: { value: heightTex },
    uSplat: { value: splatTex },
    uTexRock: { value: groundTextures.rock },
    uTexGrass: { value: groundTextures.grass },
    uTexGravel: { value: groundTextures.gravel },
    uTexSand: { value: groundTextures.sand },
    // Per-tile normal maps (sliced from each [tex]normals.png 2×2 atlas).
    // These replace the single generic detail-normal in the splat blend, so
    // each ground type's surface micro-detail follows its own diffuse pattern.
    uNormalRock:   { value: groundNormals?.rock   || normalTex },
    uNormalGrass:  { value: groundNormals?.grass  || normalTex },
    uNormalGravel: { value: groundNormals?.gravel || normalTex },
    uNormalSand:   { value: groundNormals?.sand   || normalTex },
    uMinZ: { value: dem.minZ },
    uMaxZ: { value: dem.maxZ },
    uDemSize: { value: new THREE.Vector2(dem.worldWidth, dem.worldHeight) },
    uDemTexel: { value: new THREE.Vector2(1 / dem.width, 1 / dem.height) },
    uPlaneSize: { value: new THREE.Vector2(planeWidth, planeHeight) },
    uMeshSpacing: { value: new THREE.Vector2(planeWidth / segments, planeHeight / segments) },
    uTextureScale: { value: 24.0 }, // metres per texture repeat
    uSplatScale: { value: 1.0 },
    uSunDir: { value: new THREE.Vector3(0.5, 0.85, 0.2).normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.96, 0.85) },
    uAmbientColor: { value: new THREE.Color(0.42, 0.45, 0.55) },
    uFogDensity: { value: 0.00017 },     // 1/metres — base extinction rate
    uFogColorLow:  { value: new THREE.Color('#c9d1d8') },
    uFogColorMid:  { value: new THREE.Color('#96abc1') },
    uFogColorFar:  { value: new THREE.Color('#668db8') },
    uHorizonAlt:   { value: 1200.0 },    // metres above which sky tint dominates
    uExposure:     { value: 1.18 },      // pre-fog brightness lift on the lit albedo
    uLanternPos:   { value: new THREE.Vector3() },
    uLanternColor: { value: new THREE.Color('#b8d2ff') },  // cool moonlight
    uLanternRange: { value: 22.0 },
    uLanternIntensity: { value: 0.0 },
    // Sub-DEM detail: ridged-multifractal lookup (caprock bumps) + an
    // elevation-keyed bedding pulse computed in the shader (horizontal
    // bench lines). uDetailHas gates everything so a build without a
    // detail texture compiles + runs cleanly (the sampler must still
    // bind to *something*, so we hand it the heightmap as a fallback).
    uDetailTex:        { value: detailNoise ? detailNoise.texture : heightTex },
    uDetailWorldSize:  { value: detailNoise
        ? new THREE.Vector2(detailNoise.worldWidth, detailNoise.worldHeight)
        : new THREE.Vector2(1, 1) },
    uRidgeAmp:         { value: detailNoise ? detailNoise.ridgeAmp   : 0.0 },
    uBedAmp:           { value: detailNoise ? detailNoise.bedAmp     : 0.0 },
    uBedPeriod:        { value: detailNoise ? detailNoise.bedPeriod  : 18.0 },
    uBedWarpAmp:       { value: detailNoise ? detailNoise.bedWarpAmp : 0.0 },
    uDetailHas:        { value: detailNoise ? 1.0 : 0.0 }
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.FrontSide,
    fog: false
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; // always render — terrain is the world.
  mesh.receiveShadow = false;
  return { mesh, material, uniforms };
}

const VERT = /* glsl */`
  precision highp float;
  uniform sampler2D uHeightmap;
  uniform sampler2D uDetailTex;
  uniform vec2 uDemSize;
  uniform vec2 uDetailWorldSize;
  uniform vec2 uPlaneSize;
  uniform vec2 uMeshSpacing;
  uniform float uRidgeAmp;
  uniform float uBedAmp;
  uniform float uBedPeriod;
  uniform float uBedWarpAmp;
  uniform float uDetailHas;

  varying vec3 vWorldPos;
  varying vec2 vUv;
  varying vec2 vDemUv;
  varying vec3 vMeshNormal;
  varying vec3 vTangent;
  varying vec3 vBitangent;
  varying float vEdgeFade;

  // Detail is added on top of every DEM sample so the rendered surface IS
  // (DEM + detail), and the per-vertex normal computed below picks up the
  // perturbation from the detail field automatically.
  //
  // Two layers, both unsigned (always lift the surface):
  //   1. ridged-multifractal lookup     — caprock bumps (texture)
  //   2. elevation-keyed bedding pulse  — horizontal bench lines (sin of
  //                                       hDem, domain-warped by the ridge
  //                                       field so they wander naturally)
  float sampleDetail(vec2 worldXZ, float hDem) {
    if (uDetailHas < 0.5) return 0.0;
    vec2 uv = (worldXZ / uDetailWorldSize) + 0.5;
    uv = clamp(uv, vec2(0.0), vec2(1.0));
    float ridge = texture2D(uDetailTex, uv).r;             // [0, 1]
    float warpedH = hDem + ridge * uBedWarpAmp;
    float bedTau  = 6.283185307179586 / uBedPeriod;
    float pulse   = max(0.0, sin(warpedH * bedTau) - 0.5) * 2.0;
    return ridge * uRidgeAmp + pulse * uBedAmp;
  }

  float sampleHEdge(vec2 worldXZ) {
    // Drop both the DEM and the detail through the edge fade so the padding
    // ring stays clean (no stray noise outside the world).
    vec2 uv = (worldXZ / uDemSize) + 0.5;
    uv = clamp(uv, vec2(0.0), vec2(1.0));
    float hDem = texture2D(uHeightmap, uv).r;
    vec2 inside = abs(worldXZ) - uDemSize * 0.5;
    float outside = max(max(inside.x, inside.y), 0.0);
    float ef = clamp(outside / 4000.0, 0.0, 1.0);
    ef = ef * ef;
    float baseH = mix(hDem, hDem - 80.0, ef);
    return baseH + sampleDetail(worldXZ, hDem) * (1.0 - ef);
  }

  void main() {
    vec3 p = position;
    vec2 worldXZ = p.xz;

    vec2 inside = abs(worldXZ) - uDemSize * 0.5;
    float outside = max(max(inside.x, inside.y), 0.0);
    float edgeFade = clamp(outside / 4000.0, 0.0, 1.0);
    edgeFade = edgeFade * edgeFade;

    // Use the edge-aware sampler for the centre too, so detail noise is
    // gated by edgeFade the same way it is when sampled for the normal-
    // computing neighbours below — otherwise the centre's noise rides the
    // -80m fade ramp while the neighbours don't, and the seam shows up as
    // a lighting glitch at the DEM boundary.
    p.y = sampleHEdge(worldXZ);

    // Per-vertex normal computed from heightmap sampled at mesh-vertex spacing —
    // this matches the rasterised surface (which is linear between vertices).
    // Interpolating this varying across each triangle gives Phong shading that
    // never disagrees with the underlying geometry, so triangle edges do not
    // show up as lighting seams.
    float dx = uMeshSpacing.x;
    float dz = uMeshSpacing.y;
    float hL = sampleHEdge(worldXZ - vec2(dx, 0.0));
    float hR = sampleHEdge(worldXZ + vec2(dx, 0.0));
    float hD = sampleHEdge(worldXZ - vec2(0.0, dz));
    float hU = sampleHEdge(worldXZ + vec2(0.0, dz));
    vec3 tx = vec3(2.0 * dx, hR - hL, 0.0);
    vec3 tz = vec3(0.0, hU - hD, 2.0 * dz);
    vMeshNormal = normalize(cross(tz, tx));
    // Pass the tangent and bitangent to the fragment shader so it can
    // transform tangent-space normal maps into world space (TBN matrix).
    // Tangent goes along world X (with the surface's local slope); bitangent
    // goes along world Z. Together with the surface normal these form an
    // orthonormal basis for sampled normals.
    vTangent = normalize(tx);
    vBitangent = normalize(tz);

    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWorldPos = wp.xyz;
    vUv = (worldXZ + uPlaneSize * 0.5) / uPlaneSize;
    vDemUv = clamp(worldXZ / uDemSize + 0.5, 0.0, 1.0);
    vEdgeFade = edgeFade;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uSplat;
  uniform sampler2D uTexRock;
  uniform sampler2D uTexGrass;
  uniform sampler2D uTexGravel;
  uniform sampler2D uTexSand;
  uniform sampler2D uNormalRock;
  uniform sampler2D uNormalGrass;
  uniform sampler2D uNormalGravel;
  uniform sampler2D uNormalSand;
  uniform float uTextureScale;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbientColor;
  uniform float uFogDensity;
  uniform float uHorizonAlt;
  uniform vec3 uFogColorLow, uFogColorMid, uFogColorFar;
  uniform float uExposure;
  uniform vec3 uLanternPos;
  uniform vec3 uLanternColor;
  uniform float uLanternRange;
  uniform float uLanternIntensity;
  varying vec3 vWorldPos;
  varying vec2 vUv;
  varying vec2 vDemUv;
  varying vec3 vMeshNormal;
  varying vec3 vTangent;
  varying vec3 vBitangent;
  varying float vEdgeFade;

  void main() {
    vec2 worldXZ = vWorldPos.xz;
    // Two scales of tiling, blended so close-up texture detail isn't a single
    // monotonous repeat. The far scale masks the wrap seam.
    vec2 tileUv = worldXZ / uTextureScale;
    vec2 tileUvFar = worldXZ / (uTextureScale * 6.0);
    float distView = length(cameraPosition - vWorldPos);
    // Closer = use the crisp local tile; farther = lean on the broader pattern
    // so per-pixel variance fades with distance (matches the "low-detail at
    // distance" instruction without forcing a hard mip cliff).
    float farBlend = mix(0.55, 0.92, smoothstep(80.0, 800.0, distView));

    vec3 cRock   = mix(texture2D(uTexRock,   tileUv).rgb, texture2D(uTexRock,   tileUvFar).rgb, farBlend);
    vec3 cGrass  = mix(texture2D(uTexGrass,  tileUv).rgb, texture2D(uTexGrass,  tileUvFar).rgb, farBlend);
    vec3 cGravel = mix(texture2D(uTexGravel, tileUv).rgb, texture2D(uTexGravel, tileUvFar).rgb, farBlend);
    vec3 cSand   = mix(texture2D(uTexSand,   tileUv).rgb, texture2D(uTexSand,   tileUvFar).rgb, farBlend);

    // Sharpen each tile's contrast — pushes "small rocks, light/dark breakup"
    // visible in the source PNGs into the rendered surface.
    cRock   = clamp((cRock   - 0.5) * 1.32 + 0.5, 0.0, 1.0);
    cGrass  = clamp((cGrass  - 0.5) * 1.18 + 0.5, 0.0, 1.0);
    cGravel = clamp((cGravel - 0.5) * 1.28 + 0.5, 0.0, 1.0);
    cSand   = clamp((cSand   - 0.5) * 1.10 + 0.5, 0.0, 1.0);

    // Chunky splat: bias each weight toward 0 or 1 so transitions between
    // ground types read as crisp boundaries instead of soft watercolor mixes.
    vec4 splat = texture2D(uSplat, vDemUv);
    splat = mix(splat, vec4(0.05, 0.0, 0.7, 0.25), vEdgeFade);
    splat = pow(splat, vec4(1.6));
    splat /= max(splat.r + splat.g + splat.b + splat.a, 1e-3);

    vec3 albedo = cRock * splat.r + cGrass * splat.g + cGravel * splat.b + cSand * splat.a;

    // Per-tile normal maps. Sample each one in tangent space, splat-blend by
    // material weights, then transform the result through the TBN basis into
    // world space. This is the standard tangent-space normal mapping setup —
    // it's what makes the maps actually shift the lighting (an additive
    // world-space perturbation barely changes NdotL for upward-facing terrain).
    float detailAmt = 1.0 - smoothstep(40.0, 480.0, distView);
    vec3 nRock   = texture2D(uNormalRock,   tileUv).rgb * 2.0 - 1.0;
    vec3 nGrass  = texture2D(uNormalGrass,  tileUv).rgb * 2.0 - 1.0;
    vec3 nGravel = texture2D(uNormalGravel, tileUv).rgb * 2.0 - 1.0;
    vec3 nSand   = texture2D(uNormalSand,   tileUv).rgb * 2.0 - 1.0;
    vec3 nTangent = nRock * splat.r + nGrass * splat.g + nGravel * splat.b + nSand * splat.a;
    // Boost the horizontal (R/G) deviation so the bumps actually read; leave
    // Z (out-of-surface, the B channel) alone.
    nTangent.xy *= 1.5;
    nTangent = normalize(nTangent);
    // TBN: transform tangent-space normal into world space.
    vec3 T = normalize(vTangent);
    vec3 B = normalize(vBitangent);
    vec3 Nw = normalize(vMeshNormal);
    vec3 nWorld = normalize(T * nTangent.x + B * nTangent.y + Nw * nTangent.z);
    // Optionally fade detail with distance so far slopes don't shimmer.
    vec3 n = normalize(mix(Nw, nWorld, detailAmt));

    // One strong direct sun. The fill ambient is small; a hemi-style ground
    // bounce (proportional to upward-facing normal) prevents the underside of
    // a slope from dropping to crushed black.
    float NdotL = clamp(dot(n, uSunDir), 0.0, 1.0);
    float upT = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 fill = uAmbientColor * mix(0.78, 1.25, upT);
    vec3 lit = albedo * (uSunColor * NdotL * 1.55 + fill);

    // Soft shadow floor — keep form readable without crushing to black.
    vec3 shadowFloor = uAmbientColor * 0.85;
    lit = max(lit, albedo * shadowFloor);

    // Lantern contribution: a local point-light pool tied to the bobcat. We
    // attenuate quadratically so the falloff has a hard, near-2000s edge.
    vec3 toLantern = uLanternPos - vWorldPos;
    float lanternD = length(toLantern);
    float lanternAtt = clamp(1.0 - lanternD / uLanternRange, 0.0, 1.0);
    lanternAtt *= lanternAtt;
    float lanternNdotL = clamp(dot(n, toLantern / max(lanternD, 0.0001)), 0.0, 1.0);
    lit += albedo * uLanternColor * (lanternNdotL * 0.85 + 0.30) * lanternAtt * uLanternIntensity;

    // Brightness lift on the lit colour (before fog).
    lit *= uExposure;

    // Aerial perspective: exponential extinction with two-stage colour mix.
    // Closer haze is a desaturated cool grey, deep distance is rayleigh-blue.
    // The mid colour gives the curve an inflection so terrain doesn't go from
    // tan straight to deep blue in one step.
    vec3 viewRay = normalize(vWorldPos - cameraPosition);
    float dist = length(cameraPosition - vWorldPos);
    // Denser extinction near the horizon and lower in the air column makes the
    // desert distance read less like linear screen fog and more like dust haze.
    float horizon = pow(clamp(1.0 - abs(viewRay.y), 0.0, 1.0), 1.7);
    float lowAir = 1.0 - smoothstep(520.0, 1500.0, vWorldPos.y);
    float densityBoost = 1.0 + horizon * 1.35 + lowAir * 0.45;
    float fogRaw = 1.0 - exp(-dist * uFogDensity * densityBoost);
    // Stepped band so the falloff has visible character — not a single smooth
    // ramp. Five soft bands; the floor() quantises while the +0.5 within-band
    // smooth keeps each step's edge soft enough not to read as a hard line.
    float fogBanded = floor(fogRaw * 5.0) / 5.0 + smoothstep(0.0, 0.2, fract(fogRaw * 5.0)) * 0.2;
    float fog = mix(fogRaw, fogBanded, 0.55);
    // Midground desaturate kick (40-70% fog): pulls the colour toward grey
    // before the deep blue takes over at the horizon.
    float fogStage = smoothstep(0.28, 0.82, fog);
    vec3 fogCol = mix(
      mix(uFogColorLow, uFogColorMid, smoothstep(0.0, 0.5, fog)),
      uFogColorFar,
      fogStage
    );
    float midDesat = smoothstep(0.30, 0.55, fog) * (1.0 - smoothstep(0.55, 0.82, fog));
    float fogLum = dot(fogCol, vec3(0.299, 0.587, 0.114));
    fogCol = mix(fogCol, vec3(fogLum), midDesat * 0.35);

    float sunScatter = pow(max(dot(viewRay, uSunDir), 0.0), 10.0);
    fogCol += uSunColor * sunScatter * horizon * fog * 0.22;
    float altT = smoothstep(0.0, uHorizonAlt, vWorldPos.y - cameraPosition.y + 800.0);
    fogCol = mix(fogCol, uFogColorFar, altT * 0.15);

    // Reduce the LIT scene's saturation as fog rises — the further away, the
    // less pure the underlying texture should read before being replaced by
    // sky colour.
    float litLum = dot(lit, vec3(0.299, 0.587, 0.114));
    lit = mix(lit, vec3(litLum), smoothstep(0.0, 0.7, fog) * 0.45);

    lit = mix(lit, fogCol, fog);

    // Local-contrast / split-tone grade. Compresses dynamic range a little,
    // adds a warm bias to highlights and a cool bias to shadows. Restrained.
    lit = (lit - 0.5) * 1.12 + 0.5;
    float gradeLum = clamp(dot(lit, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
    vec3 warmHi = vec3(1.04, 1.00, 0.93);
    vec3 coolLo = vec3(0.93, 0.97, 1.06);
    lit *= mix(coolLo, warmHi, smoothstep(0.18, 0.78, gradeLum));

    gl_FragColor = vec4(lit, 1.0);
  }
`;
