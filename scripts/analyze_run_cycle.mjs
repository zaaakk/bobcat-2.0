/**
 * Offline gait analysis for the bobcat runbase cycle — hunts the "limp".
 *
 * Loads public/assets/bobcat.glb, FKs the skeleton through the runbase clip,
 * and prints hard numbers for the things we've been judging by eye:
 *
 *   1. world-space foot trajectories: contact windows, duty factor, step
 *      height, forward reach — compared L vs R for front and rear pairs
 *   2. loop closure: per-bone pose delta between the clip's last frame and
 *      first frame (a non-closing loop pops on every wrap)
 *   3. frame-to-frame jerk: per-foot world acceleration spikes, flagged by
 *      frame index (checks the hand-edited right-rear frames 2,5-9)
 *   4. original-vs-mirror pose distance over the whole cycle, using the same
 *      rig-aware bind-pose mirror math as BobcatRig.js. The runtime swaps
 *      lead at t=0 assuming that's where the two clips are most alike —
 *      this verifies (or refutes) that with numbers and reports the actual
 *      best swap phase.
 *
 * Run: node scripts/analyze_run_cycle.mjs [path/to.glb] [clipRegex]
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import * as THREE from 'three';

const GLB = process.argv[2] || 'public/assets/bobcat.glb';
const CLIP_RE = new RegExp(process.argv[3] || 'runbase', 'i');
const N_SAMPLES = 240;          // uniform samples across the cycle
const ROOT_KEY = /(^|_)(c_)?(root|hips)(_joint)?$/i;   // same strip as BobcatRig
const SIDE_NODE_RE = /^(.+_joint)(\.?)([LR])$/;        // node-name form of SIDE_RE

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(GLB);
const root = doc.getRoot();

const anim = root.listAnimations().find(a => CLIP_RE.test(a.getName() || ''));
if (!anim) {
  console.error(`no ${CLIP_RE} animation found; clips present:`);
  for (const a of root.listAnimations()) console.error(' ', a.getName());
  process.exit(1);
}
console.log(`clip: ${anim.getName()}`);

// ---- node graph -----------------------------------------------------------
const nodes = root.listNodes();
const parentOf = new Map();
for (const n of nodes) for (const c of n.listChildren()) parentOf.set(c, n);
const byName = new Map(nodes.map(n => [n.getName(), n]));

// ---- channels -------------------------------------------------------------
// chansByNode: node -> { translation?, rotation? } each {times, values, interp}
const chansByNode = new Map();
let duration = 0;
let strippedRootPos = 0;
for (const ch of anim.listChannels()) {
  const node = ch.getTargetNode();
  if (!node) continue;
  const path = ch.getTargetPath();
  const s = ch.getSampler();
  if (!s) continue;
  const times = s.getInput().getArray();
  const values = s.getOutput().getArray();
  duration = Math.max(duration, times[times.length - 1]);
  if (path === 'translation' && ROOT_KEY.test(node.getName() || '')) {
    strippedRootPos++;
    continue; // BobcatRig strips root motion — match that
  }
  if (!chansByNode.has(node)) chansByNode.set(node, {});
  chansByNode.get(node)[path] = { times, values, interp: s.getInterpolation() };
}
console.log(`duration: ${duration.toFixed(4)}s, root .position tracks stripped: ${strippedRootPos}`);

// ---- sampling -------------------------------------------------------------
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
function sampleVec3(chan, t, out) {
  const { times, values } = chan;
  const n = times.length;
  if (t <= times[0]) return out.fromArray(values, 0);
  if (t >= times[n - 1]) return out.fromArray(values, (n - 1) * 3);
  let i = 0;
  while (i < n - 2 && times[i + 1] < t) i++;
  const f = chan.interp === 'STEP' ? 0 : (t - times[i]) / (times[i + 1] - times[i]);
  const a = i * 3, b = (i + 1) * 3;
  return out.set(
    values[a] + (values[b] - values[a]) * f,
    values[a + 1] + (values[b + 1] - values[a + 1]) * f,
    values[a + 2] + (values[b + 2] - values[a + 2]) * f
  );
}
function sampleQuat(chan, t, out) {
  const { times, values } = chan;
  const n = times.length;
  if (t <= times[0]) return out.fromArray(values, 0);
  if (t >= times[n - 1]) return out.fromArray(values, (n - 1) * 4);
  let i = 0;
  while (i < n - 2 && times[i + 1] < t) i++;
  const f = chan.interp === 'STEP' ? 0 : (t - times[i]) / (times[i + 1] - times[i]);
  _qa.fromArray(values, i * 4);
  _qb.fromArray(values, (i + 1) * 4);
  return out.copy(_qa).slerp(_qb, f);
}

// ---- FK -------------------------------------------------------------------
// evalWorld(t, localOverride) -> Map node -> Matrix4
// localOverride(node, t, outPos, outQuat) may fill sampled local TRS; return
// false to fall back to rest pose. Scale animation is ignored (PZ doesn't
// animate scale on the skeleton).
function evalWorld(t, localOverride) {
  const world = new Map();
  const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const compute = node => {
    if (world.has(node)) return world.get(node);
    // Resolve the parent BEFORE touching the shared temps — the recursion
    // reuses _p/_q/_s/_m, so composing first and recursing inside the
    // multiply would clobber this node's local matrix with an ancestor's.
    const parent = parentOf.get(node);
    const parentW = parent ? compute(parent) : null;
    _p.fromArray(node.getTranslation());
    _q.fromArray(node.getRotation());
    _s.fromArray(node.getScale());
    localOverride(node, t, _p, _q);
    _m.compose(_p, _q, _s);
    const w = parentW ? new THREE.Matrix4().multiplyMatrices(parentW, _m)
                      : _m.clone();
    world.set(node, w);
    return w;
  };
  for (const n of nodes) compute(n);
  return world;
}

// Original clip: sample own channels.
const overrideOriginal = (node, t, p, q) => {
  const ch = chansByNode.get(node);
  if (!ch) return;
  if (ch.translation) sampleVec3(ch.translation, t, p);
  if (ch.rotation) sampleQuat(ch.rotation, t, q);
};

// Bind pose = rest TRS (what BobcatRig sees pre-mixer).
const bindWorld = evalWorld(0, () => {});

// ---- feet -----------------------------------------------------------------
const footNodes = nodes.filter(n => /foot/i.test(n.getName() || '') && SIDE_NODE_RE.test(n.getName() || ''));
console.log(`\nfoot bones (${footNodes.length}): ${footNodes.map(n => n.getName()).join(', ')}`);
if (!footNodes.length) {
  console.error('no L/R foot bones found — bone list with leg/foot/toe:');
  for (const n of nodes) if (/leg|foot|toe|paw/i.test(n.getName() || '')) console.error(' ', n.getName());
  process.exit(1);
}

// ---- mirror axis + pair data (mirrors BobcatRig.js exactly) ----------------
let mirrorAxisIdx = 0;
for (const base of ['def_legUpr_joint', 'def_ear_joint', 'def_eye_joint', 'def_pelvis_joint']) {
  const bL = byName.get(`${base}L`) || byName.get(`${base}.L`);
  const bR = byName.get(`${base}R`) || byName.get(`${base}.R`);
  if (!bL || !bR) continue;
  const pL = new THREE.Vector3().setFromMatrixPosition(bindWorld.get(bL));
  const pR = new THREE.Vector3().setFromMatrixPosition(bindWorld.get(bR));
  const diff = [Math.abs(pL.x - pR.x), Math.abs(pL.y - pR.y), Math.abs(pL.z - pR.z)];
  mirrorAxisIdx = diff.indexOf(Math.max(...diff));
  console.log(`mirror axis: ${['x', 'y', 'z'][mirrorAxisIdx]} (via ${base})`);
  break;
}

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
console.log(`L/R paired bones: ${pairData.size}`);

// Mirrored clip: each paired bone plays the OTHER side's animation, mirrored
// through the bind centerline — identical math to rebuildMirrorClip().
const _mq = new THREE.Quaternion(), _mp = new THREE.Vector3();
const overrideMirror = (node, t, p, q) => {
  const pair = pairData.get(node);
  if (!pair) return overrideOriginal(node, t, p, q);
  const chOther = chansByNode.get(pair.other);
  if (!chOther) return overrideOriginal(node, t, p, q);
  if (chOther.rotation) {
    sampleQuat(chOther.rotation, t, _mq);
    _mq.premultiply(pair.W_p_other_quat);
    if (mirrorAxisIdx === 0)      { _mq.y = -_mq.y; _mq.z = -_mq.z; }
    else if (mirrorAxisIdx === 1) { _mq.x = -_mq.x; _mq.z = -_mq.z; }
    else                          { _mq.x = -_mq.x; _mq.y = -_mq.y; }
    q.copy(pair.W_p_my_quat_inv).multiply(_mq);
  }
  if (chOther.translation) {
    sampleVec3(chOther.translation, t, _mp);
    _mp.applyMatrix4(pair.W_p_other);
    if (mirrorAxisIdx === 0) _mp.x = -_mp.x;
    else if (mirrorAxisIdx === 1) _mp.y = -_mp.y;
    else _mp.z = -_mp.z;
    _mp.applyMatrix4(pair.W_p_my_inv);
    p.copy(_mp);
  }
};

// ---- sample both clips across the cycle ------------------------------------
const times = Array.from({ length: N_SAMPLES }, (_, i) => (i / N_SAMPLES) * duration);
const footTracks = new Map();       // footName -> [Vector3 x N] (original)
const footTracksMir = new Map();    // footName -> [Vector3 x N] (mirror)
for (const f of footNodes) { footTracks.set(f.getName(), []); footTracksMir.set(f.getName(), []); }

for (const t of times) {
  const wO = evalWorld(t, overrideOriginal);
  const wM = evalWorld(t, overrideMirror);
  for (const f of footNodes) {
    footTracks.get(f.getName()).push(new THREE.Vector3().setFromMatrixPosition(wO.get(f)));
    footTracksMir.get(f.getName()).push(new THREE.Vector3().setFromMatrixPosition(wM.get(f)));
  }
}

// Vertical axis = the world axis with the smallest foot-position range summed
// over all feet (feet move a lot along travel + a lot up/down… so instead:
// take the axis where the *bind* feet all sit near the same coordinate AND
// which isn't the mirror axis or the travel axis). Simpler and robust here:
// report ranges and let the up-axis be the one with mid-size range that isn't
// the mirror axis. PZ anims lie along X, Y up — assert by printing.
const axes = ['x', 'y', 'z'];
console.log('\nper-foot world position ranges (original clip):');
for (const [name, pts] of footTracks) {
  const rng = axes.map(ax => {
    const vs = pts.map(p => p[ax]);
    return `${ax}:[${Math.min(...vs).toFixed(3)},${Math.max(...vs).toFixed(3)}]`;
  });
  console.log(`  ${name}  ${rng.join('  ')}`);
}
const UP = 'y';
const TRAVEL = mirrorAxisIdx === 0 ? 'x' : 'x'; // PZ anims travel along X; mirror axis is usually z? printed above
console.log(`(assuming up=${UP}; check ranges above — travel axis should have the big horizontal swing)`);

// ---- 1. contact analysis ----------------------------------------------------
console.log('\n== contact / stride analysis (original clip) ==');
const summarize = (name, pts) => {
  const ys = pts.map(p => p[UP]);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const thresh = minY + (maxY - minY) * 0.15;
  const contact = ys.map(y => y <= thresh);
  const duty = contact.filter(Boolean).length / contact.length;
  // contact onset phases (touch-down events)
  const downs = [];
  for (let i = 0; i < contact.length; i++) {
    const prev = contact[(i + contact.length - 1) % contact.length];
    if (contact[i] && !prev) downs.push(i / contact.length);
  }
  // horizontal reach at touch-down vs lift-off along each horizontal axis
  return { minY, maxY, duty, downs, ys };
};
const stats = new Map();
for (const [name, pts] of footTracks) stats.set(name, summarize(name, pts));
for (const [name, s] of stats) {
  console.log(`  ${name.padEnd(28)} y:[${s.minY.toFixed(3)},${s.maxY.toFixed(3)}] step-height:${(s.maxY - s.minY).toFixed(3)} duty:${(s.duty * 100).toFixed(1)}% touch-down@phase:${s.downs.map(d => d.toFixed(3)).join(',')}`);
}
// L/R deltas per pair
console.log('  -- L/R pair deltas --');
const seenPair = new Set();
for (const f of footNodes) {
  const m = f.getName().match(SIDE_NODE_RE);
  const base = `${m[1]}${m[2]}`;
  if (seenPair.has(base)) continue;
  seenPair.add(base);
  const L = stats.get(`${base[base.length - 1] === '.' ? base : base}L`) || stats.get(`${m[1]}${m[2]}L`);
  const R = stats.get(`${m[1]}${m[2]}R`);
  if (!L || !R) continue;
  console.log(`  ${m[1]}${m[2]}*  Δstep-height:${((L.maxY - L.minY) - (R.maxY - R.minY)).toFixed(4)}  Δduty:${((L.duty - R.duty) * 100).toFixed(1)}%  ΔminY:${(L.minY - R.minY).toFixed(4)}`);
}

// ---- 2. loop closure --------------------------------------------------------
console.log('\n== loop closure (last keyframe vs first, per bone) ==');
// Use actual keyframe endpoints: t=0 and t=duration.
const w0 = evalWorld(0, overrideOriginal);
const w1 = evalWorld(duration, overrideOriginal);
const closure = [];
const _qA = new THREE.Quaternion(), _qB = new THREE.Quaternion();
const _pA = new THREE.Vector3(), _pB = new THREE.Vector3(), _sA = new THREE.Vector3();
for (const n of nodes) {
  if (!chansByNode.has(n)) continue;
  w0.get(n).decompose(_pA, _qA, _sA);
  w1.get(n).decompose(_pB, _qB, _sA);
  const dPos = _pA.distanceTo(_pB);
  const dAng = 2 * Math.acos(Math.min(1, Math.abs(_qA.dot(_qB)))) * 180 / Math.PI;
  closure.push({ name: n.getName(), dPos, dAng });
}
closure.sort((a, b) => b.dAng - a.dAng);
console.log('  worst 10 by angle:');
for (const c of closure.slice(0, 10)) {
  console.log(`  ${c.name.padEnd(34)} Δangle:${c.dAng.toFixed(2)}°  Δpos:${(c.dPos * 1000).toFixed(1)}mm`);
}

// ---- 3. jerk spikes ----------------------------------------------------------
console.log('\n== per-foot frame-to-frame speed (original clip; spikes = hitch) ==');
// report in "keyframe" units too: find the keyframe count of a rear-leg channel
let kfCount = 0;
for (const [node, ch] of chansByNode) {
  if (/rearLeg|rearHorse/i.test(node.getName() || '') && ch.rotation) {
    kfCount = Math.max(kfCount, ch.rotation.times.length);
  }
}
console.log(`  (rear-leg channels have ${kfCount} keyframes; hand-edits were at frames 2,5,6,7,8,9)`);
for (const [name, pts] of footTracks) {
  const speeds = pts.map((p, i) => p.distanceTo(pts[(i + 1) % pts.length]));
  const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const spikes = speeds
    .map((s, i) => ({ i, s }))
    .filter(o => o.s > mean * 2.5)
    .sort((a, b) => b.s - a.s)
    .slice(0, 6);
  const fmt = spikes.map(o => `phase ${(o.i / pts.length).toFixed(3)} (~kf ${(o.i / pts.length * (kfCount - 1)).toFixed(1)}): ${(o.s / mean).toFixed(1)}x`);
  console.log(`  ${name.padEnd(28)} mean:${(mean * 1000).toFixed(2)}mm/sample  spikes: ${fmt.length ? fmt.join('; ') : 'none >2.5x'}`);
}

// ---- 4. original vs mirror distance ------------------------------------------
console.log('\n== original vs mirror pose distance over cycle (feet, world) ==');
const dist = times.map((t, i) => {
  let d = 0;
  for (const f of footNodes) {
    d += footTracks.get(f.getName())[i].distanceTo(footTracksMir.get(f.getName())[i]);
  }
  return d;
});
const dMin = Math.min(...dist), dMax = Math.max(...dist);
const iMin = dist.indexOf(dMin);
console.log(`  at t=0 (current swap point): ${(dist[0] * 1000).toFixed(1)}mm summed over ${footNodes.length} feet`);
console.log(`  min over cycle:              ${(dMin * 1000).toFixed(1)}mm at phase ${(iMin / N_SAMPLES).toFixed(3)}`);
console.log(`  max over cycle:              ${(dMax * 1000).toFixed(1)}mm`);
console.log('  distance curve (phase: mm):');
const STEP = Math.floor(N_SAMPLES / 24);
for (let i = 0; i < N_SAMPLES; i += STEP) {
  const bar = '#'.repeat(Math.round((dist[i] / dMax) * 50));
  console.log(`    ${(i / N_SAMPLES).toFixed(3)}  ${(dist[i] * 1000).toFixed(1).padStart(7)}  ${bar}`);
}

// ---- 5. phase-lag sweep -------------------------------------------------------
// If the R side were a healthy phase-shifted counterpart of the L side (a
// gallop's lead offset), then for some lag the L foot trajectory would match
// the mirror clip's L foot (= mirrored R data) shifted by that lag. If NO lag
// aligns them, the R data's motion plane itself is wrong — converter-level
// corruption, not a phase thing.
console.log('\n== phase-lag sweep: L foot vs mirrored-R foot (best alignment) ==');
for (const f of footNodes) {
  const name = f.getName();
  if (!/\.?L$/.test(name)) continue;
  const A = footTracks.get(name);       // original L data
  const B = footTracksMir.get(name);    // mirrored R data on the same bone
  let best = { lag: 0, d: Infinity };
  for (let lag = 0; lag < N_SAMPLES; lag++) {
    let d = 0;
    for (let i = 0; i < N_SAMPLES; i++) d += A[i].distanceTo(B[(i + lag) % N_SAMPLES]);
    d /= N_SAMPLES;
    if (d < best.d) best = { lag, d };
  }
  let d0 = 0;
  for (let i = 0; i < N_SAMPLES; i++) d0 += A[i].distanceTo(B[i]);
  d0 /= N_SAMPLES;
  console.log(`  ${name.padEnd(28)} zero-lag:${(d0 * 1000).toFixed(1)}mm  best:${(best.d * 1000).toFixed(1)}mm at phase-lag ${(best.lag / N_SAMPLES).toFixed(3)}`);
}
