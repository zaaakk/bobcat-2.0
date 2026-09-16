/**
 * Optimize a prey-mob GLB from extract_pz_animal.py into the runtime asset.
 *
 * PZ exports carry 6 LODs × (fur/skin/eyes/hair/antlers/fur_fin) plus ~40
 * physics-collider meshes and 80+ animation clips. We ship one LOD and the
 * handful of clips the prey state machine plays:
 *
 *   - keep only `<name>_L<keepLod>: <part>` mesh nodes; drop physics + fur_fin
 *     (fin/shell fur tech renders as solid junk without PZ's shaders).
 *     L2 is the default: L0/L1 have the fur_shell geometry *merged into* the
 *     fur primitive (can't be separated) and L0's material indices are
 *     scrambled in the export; L2 is the first clean, shell-free LOD.
 *   - keep only clips matching KEEP_ANIMS; drop the dozens of transitions.
 *   - weld + dedup + prune. No simplify: L2 is already ~8k verts.
 *
 * Run: node scripts/optimize_mob.mjs <in.glb> <out.glb> [keepLod]
 */
import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, weld } from '@gltf-transform/functions';

const [IN, OUT, KEEP_LOD = '2'] = process.argv.slice(2);
if (!IN || !OUT) {
  console.error('usage: node scripts/optimize_mob.mjs <in.glb> <out.glb> [keepLod]');
  process.exit(1);
}

// Gaits + idles + graze + deaths. Tail token after the `@` namespace.
const KEEP_ANIMS = /@(standidle\d*|walkbase|runbase|standdie|restdie|grazeloop\d*|eatloop\d*)$/i;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(IN);
const root = doc.getRoot();

// ---- meshes: keep one clean LOD, drop colliders + fin fur ----------------
const lodRe = new RegExp(`_l${KEEP_LOD}:`, 'i');
let kept = 0, dropped = 0;
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const name = node.getName() || '';
  const keep = lodRe.test(name) && !/physic/i.test(name) && !/fur_fin/i.test(name);
  if (keep) { kept++; continue; }
  node.setMesh(null);
  mesh.dispose();
  dropped++;
}
console.log(`meshes: kept ${kept}, dropped ${dropped}`);

// ---- animations: prune to the runtime set ---------------------------------
let keptA = 0, droppedA = 0;
for (const anim of root.listAnimations()) {
  if (KEEP_ANIMS.test(anim.getName() || '')) { keptA++; continue; }
  for (const ch of anim.listChannels()) ch.dispose();
  for (const s of anim.listSamplers()) s.dispose();
  anim.dispose();
  droppedA++;
}
console.log(`animations: kept ${keptA}, dropped ${droppedA}`);
for (const anim of root.listAnimations()) console.log('  ', anim.getName());

// Material dedup excluded: the textureless eyes/skin materials are byte-
// identical, and merging them breaks the runtime's bind-textures-by-
// material-name pass (eyes would inherit the body fur diffuse).
await doc.transform(
  weld({ tolerance: 0.0001 }),
  dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.TEXTURE, PropertyType.SKIN] }),
  prune()
);

await io.write(OUT, doc);
const { statSync } = await import('fs');
console.log(`wrote ${OUT} (${(statSync(OUT).size / 1024 / 1024).toFixed(2)} MB)`);
