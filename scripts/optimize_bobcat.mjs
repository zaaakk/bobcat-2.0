/**
 * Optimize bobcat.glb:
 *   - simplify geometry to ~3% of original triangle count (≈ 15k → keeps shape)
 *   - downscale + re-encode the diffuse texture as a compact PNG
 *   - meshopt-compress the binary buffer
 *
 * Run: node scripts/optimize_bobcat.mjs
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { simplify, textureCompress, prune, dedup, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IN  = resolve(__dirname, '..', 'public', 'assets', 'bobcat.glb');
const OUT = resolve(__dirname, '..', 'public', 'assets', 'bobcat.glb');

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(IN);

await MeshoptSimplifier.ready;

await doc.transform(
  weld({ tolerance: 0.0001 }),
  simplify({ simplifier: MeshoptSimplifier, ratio: 0.05, error: 0.005 }),
  textureCompress({ encoder: sharp, targetFormat: 'png', resize: [1024, 1024] }),
  dedup(),
  prune()
);

await io.write(OUT, doc);
console.log('wrote', OUT);
