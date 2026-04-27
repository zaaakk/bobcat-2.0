import { loadBobcatRig } from './BobcatRig.js';
import { createBobcatSim } from './BobcatSim.js';

/**
 * Public entry for the bobcat controller. Composes the rig (visuals +
 * animation) with the sim (motion physics).
 *
 * Returns the sim's state object, augmented with:
 *   object         — the Group to add to the scene
 *   pivot          — the same Group; used by camera lookups
 *   setGroundFn    — sim grounding callback (passed terrainQuery.sampleGroundY)
 *   onJumpStart    — optional (pos, jumpsLeft) => void; main.js wires dust here
 *   onJumpLand     — optional (pos) => void
 *   update(dt, inputs, dem)
 *
 * Naming: the returned object IS the canonical state that camera/HUD/main.js
 * read. We don't expose the rig or sim directly; everything goes through this
 * façade so call sites stay unchanged across refactors.
 */
export async function loadBobcat({ url = '/assets/bobcat.glb', onProgress } = {}) {
  const rig = await loadBobcatRig({ url, onProgress });
  const { state, update: updateSim } = createBobcatSim({
    pivot: rig.pivot,
    support: rig.support,
  });

  state.update = (dt, inputs, dem) => {
    updateSim(dt, inputs, dem, rig);
    // While drinking, fade the locomotion blend out (idle weight = 0 too)
    // so the only thing driving the pose is the drink tilt — otherwise the
    // mixer's idle still asserts a level head and fights the rig tilt.
    rig.setLocomotionBlend(
      state.isDrinking ? 0 : state.speed,
      state.walkSpeed, state.runSpeed,
      state.airborne || state.isDrinking,    // treat as "off-locomotion"
    );
    rig.setDrinkPose(state.isDrinking, dt);
    rig.tick(dt, state);
  };

  return state;
}
