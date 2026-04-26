import * as THREE from 'three';

/**
 * Third-person orbit camera. Mouse drag rotates around the bobcat. `groundY`
 * is the rendered-terrain sampler — used to keep the camera above the floor.
 */
export function createThirdPersonCamera({ camera, target, groundY, domElement }) {
  const state = {
    yaw: Math.PI,        // 0 looks north; PI looks south (camera behind cat at start)
    pitch: -0.22,
    distance: 4.5,
    minDistance: 2.0,
    maxDistance: 12.0,
    sensitivity: 0.0035,
    targetOffset: new THREE.Vector3(0, 0.45, 0)
  };

  let isDragging = false;
  let lastX = 0, lastY = 0;

  domElement.addEventListener('pointerdown', e => {
    isDragging = true;
    lastX = e.clientX; lastY = e.clientY;
    domElement.setPointerCapture?.(e.pointerId);
  });
  domElement.addEventListener('pointermove', e => {
    if (!isDragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    state.yaw -= dx * state.sensitivity;
    state.pitch -= dy * state.sensitivity;
    state.pitch = Math.max(-1.0, Math.min(0.4, state.pitch));
  });
  const stop = e => { isDragging = false; };
  domElement.addEventListener('pointerup', stop);
  domElement.addEventListener('pointerleave', stop);
  domElement.addEventListener('pointercancel', stop);
  domElement.addEventListener('wheel', e => {
    state.distance = Math.max(state.minDistance, Math.min(state.maxDistance,
      state.distance + e.deltaY * 0.01));
    e.preventDefault();
  }, { passive: false });

  const tmpTarget = new THREE.Vector3();
  const tmpCamPos = new THREE.Vector3();

  function update(dt) {
    tmpTarget.copy(target.position).add(state.targetOffset);

    const cosP = Math.cos(state.pitch);
    const sinP = Math.sin(state.pitch);
    const sinY = Math.sin(state.yaw);
    const cosY = Math.cos(state.yaw);
    const ox = sinY * cosP * state.distance;
    const oz = cosY * cosP * state.distance;
    const oy = -sinP * state.distance;

    tmpCamPos.set(tmpTarget.x + ox, tmpTarget.y + oy, tmpTarget.z + oz);

    // Walk a few sample points along the camera-to-target ray and find the
    // highest ground height. If the camera is below that, lift it. This stops
    // bumps between the camera and the bobcat from occluding the bobcat's
    // lower body — we always crest the highest bump.
    let maxBumpY = groundY(tmpCamPos.x, tmpCamPos.z);
    const SAMPLES = 6;
    for (let i = 1; i < SAMPLES; i++) {
      const t = i / SAMPLES;
      const sx = THREE.MathUtils.lerp(tmpCamPos.x, tmpTarget.x, t);
      const sz = THREE.MathUtils.lerp(tmpCamPos.z, tmpTarget.z, t);
      const sy = groundY(sx, sz);
      if (sy > maxBumpY) maxBumpY = sy;
    }
    const minY = maxBumpY + 0.55;
    if (tmpCamPos.y < minY) tmpCamPos.y = minY;

    // smooth move
    camera.position.lerp(tmpCamPos, Math.min(1, dt * 8));
    camera.lookAt(tmpTarget);
  }

  return {
    update,
    get yaw() { return state.yaw; },
    state
  };
}
