import { asset } from '../assetPath.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * The bobcat rig: visual mesh, textures, animation mixer, and the methods that
 * play/blend clips. Knows nothing about physics, input, or terrain — only how
 * to put the right pose on screen.
 *
 * loadBobcatRig() returns:
 *   {
 *     object,  // pivot Group — add this to the scene
 *     pivot,   // same as object (kept for clarity at call sites)
 *     root,    // the loaded GLB scene under pivot
 *     support: { halfLength, halfWidth, groundClearance },  // for sim grounding
 *     setLocomotionBlend(speed, walkSpeed, runSpeed, airborne),
 *     playJump(), stopJump(),
 *     tick(dt)  // advances the mixer (or runs a procedural bob if unanimated)
 *   }
 */
export async function loadBobcatRig({ url = asset('bobcat.glb'), onProgress } = {}) {
  const loader = new GLTFLoader();

  // Pre-load PZ fur textures in parallel with the GLB. Extracted via cobra-
  // tools + ImageMagick; the GLB ships with empty material slots because
  // Cobra .tex files don't round-trip through glTF.
  const texLoader = new THREE.TextureLoader();
  const loadOpt = (path, srgb = true) => new Promise(res => texLoader.load(path,
    t => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.flipY = false;
      res(t);
    }, undefined, () => res(null)));
  const [furBase, furNormal, furRough, eyeBase, whiskersBase] = await Promise.all([
    loadOpt(asset(`bobcat_textures/bobcat-newfurdiffuse.jpg?t=${Date.now()}`)),
    loadOpt(asset('bobcat_textures/nabobcat_ani_male_fur.pnormaltexture.png'), false),
    loadOpt(asset('bobcat_textures/nabobcat_ani_male_fur.proughnesspackedtexture.png'), false),
    loadOpt(asset('bobcat_textures/nabobcat_ani_male_eye.pbasecolourandmasktexture.png')),
    loadOpt(asset('bobcat_textures/nabobcat_ani_male_whiskers.pdiffuse.png'))
  ]);
  const pzTextures = { furBase, furNormal, furRough, eyeBase, whiskersBase };

  const gltf = await new Promise((resolve, reject) => {
    loader.load(url, resolve,
      xhr => onProgress && onProgress(xhr.loaded / Math.max(1, xhr.total)),
      reject);
  });

  return buildRig(gltf, pzTextures);
}

function buildRig(gltf, pzTextures) {
  const root = gltf.scene;

  // Planet Zoo packs the bobcat as 6 LODs (L0 highest), each with skin/fur/
  // fur_shell/fur_fin/eye/whiskers sub-meshes plus 35+ physics colliders.
  // Without PZ's dynamic fur shaders, fur_shell extrusions render as solid
  // offset copies — the "cardboard boxes" look. Show only L0 skin+eye+
  // whiskers; hide every other LOD, the fur shells, and the physics meshes.
  const isVisibleMesh = name => {
    if (!name) return true;
    const lc = name.toLowerCase();
    if (lc.includes('_physics')) return false;
    if (lc.includes('fur_fin')) return false;
    const lodMatch = lc.match(/_l(\d)_/);
    if (lodMatch && lodMatch[1] !== '0') return false;
    return true;
  };
  root.traverse(o => {
    if ((o.isMesh || o.isSkinnedMesh) && !isVisibleMesh(o.name)) {
      o.visible = false;
    }
  });
  // Disable fur_shell sub-materials on the merged fur mesh so the extruded
  // shells stop rendering.
  root.traverse(o => {
    if (!(o.isMesh || o.isSkinnedMesh) || !o.visible) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      const mn = (m.name || '').toLowerCase();
      if (/shell|fur_fin/.test(mn)) m.visible = false;
    }
  });

  // Pick the right PZ texture per material. The shipped GLB's *meshes* are
  // named `nabobcat_mod_male_model0..23` (LOD/marking variants) so a mesh-name
  // heuristic never matched — but the *materials* are correctly named
  // (`nabobcat_ani_male_fur`, `_skin`, `_eye`, `_whiskers`). Key off those.
  // Fur material gets the new JPG diffuse; skin shares it (single body covering).
  const pickTexturesForMaterial = matName => {
    const lc = (matName || '').toLowerCase();
    if (lc.includes('eye')) return { map: pzTextures.eyeBase };
    if (lc.includes('whisker')) return { map: pzTextures.whiskersBase };
    if (lc.includes('fur') || lc.includes('skin')) {
      return { map: pzTextures.furBase, normalMap: pzTextures.furNormal, roughMap: pzTextures.furRough };
    }
    return {};
  };
  const debugSeen = new Set();
  root.traverse(o => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if (!o.visible) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      const picks = pickTexturesForMaterial(m.name);
      // Override unconditionally — the GLB ships with a marking-noise PNG
      // bound to map slots on some materials, so honoring an existing m.map
      // would hide the diffuse we want to apply.
      if (picks.map) m.map = picks.map;
      if (picks.normalMap) {
        m.normalMap = picks.normalMap;
        if (m.normalScale) m.normalScale.set(1.0, 1.0);
      }
      if (picks.roughMap) m.roughnessMap = picks.roughMap;
      if (!debugSeen.has(m.name)) {
        debugSeen.add(m.name);
        console.log(`bobcat material: "${m.name}" → map=${m.map ? 'yes' : 'NO'}`);
      }
      if ('metalness' in m) m.metalness = 0.0;
      if ('roughness' in m) m.roughness = Math.min(1, (m.roughness ?? 0.6) + 0.05);
      // GLB ships these materials as alphaMode=BLEND — force them solid so
      // the cat writes depth (water/grass don't bleed through) and so the
      // diffuse renders at full strength rather than alpha-blended.
      m.transparent = false;
      m.opacity = 1.0;
      m.depthTest = true;
      m.depthWrite = true;
      if (m.map) m.alphaTest = 0.35;
      if (m.color) {
        if (m.map) m.color.setRGB(1, 1, 1);
        else m.color.setRGB(0.78, 0.62, 0.42);
      }
      // No emissive fill — the new fur diffuse already has shading baked in,
      // so adding a warm fill flattens the markings and washes the body.
      if (m.emissive) {
        m.emissive.setRGB(0, 0, 0);
        m.emissiveIntensity = 0;
      }
      m.needsUpdate = true;
    }
    o.castShadow = false;
    o.receiveShadow = false;
  });

  // ---- Sizing: scale uniformly so longest axis ≈ 0.85m ------------------
  const _v = new THREE.Vector3();
  const computeVisibleBBox = () => {
    const bb = new THREE.Box3();
    root.traverse(o => {
      if (!(o.isMesh || o.isSkinnedMesh) || !o.visible || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const gb = o.geometry.boundingBox;
      o.updateWorldMatrix(true, false);
      for (let i = 0; i < 8; i++) {
        _v.set(
          i & 1 ? gb.max.x : gb.min.x,
          i & 2 ? gb.max.y : gb.min.y,
          i & 4 ? gb.max.z : gb.min.z
        ).applyMatrix4(o.matrixWorld);
        bb.expandByPoint(_v);
      }
    });
    return bb;
  };

  const bbox = computeVisibleBBox();
  const size = bbox.getSize(new THREE.Vector3());
  console.log('bobcat bbox (visible only):', size.x.toFixed(2), size.y.toFixed(2), size.z.toFixed(2));

  // Scale uniformly so the LONGEST axis (nose-to-tail length) is ~0.85m,
  // robust to whether the bind pose is standing or lying.
  const targetLength = 0.85;
  const longest = Math.max(size.x, size.y, size.z, 1e-3);
  const scale = targetLength / longest;
  root.scale.setScalar(scale);

  // PZ bind pose lays nose-to-tail along Z, but every animation re-orients
  // the body to lie along X — so it walks sideways relative to motion.
  // Counter-rotate -90° around Y so animated forward (-X) aligns with our +Z
  // motion direction. Quaternius's bobcat doesn't have this offset; detect
  // by skinned-mesh name.
  let isPZ = false;
  root.traverse(o => {
    if (o.isSkinnedMesh && /nabobcat/i.test(o.name || '')) isPZ = true;
  });
  // Apply rotations as YXZ so the PZ yaw fix is the OUTERMOST rotation.
  // That way root.rotation.x (used by the drink-pose tilt below) pivots
  // the cat around its body's true horizontal axis, regardless of the yaw
  // correction. Default order is XYZ which would tilt around world axes
  // and pitch the cat sideways.
  root.rotation.order = 'YXZ';
  if (isPZ) root.rotation.y = -Math.PI / 2;
  console.log('bobcat orientation:', isPZ ? 'Planet Zoo (rotated -90°)' : 'Quaternius (no rotation)');

  // Recompute bbox post-scale, then translate so feet at y=0 and centred on
  // x/z. Same visible-only walk.
  const bbox2 = computeVisibleBBox();
  const size2 = bbox2.getSize(new THREE.Vector3());
  const center2 = bbox2.getCenter(new THREE.Vector3());
  root.position.x -= center2.x;
  root.position.z -= center2.z;
  root.position.y -= bbox2.min.y;
  const footY = root.position.y;

  const support = {
    halfLength: Math.max(0.08, size2.z * 0.32),
    halfWidth:  Math.max(0.05, size2.x * 0.30),
    groundClearance: 0.02
  };

  const pivot = new THREE.Group();
  pivot.add(root);

  // ---- Animations -------------------------------------------------------
  // Strip root motion on locomotion clips: PZ translates the root bone
  // forward through the cycle, but the sim moves the cat itself, so the
  // animation's root translation doubles up and snaps at loop wrap. Dropping
  // .position tracks on root/hips bones fixes the lurch-then-teleport.
  const ROOT_KEY = /(^|_)(c_)?(root|hips)(_joint)?$/i;
  const stripRootMotion = clip => {
    clip.tracks = clip.tracks.filter(t => {
      if (!t.name.endsWith('.position')) return true;
      const bone = t.name.split('.')[0];
      return !ROOT_KEY.test(bone);
    });
  };


  let mixer = null;
  const actions = {};
  if (gltf.animations && gltf.animations.length) {
    mixer = new THREE.AnimationMixer(root);
    for (const clip of gltf.animations) {
      const lc = clip.name.toLowerCase();
      if (/walk|run|jump|pounce|sprint/.test(lc)) stripRootMotion(clip);
      const a = mixer.clipAction(clip);
      a.setLoop(THREE.LoopRepeat);
      a.enabled = true;
      a.setEffectiveWeight(0);
      a.setEffectiveTimeScale(1);
      a.play();
      actions[lc] = a;
    }
  }

  // Resolve actions by tokens that uniquely identify each gait. PZ clips
  // are namespaced like `nabobcat_ani_male@walkbase` — match on the suffix
  // (after the last `@` or `_`). For Quaternius we just compare lowercased.
  // Prefix-match catches PZ's idle variants (standidle01/02) without false-
  // matching e.g. climbidle.
  const pickAction = (...names) => {
    const wanted = names.map(s => s.toLowerCase());
    for (const k of wanted) if (actions[k]) return actions[k];
    for (const k of wanted) {
      for (const key of Object.keys(actions)) {
        const tail = key.split('@').pop().split('_').pop();
        if (tail === k || tail.startsWith(k)) return actions[key];
      }
    }
    return null;
  };
  const idle  = pickAction('standidle', 'idle');
  const walkS = pickAction('walkslow', 'walk_slow');
  const walk  = pickAction('walkbase', 'walk');
  const run   = pickAction('runbase', 'run', 'sprint');
  const jump  = pickAction('jumpmid', 'jumpin', 'jump');
  if (idle) idle.setEffectiveWeight(1);

  // ---- Run clip mirror (rig-aware bind-pose retarget) ------------------
  // Single-lead source clip → permanent body bias. Build a sibling clip in
  // which each L bone plays the R bone's animation (and vice-versa),
  // mirrored across the rig's centerline plane.
  //
  // The math:  for each L/R pair, per keyframe,
  //     q_local_source → world via parent's bind quat
  //                    → mirror in world (component flip on chosen axis)
  //                    → local of target via inverse of target parent's bind quat
  // Positions go through the same chain with full bind matrices (including
  // translation). This is rig-aware: the mirror direction is determined by
  // each bone's *actual* bind orientation, not a hard-coded axis convention,
  // so it works regardless of how the original rigger oriented bones.
  //
  // Centerline bones (def_c_*) have no L/R suffix and remain identical
  // between the two clips — body bend is shared, only side bones flip.
  let runMirror = null;
  let runFullDuration = 0;
  let runCropFraction = 0.0;
  // Debug levers for diagnosing the sprint gait. Read in setLocomotionBlend.
  let debugRunTimeScale = 1.0;
  let debugMirrorEnabled = true;
  let debugMirrorLeadLock = 0; // 0=auto, +1=force original, -1=force mirror
  let debugPaused = false;
  let debugForceSprint = false;
  const originalMirrorValues = new Map();   // trackName → Float32Array snapshot
  const originalRunValues = new Map();      // trackName → Float32Array snapshot
  const skippedFrames = new Set();          // integer keyframe indices
  // Bones whose name matches this regex are excluded from the mirror — their
  // tracks keep the original (un-mirrored) values. Default excludes face/ears
  // because those bones aren't truly bind-mirror-symmetric in the PZ rig,
  // producing inside-out face pops when run through the mirror math.
  let mirrorExcludePattern = /lip|tongue|muzzle|nose|nostril|ear|whisker|eye|jaw|brow|snout|lid|mouth|cheek|tooth|chin/i;
  let rebuildMirrorClip = () => {};  // assigned inside the if-block below
  if (mixer && run) {
    // Cache bones by name and freeze bind-pose world transforms. Bind pose
    // is current here: actions are .play()-ed but at weight 0 and the mixer
    // hasn't been ticked yet, so bones still sit at their authored TRS.
    root.updateMatrixWorld(true);
    const boneByName = new Map();
    root.traverse(o => { if (o.isBone) boneByName.set(o.name, o); });

    // PZ convention: bones are `def_<name>_joint` (centerline) or
    // `def_<name>_joint<L|R>` (paired). The L/R suffix is either directly
    // on `_joint` (PZ source) or separated by a dot (Blender round-trip).
    const SIDE_RE = /^(.+_joint)(\.?)([LR])(\.[^.]+)$/;

    // Detect the rig's mirror plane axis empirically by comparing world
    // positions of a known L/R pair. The axis with the largest absolute
    // L−R offset is the one the rig mirrors across.
    let mirrorAxisIdx = 0;
    for (const candidateBase of ['def_legUpr_joint', 'def_ear_joint', 'def_eye_joint', 'def_pelvis_joint']) {
      const bL = boneByName.get(`${candidateBase}L`) || boneByName.get(`${candidateBase}.L`);
      const bR = boneByName.get(`${candidateBase}R`) || boneByName.get(`${candidateBase}.R`);
      if (!bL || !bR) continue;
      const pL = new THREE.Vector3().setFromMatrixPosition(bL.matrixWorld);
      const pR = new THREE.Vector3().setFromMatrixPosition(bR.matrixWorld);
      const diff = [Math.abs(pL.x - pR.x), Math.abs(pL.y - pR.y), Math.abs(pL.z - pR.z)];
      mirrorAxisIdx = diff.indexOf(Math.max(...diff));
      console.log(`[BobcatRig] mirror axis = ${['x','y','z'][mirrorAxisIdx]}=0`,
        '(via', candidateBase, 'L=', pL.toArray().map(v => v.toFixed(3)),
        'R=', pR.toArray().map(v => v.toFixed(3)), ')');
      break;
    }

    // Deep-copy original run clip values + times so origByName is immune to
    // the user's subsequent skip-frame mutations on the run clip.
    const origByName = new Map();
    for (const t of run.getClip().tracks) {
      origByName.set(t.name, {
        values: new Float32Array(t.values),
        times: new Float32Array(t.times)
      });
    }

    const mirroredClip = run.getClip().clone();
    mirroredClip.name = 'runbase_mirror';
    mirroredClip.uuid = THREE.MathUtils.generateUUID();
    mirroredClip.tracks = mirroredClip.tracks.map(t => t.clone());

    // Per-pair bind-frame transforms: parents' world matrices and quats.
    const pairData = new Map();
    for (const t of mirroredClip.tracks) {
      const m = t.name.match(SIDE_RE);
      if (!m) continue;
      const myName = `${m[1]}${m[2]}${m[3]}`;
      if (pairData.has(myName)) continue;
      const otherName = `${m[1]}${m[2]}${m[3] === 'L' ? 'R' : 'L'}`;
      const myBone = boneByName.get(myName);
      const otherBone = boneByName.get(otherName);
      if (!myBone || !otherBone) continue;
      const myParent = myBone.parent;
      const otherParent = otherBone.parent;
      if (!myParent || !otherParent) continue;
      const W_p_my = myParent.matrixWorld.clone();
      const W_p_other = otherParent.matrixWorld.clone();
      const W_p_my_inv = new THREE.Matrix4().copy(W_p_my).invert();
      const W_p_my_quat = new THREE.Quaternion();
      W_p_my.decompose(new THREE.Vector3(), W_p_my_quat, new THREE.Vector3());
      const W_p_other_quat = new THREE.Quaternion();
      W_p_other.decompose(new THREE.Vector3(), W_p_other_quat, new THREE.Vector3());
      pairData.set(myName, {
        W_p_my_inv,
        W_p_other,
        W_p_my_quat_inv: W_p_my_quat.clone().invert(),
        W_p_other_quat
      });
    }

    // Dump all L/R bone families to console so the user can see what's
    // available to include/exclude via the mirror pattern.
    const families = new Set();
    for (const myName of pairData.keys()) families.add(myName.replace(/\.?[LR]$/, ''));
    console.log(`[BobcatRig] L/R bone families (${families.size}):\n  ${[...families].sort().join('\n  ')}`);

    const _q = new THREE.Quaternion();
    const _qw = new THREE.Quaternion();
    const _p = new THREE.Vector3();

    // The per-track mirror compute, refactored into a function so it can be
    // re-run when the user changes the exclude pattern. Captures pairData,
    // origByName, mirrorAxisIdx, boneByName, mirroredClip in closure.
    rebuildMirrorClip = function () {
      let quatCount = 0, posCount = 0, excludeCount = 0;
      for (const t of mirroredClip.tracks) {
        const m = t.name.match(SIDE_RE);
        if (!m) continue;
        const [, base, sep, side, prop] = m;
        const myName = `${base}${sep}${side}`;

        // Excluded bones: restore the original source values verbatim.
        if (mirrorExcludePattern && mirrorExcludePattern.test(myName)) {
          const orig = origByName.get(t.name);
          if (orig) {
            t.times = new Float32Array(orig.times);
            t.values = new Float32Array(orig.values);
            excludeCount++;
          }
          continue;
        }

        const otherName = `${base}${sep}${side === 'L' ? 'R' : 'L'}`;
        const pair = pairData.get(myName);
        if (!pair) continue;
        const otherTrack = origByName.get(`${otherName}${prop}`);
        if (!otherTrack) continue;
        t.times = new Float32Array(otherTrack.times);

        if (prop === '.quaternion') {
          const vals = otherTrack.values;
          const newVals = new Float32Array(vals.length);
          const { W_p_my_quat_inv, W_p_other_quat } = pair;
          const myBone = boneByName.get(myName);
          let prevX = myBone.quaternion.x;
          let prevY = myBone.quaternion.y;
          let prevZ = myBone.quaternion.z;
          let prevW = myBone.quaternion.w;
          for (let i = 0; i < vals.length; i += 4) {
            _q.set(vals[i], vals[i + 1], vals[i + 2], vals[i + 3]);
            _qw.copy(W_p_other_quat).multiply(_q);
            if (mirrorAxisIdx === 0)      { _qw.y = -_qw.y; _qw.z = -_qw.z; }
            else if (mirrorAxisIdx === 1) { _qw.x = -_qw.x; _qw.z = -_qw.z; }
            else                          { _qw.x = -_qw.x; _qw.y = -_qw.y; }
            _q.copy(W_p_my_quat_inv).multiply(_qw);
            const dot = _q.x * prevX + _q.y * prevY + _q.z * prevZ + _q.w * prevW;
            if (dot < 0) {
              _q.x = -_q.x; _q.y = -_q.y; _q.z = -_q.z; _q.w = -_q.w;
            }
            newVals[i]     = _q.x;
            newVals[i + 1] = _q.y;
            newVals[i + 2] = _q.z;
            newVals[i + 3] = _q.w;
            prevX = _q.x; prevY = _q.y; prevZ = _q.z; prevW = _q.w;
          }
          t.values = newVals;
          quatCount++;
        } else if (prop === '.position') {
          const vals = otherTrack.values;
          const newVals = new Float32Array(vals.length);
          const { W_p_my_inv, W_p_other } = pair;
          for (let i = 0; i < vals.length; i += 3) {
            _p.set(vals[i], vals[i + 1], vals[i + 2]);
            _p.applyMatrix4(W_p_other);
            if (mirrorAxisIdx === 0) _p.x = -_p.x;
            else if (mirrorAxisIdx === 1) _p.y = -_p.y;
            else _p.z = -_p.z;
            _p.applyMatrix4(W_p_my_inv);
            newVals[i] = _p.x;
            newVals[i + 1] = _p.y;
            newVals[i + 2] = _p.z;
          }
          t.values = newVals;
          posCount++;
        } else {
          t.values = new Float32Array(otherTrack.values);
        }
      }
      console.log(`[BobcatRig] mirror rebuilt: ${quatCount} quat + ${posCount} pos transformed, ${excludeCount} excluded`);
    };
    rebuildMirrorClip();

    runMirror = mixer.clipAction(mirroredClip);
    runMirror.setLoop(THREE.LoopRepeat);
    runMirror.enabled = true;
    runMirror.setEffectiveWeight(0);
    runMirror.setEffectiveTimeScale(1);
    runMirror.play();
    runMirror.time = run.time;

    // Snapshot the freshly built mirror track values so we can restore them
    // when the user toggles per-frame skips on/off via the debug menu.
    for (const t of mirroredClip.tracks) {
      originalMirrorValues.set(t.name, new Float32Array(t.values));
    }
    // Snapshot original run clip values too — skip frames apply to both
    // clips so a single skip cleans both lead variants at once.
    for (const t of run.getClip().tracks) {
      originalRunValues.set(t.name, new Float32Array(t.values));
    }

    // End-of-cycle crop: the mirrored back leg has a quaternion artifact in
    // the very last frames of the loop. Shorten both clips equally so that
    // bad frame is never reached. They stay synced because the wrap-detection
    // in tick() compares run.time to lastRunTime — and both wrap together
    // when duration is identical.
    runFullDuration = run.getClip().duration;
    setRunCrop(runCropFraction);
  }
  function setRunCrop(f) {
    runCropFraction = Math.max(0, Math.min(0.5, f));
    if (!run || !runFullDuration) return;
    const dur = runFullDuration * (1 - runCropFraction);
    run.getClip().duration = dur;
    if (runMirror) runMirror.getClip().duration = dur;
  }
  function getRunCrop() { return runCropFraction; }
  function setRunTimeScale(s) { debugRunTimeScale = Math.max(0.05, Math.min(2, s)); }
  function getRunTimeScale() { return debugRunTimeScale; }
  function setMirrorEnabled(b) { debugMirrorEnabled = !!b; }
  function getMirrorEnabled() { return debugMirrorEnabled; }
  function setMirrorLeadLock(n) { debugMirrorLeadLock = n > 0 ? 1 : n < 0 ? -1 : 0; }
  function getMirrorLeadLock() { return debugMirrorLeadLock; }
  function setMirrorExcludePattern(re) {
    mirrorExcludePattern = re instanceof RegExp ? re : (re ? new RegExp(re, 'i') : null);
    rebuildMirrorClip();
    if (runMirror) {
      for (const t of runMirror.getClip().tracks) {
        originalMirrorValues.set(t.name, new Float32Array(t.values));
      }
    }
    rebuildMirrorTracks();
  }
  function getMirrorExcludePattern() {
    return mirrorExcludePattern ? mirrorExcludePattern.source : '';
  }
  function setPaused(b) { debugPaused = !!b; }
  function getPaused() { return debugPaused; }
  function setForceSprint(b) { debugForceSprint = !!b; }
  function getForceSprint() { return debugForceSprint; }
  function setRunTimeFraction(f) {
    if (!run) return;
    const dur = run.getClip().duration;
    if (dur <= 0) return;
    const t = Math.max(0, Math.min(0.999, f)) * dur;
    run.time = t;
    if (runMirror) runMirror.time = t;
    // When paused, the main tick won't advance the mixer — but we still
    // need to resample the bones at the new time. mixer.update(0) does that.
    if (mixer && debugPaused) mixer.update(0);
  }
  function getRunTimeFraction() {
    if (!run) return 0;
    const dur = run.getClip().duration;
    return dur > 0 ? (run.time % dur) / dur : 0;
  }
  function getFrameCount() {
    if (!runMirror) return 0;
    let max = 0;
    for (const t of runMirror.getClip().tracks) {
      if (t.times.length > max) max = t.times.length;
    }
    return max;
  }
  function isFrameSkipped(idx) { return skippedFrames.has(idx); }
  function getSkippedFrames() { return [...skippedFrames].sort((a, b) => a - b); }
  function setFrameSkipped(idx, on) {
    if (on) skippedFrames.add(idx); else skippedFrames.delete(idx);
    rebuildMirrorTracks();
  }
  function clearSkippedFrames() {
    skippedFrames.clear();
    rebuildMirrorTracks();
  }
  function rebuildMirrorTracks() {
    rebuildClipTracks(run, originalRunValues);
    rebuildClipTracks(runMirror, originalMirrorValues);
  }
  function rebuildClipTracks(action, originals) {
    if (!action) return;
    const maxFrames = getFrameCount();
    if (maxFrames < 2) return;
    const dur = action.getClip().duration || runFullDuration;
    for (const t of action.getClip().tracks) {
      const orig = originals.get(t.name);
      if (!orig) continue;
      const frames = t.times.length;
      if (frames < 2) continue;
      const stride = orig.length / frames;
      if (!Number.isInteger(stride)) continue;
      t.values = new Float32Array(orig);
      // For each skipped global frame, find the nearest keyframe in this
      // track (matched by time, not index — tracks have varying keyframe
      // counts) and hold the previous keyframe's values.
      for (const skippedIdx of skippedFrames) {
        const tFrac = skippedIdx / (maxFrames - 1);
        const targetTime = tFrac * dur;
        let nearest = 0;
        let nearestDist = Infinity;
        for (let i = 0; i < frames; i++) {
          const d = Math.abs(t.times[i] - targetTime);
          if (d < nearestDist) { nearestDist = d; nearest = i; }
        }
        if (nearest > 0) {
          for (let k = 0; k < stride; k++) {
            t.values[nearest * stride + k] = t.values[(nearest - 1) * stride + k];
          }
        }
      }
    }
  }

  // PZ rigs only: the root bone's bind-pose quaternion is the bind X-forward
  // value (90° off from the corrected pose), so when the mixer drops back to
  // bind — which happens whenever no active clip writes the track, e.g. when
  // jump's clip has a stale t=0 keyframe or when locomotion is at weight 0
  // during a jump — the body snaps 90°. Sample the corrected quaternion from
  // an idle clip's first keyframe and force-write it onto the bone every
  // frame after mixer.update, so the bone orientation can't be clobbered.
  let rootBone = null;
  const rootBoneQuat = new THREE.Quaternion();
  let rootBoneOverride = false;
  if (isPZ && mixer) {
    const sourceClip = (idle && idle.getClip()) || (walk && walk.getClip()) || null;
    if (sourceClip) {
      const qTrack = sourceClip.tracks.find(t => {
        const dot = t.name.lastIndexOf('.');
        return t.name.slice(dot + 1) === 'quaternion'
          && ROOT_KEY.test(t.name.slice(0, dot));
      });
      if (qTrack && qTrack.values.length >= 4) {
        const boneName = qTrack.name.slice(0, qTrack.name.lastIndexOf('.'));
        root.traverse(o => { if (o.isBone && o.name === boneName) rootBone = o; });
        if (rootBone) {
          rootBoneQuat.set(qTrack.values[0], qTrack.values[1], qTrack.values[2], qTrack.values[3]);
          rootBoneOverride = true;
        }
      }
    }
  }

  // ---- Public methods ---------------------------------------------------
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  let gaitClock = 0;

  function setLocomotionBlend(speed, walkSpeed, runSpeed, airborne) {
    if (!mixer) return;
    // Cross-fade idle/walkSlow/walk/run by speed. Narrow blend zones (especially
    // walk↔run) so two clips with different foot phases don't average together
    // into an asymmetric gait — that averaging is what reads as a "limp".
    //   v=0          → idle 1
    //   v=walkSpeed/2→ walkSlow 1
    //   v=walkSpeed  → walk 1
    //   v≥walkSpeed*1.6 → run 1
    const v = speed;
    const wIdle  = clamp01(1 - v / 0.8);
    const wWalkS = clamp01(1 - Math.abs(v - 1.6) / 1.6);
    // Walk peaks at walkSpeed (3.2) and falls off by walkSpeed*1.4 — sharper
    // shoulders mean less overlap with run.
    const wWalk  = clamp01(1 - Math.abs(v - walkSpeed) / (walkSpeed * 0.7));
    // Run ramps in just as walk fades out (~walkSpeed*1.3 to walkSpeed*1.7).
    const wRun   = clamp01((v - walkSpeed * 1.3) / (walkSpeed * 0.4));
    const total  = wIdle + wWalkS + wWalk + wRun + 1e-6;
    const locoMul = airborne ? 0 : 1;
    const ri = locoMul * wIdle  / total;
    const rs = locoMul * wWalkS / total;
    const rw = locoMul * wWalk  / total;
    const rr = locoMul * wRun   / total;
    // Force-sprint override: pin all weight to the run pair regardless of
    // actual speed. Useful for scrubbing the sprint cycle while standing.
    let ri2 = ri, rs2 = rs, rw2 = rw, rr2 = rr;
    if (debugForceSprint) { ri2 = 0; rs2 = 0; rw2 = 0; rr2 = 1; }
    if (idle)  idle.setEffectiveWeight(ri2);
    if (walkS) walkS.setEffectiveWeight(rs2);
    if (walk)  walk.setEffectiveWeight(rw2);
    // Run weight is split between the original (lead A) and the .L/.R-swapped
    // mirror (lead B). mirrorLead flips each cycle wrap; the inactive lead is
    // held at weight 0. Debug levers override: if mirror is disabled all
    // weight goes to original; if a lead is locked, use that instead of
    // the auto-alternating mirrorLead.
    const effectiveLead = !debugMirrorEnabled
      ? 1
      : (debugMirrorLeadLock !== 0 ? debugMirrorLeadLock : mirrorLead);
    if (run && runMirror) {
      // Cross-fade the lead swap instead of hard-cutting. An instant weight
      // flip at every cycle wrap lands any original↔mirror asymmetry as a
      // once-per-stride hitch — which reads as a limp. smoothedLead chases
      // effectiveLead in tick() (~70ms), so the swap blends through the
      // stride apex where the two clips are most alike.
      const leadT = (smoothedLead + 1) * 0.5;   // 1 = original, 0 = mirror
      run.setEffectiveWeight(rr2 * leadT);
      runMirror.setEffectiveWeight(rr2 * (1 - leadT));
    } else if (run) {
      run.setEffectiveWeight(rr2);
    }
    const runTs = debugRunTimeScale * (rr2 > 0.02 ? Math.min(1.0, 0.95 + 0.10 * (v / runSpeed)) : 1.0);
    if (run)       run.setEffectiveTimeScale(runTs);
    if (runMirror) runMirror.setEffectiveTimeScale(runTs);
    if (walk) walk.setEffectiveTimeScale(rw > 0.02 ? Math.min(1.0, 0.90 + 0.15 * (v / walkSpeed)) : 1.0);

    runWeightForRoll = rr2;
  }
  let runWeightForRoll = 0;

  // Lead-alternation body roll layered on top of the clip mirror — adds the
  // body bank that the swap alone doesn't produce (centerline bones aren't
  // touched by the swap, so spine lean stays the same on both clips). Small
  // magnitude so it complements the mirrored leg phase, doesn't dominate it.
  const ROLL_LEAD_RAD = 0.045;
  let mirrorLead = 1;
  let smoothedLead = 1;   // chases the active lead for the cross-fade
  let lastRunTime = 0;

  // ---- Feeding pose (kill latch) ----------------------------------------
  // While the sim is latched onto a kill, layer the run clip — restricted to
  // the FRONT half of the skeleton — at high speed over the idle base. The
  // pumping shoulders/neck/jaw of the run cycle read as tearing at the
  // carcass, while the hindquarters keep the calm idle so the cat looks
  // planted. Weight is set well above idle's so the front bones are
  // feed-dominated (mixer normalizes by accumulated weight).
  const FEED_FRONT_RE = /head|neck|jaw|front|clavicle|scapula|chest|spine3|lip|tongue|muzzle|ear|eye|brow|whisker/i;
  const FEED_TIMESCALE = 2.4;
  const FEED_DOMINANCE = 3.0;
  let feedAction = null;
  let feedWeight = 0;
  function ensureFeedAction() {
    if (feedAction || !mixer || !run) return;
    const src = run.getClip();
    const tracks = src.tracks
      .filter(t => FEED_FRONT_RE.test(t.name.split('.')[0]))
      .map(t => t.clone());
    if (!tracks.length) return;
    const clip = new THREE.AnimationClip('feed_front', src.duration, tracks);
    feedAction = mixer.clipAction(clip);
    feedAction.setLoop(THREE.LoopRepeat, Infinity);
    feedAction.setEffectiveWeight(0);
    feedAction.setEffectiveTimeScale(FEED_TIMESCALE);
    feedAction.play();
  }
  function setFeeding(active, dt) {
    if (active) ensureFeedAction();
    if (!feedAction) return;
    const target = active ? 1 : 0;
    feedWeight += (target - feedWeight) * Math.min(1, dt * 10);
    if (feedWeight < 0.01) feedWeight = active ? feedWeight : 0;
    feedAction.setEffectiveWeight(feedWeight * FEED_DOMINANCE);
  }

  function playJump() {
    if (!jump) return;
    jump.reset();
    jump.setLoop(THREE.LoopOnce, 1);
    jump.clampWhenFinished = true;
    jump.setEffectiveTimeScale(1.1);
    jump.setEffectiveWeight(1);
    jump.fadeIn(0.08);
    jump.play();
  }

  function stopJump() {
    if (jump) jump.fadeOut(0.18);
  }

  /**
   * Per-frame mixer tick. If the GLB has no animations, falls back to a
   * procedural bob/pitch/roll keyed off the sim state.
   */
  let appliedLeadRoll = 0;
  function tick(dt, sim) {
    if (mixer) {
      // When paused, advance 0 — bones stay at whatever time was last set
      // (by the scrub slider via setRunTimeFraction, or just frozen).
      mixer.update(debugPaused ? 0 : dt);
      if (rootBoneOverride) rootBone.quaternion.copy(rootBoneQuat);

      // Detect run-cycle wrap → swap which lead is active. Resync the
      // mirror's clock to the original so the swap lands at the same phase
      // (both clips currently at ~t=0, which is "stride end / apex"
      // — the moment in the cycle where left/right leg positions are most
      // similar, so the visible pop is minimised). Skip while paused to
      // avoid the lead flipping whenever the user scrubs backwards.
      if (run && !debugPaused) {
        const t = run.time;
        if (t < lastRunTime) {
          mirrorLead = -mirrorLead;
          if (runMirror) runMirror.time = run.time;
        }
        lastRunTime = t;
      }
      // Chase the active lead for the weight cross-fade (see
      // setLocomotionBlend). ~70ms: fast enough that both clips only
      // co-mix for a few frames around the swap, slow enough to kill the
      // pop. While paused (scrubbing), snap — the debug levers should be
      // instant.
      {
        const targetLead = !debugMirrorEnabled
          ? 1
          : (debugMirrorLeadLock !== 0 ? debugMirrorLeadLock : mirrorLead);
        if (debugPaused) smoothedLead = targetLead;
        else smoothedLead += (targetLead - smoothedLead) * Math.min(1, dt / 0.07);
      }
      // Target roll: only applied when run is the dominant gait. Fades in
      // smoothly with run weight so walking/transition speeds aren't tilted.
      const target = runWeightForRoll > 0.4
        ? mirrorLead * ROLL_LEAD_RAD * Math.min(1, (runWeightForRoll - 0.4) / 0.4)
        : 0;
      // Smoothing time constant ≈ 0.18s so the flip happens over a few frames
      // and doesn't snap (which would look like the camera jolting).
      const k = Math.min(1, dt / 0.18);
      appliedLeadRoll += (target - appliedLeadRoll) * k;
      root.rotation.z = appliedLeadRoll;
    } else {
      const speedT = Math.min(1, sim.speed / sim.runSpeed);
      const gaitFreq = THREE.MathUtils.lerp(2.0, 12.0, speedT);
      const gaitPhase = (gaitClock += dt * gaitFreq);
      const bob   = Math.sin(gaitPhase) * THREE.MathUtils.lerp(0.005, 0.07, speedT);
      const pitch = Math.sin(gaitPhase) * THREE.MathUtils.lerp(0.0,  0.10, speedT);
      const roll  = Math.sin(gaitPhase * 0.5) * speedT * 0.06;
      root.position.y = footY + bob;
      root.rotation.x = pitch;
      root.rotation.z = roll;
    }
  }

  // Drink pose — when active, lerps the root's pitch toward `drinkAngle` so
  // the cat visibly leans forward (head down) toward the water. Released
  // smoothly when inactive. With root.rotation.order = 'YXZ', the X-axis
  // tilt happens AFTER the yaw fix, so the cat tilts around its body's
  // forward axis correctly.
  let drinkPose = 0;
  const DRINK_ANGLE = 0.55;   // radians forward — about 31°, "stooped"
  function setDrinkPose(active, dt) {
    const target = active ? 1.0 : 0.0;
    const k = Math.min(1, dt * 6);
    drinkPose += (target - drinkPose) * k;
    // Animation mixer drives the rest of the pose; we layer the drink tilt
    // by writing root.rotation.x. (Mixer-controlled bones aren't on the
    // root transform, so we don't fight with it.) Slight Y dip too — the
    // cat lowers itself a touch as it bends.
    if (mixer) {
      root.rotation.x = drinkPose * DRINK_ANGLE;
      root.position.y = footY - drinkPose * 0.06;
    }
  }

  return {
    object: pivot,
    pivot,
    root,
    mixer,
    actions,
    support,
    setLocomotionBlend,
    playJump,
    stopJump,
    setDrinkPose,
    setFeeding,
    setRunCrop,
    getRunCrop,
    setRunTimeScale,
    getRunTimeScale,
    setMirrorEnabled,
    getMirrorEnabled,
    setMirrorLeadLock,
    getMirrorLeadLock,
    setMirrorExcludePattern,
    getMirrorExcludePattern,
    setPaused,
    getPaused,
    setForceSprint,
    getForceSprint,
    setRunTimeFraction,
    getRunTimeFraction,
    getFrameCount,
    isFrameSkipped,
    getSkippedFrames,
    setFrameSkipped,
    clearSkippedFrames,
    tick
  };
}
