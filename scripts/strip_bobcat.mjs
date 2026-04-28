/**
 * Strip the bobcat.glb down to something Blender can open.
 *
 * The shipped GLB has 70+ mesh primitives:
 *   - 37 *_joint_physics debug octahedra (one per bone) — pure clutter
 *   - 24 model/LOD variants (model0…model23) — same mesh authored multiple
 *     times for different markings / LODs
 *   - the actual rig + animations + skin
 *
 * Blender chokes on the combination. This script writes a slimmed copy, leaving
 * the original untouched:
 *
 *   bobcat_edit.glb         → joint_physics stripped only (still all 24 LODs)
 *   bobcat_edit_minimal.glb → joint_physics stripped + only the chosen LOD set
 *
 * Run: node scripts/strip_bobcat.mjs [--keep model1]
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup } from '@gltf-transform/functions';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IN          = resolve(__dirname, '..', 'public', 'assets', 'bobcat.glb');
const OUT_LITE    = resolve(__dirname, '..', 'public', 'assets', 'bobcat_edit.glb');
const OUT_MINIMAL = resolve(__dirname, '..', 'public', 'assets', 'bobcat_edit_minimal.glb');

// Which LOD/variant to keep in the minimal output. model1/11/15 are the 7,688-vert
// "main body" variant — a sane sculpt target. model5/10 is the 23k-vert hi-poly.
const KEEP_LOD = process.argv.includes('--keep')
  ? process.argv[process.argv.indexOf('--keep') + 1]
  : 'model1';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

async function strip({ stripJointPhysics, keepOnlyLod }) {
  const doc = await io.read(IN);
  const root = doc.getRoot();

  let removed = 0;
  for (const mesh of root.listMeshes()) {
    const name = mesh.getName() || '';
    const isJointPhysics = name.endsWith('_joint_physics');
    // model variant suffix: nabobcat_mod_male_modelN
    const lodMatch = name.match(/_(model\d+)$/);
    const isLod = !!lodMatch;
    const lodName = lodMatch?.[1];

    const drop =
      (stripJointPhysics && isJointPhysics) ||
      (keepOnlyLod && isLod && lodName !== keepOnlyLod);

    if (!drop) continue;

    // Detach any node that points at this mesh, then dispose the mesh itself.
    // prune() will clean up the orphan nodes, materials, accessors, etc.
    for (const node of root.listNodes()) {
      if (node.getMesh() === mesh) node.setMesh(null);
    }
    mesh.dispose();
    removed++;
  }

  await doc.transform(dedup(), prune());

  return { doc, removed };
}

// Pass 1: lite (joint_physics gone, all LODs kept)
{
  const { doc, removed } = await strip({ stripJointPhysics: true, keepOnlyLod: null });
  await io.write(OUT_LITE, doc);
  console.log(`lite:    removed ${removed} joint_physics meshes  →  ${OUT_LITE}`);
}

// Pass 2: minimal (joint_physics gone + one LOD kept)
{
  const { doc, removed } = await strip({ stripJointPhysics: true, keepOnlyLod: KEEP_LOD });
  await io.write(OUT_MINIMAL, doc);
  console.log(`minimal: removed ${removed} meshes (kept ${KEEP_LOD})  →  ${OUT_MINIMAL}`);
}
