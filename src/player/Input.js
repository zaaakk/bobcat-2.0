/**
 * Keyboard input → {move: {x,y}, sprint, cameraYaw}.
 * cameraYaw is filled in by main loop from the camera each frame.
 */
export function createInput() {
  const keys = new Set();
  window.addEventListener('keydown', e => keys.add(e.code));
  window.addEventListener('keyup',   e => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  return {
    sample(cameraYaw) {
      const x = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
                (keys.has('KeyA') || keys.has('ArrowLeft')  ? 1 : 0);
      const y = (keys.has('KeyW') || keys.has('ArrowUp')    ? 1 : 0) -
                (keys.has('KeyS') || keys.has('ArrowDown')  ? 1 : 0);
      return {
        move: { x, y },
        sprint: keys.has('ShiftLeft') || keys.has('ShiftRight'),
        cameraYaw
      };
    }
  };
}
