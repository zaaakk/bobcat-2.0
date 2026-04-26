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

  const state = {
    object: pivot,
    pivot,
    position: pivot.position,
    velocity: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 0, 1),
    yaw: 0,
    speed: 0,
    walkSpeed: 3.2,
    runSpeed: 7.4,
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

    pivot.rotation.y = state.yaw;

    if (mixer) mixer.update(dt);
    else {
      const t = performance.now() * 0.001;
      root.position.y = footY + Math.sin(t * 6) * 0.01 * (state.speed > 0.1 ? 1.6 : 0.4);
    }
  }

  return { ...state, update };
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
