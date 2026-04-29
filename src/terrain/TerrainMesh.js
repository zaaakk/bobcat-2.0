import * as THREE from 'three';

/**
 * A single shader-displaced terrain mesh covering the DEM extents (and a fade ring
 * beyond, set by edgePadding, so the world doesn't look like a card on a table).
 *
 * Vertex grid is fixed (segments x segments); the heightmap texture is sampled in
 * the vertex shader. Splatmap blends four ground textures in the fragment shader.
 */
export function createTerrainMesh({ dem, heightTex, splatTex, groundTextures, normalAtlas = null, groundDetail = null, normalTex, detailNoise = null, segments = 512, edgePadding = 8000 }) {
  const planeWidth = dem.worldWidth + edgePadding * 2;
  const planeHeight = dem.worldHeight + edgePadding * 2;
  const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight, segments, segments);
  geometry.rotateX(-Math.PI / 2);

  const splatA = splatTex.splatA || splatTex;
  const splatB = splatTex.splatB || null;
  const uniforms = {
    uHeightmap: { value: heightTex },
    uSplat:  { value: splatA },
    uSplatB: { value: splatB || splatA }, // fallback so sampler always binds
    uHasSplatB: { value: splatB ? 1.0 : 0.0 },
    uTexRock:   { value: groundTextures.rock },
    uTexGrass:  { value: groundTextures.grass },
    uTexGravel: { value: groundTextures.gravel },
    uTexSand:   { value: groundTextures.sand },
    uTexRipBed: { value: groundTextures.riparianbed || groundTextures.sand },
    uTexRockyZ: { value: groundTextures.rockyZone   || groundTextures.rock },
    uTexSandyW: { value: groundTextures.sandyWash   || groundTextures.sand },
    // Per-tile normal maps packed into a single 4×2 atlas (one sampler so we
    // stay under the macOS WebGL fragment sampler limit of 16). Per-material
    // tile offsets are constants in the fragment shader.
    uNormalAtlas:  { value: normalAtlas || normalTex },
    uHasNormalAtlas: { value: normalAtlas ? 1.0 : 0.0 },
    uNormalAtlasGutter: { value: 2.0 / 256.0 },
    // Single grayscale detail texture, tiled across the world. Multiplied
    // into the splat-blended albedo at close range to break up the macro
    // tile repeat. One sampler, one tap, no atlas math.
    uGroundDetail:    { value: groundDetail || normalTex },
    uHasGroundDetail: { value: groundDetail ? 1.0 : 0.0 },
    uDetailTexSize:   { value: new THREE.Vector2(groundDetail?.image?.width || 256, groundDetail?.image?.height || 256) },
    uDetailStrength:  { value: 1.50 },  // how much to lean into it (0=off, 1=full)
    uDetailTileSize:  { value: 3.95 },  // metres per detail tile repeat
    uDetailFadeNear:  { value: 1.0 },   // m — full strength
    uDetailFadeFar:   { value: 10.0 },  // m — fully gone past this (kills mid-distance moiré)
    uDetailMipBias:   { value: -1.0 },  // positive = softer sooner
    uDetailAaStrength:{ value: 1.0 },   // suppresses undersampled shimmer bands
    uMinZ: { value: dem.minZ },
    uMaxZ: { value: dem.maxZ },
    uDemSize: { value: new THREE.Vector2(dem.worldWidth, dem.worldHeight) },
    uDemTexel: { value: new THREE.Vector2(1 / dem.width, 1 / dem.height) },
    uPlaneSize: { value: new THREE.Vector2(planeWidth, planeHeight) },
    uMeshSpacing: { value: new THREE.Vector2(planeWidth / segments, planeHeight / segments) },
    uTextureScale: { value: 51.5 }, // metres per texture repeat
    uTextureQuality: { value: 2.0 }, // 0=flat splat, 1=single-scale, 2=dual-scale
    uTerrainNormals: { value: 1.0 },
    uNormalFadeNear: { value: 90.0 },
    uNormalFadeFar:  { value: 360.0 },
    uSplatScale: { value: 1.0 },
    uSplatBias: { value: 3.3 },     // pow() applied to splat weights — higher = chunkier
    uSunDir: { value: new THREE.Vector3(0.5, 0.85, 0.2).normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.96, 0.85) },
    uAmbientColor: { value: new THREE.Color(0.42, 0.45, 0.55) },
    uFogDensity: { value: 0.00017 },     // 1/metres — base extinction rate
    uFogColorLow:  { value: new THREE.Color('#c9d1d8') },
    uFogColorMid:  { value: new THREE.Color('#96abc1') },
    uFogColorFar:  { value: new THREE.Color('#668db8') },
    uHorizonAlt:   { value: 1200.0 },    // metres above which sky tint dominates
    uExposure:     { value: 1.18 },      // pre-fog brightness lift on the lit albedo
    uDebugTerrainGrade: { value: 1.0 },
    uDebugRawFarFog: { value: 0.0 },
    uDebugGroundDetail: { value: 1.0 },
    uDebugDetailAA: { value: 1.0 },
    uDebugTextureContrast: { value: 1.0 },
    uDebugFarBlend: { value: 1.0 },
    uDebugPatchDither: { value: 0.0 },
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
    uRidgeAmp:         { value: detailNoise ? detailNoise.ridgeAmp      : 0.0 },
    uBedAmp:           { value: detailNoise ? detailNoise.bedAmp        : 0.0 },
    uBedPeriod:        { value: detailNoise ? detailNoise.bedPeriod     : 18.0 },
    uBedRiserWidth:    { value: detailNoise ? detailNoise.bedRiserWidth : 0.62 },
    uBedWarpAmp:       { value: detailNoise ? detailNoise.bedWarpAmp    : 0.0 },
    uBedSlopeLo:       { value: detailNoise ? detailNoise.bedSlopeLo    : 0.10 },
    uBedSlopeHi:       { value: detailNoise ? detailNoise.bedSlopeHi    : 0.24 },
    uDetailHas:        { value: detailNoise ? 1.0 : 0.0 },
    // Fine-tile detail: a small repeating noise texture sampled at world
    // coords / tileSize. Captures sub-meter features the broad world-aligned
    // texture can't represent (its 2048² over 21km caps at ~10m features).
    uFineTex:          { value: detailNoise && detailNoise.fine ? detailNoise.fine.texture : heightTex },
    uFineTileSize:     { value: detailNoise && detailNoise.fine ? detailNoise.fine.tileSize : 1.0 },
    uFineAmp:          { value: detailNoise && detailNoise.fine ? detailNoise.fine.amp     : 0.0 },
    // Carve layer: signed bowl-shaped depressions at each pool, applied
    // OUTSIDE the detail mask so the bowl always exists regardless of
    // ridge value. Texture stores values in [-1, 0]; uCarveAmp scales to
    // metres of carve depth.
    uCarveTex:         { value: detailNoise && detailNoise.carve ? detailNoise.carve.texture : heightTex },
    uCarveAmp:         { value: detailNoise && detailNoise.carve ? detailNoise.carve.amp : 0.0 },
    // Detail-patch parameters: only consumed when IS_PATCH is defined
    // (see DetailPatch.js). Live in the shared uniforms block so the patch
    // and base material can use a single object.
    uPatchCenter:      { value: new THREE.Vector2(0, 0) },
    uPatchHalfSize:    { value: 75.0 },
    // Macro-mask thresholds: detail multiplier = smoothstep(uMaskLo, uMaskHi, ridge).
    // ridge is the broad ridged-multifractal lookup in [0, 1]. Setting
    // uMaskLo = uMaskHi = 0 effectively disables the mask (everywhere full
    // detail). The defaults concentrate detail on actual ridges and leave
    // low-ridge plains smooth.
    uMaskLo:           { value: detailNoise ? detailNoise.maskLo : 0.20 },
    uMaskHi:           { value: detailNoise ? detailNoise.maskHi : 0.55 },
    // Bench-specific mask — stricter than the general one so the binary
    // bedding pulse only fires on clearly-ridged terrain. Avoids the
    // "stairsteps everywhere" artifact even when the user pushes bench
    // amplitude or shrinks bench period.
    uBenchMaskLo:      { value: detailNoise ? detailNoise.benchMaskLo : 0.55 },
    uBenchMaskHi:      { value: detailNoise ? detailNoise.benchMaskHi : 0.78 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: TERRAIN_VERT,
    fragmentShader: TERRAIN_FRAG,
    extensions: {
      derivatives: true,
      shaderTextureLOD: true,
    },
    side: THREE.FrontSide,
    fog: false
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; // always render — terrain is the world.
  mesh.receiveShadow = false;
  return { mesh, material, uniforms };
}

export const TERRAIN_VERT = /* glsl */`
  precision highp float;
  uniform sampler2D uHeightmap;
  uniform sampler2D uDetailTex;
  uniform sampler2D uFineTex;
  uniform sampler2D uCarveTex;
  uniform float uMinZ;
  uniform float uMaxZ;
  uniform vec2 uDemSize;
  uniform vec2 uDemTexel;
  uniform vec2 uDetailWorldSize;
  uniform vec2 uPlaneSize;
  uniform vec2 uMeshSpacing;
  uniform vec2 uPatchCenter;
  uniform float uRidgeAmp;
  uniform float uBedAmp;
  uniform float uBedPeriod;
  uniform float uBedRiserWidth;
  uniform float uBedWarpAmp;
  uniform float uBedSlopeLo;
  uniform float uBedSlopeHi;
  uniform float uDetailHas;
  uniform float uFineTileSize;
  uniform float uFineAmp;
  uniform float uCarveAmp;
  uniform float uPatchHalfSize;
  uniform float uMaskLo;
  uniform float uMaskHi;
  uniform float uBenchMaskLo;
  uniform float uBenchMaskHi;

  varying vec3 vWorldPos;
  varying vec2 vUv;
  varying vec2 vDemUv;
  varying vec3 vMeshNormal;
  varying vec3 vTangent;
  varying vec3 vBitangent;
  varying float vEdgeFade;

  float decodeHeight(float encodedH) {
    return encodedH * (uMaxZ - uMinZ) + uMinZ;
  }

  float sampleDem(vec2 worldXZ) {
    vec2 uv = (worldXZ / uDemSize) + 0.5;
    uv = clamp(uv, vec2(0.0), vec2(1.0));
    return decodeHeight(texture2D(uHeightmap, uv).r);
  }

  float sampleDemSlope(vec2 worldXZ) {
    vec2 uv = (worldXZ / uDemSize) + 0.5;
    uv = clamp(uv, vec2(0.0), vec2(1.0));
    vec2 duv = uDemTexel * 2.0;
    float hL = decodeHeight(texture2D(uHeightmap, clamp(uv - vec2(duv.x, 0.0), vec2(0.0), vec2(1.0))).r);
    float hR = decodeHeight(texture2D(uHeightmap, clamp(uv + vec2(duv.x, 0.0), vec2(0.0), vec2(1.0))).r);
    float hD = decodeHeight(texture2D(uHeightmap, clamp(uv - vec2(0.0, duv.y), vec2(0.0), vec2(1.0))).r);
    float hU = decodeHeight(texture2D(uHeightmap, clamp(uv + vec2(0.0, duv.y), vec2(0.0), vec2(1.0))).r);
    float sx = (hR - hL) / (4.0 * uDemSize.x * uDemTexel.x);
    float sz = (hU - hD) / (4.0 * uDemSize.y * uDemTexel.y);
    return length(vec2(sx, sz));
  }

  // Detail is added on top of every DEM sample so the rendered surface IS
  // (DEM + detail), and the per-vertex normal computed below picks up the
  // perturbation from the detail field automatically.
  //
  // Two layers, both unsigned (always lift the surface):
  //   1. ridged-multifractal lookup    — caprock bumps (texture)
  //   2. stepped-riser elevation transfer — caprock cliff/bench profile.
  //      Built from the base DEM height: the displacement
  //         (smoothstep(0, riserWidth, frac(h/period)) - frac(h/period)) * period
  //      turns a smooth slope into floor(h/period)*period + smoothstep band,
  //      i.e. a sequence of treads separated by near-vertical risers. The
  //      riser-width fraction sets how sharp the cliff is: small width →
  //      tighter, taller cliffs; larger width → softer ramps. Domain-warped
  //      by the ridge field so the bedding lines wander like real outcrops.
  float sampleDetail(vec2 worldXZ, float hDem) {
    if (uDetailHas < 0.5) return 0.0;
    // Broad layer: world-aligned ridged FBM in [0, 1] + stepped riser.
    vec2 uv = (worldXZ / uDetailWorldSize) + 0.5;
    uv = clamp(uv, vec2(0.0), vec2(1.0));
    float ridge = texture2D(uDetailTex, uv).r;
    float warpedH = hDem + ridge * uBedWarpAmp;
    float bedFrac = fract(warpedH / uBedPeriod);
    float riserCurve = smoothstep(0.0, uBedRiserWidth, bedFrac);
    float pulse = (riserCurve - bedFrac) * uBedPeriod;  // metres
    float demSlope = sampleDemSlope(worldXZ);
    float slopeMask = smoothstep(uBedSlopeLo, uBedSlopeHi, demSlope);
    float reliefMask = mix(0.08, 1.0, smoothstep(uBedSlopeLo * 0.80, uBedSlopeHi, demSlope));
    // Fine layer: tile-wrapped FBM in [-1, 1], domain-warped by the broad
    // ridge so the 16m tile pattern doesn't read as a regular grid.
    vec2 warpedXZ = worldXZ + vec2(ridge * 4.0, ridge * 3.0);
    float fine = texture2D(uFineTex, warpedXZ / uFineTileSize).r;
    // Two macro masks. The general one gates the smooth ridge + fine
    // layers (acceptable in transition zones). The bench mask is stricter:
    // the stepped riser amplifies the local slope at each riser band, so a
    // half-mask in a transition zone still produces visible cliff edges.
    // Confining the cliff/tread transfer to clearly-ridged areas keeps
    // transitions smooth and reads as caprock outcrops, not stairsteps.
    float mask      = smoothstep(uMaskLo,      uMaskHi,      ridge);
    float benchMask = smoothstep(uBenchMaskLo, uBenchMaskHi, ridge);
    return ridge * uRidgeAmp * mask * reliefMask
         + pulse * uBedAmp   * benchMask * slopeMask
         + fine  * uFineAmp  * mask * reliefMask;
  }

  // Detail-fade multiplier — keeps the detail patch (a 256-segment mesh
  // following the camera) from creating a seam where it meets the coarse
  // base mesh. At the patch centre the fade is 1 (full detail); over the
  // outer 15% it ramps to 0 so the patch's surface matches the base mesh's
  // surface (which has no detail at the same world coords). The base mesh
  // itself doesn't define IS_PATCH so the fade is constant 1 there.
  float patchDetailFade(vec2 worldXZ) {
    #ifdef IS_PATCH
      vec2 local = worldXZ - uPatchCenter;
      float maxAbs = max(abs(local.x), abs(local.y));
      return smoothstep(uPatchHalfSize, uPatchHalfSize * 0.85, maxAbs);
    #else
      return 1.0;
    #endif
  }

  // Carve sample: signed dip stored in a world-aligned texture, in metres
  // after multiplying by uCarveAmp. Always negative or zero. We apply this
  // OUTSIDE the detail mask so even fully-masked-out smooth areas still
  // get the bowl carved for any pools that fall there.
  float sampleCarve(vec2 worldXZ) {
    vec2 uv = (worldXZ / uDetailWorldSize) + 0.5;
    uv = clamp(uv, vec2(0.0), vec2(1.0));
    return texture2D(uCarveTex, uv).r * uCarveAmp;
  }

  float sampleHEdge(vec2 worldXZ) {
    // Drop both the DEM and the detail through the edge fade so the padding
    // ring stays clean (no stray noise outside the world).
    float hDem = sampleDem(worldXZ);
    vec2 inside = abs(worldXZ) - uDemSize * 0.5;
    float outside = max(max(inside.x, inside.y), 0.0);
    float ef = clamp(outside / 4000.0, 0.0, 1.0);
    ef = ef * ef;
    float baseH = mix(hDem, hDem - 80.0, ef);
    float detailMul = (1.0 - ef) * patchDetailFade(worldXZ);
    return baseH + sampleDetail(worldXZ, hDem) * detailMul
                 + sampleCarve(worldXZ) * (1.0 - ef);
  }

  void main() {
    vec3 p = position;
    // World-XZ via modelMatrix so this shader works for both the static
    // base mesh (mesh.position = 0) and a translated detail patch.
    vec4 wpInit = modelMatrix * vec4(p, 1.0);
    vec2 worldXZ = wpInit.xz;

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

export const TERRAIN_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uSplat;
  uniform sampler2D uSplatB;
  uniform float uHasSplatB;
  uniform float uSplatBias;
  uniform sampler2D uTexRock;
  uniform sampler2D uTexGrass;
  uniform sampler2D uTexGravel;
  uniform sampler2D uTexSand;
  uniform sampler2D uTexRipBed;
  uniform sampler2D uTexRockyZ;
  uniform sampler2D uTexSandyW;
  uniform sampler2D uNormalAtlas;
  uniform float uHasNormalAtlas;
  uniform float uNormalAtlasGutter;
  uniform sampler2D uGroundDetail;
  uniform float uHasGroundDetail;
  uniform vec2 uDetailTexSize;
  uniform float uDetailStrength;
  uniform float uDetailTileSize;
  uniform float uDetailFadeNear;
  uniform float uDetailFadeFar;
  uniform float uDetailMipBias;
  uniform float uDetailAaStrength;
  uniform float uTextureScale;
  uniform float uTextureQuality;
  uniform float uTerrainNormals;
  uniform float uNormalFadeNear;
  uniform float uNormalFadeFar;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbientColor;
  uniform float uFogDensity;
  uniform float uHorizonAlt;
  uniform vec3 uFogColorLow, uFogColorMid, uFogColorFar;
  uniform float uExposure;
  uniform float uDebugTerrainGrade;
  uniform float uDebugRawFarFog;
  uniform float uDebugGroundDetail;
  uniform float uDebugDetailAA;
  uniform float uDebugTextureContrast;
  uniform float uDebugFarBlend;
  uniform float uDebugPatchDither;
  uniform vec3 uLanternPos;
  uniform vec3 uLanternColor;
  uniform float uLanternRange;
  uniform float uLanternIntensity;
  uniform vec2 uPatchCenter;
  uniform float uPatchHalfSize;
  varying vec3 vWorldPos;
  varying vec2 vUv;
  varying vec2 vDemUv;
  varying vec3 vMeshNormal;
  varying vec3 vTangent;
  varying vec3 vBitangent;
  varying float vEdgeFade;

  float ditherHash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec2 worldXZ = vWorldPos.xz;
    // Hide the coarse base near the patch centre so it cannot occlude the
    // high-res patch/bobcat. Fade the base back in with a dithered transition
    // near the far patch edge, so coarse triangles do not appear as a hard
    // stretching band over detailed terrain. Dithered discard keeps the
    // terrain opaque/depth-correct; true alpha blending would create sorting
    // problems against plants, water and the bobcat.
    #ifndef IS_PATCH
      vec2 patchLocal = worldXZ - uPatchCenter;
      float patchEdge = max(abs(patchLocal.x), abs(patchLocal.y));
      float fadeIn = smoothstep(uPatchHalfSize * 0.72, uPatchHalfSize * 0.92, patchEdge);
      // Hash in world-space (NOT screen-space) so the dither pattern locks
      // to the ground rather than reading as an overlay on the monitor. No
      // floor() — we want per-pixel speckle, not quantized world cells, or
      // each cell discards as a chunky patch instead of a fine dot.
      if (uDebugPatchDither > 0.5 && ditherHash(worldXZ * 73.0) > fadeIn) {
        discard;
      }
      if (uDebugPatchDither < 0.5 && fadeIn < 0.5) {
        discard;
      }
    #endif

    if (uDebugRawFarFog > 0.5) {
      gl_FragColor = vec4(uFogColorFar, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    // Two scales of tiling, blended so close-up texture detail isn't a single
    // monotonous repeat. The far scale masks the wrap seam.
    vec2 tileUv = worldXZ / uTextureScale;
    vec2 tileUvFar = worldXZ / (uTextureScale * 6.0);
    float distView = length(cameraPosition - vWorldPos);
    // Closer = use the crisp local tile; farther = lean on the broader pattern
    // so per-pixel variance fades with distance (matches the "low-detail at
    // distance" instruction without forcing a hard mip cliff).
    float farBlend = mix(0.55, 0.92, smoothstep(80.0, 800.0, distView));

    vec3 cRock   = texture2D(uTexRock,   tileUv).rgb;
    vec3 cGrass  = texture2D(uTexGrass,  tileUv).rgb;
    vec3 cGravel = texture2D(uTexGravel, tileUv).rgb;
    vec3 cSand   = texture2D(uTexSand,   tileUv).rgb;
    vec3 cRipBed = texture2D(uTexRipBed, tileUv).rgb;
    vec3 cRockyZ = texture2D(uTexRockyZ, tileUv).rgb;
    vec3 cSandyW = texture2D(uTexSandyW, tileUv).rgb;
    if (uTextureQuality > 1.5 && uDebugFarBlend > 0.5) {
      cRock   = mix(cRock,   texture2D(uTexRock,   tileUvFar).rgb, farBlend);
      cGrass  = mix(cGrass,  texture2D(uTexGrass,  tileUvFar).rgb, farBlend);
      cGravel = mix(cGravel, texture2D(uTexGravel, tileUvFar).rgb, farBlend);
      cSand   = mix(cSand,   texture2D(uTexSand,   tileUvFar).rgb, farBlend);
      cRipBed = mix(cRipBed, texture2D(uTexRipBed, tileUvFar).rgb, farBlend);
      cRockyZ = mix(cRockyZ, texture2D(uTexRockyZ, tileUvFar).rgb, farBlend);
      cSandyW = mix(cSandyW, texture2D(uTexSandyW, tileUvFar).rgb, farBlend);
    }

    if (uDebugTextureContrast > 0.5) {
      // Sharpen each tile's contrast — pushes "small rocks, light/dark breakup"
      // visible in the source PNGs into the rendered surface.
      cRock   = clamp((cRock   - 0.5) * 1.32 + 0.5, 0.0, 1.0);
      cGrass  = clamp((cGrass  - 0.5) * 1.18 + 0.5, 0.0, 1.0);
      cGravel = clamp((cGravel - 0.5) * 1.28 + 0.5, 0.0, 1.0);
      cSand   = clamp((cSand   - 0.5) * 1.10 + 0.5, 0.0, 1.0);
      cRipBed = clamp((cRipBed - 0.5) * 1.30 + 0.5, 0.0, 1.0);
      cRockyZ = clamp((cRockyZ - 0.5) * 1.28 + 0.5, 0.0, 1.0);
      cSandyW = clamp((cSandyW - 0.5) * 1.18 + 0.5, 0.0, 1.0);
    }

    // Chunky splat: bias each weight toward 0 or 1 so transitions between
    // ground types read as crisp boundaries instead of soft watercolor mixes.
    vec4 splat  = texture2D(uSplat,  vDemUv);
    vec4 splatB = uHasSplatB > 0.5 ? texture2D(uSplatB, vDemUv) : vec4(0.0);
    splat  = mix(splat,  vec4(0.05, 0.0, 0.7, 0.25), vEdgeFade);
    splatB = mix(splatB, vec4(0.0), vEdgeFade);
    splat  = pow(splat,  vec4(uSplatBias));
    splatB = pow(splatB, vec4(uSplatBias));
    float splatTotal = max(splat.r + splat.g + splat.b + splat.a + splatB.r + splatB.g + splatB.b, 1e-3);
    splat  /= splatTotal;
    splatB /= splatTotal;

    vec3 albedo =
        cRock   * splat.r + cGrass   * splat.g + cGravel  * splat.b + cSand    * splat.a
      + cRipBed * splatB.r + cRockyZ * splatB.g + cSandyW * splatB.b;
    if (uTextureQuality < 0.5) {
      albedo = vec3(0.30, 0.25, 0.19) * splat.r
             + vec3(0.36, 0.33, 0.22) * splat.g
             + vec3(0.42, 0.37, 0.29) * splat.b
             + vec3(0.58, 0.50, 0.36) * splat.a
             + vec3(0.32, 0.27, 0.20) * splatB.r
             + vec3(0.24, 0.22, 0.19) * splatB.g
             + vec3(0.50, 0.43, 0.31) * splatB.b;
    }

    // Close-range detail: one grayscale tile, sampled at world-space coords.
    // Use explicit distance LOD instead of implicit screen-space derivatives:
    // near Nyquist, the implicit per-triangle mip choice beats against the
    // terrain mesh and creates curved smear bands.
    float detailFade = uHasGroundDetail * uDebugGroundDetail * uDetailStrength
                     * (1.0 - smoothstep(uDetailFadeNear, uDetailFadeFar, distView));
    if (detailFade > 0.001) {
      vec2 detailUv = worldXZ / max(uDetailTileSize, 0.001);
      float detailFootprint = max(length(dFdx(detailUv * uDetailTexSize)), length(dFdy(detailUv * uDetailTexSize)));
      float detailAlias = clamp(log2(max(detailFootprint, 1.0)) - 1.0, 0.0, 1.0);
      float detailAa = clamp(uDetailAaStrength * uDebugDetailAA, 0.0, 2.0);
      detailFade *= clamp(1.0 - detailAlias * detailAa, 0.0, 1.0);
      float footprintLod = log2(max(detailFootprint, 1.0));
      float distanceLod = log2(max(distView, 1.0) / max(uDetailTileSize, 0.25));
      float effectiveMipBias = mix(uDetailMipBias, max(uDetailMipBias, 0.0), detailAlias);
      float detailLod = clamp(
        max(distanceLod, footprintLod)
          + effectiveMipBias
          + detailAlias * detailAa * 1.5,
        0.0,
        7.0
      );
      float d = texture2DLodEXT(uGroundDetail, detailUv, detailLod).r;
      // Centred multiplier: 1.0 = no change, <1 darkens, >1 brightens. Light
      // crevices read as occlusion; light grains as catchlight.
      albedo *= mix(1.0, d * 2.0, detailFade);
    }

    // Per-tile normal maps. Sample each one in tangent space, splat-blend by
    // material weights, then transform the result through the TBN basis into
    // world space. This is the standard tangent-space normal mapping setup —
    // it's what makes the maps actually shift the lighting (an additive
    // world-space perturbation barely changes NdotL for upward-facing terrain).
    float detailAmt = (1.0 - smoothstep(uNormalFadeNear, uNormalFadeFar, distView)) * uTerrainNormals;
    float normalEnabled = step(0.5, uTextureQuality) * step(0.5, uTerrainNormals) * uHasNormalAtlas;
    // Same atlas packing + same textureGrad trick as grit. Without the
    // explicit derivatives, mipmap selection gets garbage at tile seams.
    vec2 nTs = vec2(0.25, 0.50);
    vec2 nDUVx = dFdx(tileUv) * nTs;
    vec2 nDUVy = dFdy(tileUv) * nTs;
    vec2 nLocal01 = clamp(fract(tileUv), vec2(uNormalAtlasGutter), vec2(1.0 - uNormalAtlasGutter));
    vec2 nLocal = nLocal01 * nTs;
    vec3 nRock   = normalEnabled > 0.5 ? texture2DGradEXT(uNormalAtlas, nLocal + vec2(0.00, 0.00), nDUVx, nDUVy).rgb * 2.0 - 1.0 : vec3(0.0, 0.0, 1.0);
    vec3 nGrass  = normalEnabled > 0.5 ? texture2DGradEXT(uNormalAtlas, nLocal + vec2(0.25, 0.00), nDUVx, nDUVy).rgb * 2.0 - 1.0 : vec3(0.0, 0.0, 1.0);
    vec3 nGravel = normalEnabled > 0.5 ? texture2DGradEXT(uNormalAtlas, nLocal + vec2(0.50, 0.00), nDUVx, nDUVy).rgb * 2.0 - 1.0 : vec3(0.0, 0.0, 1.0);
    vec3 nSand   = normalEnabled > 0.5 ? texture2DGradEXT(uNormalAtlas, nLocal + vec2(0.75, 0.00), nDUVx, nDUVy).rgb * 2.0 - 1.0 : vec3(0.0, 0.0, 1.0);
    vec3 nRipBed = normalEnabled > 0.5 ? texture2DGradEXT(uNormalAtlas, nLocal + vec2(0.00, 0.50), nDUVx, nDUVy).rgb * 2.0 - 1.0 : vec3(0.0, 0.0, 1.0);
    vec3 nRockyZ = normalEnabled > 0.5 ? texture2DGradEXT(uNormalAtlas, nLocal + vec2(0.25, 0.50), nDUVx, nDUVy).rgb * 2.0 - 1.0 : vec3(0.0, 0.0, 1.0);
    vec3 nSandyW = normalEnabled > 0.5 ? texture2DGradEXT(uNormalAtlas, nLocal + vec2(0.50, 0.50), nDUVx, nDUVy).rgb * 2.0 - 1.0 : vec3(0.0, 0.0, 1.0);
    vec3 nTangent =
        nRock   * splat.r + nGrass   * splat.g + nGravel  * splat.b + nSand    * splat.a
      + nRipBed * splatB.r + nRockyZ * splatB.g + nSandyW * splatB.b;
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

    if (uDebugTerrainGrade > 0.5) {
      // Local-contrast / split-tone grade. Runs before fog so the configured
      // air colour can still own the horizon.
      lit = (lit - 0.5) * 1.06 + 0.5;
      float gradeLum = clamp(dot(lit, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
      vec3 warmHi = vec3(1.02, 1.00, 0.965);
      vec3 coolLo = vec3(0.965, 0.985, 1.03);
      lit *= mix(coolLo, warmHi, smoothstep(0.18, 0.78, gradeLum));
    }

    // Aerial perspective: one monotonic distance factor and a guaranteed
    // far-colour takeover. This keeps the midday horizon from retaining dark
    // terrain albedo while still allowing near/mid dust colour variation.
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
    float altT = smoothstep(0.0, uHorizonAlt, vWorldPos.y - cameraPosition.y + 800.0);
    fogCol = mix(fogCol, uFogColorFar, altT * 0.15);

    float horizonTakeover = smoothstep(0.85, 1.0, fog);
    fogCol = mix(fogCol, uFogColorFar, horizonTakeover);
    fog = mix(fog, 1.0, horizonTakeover);

    // Reduce the LIT scene's saturation as fog rises — the further away, the
    // less pure the underlying texture should read before being replaced by
    // sky colour.
    float litLum = dot(lit, vec3(0.299, 0.587, 0.114));
    lit = mix(lit, vec3(litLum), smoothstep(0.0, 0.7, fog) * 0.45);

    lit = mix(lit, fogCol, fog);

    gl_FragColor = vec4(lit, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
