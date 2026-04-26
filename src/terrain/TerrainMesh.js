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
    uTextureScale: { value: 24.0 }, // metres per texture repeat
    uSplatScale: { value: 1.0 },
    uSunDir: { value: new THREE.Vector3(0.5, 0.85, 0.2).normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.96, 0.85) },
    uAmbientColor: { value: new THREE.Color(0.42, 0.45, 0.55) },
    uFogNear: { value: 600.0 },
    uFogMid: { value: 4000.0 },
    uFogFar: { value: 18000.0 },
    uFogColorNear: { value: new THREE.Color(0.85, 0.82, 0.75) },
    uFogColorFar: { value: new THREE.Color(0.70, 0.78, 0.86) }
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
  varying vec3 vWorldPos;
  varying vec2 vUv;
  varying vec2 vDemUv;
  varying float vEdgeFade;

  // sample heightmap at world-space xz; clamp UV to [0,1].
  float sampleH(vec2 worldXZ) {
    vec2 uv = (worldXZ / uDemSize) + 0.5;
    uv = clamp(uv, vec2(0.0), vec2(1.0));
    return texture2D(uHeightmap, uv).r;
  }

  void main() {
    vec3 p = position;
    vec2 worldXZ = p.xz;

    // Edge fade outside DEM bounds: blend height down to a basin so far horizon
    // doesn't read as a sharp cliff. Within bounds, edgeFade = 0 (full height).
    vec2 inside = abs(worldXZ) - uDemSize * 0.5;
    float outside = max(max(inside.x, inside.y), 0.0);
    float edgeFade = clamp(outside / 4000.0, 0.0, 1.0);
    edgeFade = edgeFade * edgeFade;

    float h = sampleH(worldXZ);
    h = mix(h, h - 80.0, edgeFade);
    p.y = h;

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
  uniform sampler2D uHeightmap;
  uniform vec2 uDemSize;
  uniform vec2 uDemTexel;
  uniform float uTextureScale;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbientColor;
  uniform float uFogNear, uFogMid, uFogFar;
  uniform vec3 uFogColorNear, uFogColorFar;
  varying vec3 vWorldPos;
  varying vec2 vUv;
  varying vec2 vDemUv;
  varying float vEdgeFade;

  // Recompute terrain normal in fragment from heightmap derivatives (sharper than
  // shading the coarse vertex grid).
  vec3 computeNormal(vec2 worldXZ) {
    vec2 uv = clamp(worldXZ / uDemSize + 0.5, 0.0, 1.0);
    float hL = texture2D(uHeightmap, uv - vec2(uDemTexel.x, 0.0)).r;
    float hR = texture2D(uHeightmap, uv + vec2(uDemTexel.x, 0.0)).r;
    float hD = texture2D(uHeightmap, uv - vec2(0.0, uDemTexel.y)).r;
    float hU = texture2D(uHeightmap, uv + vec2(0.0, uDemTexel.y)).r;
    // World-space pixel size:
    float dx = uDemSize.x * uDemTexel.x;
    float dz = uDemSize.y * uDemTexel.y;
    vec3 t = vec3(2.0 * dx, hR - hL, 0.0);
    vec3 b = vec3(0.0, hU - hD, 2.0 * dz);
    return normalize(cross(b, t));
  }

  void main() {
    vec2 worldXZ = vWorldPos.xz;
    vec2 tileUv = worldXZ / uTextureScale;
    vec2 tileUvFar = worldXZ / (uTextureScale * 6.0);

    vec3 cRock   = mix(texture2D(uTexRock,   tileUv).rgb, texture2D(uTexRock,   tileUvFar).rgb, 0.4);
    vec3 cGrass  = mix(texture2D(uTexGrass,  tileUv).rgb, texture2D(uTexGrass,  tileUvFar).rgb, 0.4);
    vec3 cGravel = mix(texture2D(uTexGravel, tileUv).rgb, texture2D(uTexGravel, tileUvFar).rgb, 0.4);
    vec3 cSand   = mix(texture2D(uTexSand,   tileUv).rgb, texture2D(uTexSand,   tileUvFar).rgb, 0.4);

    vec4 splat = texture2D(uSplat, vDemUv);
    // Beyond DEM bounds, force gravel/sand mix so we don't see splatmap stretching.
    splat = mix(splat, vec4(0.05, 0.0, 0.7, 0.25), vEdgeFade);

    vec3 albedo = cRock * splat.r + cGrass * splat.g + cGravel * splat.b + cSand * splat.a;

    vec3 n = computeNormal(worldXZ);
    // Detail normal perturbs N slightly. Only use detail near.
    vec3 detail = texture2D(uNormal, tileUv * 0.5).rgb * 2.0 - 1.0;
    detail.y = abs(detail.y); // keep upright
    n = normalize(mix(n, normalize(n + detail * 0.25), 0.5));

    float NdotL = clamp(dot(n, uSunDir), 0.0, 1.0);
    vec3 lit = albedo * (uSunColor * NdotL + uAmbientColor);

    // Aerial perspective.
    float dist = length(cameraPosition - vWorldPos);
    float fNear = smoothstep(uFogNear, uFogMid, dist);
    float fFar  = smoothstep(uFogMid, uFogFar, dist);
    vec3 fogCol = mix(uFogColorNear, uFogColorFar, fFar);
    lit = mix(lit, fogCol, fNear * 0.4 + fFar * 0.6);

    gl_FragColor = vec4(lit, 1.0);
  }
`;
