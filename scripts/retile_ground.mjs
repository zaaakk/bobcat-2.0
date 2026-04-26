/**
 * Make the ground textures seamlessly tileable by mirror-padding the edges and
 * cross-fading the image with a 90°-rotated copy of itself. The fade weight is
 * a smooth ring whose strength rises near the edges, so the centre of the
 * texture is unchanged but the edges blend into a seamless repeat.
 *
 * Run: node scripts/retile_ground.mjs
 */
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(__dirname, '..', 'public', 'assets', 'ground');
const FILES = ['rock.png', 'gravel.png', 'sand.png', 'grassdry.png', 'riparian.png'];

function blendOffset(png) {
  const w = png.width, h = png.height;
  const src = png.data;
  const out = new Uint8Array(src.length);

  // Cross-fade with a half-shifted copy. At every (x, y) the output is a mix
  // of src[x, y] and src[(x + w/2) % w, (y + h/2) % h], weighted by a ring
  // function so the centre of the tile is unchanged and the edges are 50/50.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // distance from nearest edge, normalised
      const dx = Math.min(x, w - 1 - x) / (w * 0.5);
      const dy = Math.min(y, h - 1 - y) / (h * 0.5);
      const edge = Math.min(dx, dy);
      // 0 at edge, 1 in the centre
      const t = Math.max(0, Math.min(1, edge));
      const w0 = 0.5 + 0.5 * smoothstep(0, 1, t); // 0.5 at edge → 1 at centre
      const w1 = 1 - w0;

      const sx = (x + (w >> 1)) % w;
      const sy = (y + (h >> 1)) % h;

      const i = (y * w + x) * 4;
      const j = (sy * w + sx) * 4;
      out[i]     = Math.round(src[i] * w0 + src[j] * w1);
      out[i + 1] = Math.round(src[i + 1] * w0 + src[j + 1] * w1);
      out[i + 2] = Math.round(src[i + 2] * w0 + src[j + 2] * w1);
      out[i + 3] = src[i + 3];
    }
  }
  png.data = Buffer.from(out);
  return png;
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

for (const f of FILES) {
  const path = resolve(DIR, f);
  try {
    const buf = readFileSync(path);
    const png = PNG.sync.read(buf);
    const out = blendOffset(png);
    writeFileSync(path, PNG.sync.write(out));
    console.log('retiled', f, png.width, 'x', png.height);
  } catch (e) {
    console.warn('skip', f, e.message);
  }
}
