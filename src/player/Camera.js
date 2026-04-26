import * as THREE from 'three';
import { sampleHeight } from '../terrain/DEMLoader.js';

/**
 * Third-person orbit camera. Mouse drag (or hold) rotates around the bobcat.
 * Camera trails the player and gently leads when running.
 *
 * Yaw is exposed so player input can be made camera-relative.
 */
export function createThirdPersonCamera({ camera, target, dem, domElement }) {
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

    // keep camera above terrain (don't clip into ground)
    const groundY = sampleHeight(dem, tmpCamPos.x, tmpCamPos.z) + 0.6;
    if (tmpCamPos.y < groundY) tmpCamPos.y = groundY;

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
