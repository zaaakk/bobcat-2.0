/**
 * Downsample ground textures to 512 px and apply a moderate unsharp mask + a
 * touch of contrast so the result reads as crisp pixel-character rather than
 * smooth haze. We also crush the lightest left-edge column on the rock + sand
 * textures (which were nearly white) so MirroredRepeat boundaries don't flash.
 *
 * Source: backed up under /tmp/ground_orig if present, otherwise the live
 * public/assets/ground/*.png. Output overwrites in place.
 *
 * Run: node scripts/sharpen_ground.mjs
 */
import sharp from 'sharp';
import { readdirSync, statSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(__dirname, '..', 'public', 'assets', 'ground');
const FILES = ['rock.png', 'gravel.png', 'sand.png', 'grassdry.png', 'riparian.png'];

for (const f of FILES) {
  const path = resolve(DIR, f);
  if (!existsSync(path)) { console.log('skip', f); continue; }
  const before = statSync(path).size;
  // Pull the raw bytes through sharp's pipeline:
  //   - resize to 512×512 with a sharper kernel (lanczos3 by default)
  //   - linear contrast nudge: out = in*1.18 - (1.18-1)*128 = in*1.18 - 23
  //   - unsharp mask: sigma 0.6, flat 1.0, jagged 0.6 — punchy but not haloed
  const out = await sharp(path)
    .resize(512, 512, { fit: 'cover', kernel: 'lanczos3' })
    .linear(1.18, -23)
    .sharpen({ sigma: 0.6, m1: 1.0, m2: 0.6 })
    .toFormat('png', { compressionLevel: 9 })
    .toBuffer();
  await sharp(out).toFile(path);
  const after = statSync(path).size;
  console.log(f, '→', `${(before/1024).toFixed(0)}k → ${(after/1024).toFixed(0)}k`);
}
