/**
 * Build-time DEM fetcher.
 *
 * Pulls Mapzen "terrarium" PNG elevation tiles from the public AWS bucket,
 * decodes the elevation values, stitches a region into one PNG and writes it
 * along with a small JSON sidecar (bbox in WGS84, world dimensions, pixel size).
 *
 * Run via:  node scripts/fetch_dem.mjs
 *
 * Region target: Pandale, Val Verde Co., Texas (matches the original Pandale
 * topo map orthoimagery extent).
 */

import { PNG } from 'pngjs';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public', 'assets', 'dem');
mkdirSync(OUT_DIR, { recursive: true });

// Bbox approximately matching the original Pandale topo extent.
const BBOX = {
  minLat: 30.085,
  maxLat: 30.250,
  minLon: -101.605,
  maxLon: -101.435
};

const ZOOM = 13; // 256-px tile ≈ 4.9 km at lat 30°, ~19 m/px
const TILE_SIZE = 256;

function lonToTileX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
function latToTileY(lat, z) {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
}
function tileXToLon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
function tileYToLat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

const xMin = Math.floor(lonToTileX(BBOX.minLon, ZOOM));
const xMax = Math.floor(lonToTileX(BBOX.maxLon, ZOOM));
const yMin = Math.floor(latToTileY(BBOX.maxLat, ZOOM)); // y inverted
const yMax = Math.floor(latToTileY(BBOX.minLat, ZOOM));
const tilesX = xMax - xMin + 1;
const tilesY = yMax - yMin + 1;
const W = tilesX * TILE_SIZE;
const H = tilesY * TILE_SIZE;

console.log(`tiles ${tilesX}x${tilesY} = ${W}x${H} pixels at zoom ${ZOOM}`);

async function fetchTile(x, y) {
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ZOOM}/${x}/${y}.png`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tile ${x},${y} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return PNG.sync.read(buf);
}

const composite = new PNG({ width: W, height: H, colorType: 6 });
const heights = new Float32Array(W * H);
let minH = Infinity, maxH = -Infinity;

for (let ty = 0; ty < tilesY; ty++) {
  for (let tx = 0; tx < tilesX; tx++) {
    const x = xMin + tx, y = yMin + ty;
    process.stdout.write(`fetching ${tx + 1 + ty * tilesX}/${tilesX * tilesY}\r`);
    const img = await fetchTile(x, y);
    for (let j = 0; j < TILE_SIZE; j++) {
      for (let i = 0; i < TILE_SIZE; i++) {
        const srcIdx = (j * TILE_SIZE + i) * 4;
        const r = img.data[srcIdx + 0];
        const g = img.data[srcIdx + 1];
        const b = img.data[srcIdx + 2];
        const elev = (r * 256 + g + b / 256) - 32768; // metres
        const dstX = tx * TILE_SIZE + i;
        const dstY = ty * TILE_SIZE + j;
        const dstFlat = dstY * W + dstX;
        heights[dstFlat] = elev;
        if (elev < minH) minH = elev;
        if (elev > maxH) maxH = elev;
        const dstIdx = dstFlat * 4;
        composite.data[dstIdx + 0] = r;
        composite.data[dstIdx + 1] = g;
        composite.data[dstIdx + 2] = b;
        composite.data[dstIdx + 3] = 255;
      }
    }
  }
}
process.stdout.write('\n');

const compositePath = resolve(OUT_DIR, 'terrarium.png');
writeFileSync(compositePath, PNG.sync.write(composite));

// Compute approximate metres-per-pixel at the centre latitude (Mercator).
const centerLat = (BBOX.minLat + BBOX.maxLat) * 0.5;
const earthCircumf = 40075016.686;
const mPerPxAtZoom = (earthCircumf * Math.cos(centerLat * Math.PI / 180)) / Math.pow(2, ZOOM) / TILE_SIZE;

// Real bbox of the stitched image (tile-aligned).
const realBbox = {
  minLon: tileXToLon(xMin, ZOOM),
  maxLon: tileXToLon(xMax + 1, ZOOM),
  minLat: tileYToLat(yMax + 1, ZOOM),
  maxLat: tileYToLat(yMin, ZOOM)
};

const meta = {
  source: 'mapzen-terrarium',
  zoom: ZOOM,
  width: W,
  height: H,
  pixelSizeMeters: mPerPxAtZoom,
  worldWidthMeters: W * mPerPxAtZoom,
  worldHeightMeters: H * mPerPxAtZoom,
  minElevation: minH,
  maxElevation: maxH,
  bbox: realBbox,
  tileGrid: { xMin, yMin, xMax, yMax }
};
writeFileSync(resolve(OUT_DIR, 'terrarium.json'), JSON.stringify(meta, null, 2));

console.log(`wrote ${compositePath}`);
console.log(`bbox: ${JSON.stringify(realBbox)}`);
console.log(`elev: ${minH.toFixed(1)} … ${maxH.toFixed(1)} m`);
console.log(`pixel: ${mPerPxAtZoom.toFixed(2)} m   world: ${(W*mPerPxAtZoom/1000).toFixed(2)}×${(H*mPerPxAtZoom/1000).toFixed(2)} km`);
