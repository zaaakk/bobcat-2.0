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

export function heightmapTexture(THREE, dem) {
  const tex = new THREE.DataTexture(
    dem.data, dem.width, dem.height,
    THREE.RedFormat, THREE.FloatType
  );
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export function sampleHeight(dem, x, z) {
  const u = (x / dem.worldWidth + 0.5) * dem.width;
  const v = (z / dem.worldHeight + 0.5) * dem.height;
  const x0 = Math.floor(u), y0 = Math.floor(v);
  const x1 = Math.min(x0 + 1, dem.width - 1);
  const y1 = Math.min(y0 + 1, dem.height - 1);
  const cx0 = Math.max(0, Math.min(dem.width - 1, x0));
  const cy0 = Math.max(0, Math.min(dem.height - 1, y0));
  const fx = u - x0, fy = v - y0;
  const h00 = dem.data[cy0 * dem.width + cx0];
  const h10 = dem.data[cy0 * dem.width + x1];
  const h01 = dem.data[y1 * dem.width + cx0];
  const h11 = dem.data[y1 * dem.width + x1];
  const h0 = h00 * (1 - fx) + h10 * fx;
  const h1 = h01 * (1 - fx) + h11 * fx;
  return h0 * (1 - fy) + h1 * fy;
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
