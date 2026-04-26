import * as THREE from 'three';

/**
 * A single shader-displaced terrain mesh covering the DEM extents (and a fade ring
 * beyond, set by edgePadding, so the world doesn't look like a card on a table).
 *
 * Vertex grid is fixed (segments x segments); the heightmap texture is sampled in
 * the vertex shader. Splatmap blends four ground textures in the fragment shader.
 */
export function createTerrainMesh({ dem, heightTex, splatTex, groundTextures, normalTex, segments = 512, edgePadding = 8000 }) {
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
    uNormal: { value: normalTex },
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
    uFogDensity: { value: 0.00012 },     // 1/metres — exponential fog rate
    uFogColorLow:  { value: new THREE.Color('#bcc7d4') },
    uFogColorMid:  { value: new THREE.Color('#7a9dc6') },
    uFogColorFar:  { value: new THREE.Color('#4373b3') },
    uHorizonAlt:   { value: 1200.0 }     // metres above which sky tint dominates
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
  uniform vec2 uDemSize;
  uniform vec2 uPlaneSize;
  uniform vec2 uMeshSpacing;

  // Hash + value-noise from Inigo Quilez. Cheap and tile-free.
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise2(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  // Mesoscale terrain detail: fractal brownian motion over (worldXZ).
  // Returns metres of displacement, peak ≈ 0.9 m at ~3-12 m wavelength.
  float terrainDetail(vec2 worldXZ) {
    float n = 0.0;
    float a = 0.55, f = 0.10;
    for (int k = 0; k < 4; k++) {
      n += a * (noise2(worldXZ * f) - 0.5);
      f *= 2.13; a *= 0.55;
    }
    return n * 1.6;
  }
  varying vec3 vWorldPos;
  varying vec2 vUv;
  varying vec2 vDemUv;
  varying vec3 vMeshNormal;
  varying float vEdgeFade;

  float sampleH(vec2 worldXZ) {
    vec2 uv = (worldXZ / uDemSize) + 0.5;
    uv = clamp(uv, vec2(0.0), vec2(1.0));
    return texture2D(uHeightmap, uv).r;
  }

  float sampleHEdge(vec2 worldXZ) {
    float h = sampleH(worldXZ);
    vec2 inside = abs(worldXZ) - uDemSize * 0.5;
    float outside = max(max(inside.x, inside.y), 0.0);
    float ef = clamp(outside / 4000.0, 0.0, 1.0);
    ef = ef * ef;
    return mix(h, h - 80.0, ef);
  }

  void main() {
    vec3 p = position;
    vec2 worldXZ = p.xz;

    vec2 inside = abs(worldXZ) - uDemSize * 0.5;
    float outside = max(max(inside.x, inside.y), 0.0);
    float edgeFade = clamp(outside / 4000.0, 0.0, 1.0);
    edgeFade = edgeFade * edgeFade;

    float h = sampleH(worldXZ);
    h = mix(h, h - 80.0, edgeFade);
    // Add a small mesoscale displacement so the terrain doesn't read as flat
    // angled planes between vertices. Fades out near the DEM edge so we don't
    // amplify edge-fade discontinuities.
    h += terrainDetail(worldXZ) * (1.0 - edgeFade);
    p.y = h;

    // Per-vertex normal computed from heightmap sampled at mesh-vertex spacing —
    // this matches the rasterised surface (which is linear between vertices).
    // Interpolating this varying across each triangle gives Phong shading that
    // never disagrees with the underlying geometry, so triangle edges do not
    // show up as lighting seams.
    float dx = uMeshSpacing.x;
    float dz = uMeshSpacing.y;
    float detailFade = 1.0 - edgeFade;
    float hL = sampleHEdge(worldXZ - vec2(dx, 0.0)) + terrainDetail(worldXZ - vec2(dx, 0.0)) * detailFade;
    float hR = sampleHEdge(worldXZ + vec2(dx, 0.0)) + terrainDetail(worldXZ + vec2(dx, 0.0)) * detailFade;
    float hD = sampleHEdge(worldXZ - vec2(0.0, dz)) + terrainDetail(worldXZ - vec2(0.0, dz)) * detailFade;
    float hU = sampleHEdge(worldXZ + vec2(0.0, dz)) + terrainDetail(worldXZ + vec2(0.0, dz)) * detailFade;
    vec3 tx = vec3(2.0 * dx, hR - hL, 0.0);
    vec3 tz = vec3(0.0, hU - hD, 2.0 * dz);
    vMeshNormal = normalize(cross(tz, tx));

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
  uniform sampler2D uNormal;
  uniform float uTextureScale;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbientColor;
  uniform float uFogDensity;
  uniform float uHorizonAlt;
  uniform vec3 uFogColorLow, uFogColorMid, uFogColorFar;
  varying vec3 vWorldPos;
  varying vec2 vUv;
  varying vec2 vDemUv;
  varying vec3 vMeshNormal;
  varying float vEdgeFade;

  void main() {
    vec2 worldXZ = vWorldPos.xz;
    // Two scales of tiling, blended so close-up texture detail isn't a single
    // monotonous repeat. The far scale also masks the seam between tile copies.
    vec2 tileUv = worldXZ / uTextureScale;
    vec2 tileUvFar = worldXZ / (uTextureScale * 6.0);

    vec3 cRock   = mix(texture2D(uTexRock,   tileUv).rgb, texture2D(uTexRock,   tileUvFar).rgb, 0.45);
    vec3 cGrass  = mix(texture2D(uTexGrass,  tileUv).rgb, texture2D(uTexGrass,  tileUvFar).rgb, 0.45);
    vec3 cGravel = mix(texture2D(uTexGravel, tileUv).rgb, texture2D(uTexGravel, tileUvFar).rgb, 0.45);
    vec3 cSand   = mix(texture2D(uTexSand,   tileUv).rgb, texture2D(uTexSand,   tileUvFar).rgb, 0.45);

    vec4 splat = texture2D(uSplat, vDemUv);
    splat = mix(splat, vec4(0.05, 0.0, 0.7, 0.25), vEdgeFade);

    vec3 albedo = cRock * splat.r + cGrass * splat.g + cGravel * splat.b + cSand * splat.a;
    // Cool the close-up albedo slightly — the bare-sand desert reads too warm
    // by default. This is a small tint, not a desaturation.
    albedo *= vec3(0.95, 0.97, 1.02);

    // Detail normal — small perturbation, distance-faded so the repeating tile
    // pattern doesn't make obvious bands at glancing angles.
    float detailDist = length(cameraPosition - vWorldPos);
    float detailAmt = 0.18 * (1.0 - smoothstep(40.0, 220.0, detailDist));
    vec3 detail = texture2D(uNormal, tileUv * 0.5).rgb * 2.0 - 1.0;
    detail.y = abs(detail.y);
    vec3 n = normalize(vMeshNormal + detail * detailAmt);

    float NdotL = clamp(dot(n, uSunDir), 0.0, 1.0);
    vec3 lit = albedo * (uSunColor * NdotL + uAmbientColor);

    // Aerial perspective: exponential extinction with two-stage colour mix.
    // Closer haze is a desaturated cool grey, deep distance is rayleigh-blue.
    // The mid colour gives the curve an inflection so terrain doesn't go from
    // tan straight to deep blue in one step.
    float dist = length(cameraPosition - vWorldPos);
    float fog = 1.0 - exp(-dist * uFogDensity);            // 0..1
    float fogStage = smoothstep(0.35, 0.85, fog);          // late-stage bias
    vec3 fogCol = mix(
      mix(uFogColorLow, uFogColorMid, smoothstep(0.0, 0.5, fog)),
      uFogColorFar,
      fogStage
    );
    // Slight altitude tint — high terrain reads cooler/bluer because more air column.
    float altT = smoothstep(0.0, uHorizonAlt, vWorldPos.y - cameraPosition.y + 800.0);
    fogCol = mix(fogCol, uFogColorFar, altT * 0.15);
    lit = mix(lit, fogCol, fog);

    gl_FragColor = vec4(lit, 1.0);
  }
`;
