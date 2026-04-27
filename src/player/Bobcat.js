import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Loads the bobcat GLB and exposes a controller that walks/runs the cat across
 * the terrain. Works without animations if the model has none — falls back to
 * a small idle bob.
 */
export async function loadBobcat({ url = '/assets/bobcat.glb', onProgress } = {}) {
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.load(url,
      gltf => resolve(buildController(gltf)),
      xhr => onProgress && onProgress(xhr.loaded / Math.max(1, xhr.total)),
      reject
    );
  });
}

function buildController(gltf) {
  const root = gltf.scene;

  // The retargeted GLB carries baseColor textures whose linear values are
  // dark; with our restrained lighting they read as a black silhouette. Lift
  // them by tweaking each material as we traverse: brighten baseColor, drop
  // metalness, soften roughness slightly, and add a small emissive so the
  // unlit side of the body never crushes to pure black.
  const tmpCol = new THREE.Color();
  root.traverse(o => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      // The Quaternius/retarget pipeline gave us a baked baseColor texture
      // that's just dark bobcat fur. Three's MeshStandardMaterial multiplies
      // texture × color × incident light; with our restrained sun + small
      // ambient the result reads as black. We compensate by:
      //   - leaving texture and color at identity,
      //   - using the texture itself as an emissive map so the unlit side
      //     never drops below a usable brightness floor.
      if ('metalness' in m) m.metalness = 0.0;
      if ('roughness' in m) m.roughness = Math.min(1, (m.roughness ?? 0.6) + 0.05);
      // Lift the base-colour factor — Three accepts > 1 even though glTF on
      // disk doesn't, so this is a runtime-only brightness multiplier.
      if (m.color) m.color.setScalar(1.85);
      // And use the diffuse texture as an emissive map so the unlit side
      // doesn't crush. Combined the two roughly double the bobcat's apparent
      // luminance.
      if (m.map && m.emissive) {
        m.emissiveMap = m.map;
        m.emissive.setRGB(1, 0.94, 0.82);
        m.emissiveIntensity = 1.65;
      } else if (m.emissive) {
        m.emissive.setRGB(0.55, 0.5, 0.4);
        m.emissiveIntensity = 1.4;
      }
      m.needsUpdate = true;
    }
    o.castShadow = false;
    o.receiveShadow = false;
  });

  // Compute pre-scale bbox so we can size the model first.
  const bbox = new THREE.Box3().setFromObject(root);
  const size = bbox.getSize(new THREE.Vector3());

  // Bobcats are ~0.6m at the shoulder.
  const targetHeight = 0.6;
  const scale = targetHeight / Math.max(size.y, 1e-3);
  root.scale.setScalar(scale);

  // Recompute bbox after scaling, then translate so feet at y=0 and centered on x/z.
  const bbox2 = new THREE.Box3().setFromObject(root);
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
    for (const clip of gltf.animations) {
      const a = mixer.clipAction(clip);
      a.setLoop(THREE.LoopRepeat);
      a.enabled = true;
      a.setEffectiveWeight(0);
      a.setEffectiveTimeScale(1);
      a.play();
      actions[clip.name.toLowerCase()] = a;
    }
  }
  // Aliases so callers can use friendly names regardless of clip casing.
  function pickAction(...names) {
    for (const n of names) {
      const a = actions[n.toLowerCase()];
      if (a) return a;
    }
    return null;
  }
  const idle    = pickAction('idle');
  const walkS   = pickAction('walkslow', 'walk_slow');
  const walk    = pickAction('walk');
  const run     = pickAction('run', 'sprint');
  const jump    = pickAction('jump');
  const death   = pickAction('death', 'die');
  if (idle)  idle.setEffectiveWeight(1);  // start in idle

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

    state.position.y = Math.max(hC, (hF + hB + hR + hL) * 0.25) + groundClearance;
    tmpBasis.makeBasis(tmpRight, tmpUp, tmpFwd);
    tmpQuat.setFromRotationMatrix(tmpBasis);
    pivot.quaternion.slerp(tmpQuat, Math.min(1, dt * 10));
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
      if (idle)  idle.setEffectiveWeight(wIdle / total);
      if (walkS) walkS.setEffectiveWeight(wWalkS / total);
      if (walk)  walk.setEffectiveWeight(wWalk / total);
      if (run)   run.setEffectiveWeight(wRun / total);
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
