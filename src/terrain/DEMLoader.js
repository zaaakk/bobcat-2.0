/**
 * DEM loader. Reads a stitched Mapzen "terrarium" PNG produced by
 * scripts/fetch_dem.mjs along with its sidecar JSON of bbox/world dimensions.
 *
 * height_m = (R*256 + G + B/256) - 32768
 *
 * Returns { data: Float32Array, width, height, minZ, maxZ, pixelSizeX, pixelSizeY,
 *           worldWidth, worldHeight }.
 */
export async function loadDEM(pngUrl, jsonUrl, onProgress) {
  if (onProgress) onProgress(0.05);
  const meta = await fetch(jsonUrl).then(r => r.json());
  if (onProgress) onProgress(0.1);

  const img = await loadImage(pngUrl, p => onProgress && onProgress(0.1 + p * 0.6));
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, img.width, img.height).data;
  if (onProgress) onProgress(0.85);

  const width = img.width, height = img.height;
  const data = new Float32Array(width * height);
  let minZ = Infinity, maxZ = -Infinity;

  // Mapzen tiles are north-up, top-to-bottom. We flip vertically so that DEM
  // index (0,0) corresponds to world south-west — matches the rest of the engine.
  for (let y = 0; y < height; y++) {
    const srcY = (height - 1 - y);
    for (let x = 0; x < width; x++) {
      const o = (srcY * width + x) * 4;
      const r = pixels[o + 0];
      const g = pixels[o + 1];
      const b = pixels[o + 2];
      const z = (r * 256 + g + b / 256) - 32768;
      data[y * width + x] = z;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  if (onProgress) onProgress(1);

  return {
    data,
    width,
    height,
    minZ,
    maxZ,
    pixelSizeX: meta.pixelSizeMeters,
    pixelSizeY: meta.pixelSizeMeters,
    worldWidth: meta.worldWidthMeters,
    worldHeight: meta.worldHeightMeters,
    bbox: meta.bbox
  };
}

function loadImage(src, onProgress) {
  // Use fetch to track progress, then create a Blob URL for the image element.
  return new Promise(async (resolve, reject) => {
    try {
      const res = await fetch(src);
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (total && onProgress) onProgress(received / total);
      }
      const blob = new Blob(chunks, { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    } catch (e) { reject(e); }
  });
}

/**
 * Heightmap texture as R16F (half-float). Filtering R16F is core WebGL2 — it
 * doesn't need OES_texture_float_linear (which R32F does). We saw R32F return
 * zeroed samples on some configurations (notably headless Chromium).
 */
export function heightmapTexture(THREE, dem) {
  const halfData = new Uint16Array(dem.data.length);
  for (let i = 0; i < dem.data.length; i++) {
    halfData[i] = THREE.DataUtils.toHalfFloat(dem.data[i]);
  }
  const tex = new THREE.DataTexture(
    halfData, dem.width, dem.height,
    THREE.RedFormat, THREE.HalfFloatType
  );
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  tex.userData = { heightOffset: 0, heightScale: 1 };
  return tex;
}

/**
 * Bilinear height sample matching the GPU's texture sampling convention. The
 * GPU treats pixel n as living at uv = (n + 0.5) / W, so a sample at uv = 0.5
 * blends pixels W/2-1 and W/2 equally. Without the −0.5 offset, JS and shader
 * disagree by half a pixel — enough that the bobcat ends up below the rendered
 * terrain on a slope.
 */
export function sampleHeight(dem, x, z) {
  const u = (x / dem.worldWidth + 0.5) * dem.width - 0.5;
  const v = (z / dem.worldHeight + 0.5) * dem.height - 0.5;
  const x0 = Math.floor(u), y0 = Math.floor(v);
  const fx = u - x0, fy = v - y0;
  const cx0 = Math.max(0, Math.min(dem.width - 1, x0));
  const cy0 = Math.max(0, Math.min(dem.height - 1, y0));
  const cx1 = Math.max(0, Math.min(dem.width - 1, x0 + 1));
  const cy1 = Math.max(0, Math.min(dem.height - 1, y0 + 1));
  const h00 = dem.data[cy0 * dem.width + cx0];
  const h10 = dem.data[cy0 * dem.width + cx1];
  const h01 = dem.data[cy1 * dem.width + cx0];
  const h11 = dem.data[cy1 * dem.width + cx1];
  const h0 = h00 * (1 - fx) + h10 * fx;
  const h1 = h01 * (1 - fx) + h11 * fx;
  return h0 * (1 - fy) + h1 * fy;
}

/**
 * Sample the height the *rendered terrain mesh* actually draws at (x, z).
 *
 * The mesh's vertices are a regular grid; the rasterizer interpolates each
 * triangle's three vertices linearly (NOT bilinearly across the quad). Three's
 * PlaneGeometry triangulates with the V01↔V10 diagonal:
 *   • below diagonal (fx + fy < 1): V00, V01, V10
 *   • above diagonal (fx + fy ≥ 1): V01, V11, V10
 *
 * Bilinear sampling disagrees with this by tens of cm on slopes — enough that
 * placed plants and the bobcat appear to float above (or sink into) the ground.
 */
export function sampleRenderedHeight(dem, planeSize, segments, x, z) {
  const halfPlane = planeSize * 0.5;
  const dx = planeSize / segments;
  const gx = (x + halfPlane) / dx;
  const gy = (z + halfPlane) / dx;
  const ix0 = Math.floor(gx), iy0 = Math.floor(gy);
  const fx = gx - ix0, fy = gy - iy0;
  const x0w = ix0 * dx - halfPlane;
  const x1w = (ix0 + 1) * dx - halfPlane;
  const y0w = iy0 * dx - halfPlane;
  const y1w = (iy0 + 1) * dx - halfPlane;
  const h00 = sampleHeight(dem, x0w, y0w);
  const h10 = sampleHeight(dem, x1w, y0w);
  const h01 = sampleHeight(dem, x0w, y1w);
  const h11 = sampleHeight(dem, x1w, y1w);
  // Each vertex's rendered Y also includes the procedural mesoscale detail
  // (the shader adds it on top of the heightmap sample).
  const d00 = terrainDetail(x0w, y0w);
  const d10 = terrainDetail(x1w, y0w);
  const d01 = terrainDetail(x0w, y1w);
  const d11 = terrainDetail(x1w, y1w);
  const v00 = h00 + d00, v10 = h10 + d10, v01 = h01 + d01, v11 = h11 + d11;
  if (fx + fy < 1) {
    return (1 - fx - fy) * v00 + fy * v01 + fx * v10;
  }
  return (1 - fx) * v01 + (fx + fy - 1) * v11 + (1 - fy) * v10;
}

/**
 * Mesoscale detail noise — must MATCH the GLSL `terrainDetail` in TerrainMesh.js
 * exactly, otherwise plants and the bobcat float above (or sink into) the
 * visible bumps that the shader adds to the rasterised geometry.
 */
function hash2(x, y) {
  return frac(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
}
function frac(v) { return v - Math.floor(v); }
function valueNoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}
export function terrainDetail(x, z) {
  let n = 0, a = 0.55, f = 0.10;
  for (let k = 0; k < 4; k++) {
    n += a * (valueNoise(x * f, z * f) - 0.5);
    f *= 2.13; a *= 0.55;
  }
  return n * 1.6;
}

export function sampleSlope(dem, x, z, step = 4) {
  const ds = step * dem.pixelSizeX;
  const hL = sampleHeight(dem, x - ds, z);
  const hR = sampleHeight(dem, x + ds, z);
  const hD = sampleHeight(dem, x, z - ds);
  const hU = sampleHeight(dem, x, z + ds);
  const dzdx = (hR - hL) / (2 * ds);
  const dzdy = (hU - hD) / (2 * ds);
  return Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
}
