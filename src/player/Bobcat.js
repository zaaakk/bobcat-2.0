import { asset } from '../assetPath.js';
import { loadBobcatRig } from './BobcatRig.js';
import { createBobcatSim } from './BobcatSim.js';
import { createWorldLightingUniforms, applyWorldLightingToObject } from '../world/WorldLighting.js';

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
export async function loadBobcat({ url = asset('bobcat.glb'), onProgress } = {}) {
  const rig = await loadBobcatRig({ url, onProgress });

  // Ground-contact z-fighting fix. The high-res detail patch under the cat is
  // pushed toward the camera (polygonOffset -12) so it beats the base terrain;
  // without a matching bias the patch's dense triangle grid shimmers through
  // the cat's paws/lower legs where they touch the ground. Bias the cat's
  // materials a little further forward than the patch so it wins the depth
  // test at contact. (Same remedy applied to the plant billboards.)
  // Light the cat with the world's own lighting model rather than three's PBR
  // pipeline. The two do not just differ by a constant, they diverge across the
  // day — see WorldLighting.js for the measurements. Uniforms are exposed on
  // the returned state so Environment can push the sun/fog into them.
  const lightingUniforms = createWorldLightingUniforms();
  const patched = applyWorldLightingToObject(rig.pivot, lightingUniforms);
  console.log(`[Bobcat] world lighting applied to ${patched} materials`);

  const seenMats = new Set();
  rig.pivot.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || seenMats.has(m)) continue;
      seenMats.add(m);
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -24;
    }
  });

  const { state, update: updateSim } = createBobcatSim({
    pivot: rig.pivot,
    support: rig.support,
  });

  state.update = (dt, inputs, dem) => {
    updateSim(dt, inputs, dem, rig);
    // While drinking, fade the locomotion blend out (idle weight = 0 too)
    // so the only thing driving the pose is the drink tilt — otherwise the
    // mixer's idle still asserts a level head and fights the rig tilt.
    // While latched (kill bite), speed is forced to 0 so idle plays as the
    // base layer — setFeeding() then drives the front half of the skeleton
    // with the sped-up run cycle on top of it. NOT off-locomotion: the idle
    // base is what keeps the hindquarters posed during the feed.
    rig.setLocomotionBlend(
      (state.isDrinking || state.isLatched) ? 0 : state.speed,
      state.walkSpeed, state.runSpeed,
      state.airborne || state.isDrinking,    // treat as "off-locomotion"
    );
    rig.setFeeding(state.isLatched, dt);
    rig.setDrinkPose(state.isDrinking, dt);
    rig.tick(dt, state);
  };

  state.setRunCrop = rig.setRunCrop;
  state.getRunCrop = rig.getRunCrop;
  state.setRunTimeScale = rig.setRunTimeScale;
  state.getRunTimeScale = rig.getRunTimeScale;
  state.setMirrorEnabled = rig.setMirrorEnabled;
  state.getMirrorEnabled = rig.getMirrorEnabled;
  state.setMirrorLeadLock = rig.setMirrorLeadLock;
  state.getMirrorLeadLock = rig.getMirrorLeadLock;
  state.setMirrorExcludePattern = rig.setMirrorExcludePattern;
  state.getMirrorExcludePattern = rig.getMirrorExcludePattern;
  state.setPaused = rig.setPaused;
  state.getPaused = rig.getPaused;
  state.setForceSprint = rig.setForceSprint;
  state.getForceSprint = rig.getForceSprint;
  state.setRunTimeFraction = rig.setRunTimeFraction;
  state.getRunTimeFraction = rig.getRunTimeFraction;
  state.getFrameCount = rig.getFrameCount;
  state.isFrameSkipped = rig.isFrameSkipped;
  state.getSkippedFrames = rig.getSkippedFrames;
  state.setFrameSkipped = rig.setFrameSkipped;
  state.clearSkippedFrames = rig.clearSkippedFrames;
  state.lightingUniforms = lightingUniforms;

  return state;
}
