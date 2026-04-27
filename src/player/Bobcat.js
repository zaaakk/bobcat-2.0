import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Loads the bobcat GLB and exposes a controller that walks/runs the cat across
 * the terrain. Works without animations if the model has none — falls back to
 * a small idle bob.
 */
export async function loadBobcat({ url = '/assets/bobcat.glb', onProgress } = {}) {
  const loader = new GLTFLoader();
  // Pre-load the PZ fur textures in parallel with the GLB. These were
  // extracted via cobra-tools + ImageMagick and dumped to public/assets/
  // bobcat_textures/. We patch them onto the fur material in buildController
  // because the GLB ships with empty material slots (Cobra .tex files don't
  // round-trip through glTF).
  const texLoader = new THREE.TextureLoader();
  const loadOpt = (path, srgb = true) => new Promise(res => texLoader.load(path,
    t => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.flipY = false;            // glTF UVs are flipped vs three's default
      res(t);
    }, undefined, () => res(null)));
  const [furBase, furNormal, furRough, eyeBase, whiskersBase] = await Promise.all([
    loadOpt('/assets/bobcat_textures/nabobcat_ani_male_fur.pbasecolourandmasktexture.png'),
    loadOpt('/assets/bobcat_textures/nabobcat_ani_male_fur.pnormaltexture.png', false),
    loadOpt('/assets/bobcat_textures/nabobcat_ani_male_fur.proughnesspackedtexture.png', false),
    loadOpt('/assets/bobcat_textures/nabobcat_ani_male_eye.pbasecolourandmasktexture.png'),
    loadOpt('/assets/bobcat_textures/nabobcat_ani_male_whiskers.pdiffuse.png')
  ]);
  const pzTextures = { furBase, furNormal, furRough, eyeBase, whiskersBase };

  return new Promise((resolve, reject) => {
    loader.load(url,
      gltf => resolve(buildController(gltf, pzTextures)),
      xhr => onProgress && onProgress(xhr.loaded / Math.max(1, xhr.total)),
      reject
    );
  });
}

function buildController(gltf, pzTextures = {}) {
  const root = gltf.scene;

  // The retargeted GLB carries baseColor textures whose linear values are
  // dark; with our restrained lighting they read as a black silhouette. Lift
  // them by tweaking each material as we traverse: brighten baseColor, drop
  // metalness, soften roughness slightly, and add a small emissive so the
  // unlit side of the body never crushes to pure black.
  const tmpCol = new THREE.Color();
  // Planet Zoo packs the bobcat as 6 LODs (L0 highest, L5 lowest), each with
  // 7-ish sub-meshes (skin, fur, fur_shell, fur_fin, eye, whiskers) plus 35+
  // physics-collider meshes that aren't meant to render at all. Without PZ's
  // dynamic fur shaders the fur_shell extrusions render as solid offset
  // copies of the body — the "cardboard boxes" look. Show only L0 skin+eye+
  // whiskers; hide every other LOD, the fur shells, and the physics colliders.
  // Filter what renders:
  //   - hide *_physics meshes (collision bounds, not for rendering)
  //   - hide L1..L5 LODs, keep only L0
  //   - hide explicit fur_fin (long-strand fur cards)
  //   - keep the merged `fur,fur_shell` mesh because that's the only thing
  //     covering the body — but disable the fur_shell sub-materials so the
  //     extruded shells stop rendering as cardboard boxes.
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
  // Disable the fur_shell material on the merged fur mesh. Three.js stores
  // multi-material meshes with `material` as an array; we walk it and hide
  // any sub-material whose name (or shader keyword) marks it as a shell.
  root.traverse(o => {
    if (!(o.isMesh || o.isSkinnedMesh) || !o.visible) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      const mn = (m.name || '').toLowerCase();
      if (/shell|fur_fin/.test(mn)) {
        m.visible = false;     // three.js Material has `.visible`
      }
    }
  });

  // Pick the right PZ texture per submesh based on its name. PZ packs the
  // diffuse + alpha mask in `pbasecolourandmasktexture`, normal in
  // `pnormaltexture`, roughness in `proughnesspackedtexture`. Mesh names like
  // `..._L0_ani_male_fur,_ani_male_fur_shell` tell us this is the fur layer.
  function pickTexturesForMesh(meshName) {
    const lc = (meshName || '').toLowerCase();
    if (lc.includes('fur')) return { map: pzTextures.furBase, normalMap: pzTextures.furNormal, roughMap: pzTextures.furRough };
    if (lc.includes('eye')) return { map: pzTextures.eyeBase };
    if (lc.includes('whisker')) return { map: pzTextures.whiskersBase };
    return {};
  }

  root.traverse(o => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if (!o.visible) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const picks = pickTexturesForMesh(o.name);
    for (const m of mats) {
      if (!m) continue;
      // Apply PZ textures pulled from the OVL extract (cobra-tools → DDS →
      // ImageMagick → PNG). Without these, the fur material renders white.
      if (picks.map && !m.map) m.map = picks.map;
      if (picks.normalMap && !m.normalMap) {
        m.normalMap = picks.normalMap;
        if (m.normalScale) m.normalScale.set(1.0, 1.0);
      }
      if (picks.roughMap && !m.roughnessMap) m.roughnessMap = picks.roughMap;
      if ('metalness' in m) m.metalness = 0.0;
      if ('roughness' in m) m.roughness = Math.min(1, (m.roughness ?? 0.6) + 0.05);
      // Color tinting: leave at identity when there's a real texture; tan
      // fallback only when the mesh has no map.
      if (m.color) {
        if (m.map) m.color.setRGB(1, 1, 1);
        else m.color.setRGB(0.78, 0.62, 0.42);
      }
      // And use the diffuse texture as an emissive map so the unlit side
      // doesn't crush. Combined the two roughly double the bobcat's apparent
      // luminance.
      // Subtle emissive fill so the unlit side of the body doesn't crush to
      // pure black under our restrained ambient. Don't lean on emissive as a
      // brightness boost — the diffuse texture is doing that now.
      if (m.emissive) {
        m.emissive.setRGB(0.18, 0.16, 0.13);
        m.emissiveIntensity = 0.4;
      }
      m.needsUpdate = true;
    }
    o.castShadow = false;
    o.receiveShadow = false;
  });

  // Compute pre-scale bbox so we can size the model first. Hidden meshes
  // (e.g. PZ's physics-colliders, fur-shells, low LODs) are excluded
  // explicitly because Box3.setFromObject still walks invisible children
  // unless we filter ourselves.
  const bbox = new THREE.Box3();
  const _v = new THREE.Vector3();
  root.traverse(o => {
    if (!(o.isMesh || o.isSkinnedMesh) || !o.visible || !o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const gb = o.geometry.boundingBox;
    o.updateWorldMatrix(true, false);
    // Expand bbox by transformed corners of the geometry box.
    for (let i = 0; i < 8; i++) {
      _v.set(
        i & 1 ? gb.max.x : gb.min.x,
        i & 2 ? gb.max.y : gb.min.y,
        i & 4 ? gb.max.z : gb.min.z
      ).applyMatrix4(o.matrixWorld);
      bbox.expandByPoint(_v);
    }
  });
  const size = bbox.getSize(new THREE.Vector3());
  console.log('bobcat bbox (visible only):', size.x.toFixed(2), size.y.toFixed(2), size.z.toFixed(2));

  // Sizing target: half the cat's height at the shoulder is roughly 0.3m;
  // the height axis depends on the source model's bind pose, so first detect
  // it from the bbox. The *shortest* axis is "thickness" (side-to-side); of
  // the remaining two, the *vertical* one is whichever points away from the
  // ground. We can't tell vertical from horizontal without checking gravity,
  // but glTF convention is Y up — and we exported with Y up. Trust that:
  // size.y is the cat's height at bind pose.
  // If the cat is bound LYING DOWN, size.y is small (~0.3m) and the height
  // is captured along x or z. If bound STANDING, size.y is the tallest.
  // Either way, we scale uniformly so the LONGEST axis (nose-to-tail length)
  // is ~0.85m.
  const targetLength = 0.85;
  const longest = Math.max(size.x, size.y, size.z, 1e-3);
  const scale = targetLength / longest;
  root.scale.setScalar(scale);
  // Forward axis: for the Planet Zoo bobcat, the bind pose lays nose-to-tail
  // along Z but every animation re-orients the body to lie along X, so it
  // walks sideways relative to its motion vector. Counter-rotate the root by
  // -90° around Y so the cat's animated forward (-X) aligns with our +Z
  // motion direction. Quaternius's bobcat doesn't have this offset, so we
  // detect by looking for skinned-mesh names typical of the PZ rig.
  let isPZ = false;
  root.traverse(o => {
    if (o.isSkinnedMesh && /nabobcat/i.test(o.name || '')) isPZ = true;
  });
  if (isPZ) {
    root.rotation.y = -Math.PI / 2;
  }
  console.log('bobcat orientation:', isPZ ? 'Planet Zoo (rotated -90°)' : 'Quaternius (no rotation)');

  // Recompute bbox after scaling, then translate so feet at y=0 and centered
  // on x/z. Same visible-only walk as above so hidden physics-meshes don't
  // pull the centre off.
  const bbox2 = new THREE.Box3();
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
      bbox2.expandByPoint(_v);
    }
  });
  const size2 = bbox2.getSize(new THREE.Vector3());
  const center2 = bbox2.getCenter(new THREE.Vector3());
  root.position.x -= center2.x;
  root.position.z -= center2.z;
  root.position.y -= bbox2.min.y;
  const footY = root.position.y; // bookkeeping for idle bob
  const supportHalfLength = Math.max(0.08, size2.z * 0.32);
  const supportHalfWidth = Math.max(0.05, size2.x * 0.30);
  const groundClearance = 0.02;

  // Wrap in a pivot for runtime yaw.
  const pivot = new THREE.Group();
  pivot.add(root);

  // Animations — Quaternius retargeted skeleton has Idle / Walk / WalkSlow /
  // Run / Jump / Death NLA tracks. We blend Idle ↔ WalkSlow ↔ Walk ↔ Run by
  // speed, leaving Jump and Death as one-shots the controller can fire.
  let mixer = null;
  const actions = {};
  if (gltf.animations && gltf.animations.length) {
    mixer = new THREE.AnimationMixer(root);
    // Strip root motion: PZ locomotion clips translate the root bone forward
    // through the cycle. We move the cat ourselves via state.position, so the
    // animation's root translation doubles up, and at loop wrap the root
    // snaps back — cat lurches forward then teleports. Drop every .position
    // track on a top-level/root-ish bone for walk/run/jump cycles. Idle keeps
    // them (it's authored in-place anyway and any subtle weight-shift adds
    // life). We detect "root-ish" by track-name keywords; this matches both
    // PZ's `def_root_joint` and Quaternius's `Hips`/`Armature`.
    // Match common root-bone naming across both rigs:
    //   PZ:         def_c_root_joint, def_c_hips_joint
    //   Quaternius: Hips, Armature, Root
    // We strip the *root* and *hips* both, since hips often carries the same
    // forward translation as a delegate of root motion.
    const ROOT_KEY = /(^|_)(c_)?(root|hips)(_joint)?$/i;
    const stripRootMotion = clip => {
      clip.tracks = clip.tracks.filter(t => {
        if (!t.name.endsWith('.position')) return true;
        const bone = t.name.split('.')[0];
        return !ROOT_KEY.test(bone);
      });
    };
    for (const clip of gltf.animations) {
      const lc = clip.name.toLowerCase();
      // Stripping is safe to do on the cycles; idle stays untouched.
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
  // Resolve actions by tokens that uniquely identify each gait. PZ clips are
  // namespaced like `nabobcat_ani_male@walkbase` — we match on the suffix
  // (after the last `@` or `_`). For Quaternius exports we just compare with
  // the lowercased clip name. The startsWith fallback catches PZ's idle
  // variants (`standidle01`, `standidle02`) without false-matching `climbidle`
  // by requiring the prefix to come before the token.
  function pickAction(...names) {
    const wanted = names.map(s => s.toLowerCase());
    for (const k of wanted) if (actions[k]) return actions[k];
    for (const k of wanted) {
      for (const key of Object.keys(actions)) {
        const tail = key.split('@').pop().split('_').pop();
        if (tail === k || tail.startsWith(k)) return actions[key];
      }
    }
    return null;
  }
  // PZ names with `base` are the looping cycles; transitions use names like
  // `walktorun`, `runtostand` etc. PZ ships `standidle01/02` as the standing
  // breathing loop, which `pickAction('standidle')` resolves via prefix match.
  const idle    = pickAction('standidle', 'idle');
  const walkS   = pickAction('walkslow', 'walk_slow');
  const walk    = pickAction('walkbase', 'walk');
  const run     = pickAction('runbase', 'run', 'sprint');
  const jump    = pickAction('jumpmid', 'jumpin', 'jump');
  const death   = pickAction('death', 'die');
  if (idle) idle.setEffectiveWeight(1);

  let groundFn = (x, z) => 0;
  let gaitClock = 0;
  // Reusable scratch for the terrain-aligned tilt.
  const tmpRight = new THREE.Vector3();
  const tmpUp = new THREE.Vector3();
  const tmpFwd = new THREE.Vector3();
  const tmpFwdYaw = new THREE.Vector3();
  const tmpSpanLR = new THREE.Vector3();
  const tmpSpanFB = new THREE.Vector3();
  const tmpBasis = new THREE.Matrix4();
  const tmpQuat = new THREE.Quaternion();

  const state = {
    object: pivot,
    pivot,
    position: pivot.position,
    velocity: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 0, 1),
    yaw: 0,
    speed: 0,
    walkSpeed: 3.2,
    runSpeed: 14.8,
    airborne: false,
    vy: 0,
    jumpInitialVy: 5.4,
    gravity: 14.0,
    // Number of jumps remaining mid-air. Starts at maxJumps when grounded
    // and decrements with each Space press; reset on landing. Default
    // maxJumps=2 → grounded jump + one mid-air "double-jump".
    jumpsRemaining: 2,
    maxJumps: 2,
    onJumpStart: null,  // (pos, jumpsLeft) => void — main.js wires dust here
    onJumpLand: null,
    mixer,
    actions,
    setGroundFn(fn) { groundFn = fn; }
  };

  function update(dt, inputs, dem) {
    // Camera-relative motion: WASD relative to the camera yaw provided in inputs.cameraYaw.
    const fwd = inputs.move.y;     // +1 forward, -1 back
    const strafe = inputs.move.x;  // +1 right, -1 left
    const wantMove = (fwd !== 0 || strafe !== 0);

    if (wantMove) {
      // Camera yaw is the direction from target to camera; forward (away from camera)
      // is the opposite, so add π.
      const moveYaw = Math.atan2(strafe, fwd) + inputs.cameraYaw + Math.PI;
      state.yaw = lerpAngle(state.yaw, moveYaw, Math.min(1, dt * 8));
      const target = inputs.sprint ? state.runSpeed : state.walkSpeed;
      state.speed = THREE.MathUtils.damp(state.speed, target, 4, dt);
    } else {
      state.speed = THREE.MathUtils.damp(state.speed, 0, 6, dt);
    }

    // Edge-trigger a jump. Each press consumes one of `jumpsRemaining`. The
    // first jump leaves the ground (grounded → airborne); subsequent presses
    // while airborne are "double-jumps" that re-set vertical velocity for an
    // additional bound. The second jump is slightly weaker so the bobcat
    // doesn't rocket into the sky.
    if (inputs.jumpPressed && state.jumpsRemaining > 0) {
      const isFirst = state.jumpsRemaining === state.maxJumps;
      state.airborne = true;
      state.vy = state.jumpInitialVy * (isFirst ? 1.0 : 0.85);
      state.jumpsRemaining -= 1;
      if (jump) {
        jump.reset();
        jump.setLoop(THREE.LoopOnce, 1);
        jump.clampWhenFinished = true;
        jump.setEffectiveTimeScale(1.1);
        jump.setEffectiveWeight(1);
        jump.fadeIn(0.08);
        jump.play();
      }
      if (state.onJumpStart) state.onJumpStart(state.position, state.jumpsRemaining);
    }

    state.position.x += Math.sin(state.yaw) * state.speed * dt;
    state.position.z += Math.cos(state.yaw) * state.speed * dt;

    // clamp to dem extents (with margin)
    const m = 50;
    const halfW = dem.worldWidth * 0.5 - m;
    const halfH = dem.worldHeight * 0.5 - m;
    state.position.x = Math.max(-halfW, Math.min(halfW, state.position.x));
    state.position.z = Math.max(-halfH, Math.min(halfH, state.position.z));

    // Grounding the cat from a single centre sample makes it behave like a
    // point collider, which visibly clips or floats as the terrain changes
    // under the rest of the body. Sample a small support footprint instead and
    // align the pivot to the local terrain plane.
    tmpFwdYaw.set(Math.sin(state.yaw), 0, Math.cos(state.yaw));
    tmpRight.set(Math.cos(state.yaw), 0, -Math.sin(state.yaw));

    const x = state.position.x;
    const z = state.position.z;
    const hC = groundFn(x, z);
    const hF = groundFn(x + tmpFwdYaw.x * supportHalfLength, z + tmpFwdYaw.z * supportHalfLength);
    const hB = groundFn(x - tmpFwdYaw.x * supportHalfLength, z - tmpFwdYaw.z * supportHalfLength);
    const hR = groundFn(x + tmpRight.x * supportHalfWidth, z + tmpRight.z * supportHalfWidth);
    const hL = groundFn(x - tmpRight.x * supportHalfWidth, z - tmpRight.z * supportHalfWidth);

    tmpSpanFB.set(
      tmpFwdYaw.x * (supportHalfLength * 2),
      hF - hB,
      tmpFwdYaw.z * (supportHalfLength * 2)
    );
    tmpSpanLR.set(
      tmpRight.x * (supportHalfWidth * 2),
      hR - hL,
      tmpRight.z * (supportHalfWidth * 2)
    );
    tmpUp.crossVectors(tmpSpanFB, tmpSpanLR).normalize();
    if (tmpUp.y < 0) tmpUp.multiplyScalar(-1);

    tmpFwd.copy(tmpFwdYaw).addScaledVector(tmpUp, -tmpFwdYaw.dot(tmpUp)).normalize();
    tmpRight.crossVectors(tmpUp, tmpFwd).normalize();
    tmpFwd.crossVectors(tmpRight, tmpUp).normalize();

    const groundFloor = Math.max(hC, (hF + hB + hR + hL) * 0.25) + groundClearance;
    if (state.airborne) {
      state.vy -= state.gravity * dt;
      state.position.y += state.vy * dt;
      if (state.position.y <= groundFloor && state.vy <= 0) {
        state.position.y = groundFloor;
        state.airborne = false;
        state.vy = 0;
        state.jumpsRemaining = state.maxJumps;
        if (jump) jump.fadeOut(0.18);
        if (state.onJumpLand) state.onJumpLand(state.position);
      }
    } else {
      state.position.y = groundFloor;
    }
    tmpBasis.makeBasis(tmpRight, tmpUp, tmpFwd);
    tmpQuat.setFromRotationMatrix(tmpBasis);
    // Don't slam to terrain-aligned tilt while airborne — it pitches the cat
    // around the local ground normal under it, even though it's mid-flight.
    const tiltK = state.airborne ? Math.min(1, dt * 2) : Math.min(1, dt * 10);
    pivot.quaternion.slerp(tmpQuat, tiltK);
    state.forward.copy(tmpFwdYaw);

    if (mixer) {
      // Cross-fade idle / slow-walk / walk / run by current speed.
      const v = state.speed;
      // Cross-fade boundaries (m/s):
      //   v=0       → idle 1
      //   v≈1.0     → walkSlow 1
      //   v≈3.2     → walk 1 (walkSpeed)
      //   v≈8       → run 1
      //  >8         → run 1 (capped)
      const wIdle = clamp01(1 - v / 0.8);
      const wWalkS = clamp01(1 - Math.abs(v - 1.6) / 1.6);
      const wWalk  = clamp01(1 - Math.abs(v - 3.6) / 2.4);
      const wRun   = clamp01((v - 4.0) / 3.0);
      const total = wIdle + wWalkS + wWalk + wRun + 1e-6;
      // While airborne, fade the locomotion blend out so Jump owns the pose.
      const locoMul = state.airborne ? 0 : 1;
      if (idle)  idle.setEffectiveWeight(locoMul * wIdle / total);
      if (walkS) walkS.setEffectiveWeight(locoMul * wWalkS / total);
      if (walk)  walk.setEffectiveWeight(locoMul * wWalk / total);
      if (run)   run.setEffectiveWeight(locoMul * wRun / total);
      // Slightly speed up the run clip when actually sprinting so the gait
      // matches forward velocity instead of looking under-cranked.
      if (run)  run.setEffectiveTimeScale(0.9 + 0.6 * (state.speed / state.runSpeed));
      if (walk) walk.setEffectiveTimeScale(0.85 + 0.4 * (state.speed / state.walkSpeed));
      mixer.update(dt);
    } else {
      // Procedural fallback if the GLB has no animation (e.g. unrigged build).
      const speedT = Math.min(1, state.speed / state.runSpeed);
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

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // Return state itself (not a spread) so live primitives — speed, yaw — stay
  // in sync with the controller's internal updates instead of freezing at the
  // construction-time snapshot.
  state.update = update;
  return state;
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
