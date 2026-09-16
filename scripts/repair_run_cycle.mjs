/**
 * Offline repair of the bobcat runbase cycle — companion to
 * analyze_run_cycle.mjs, which diagnosed the "limp" as three defects:
 *
 *   1. the right rear leg's step height is ~3x the left's (baked into the
 *      source clip; the deer's runbase from the same pipeline is symmetric)
 *   2. the loop doesn't close: last->first frame jumps feet 30-140mm and
 *      flips toe bones 120-160 degrees — a pop at every cycle wrap
 *   3. BobcatRig's lead swap fires at t=0, which is near the WORST phase for
 *      original<->mirror similarity (1677mm vs the 1007mm minimum at ~0.56)
 *
 * Repair steps, in order:
 *
 *   resample  — every runbase track onto a uniform F-frame grid (source is
 *               force-sampled LINEAR, so this is near-lossless)
 *   bridge    — replace the last (1-BRIDGE_START) of the cycle with a
 *               smoothstep blend toward frame 0's value: closes the loop AND
 *               erases the known-garbage end frames (fixes 2)
 *   symmetrize— replace every rear-R bone track with the rig-aware mirror of
 *               the cleaned rear-L track, phase-shifted to keep the gallop's
 *               rear-foot stagger (shift found by aligning the two rear feet's
 *               normalized height curves) (fixes 1)
 *   rotate    — build the full mirror clip (same math as BobcatRig), find the
 *               phase where original and mirror feet are closest, and rotate
 *               all periodic tracks so that phase becomes t=0. The runtime's
 *               swap-at-wrap then lands at the cheapest phase (fixes 3)
 *
 * Root-motion ramp tracks (net displacement over the cycle) are resampled but
 * exempt from bridge/rotate — the runtime strips them anyway.
 *
 * Run:    node scripts/repair_run_cycle.mjs [in.glb] [out.glb] [--lag N]
 *         --lag N overrides the rear stagger in frames (of F); default is
 *         touch-down alignment, which preserves the source clip's stagger.
 * Verify: node scripts/analyze_run_cycle.mjs <out.glb> runbase
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';
import { PropertyType } from '@gltf-transform/core';
import * as THREE from 'three';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const lagArg = process.argv.indexOf('--lag');
const LAG_OVERRIDE = lagArg >= 0 ? parseInt(process.argv[lagArg + 1], 10) : null;
const IN = args[0] || 'public/assets/bobcat.glb';
const OUT = args[1] || 'public/assets/bobcat_repaired.glb';
const F = 45;                    // uniform frames across the cycle (8.3ms apart)
const BRIDGE_START = 0.86;       // bridge the last 14% of the cycle to frame 0
const RAMP_THRESH = 0.05;        // translation net-displacement => root-motion ramp
const SIDE_NODE_RE = /^(.+_joint)(\.?)([LR])$/;
const REAR_RE = /rear/i;         // rear-leg chain incl. toeRear* and Rear*Claw

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(IN);
const root = doc.getRoot();

const anim = root.listAnimations().find(a => /runbase/i.test(a.getName() || ''));
if (!anim) { console.error('no runbase clip'); process.exit(1); }
console.log(`clip: ${anim.getName()}`);

// ---- node graph + bind pose -------------------------------------------------
const nodes = root.listNodes();
const parentOf = new Map();
for (const n of nodes) for (const c of n.listChildren()) parentOf.set(c, n);
const byName = new Map(nodes.map(n => [n.getName(), n]));

const bindWorld = new Map();
const bindOf = n => {
  if (bindWorld.has(n)) return bindWorld.get(n);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(n.getTranslation()),
    new THREE.Quaternion().fromArray(n.getRotation()),
    new THREE.Vector3().fromArray(n.getScale())
  );
  const p = parentOf.get(n);
  const w = p ? new THREE.Matrix4().multiplyMatrices(bindOf(p), m) : m;
  bindWorld.set(n, w);
  return w;
};
for (const n of nodes) bindOf(n);

// mirror axis — identical detection to BobcatRig.js
let mirrorAxisIdx = 0;
for (const base of ['def_legUpr_joint', 'def_ear_joint', 'def_eye_joint', 'def_pelvis_joint']) {
  const bL = byName.get(`${base}L`) || byName.get(`${base}.L`);
  const bR = byName.get(`${base}R`) || byName.get(`${base}.R`);
  if (!bL || !bR) continue;
  const pL = new THREE.Vector3().setFromMatrixPosition(bindWorld.get(bL));
  const pR = new THREE.Vector3().setFromMatrixPosition(bindWorld.get(bR));
  const diff = [Math.abs(pL.x - pR.x), Math.abs(pL.y - pR.y), Math.abs(pL.z - pR.z)];
  mirrorAxisIdx = diff.indexOf(Math.max(...diff));
  break;
}
console.log(`mirror axis: ${['x', 'y', 'z'][mirrorAxisIdx]}`);

const pairData = new Map(); // node -> {other, W_p_my_inv, W_p_other, W_p_my_quat_inv, W_p_other_quat}
for (const n of nodes) {
  const m = (n.getName() || '').match(SIDE_NODE_RE);
  if (!m) continue;
  const other = byName.get(`${m[1]}${m[2]}${m[3] === 'L' ? 'R' : 'L'}`);
  const myParent = parentOf.get(n), otherParent = other && parentOf.get(other);
  if (!other || !myParent || !otherParent) continue;
  const W_p_my = bindWorld.get(myParent), W_p_other = bindWorld.get(otherParent);
  const qMy = new THREE.Quaternion(), qOther = new THREE.Quaternion();
  W_p_my.decompose(new THREE.Vector3(), qMy, new THREE.Vector3());
  W_p_other.decompose(new THREE.Vector3(), qOther, new THREE.Vector3());
  pairData.set(n, {
    other,
    W_p_my_inv: W_p_my.clone().invert(),
    W_p_other: W_p_other.clone(),
    W_p_my_quat_inv: qMy.clone().invert(),
    W_p_other_quat: qOther
  });
}

const mirrorQuat = (pair, qIn, qOut) => {
  qOut.copy(qIn).premultiply(pair.W_p_other_quat);
  if (mirrorAxisIdx === 0)      { qOut.y = -qOut.y; qOut.z = -qOut.z; }
  else if (mirrorAxisIdx === 1) { qOut.x = -qOut.x; qOut.z = -qOut.z; }
  else                          { qOut.x = -qOut.x; qOut.y = -qOut.y; }
  qOut.premultiply(pair.W_p_my_quat_inv);
  return qOut;
};
const mirrorPos = (pair, pIn, pOut) => {
  pOut.copy(pIn).applyMatrix4(pair.W_p_other);
  if (mirrorAxisIdx === 0) pOut.x = -pOut.x;
  else if (mirrorAxisIdx === 1) pOut.y = -pOut.y;
  else pOut.z = -pOut.z;
  return pOut.applyMatrix4(pair.W_p_my_inv);
};

// ---- gather + resample channels ----------------------------------------------
let duration = 0;
for (const ch of anim.listChannels()) {
  const times = ch.getSampler()?.getInput()?.getArray();
  if (times) duration = Math.max(duration, times[times.length - 1]);
}
console.log(`duration: ${duration.toFixed(4)}s -> resampling to ${F} frames`);

// tracks: [{channel, node, path, stride, frames: Float32Array(F*stride), isRamp}]
const tracks = [];
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
for (const ch of anim.listChannels()) {
  const node = ch.getTargetNode();
  const s = ch.getSampler();
  if (!node || !s) continue;
  const path = ch.getTargetPath();
  const interp = s.getInterpolation();
  if (interp === 'CUBICSPLINE') {
    console.error(`unexpected CUBICSPLINE on ${node.getName()}.${path} — aborting`);
    process.exit(1);
  }
  const times = s.getInput().getArray();
  const values = s.getOutput().getArray();
  const stride = path === 'rotation' ? 4 : 3;
  const n = times.length;
  const frames = new Float32Array(F * stride);
  for (let f = 0; f < F; f++) {
    const t = (f / F) * duration;
    let i = 0;
    while (i < n - 2 && times[i + 1] < t) i++;
    const span = times[i + 1] - times[i];
    let w = interp === 'STEP' || span <= 0 ? 0 : (t - times[i]) / span;
    if (t <= times[0]) { i = 0; w = 0; }
    if (t >= times[n - 1]) { i = n - 2; w = 1; }
    if (path === 'rotation') {
      _qa.fromArray(values, i * 4);
      _qb.fromArray(values, (i + 1) * 4);
      _qa.slerp(_qb, w);
      _qa.toArray(frames, f * 4);
    } else {
      for (let k = 0; k < stride; k++) {
        const a = values[i * stride + k], b = values[(i + 1) * stride + k];
        frames[f * stride + k] = a + (b - a) * w;
      }
    }
  }
  // root-motion ramp: net displacement over the cycle on a translation track
  let isRamp = false;
  if (path === 'translation') {
    const dx = values[(n - 1) * 3] - values[0];
    const dy = values[(n - 1) * 3 + 1] - values[1];
    const dz = values[(n - 1) * 3 + 2] - values[2];
    isRamp = Math.hypot(dx, dy, dz) > RAMP_THRESH;
    if (isRamp) console.log(`  ramp (exempt from bridge/rotate): ${node.getName()}.translation, net ${Math.hypot(dx, dy, dz).toFixed(3)}`);
  }
  tracks.push({ channel: ch, node, path, stride, frames, isRamp });
}
console.log(`tracks: ${tracks.length}`);

// helpers over frame arrays --------------------------------------------------
const getV = (tr, f, out) => out.fromArray(tr.frames, ((f % F + F) % F) * tr.stride);
const setV = (tr, f, v) => v.toArray(tr.frames, f * tr.stride);

// ---- bridge: close the loop over the last (1-BRIDGE_START) of the cycle ------
const i0 = Math.ceil(F * BRIDGE_START);
const _p0 = new THREE.Vector3(), _p1 = new THREE.Vector3();
for (const tr of tracks) {
  if (tr.isRamp) continue;
  for (let f = i0 + 1; f < F; f++) {
    let w = (f - i0) / (F - i0);
    w = w * w * (3 - 2 * w); // smoothstep
    if (tr.path === 'rotation') {
      _qa.fromArray(tr.frames, i0 * 4);
      _qb.fromArray(tr.frames, 0);
      _qa.slerp(_qb, w).toArray(tr.frames, f * 4);
    } else {
      for (let k = 0; k < tr.stride; k++) {
        const a = tr.frames[i0 * tr.stride + k], b = tr.frames[k];
        tr.frames[f * tr.stride + k] = a + (b - a) * w;
      }
    }
  }
}
console.log(`bridged frames ${i0 + 1}..${F - 1} toward frame 0 (phase ${BRIDGE_START}+)`);

// ---- FK over frame arrays -----------------------------------------------------
const trackIndex = new Map(); // node -> {rotation?, translation?}
for (const tr of tracks) {
  if (!trackIndex.has(tr.node)) trackIndex.set(tr.node, {});
  trackIndex.get(tr.node)[tr.path] = tr;
}
// mirrored=true evaluates the full runtime-style mirror clip (all pairs swapped)
function worldAtFrame(f, mirrored) {
  const world = new Map();
  const compute = node => {
    if (world.has(node)) return world.get(node);
    const parent = parentOf.get(node);
    const parentW = parent ? compute(parent) : null;
    const p = new THREE.Vector3().fromArray(node.getTranslation());
    const q = new THREE.Quaternion().fromArray(node.getRotation());
    const s = new THREE.Vector3().fromArray(node.getScale());
    const pair = mirrored ? pairData.get(node) : null;
    const src = pair ? trackIndex.get(pair.other) : trackIndex.get(node);
    if (src) {
      if (src.rotation) {
        getV(src.rotation, f, _qa);
        if (pair) mirrorQuat(pair, _qa, q); else q.copy(_qa);
      }
      if (src.translation && !src.translation.isRamp) {
        getV(src.translation, f, _p0);
        if (pair) mirrorPos(pair, _p0, p); else p.copy(_p0);
      }
    }
    const m = new THREE.Matrix4().compose(p, q, s);
    const w = parentW ? new THREE.Matrix4().multiplyMatrices(parentW, m) : m;
    world.set(node, w);
    return w;
  };
  for (const n of nodes) compute(n);
  return world;
}

const feet = ['def_frontFoot_joint.L', 'def_frontFoot_joint.R', 'def_rearFoot_joint.L', 'def_rearFoot_joint.R']
  .map(n => byName.get(n));
if (feet.some(f => !f)) { console.error('foot bones missing'); process.exit(1); }

// ---- symmetrize: rear-R <- mirrored rear-L, phase-shifted ----------------------
// The rear legs must NOT move in unison. A gallop lands the two hinds a little
// apart; land them together and it is a bound, which reads as a bunny-hop.
//
// The first version of this script measured the stagger from the source clip,
// by comparing the two rear feet's touch-down frames. That was circular and it
// failed: the source's rear-R is the broken leg this whole script exists to
// replace (3x step height, flailing), so its height minimum is meaningless.
// It measured ~0 and produced a perfectly synchronised rear pair — step height
// symmetric to 0.0003, and hopping.
//
// So the stagger is prescribed from gait anatomy instead, and cross-checked
// against two healthy controls measured with analyze_run_cycle.mjs:
//
//     deer runbase (healthy gallop)   rear pair offset 0.075 cycle
//     bobcat runbase front pair        offset 0.079 cycle
//
// Cats gallop rotary: the hinds fall in one lateral order and the forelimbs in
// the opposite one. This clip's forelimbs already land R then L, so the hinds
// must land L then R -- same pattern the deer shows.
//
// newR(f) = mirrorL(f + lag), so R's touch-down lands at (fLmin - lag): a
// NEGATIVE lag puts R after L. Hence F - REAR_STAGGER_FRAMES.
const REAR_STAGGER_FRAMES = 4;            // 4/45 = 0.089 cycle
const bestLag = LAG_OVERRIDE ?? ((F - REAR_STAGGER_FRAMES) % F);
const yL = [], yR = [];
for (let f = 0; f < F; f++) {
  const w = worldAtFrame(f, false);
  yL.push(new THREE.Vector3().setFromMatrixPosition(w.get(feet[2])).y);
  yR.push(new THREE.Vector3().setFromMatrixPosition(w.get(feet[3])).y);
}
const fLmin = yL.indexOf(Math.min(...yL));
console.log(`rear stagger: L touches down at phase ${(fLmin / F).toFixed(3)}, `
  + `R set to land ${REAR_STAGGER_FRAMES} frames later `
  + `(${(REAR_STAGGER_FRAMES / F).toFixed(3)} cycle) -> lag ${bestLag}`
  + `${LAG_OVERRIDE != null ? ' [override]' : ''}`);

// World-space mirroring — NOT the bind-frame local mirror BobcatRig uses.
// The local mirror is only exact when the animated parent chain matches bind;
// mid-gallop the pelvis is nowhere near bind, which distorts the world result
// (measured: locals mirrored exactly, world step-height still 3x off). Instead:
//   1. express rear-L's animated world matrix in the animated ROOT frame
//      (so whole-body reorientation cancels out)
//   2. reflect across the rig's sagittal plane (bind mirror plane, carried
//      into root-local coordinates)
//   3. apply a per-pair bind correction K so that at bind pose the formula
//      reproduces the R bone's bind exactly (honors flipped R conventions)
//   4. convert back to R locals using the ANIMATED (already-replaced) parents,
//      processing the chain top-down
const rootBone = byName.get('def_c_root_joint');
if (!rootBone) { console.error('def_c_root_joint not found'); process.exit(1); }
{ // sanity: root must be an ancestor of the legs and sit on the centerline
  let a = byName.get('def_rearFoot_joint.R');
  while (a && a !== rootBone) a = parentOf.get(a);
  const rx = new THREE.Vector3().setFromMatrixPosition(bindWorld.get(rootBone)).x;
  if (!a || Math.abs(rx) > 0.01) { console.error('root ancestry/centerline check failed'); process.exit(1); }
}
// Sagittal reflection in root-bind coordinates: plane through the root origin,
// normal = world mirror axis rotated into the root's bind frame.
const rootBindQuatInv = (() => {
  const q = new THREE.Quaternion();
  bindWorld.get(rootBone).decompose(new THREE.Vector3(), q, new THREE.Vector3());
  return q.invert();
})();
const nAxis = new THREE.Vector3().setComponent(mirrorAxisIdx, 1).applyQuaternion(rootBindQuatInv);
const S = new THREE.Matrix4().identity();
{ // S = I - 2*n*n^T (homogeneous, plane through origin)
  const e = S.elements, n = nAxis;
  const nn = [n.x, n.y, n.z];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) e[c * 4 + r] -= 2 * nn[r] * nn[c];
}

// FK the original clip once for all frames (bones + root, world matrices)
const origWorld = [];
for (let f = 0; f < F; f++) origWorld.push(worldAtFrame(f, false));

// Fixed reflection frame: the root's average animated orientation over the
// cycle (translation is the rest value — ramp tracks are held at rest in FK).
// Conjugating through the PER-FRAME root was measurably wrong: the gallop's
// spine-yaw wiggle swings the mirror plane, and the reflected foot inherits
// the wiggle doubled (~19cm of lateral wander). A fixed plane mirrors the
// left leg's world deviation-from-bind exactly, yaw sway and all.
const avgRootQuat = new THREE.Quaternion(0, 0, 0, 0);
{
  const q0 = new THREE.Quaternion(), qf = new THREE.Quaternion();
  const _pp = new THREE.Vector3(), _ss = new THREE.Vector3();
  origWorld[0].get(rootBone).decompose(_pp, q0, _ss);
  for (let f = 0; f < F; f++) {
    origWorld[f].get(rootBone).decompose(_pp, qf, _ss);
    if (qf.dot(q0) < 0) { qf.x = -qf.x; qf.y = -qf.y; qf.z = -qf.z; qf.w = -qf.w; }
    avgRootQuat.x += qf.x; avgRootQuat.y += qf.y; avgRootQuat.z += qf.z; avgRootQuat.w += qf.w;
  }
  avgRootQuat.normalize();
}
const rtFixed = new THREE.Matrix4().compose(
  new THREE.Vector3().setFromMatrixPosition(origWorld[0].get(rootBone)),
  avgRootQuat,
  new THREE.Vector3(1, 1, 1)
);
const Refl = new THREE.Matrix4()
  .copy(rtFixed).multiply(S).multiply(new THREE.Matrix4().copy(rtFixed).invert());
// Anchor the plane to the rear pair's own midline, not the root origin: the
// root sits off the sagittal plane and the normal is slightly yawed, and over
// the fore-aft lever arm to the rear feet that pushed the reflected foot too
// wide. The flailing original rear-R is still usable as a LATERAL anchor (its
// side-to-side center is sane; it's the swing that's garbage) — and with
// anchor and subject colocated in x, the normal's yaw tilt cancels out.
{
  const nWorld = nAxis.clone().applyQuaternion(avgRootQuat).normalize();
  const dRoot = nWorld.dot(new THREE.Vector3().setFromMatrixPosition(rtFixed));
  let dMid = 0;
  for (let f = 0; f < F; f++) {
    _p0.setFromMatrixPosition(origWorld[f].get(feet[2]));
    _p1.setFromMatrixPosition(origWorld[f].get(feet[3]));
    dMid += (nWorld.dot(_p0) + nWorld.dot(_p1)) / 2;
  }
  dMid /= F;
  const shift = 2 * (dMid - dRoot);
  Refl.premultiply(new THREE.Matrix4().makeTranslation(
    nWorld.x * shift, nWorld.y * shift, nWorld.z * shift));
  console.log(`reflection plane: root offset ${dRoot.toFixed(3)}, rear-feet midline ${dMid.toFixed(3)} -> shifted ${(dMid - dRoot).toFixed(3)} along normal`);
}

// rear-R bones in topological (parent-first) order
const rearR = nodes.filter(n => {
  const m = (n.getName() || '').match(SIDE_NODE_RE);
  return m && m[3] === 'R' && REAR_RE.test(n.getName() || '') && pairData.get(n);
});
const depth = n => { let d = 0, a = n; while ((a = parentOf.get(a))) d++; return d; };
rearR.sort((a, b) => depth(a) - depth(b));

// per-pair bind correction K = inv(W_L_bind) * S_bind * W_R_bind.
// Derivation: skinned verts render at W(f) * IBM * v with IBM = inv(W_bind),
// and the mesh + IBMs are mirror-symmetric across the BIND plane (x=0). The
// R geometry is the animated-plane reflection of the L geometry iff
//   W_R(f) * inv(W_R_bind) * S_bind  =  Refl * W_L(f) * inv(W_L_bind)
// i.e. W_R(f) = Refl * W_L(f) * K with this K. (Solving K for bind-pose
// reproduction instead is WRONG — bind isn't part of the clip, and it put
// the reflected foot underground on the wrong side of the body.)
const S_bind = new THREE.Matrix4();
S_bind.elements[mirrorAxisIdx * 5] = -1; // diagonal entry [i][i]
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const K = new Map();
for (const n of rearR) {
  const other = pairData.get(n).other;
  K.set(n, _m1.copy(bindWorld.get(other)).invert()
    .multiply(S_bind).multiply(bindWorld.get(n)).clone());
}

// per frame: new world for each rear-R bone from reflected rear-L, then local
// via its (possibly already replaced) parent's new world
const newWorldByFrame = [];
for (let f = 0; f < F; f++) newWorldByFrame.push(new Map());
const _s1 = new THREE.Vector3();
let replaced = 0;
for (const n of rearR) {
  const pair = pairData.get(n);
  const trs = trackIndex.get(n);
  for (let f = 0; f < F; f++) {
    const fs = (f + bestLag) % F;
    // W_R_new(f) = Refl * W_L(f+lag) * K
    const W = new THREE.Matrix4()
      .copy(Refl)
      .multiply(origWorld[fs].get(pair.other))
      .multiply(K.get(n));
    newWorldByFrame[f].set(n, W);
    const parent = parentOf.get(n);
    const parentW = newWorldByFrame[f].get(parent) || origWorld[f].get(parent);
    _m2.copy(parentW).invert().multiply(W);
    _m2.decompose(_p0, _qa, _s1);
    if (trs.rotation) _qa.toArray(trs.rotation.frames, f * 4);
    if (trs.translation && !trs.translation.isRamp) _p0.toArray(trs.translation.frames, f * 3);
  }
  replaced++;
}
console.log(`rear-R bones rebuilt from world-reflected rear-L: ${replaced}`);

// ---- rotate: put the cheapest original<->mirror phase at t=0 -------------------
const dist = [];
for (let f = 0; f < F; f++) {
  const wO = worldAtFrame(f, false);
  const wM = worldAtFrame(f, true);
  let d = 0;
  for (const foot of feet) {
    _p0.setFromMatrixPosition(wO.get(foot));
    _p1.setFromMatrixPosition(wM.get(foot));
    d += _p0.distanceTo(_p1);
  }
  dist.push(d);
}
const kRot = dist.indexOf(Math.min(...dist));
console.log(`orig<->mirror feet distance: at t=0 ${(dist[0] * 1000).toFixed(0)}mm, min ${(Math.min(...dist) * 1000).toFixed(0)}mm at phase ${(kRot / F).toFixed(3)} -> rotating`);
for (const tr of tracks) {
  if (tr.isRamp) continue;
  const out = new Float32Array(F * tr.stride);
  for (let f = 0; f < F; f++) {
    out.set(tr.frames.subarray(((f + kRot) % F) * tr.stride, ((f + kRot) % F) * tr.stride + tr.stride), f * tr.stride);
  }
  tr.frames = out;
}

// ---- write back: F+1 keys (last = first, closing the loop exactly) -------------
// quaternion hemisphere pass so adjacent keys interpolate the short way
for (const tr of tracks) {
  if (tr.path !== 'rotation') continue;
  for (let f = 1; f < F; f++) {
    let dot = 0;
    for (let k = 0; k < 4; k++) dot += tr.frames[f * 4 + k] * tr.frames[(f - 1) * 4 + k];
    if (dot < 0) for (let k = 0; k < 4; k++) tr.frames[f * 4 + k] = -tr.frames[f * 4 + k];
  }
}

const buffer = root.listBuffers()[0];
const oldSamplers = new Set(anim.listSamplers());
const fullTimes = new Float32Array(F + 1);
for (let f = 0; f <= F; f++) fullTimes[f] = (f / F) * duration;
const fullTimesAcc = doc.createAccessor('runbase_times').setType('SCALAR').setArray(fullTimes).setBuffer(buffer);
const twoTimes = new Float32Array([0, duration]);
const twoTimesAcc = doc.createAccessor('runbase_times2').setType('SCALAR').setArray(twoTimes).setBuffer(buffer);

let constant = 0, animated = 0;
for (const tr of tracks) {
  const type = tr.stride === 4 ? 'VEC4' : 'VEC3';
  // constant tracks collapse to 2 keys
  let isConst = true;
  for (let f = 1; f < F && isConst; f++) {
    for (let k = 0; k < tr.stride; k++) {
      if (Math.abs(tr.frames[f * tr.stride + k] - tr.frames[k]) > 1e-6) { isConst = false; break; }
    }
  }
  let inAcc, outArr;
  if (isConst) {
    inAcc = twoTimesAcc;
    outArr = new Float32Array(2 * tr.stride);
    outArr.set(tr.frames.subarray(0, tr.stride), 0);
    outArr.set(tr.frames.subarray(0, tr.stride), tr.stride);
    constant++;
  } else {
    inAcc = fullTimesAcc;
    outArr = new Float32Array((F + 1) * tr.stride);
    outArr.set(tr.frames, 0);
    if (tr.isRamp) {
      // ramps keep their true end value instead of wrapping to frame 0
      const s = tr.channel.getSampler();
      const v = s.getOutput().getArray();
      const n = s.getInput().getArray().length;
      outArr.set(v.subarray((n - 1) * tr.stride, n * tr.stride), F * tr.stride);
    } else {
      // close the loop: last key = first key (sign-aligned for quats)
      const first = tr.frames.subarray(0, tr.stride);
      if (tr.stride === 4) {
        let dot = 0;
        for (let k = 0; k < 4; k++) dot += first[k] * tr.frames[(F - 1) * 4 + k];
        for (let k = 0; k < 4; k++) outArr[F * 4 + k] = dot < 0 ? -first[k] : first[k];
      } else {
        outArr.set(first, F * tr.stride);
      }
    }
    animated++;
  }
  const outAcc = doc.createAccessor().setType(type).setArray(outArr).setBuffer(buffer);
  const sampler = doc.createAnimationSampler().setInput(inAcc).setOutput(outAcc).setInterpolation('LINEAR');
  anim.addSampler(sampler);
  tr.channel.setSampler(sampler);
}
for (const s of oldSamplers) s.dispose();
await doc.transform(prune({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.ANIMATION_SAMPLER] }));
console.log(`written tracks: ${animated} animated (${F + 1} keys), ${constant} constant (2 keys)`);

await io.write(OUT, doc);
console.log(`wrote ${OUT}`);
