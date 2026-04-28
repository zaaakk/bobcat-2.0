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
  // The detail patch samples this DEM at 0.29m vertex spacing — well below
  // the 16m source resolution. Two artifacts to fight:
  //
  //   (1) Cell-boundary facets — each 16m cell is a flat bilinear patch and
  //       the gradient changes abruptly at cell edges. A 3×3 Gaussian blur
  //       (kernel 1 2 1 / 2 4 2 / 1 2 1) smooths the gradient. We run it
  //       twice; that's mathematically equivalent to a 5×5 binomial blur
  //       (1 4 6 4 1 outer-product) and doubles the effective radius.
  //
  //   (2) Integer-metre quantization in the source — Mapzen tiles store
  //       elevations to the nearest metre for most cells. On a long shallow
  //       slope, many adjacent cells share the same integer value, so the
  //       blur (which is a *spatial* low-pass) can't reconstruct a smooth
  //       gradient — every blurred-window contains the same integer value.
  //       The visible result is horizontal contour-line steps stepping up
  //       a slope. Fix: add a low-amplitude smooth value-noise dither
  //       (~0.6m amp, ~40m wavelength) directly to the blurred heights. It
  //       injects fractional metres so the integer plateaus disappear,
  //       without touching macro shape (40m is below any feature the source
  //       data resolves anyway).
  //
  // CPU groundY (sampleHeight) and GPU heightmap texture both read this
  // post-blur, post-dither data, so the cat tracks against the rendered surface.
  let blurred = gaussianBlur3x3(data, width, height);
  blurred = gaussianBlur3x3(blurred, width, height);
  const ditherCellsPerCycle = 40 / meta.pixelSizeMeters;
  addValueNoiseDither(blurred, width, height, ditherCellsPerCycle, 0.6, 0.913);
  // Recompute min/max over the smoothed data so downstream code (the
  // height-bands fragment shader, etc.) sees the actual range.
  let bMinZ = Infinity, bMaxZ = -Infinity;
  for (let i = 0; i < blurred.length; i++) {
    const z = blurred[i];
    if (z < bMinZ) bMinZ = z;
    if (z > bMaxZ) bMaxZ = z;
  }
  if (onProgress) onProgress(1);

  return {
    data: blurred,
    width,
    height,
    minZ: bMinZ,
    maxZ: bMaxZ,
    pixelSizeX: meta.pixelSizeMeters,
    pixelSizeY: meta.pixelSizeMeters,
    worldWidth: meta.worldWidthMeters,
    worldHeight: meta.worldHeightMeters,
    bbox: meta.bbox
  };
}

/**
 * Adds smooth value-noise dither (in place) to break integer-metre plateaus
 * in the source DEM. Kernel: 4 corner hashes, smoothstep-blended bilinearly.
 *
 *   cellsPerCycle  cells per noise-grid period (e.g. 2.5 for 40m on a 16m
 *                  DEM). Smaller → finer dither.
 *   amp            peak displacement in metres (the noise is in [-0.5, 0.5]
 *                  before this multiplier, so dither lands in ±amp/2).
 */
function addValueNoiseDither(data, w, h, cellsPerCycle, amp, seed) {
  const inv = 1 / cellsPerCycle;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const fx = i * inv, fy = j * inv;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      const tx = fx - ix, ty = fy - iy;
      const a = hashCell(ix,     iy,     seed);
      const b = hashCell(ix + 1, iy,     seed);
      const c = hashCell(ix,     iy + 1, seed);
      const d = hashCell(ix + 1, iy + 1, seed);
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const top = a * (1 - sx) + b * sx;
      const bot = c * (1 - sx) + d * sx;
      data[j * w + i] += (top * (1 - sy) + bot * sy - 0.5) * amp;
    }
  }
}

function hashCell(x, y, seed) {
  let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ ((seed * 1e6) | 0)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return (h % 1000000) / 1000000;
}

/**
 * 3×3 Gaussian-ish blur (kernel 1 2 1 / 2 4 2 / 1 2 1, sum 16). Cheap,
 * smooths cell-boundary facets without significantly softening macro
 * features. Edges are clamped, not wrapped.
 */
function gaussianBlur3x3(data, w, h) {
  const out = new Float32Array(data.length);
  for (let j = 0; j < h; j++) {
    const j0 = j > 0       ? j - 1 : j;
    const j2 = j < h - 1   ? j + 1 : j;
    const r0 = j0 * w;
    const r1 = j  * w;
    const r2 = j2 * w;
    for (let i = 0; i < w; i++) {
      const i0 = i > 0     ? i - 1 : i;
      const i2 = i < w - 1 ? i + 1 : i;
      out[r1 + i] = (
        data[r0 + i0] + 2 * data[r0 + i] + data[r0 + i2] +
        2 * data[r1 + i0] + 4 * data[r1 + i] + 2 * data[r1 + i2] +
        data[r2 + i0] + 2 * data[r2 + i] + data[r2 + i2]
      ) * (1 / 16);
    }
  }
  return out;
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
  const renderData = new Float32Array(dem.data.length);
  const heightOffset = dem.minZ;
  const heightScale = Math.max(1e-6, dem.maxZ - dem.minZ);
  for (let i = 0; i < dem.data.length; i++) {
    const h = THREE.DataUtils.toHalfFloat((dem.data[i] - heightOffset) / heightScale);
    halfData[i] = h;
    // Mirror the exact R16F quantization on the CPU so object placement and
    // terrain queries use the same heights the GPU rasterizes.
    renderData[i] = THREE.DataUtils.fromHalfFloat(h) * heightScale + heightOffset;
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
  tex.userData = { heightOffset, heightScale };
  dem.renderData = renderData;
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
  const src = dem.renderData || dem.data;
  const u = (x / dem.worldWidth + 0.5) * dem.width - 0.5;
  const v = (z / dem.worldHeight + 0.5) * dem.height - 0.5;
  const x0 = Math.floor(u), y0 = Math.floor(v);
  const fx = u - x0, fy = v - y0;
  const cx0 = Math.max(0, Math.min(dem.width - 1, x0));
  const cy0 = Math.max(0, Math.min(dem.height - 1, y0));
  const cx1 = Math.max(0, Math.min(dem.width - 1, x0 + 1));
  const cy1 = Math.max(0, Math.min(dem.height - 1, y0 + 1));
  const h00 = src[cy0 * dem.width + cx0];
  const h10 = src[cy0 * dem.width + cx1];
  const h01 = src[cy1 * dem.width + cx0];
  const h11 = src[cy1 * dem.width + cx1];
  const h0 = h00 * (1 - fx) + h10 * fx;
  const h1 = h01 * (1 - fx) + h11 * fx;
  return h0 * (1 - fy) + h1 * fy;
}

/**
 * Sample the height the *rendered terrain mesh* actually draws at (x, z).
 *
 * Three's PlaneGeometry triangulates with the V01↔V10 diagonal. In the
 * world-space corner naming used here:
 *   V00 = south-west
 *   V10 = south-east
 *   V01 = north-west
 *   V11 = north-east
 *
 * The two triangles are:
 *   • below the diagonal (fx + fy < 1):  V00, V01, V10
 *   • above the diagonal (fx + fy >= 1): V01, V11, V10
 *
 * Using the opposite diagonal (V00↔V11) makes the CPU grounding query sample
 * the wrong half of many quads, which shows up exactly as slope-dependent
 * floating/sinking against the rendered terrain.
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
  const v00 = sampleHeight(dem, x0w, y0w);
  const v10 = sampleHeight(dem, x1w, y0w);
  const v01 = sampleHeight(dem, x0w, y1w);
  const v11 = sampleHeight(dem, x1w, y1w);
  if (fx + fy < 1) {
    return (1 - fx - fy) * v00 + fy * v01 + fx * v10;
  }
  return (1 - fx) * v01 + (fx + fy - 1) * v11 + (1 - fy) * v10;
}

/**
 * Kept for now in case anything else imports it, but the terrain shader no
 * longer adds this displacement — the GPU's `sin()` precision diverges from
 * Math.sin at large arguments, so the JS port couldn't reproduce the shader's
 * value exactly and the bobcat ended up floating/sinking by up to a metre.
 */
function hash2(x, y) {
  return frac(Math.sin((x + 11.31) * 127.1 + (y + 5.97) * 311.7) * 43758.5453);
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
