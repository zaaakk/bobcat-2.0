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
  // Compute pre-scale bbox so we can size the model first.
  const bbox = new THREE.Box3().setFromObject(root);
  const size = bbox.getSize(new THREE.Vector3());

  // Bobcats are ~0.6m at the shoulder.
  const targetHeight = 0.6;
  const scale = targetHeight / Math.max(size.y, 1e-3);
  root.scale.setScalar(scale);

  // Recompute bbox after scaling, then translate so feet at y=0 and centered on x/z.
  const bbox2 = new THREE.Box3().setFromObject(root);
  const center2 = bbox2.getCenter(new THREE.Vector3());
  root.position.x -= center2.x;
  root.position.z -= center2.z;
  root.position.y -= bbox2.min.y;
  const footY = root.position.y; // bookkeeping for idle bob

  // Wrap in a pivot for runtime yaw.
  const pivot = new THREE.Group();
  pivot.add(root);

  // Animations
  let mixer = null;
  let actions = {};
  if (gltf.animations && gltf.animations.length) {
    mixer = new THREE.AnimationMixer(root);
    for (const clip of gltf.animations) {
      actions[clip.name.toLowerCase()] = mixer.clipAction(clip);
    }
    const first = Object.values(actions)[0];
    if (first) { first.play(); first.setLoop(THREE.LoopRepeat); }
  }

  let groundFn = (x, z) => 0;
  let gaitClock = 0;
  // Reusable scratch for the terrain-aligned tilt.
  const tmpRight = new THREE.Vector3();
  const tmpUp = new THREE.Vector3();
  const tmpFwd = new THREE.Vector3();
  const tmpFwdYaw = new THREE.Vector3();
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

    state.position.y = groundFn(state.position.x, state.position.z);
    pivot.rotation.set(0, state.yaw, 0);

    if (mixer) mixer.update(dt);
    else {
      // Procedural gait: the GLB is one rigid mesh, so we animate the whole
      // body. Speed drives gait frequency; idle gets a slow chest-rise breath.
      const speedT = Math.min(1, state.speed / state.runSpeed);
      const gaitFreq = THREE.MathUtils.lerp(2.0, 12.0, speedT); // breath → gallop
      const gaitPhase = (gaitClock += dt * gaitFreq);
      const bob   = Math.sin(gaitPhase) * THREE.MathUtils.lerp(0.005, 0.07, speedT);
      const pitch = Math.sin(gaitPhase) * THREE.MathUtils.lerp(0.0,  0.10, speedT);
      const roll  = Math.sin(gaitPhase * 0.5) * speedT * 0.06;
      root.position.y = footY + bob;
      root.rotation.x = pitch;
      root.rotation.z = roll;
    }
  }

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
