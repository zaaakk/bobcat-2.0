/**
 * Keyboard input → {move, sprint, jumpPressed, toggleNightVision, cameraYaw}.
 * Held keys come from `keys`; one-shot edge events from `justPressed`, which
 * is cleared after each sample so each press fires exactly once.
 */
export function createInput() {
  const keys = new Set();
  const justPressed = new Set();
  window.addEventListener('keydown', e => {
    if (!keys.has(e.code)) justPressed.add(e.code);
    keys.add(e.code);
  });
  window.addEventListener('keyup',   e => keys.delete(e.code));
  window.addEventListener('blur', () => { keys.clear(); justPressed.clear(); });

  return {
    sample(cameraYaw) {
      const x = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
                (keys.has('KeyA') || keys.has('ArrowLeft')  ? 1 : 0);
      const y = (keys.has('KeyW') || keys.has('ArrowUp')    ? 1 : 0) -
                (keys.has('KeyS') || keys.has('ArrowDown')  ? 1 : 0);
      const out = {
        move: { x, y },
        sprint: keys.has('ShiftLeft') || keys.has('ShiftRight'),
        jumpPressed: justPressed.has('Space'),
        toggleNightVision: justPressed.has('KeyN'),
        drinkPressed: justPressed.has('KeyE'),
        cameraYaw
      };
      justPressed.clear();
      return out;
    }
  };
}
