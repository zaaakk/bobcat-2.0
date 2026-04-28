import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * The bobcat rig: visual mesh, textures, animation mixer, and the methods that
 * play/blend clips. Knows nothing about physics, input, or terrain — only how
 * to put the right pose on screen.
 *
 * loadBobcatRig() returns:
 *   {
 *     object,  // pivot Group — add this to the scene
 *     pivot,   // same as object (kept for clarity at call sites)
 *     root,    // the loaded GLB scene under pivot
 *     support: { halfLength, halfWidth, groundClearance },  // for sim grounding
 *     setLocomotionBlend(speed, walkSpeed, runSpeed, airborne),
 *     playJump(), stopJump(),
 *     tick(dt)  // advances the mixer (or runs a procedural bob if unanimated)
 *   }
 */
export async function loadBobcatRig({ url = '/assets/bobcat.glb', onProgress } = {}) {
  const loader = new GLTFLoader();

  // Pre-load PZ fur textures in parallel with the GLB. Extracted via cobra-
  // tools + ImageMagick; the GLB ships with empty material slots because
  // Cobra .tex files don't round-trip through glTF.
  const texLoader = new THREE.TextureLoader();
  const loadOpt = (path, srgb = true) => new Promise(res => texLoader.load(path,
    t => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.flipY = false;
      res(t);
    }, undefined, () => res(null)));
  const [furBase, furNormal, furRough, eyeBase, whiskersBase] = await Promise.all([
    loadOpt(`/assets/bobcat_textures/bobcat-newfurdiffuse.jpg?t=${Date.now()}`),
    loadOpt('/assets/bobcat_textures/nabobcat_ani_male_fur.pnormaltexture.png', false),
    loadOpt('/assets/bobcat_textures/nabobcat_ani_male_fur.proughnesspackedtexture.png', false),
    loadOpt('/assets/bobcat_textures/nabobcat_ani_male_eye.pbasecolourandmasktexture.png'),
    loadOpt('/assets/bobcat_textures/nabobcat_ani_male_whiskers.pdiffuse.png')
  ]);
  const pzTextures = { furBase, furNormal, furRough, eyeBase, whiskersBase };

  const gltf = await new Promise((resolve, reject) => {
    loader.load(url, resolve,
      xhr => onProgress && onProgress(xhr.loaded / Math.max(1, xhr.total)),
      reject);
  });

  return buildRig(gltf, pzTextures);
}

function buildRig(gltf, pzTextures) {
  const root = gltf.scene;

  // Planet Zoo packs the bobcat as 6 LODs (L0 highest), each with skin/fur/
  // fur_shell/fur_fin/eye/whiskers sub-meshes plus 35+ physics colliders.
  // Without PZ's dynamic fur shaders, fur_shell extrusions render as solid
  // offset copies — the "cardboard boxes" look. Show only L0 skin+eye+
  // whiskers; hide every other LOD, the fur shells, and the physics meshes.
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
  // Disable fur_shell sub-materials on the merged fur mesh so the extruded
  // shells stop rendering.
  root.traverse(o => {
    if (!(o.isMesh || o.isSkinnedMesh) || !o.visible) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      const mn = (m.name || '').toLowerCase();
      if (/shell|fur_fin/.test(mn)) m.visible = false;
    }
  });

  // Pick the right PZ texture per material. The shipped GLB's *meshes* are
  // named `nabobcat_mod_male_model0..23` (LOD/marking variants) so a mesh-name
  // heuristic never matched — but the *materials* are correctly named
  // (`nabobcat_ani_male_fur`, `_skin`, `_eye`, `_whiskers`). Key off those.
  // Fur material gets the new JPG diffuse; skin shares it (single body covering).
  const pickTexturesForMaterial = matName => {
    const lc = (matName || '').toLowerCase();
    if (lc.includes('eye')) return { map: pzTextures.eyeBase };
    if (lc.includes('whisker')) return { map: pzTextures.whiskersBase };
    if (lc.includes('fur') || lc.includes('skin')) {
      return { map: pzTextures.furBase, normalMap: pzTextures.furNormal, roughMap: pzTextures.furRough };
    }
    return {};
  };
  const debugSeen = new Set();
  root.traverse(o => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if (!o.visible) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      const picks = pickTexturesForMaterial(m.name);
      // Override unconditionally — the GLB ships with a marking-noise PNG
      // bound to map slots on some materials, so honoring an existing m.map
      // would hide the diffuse we want to apply.
      if (picks.map) m.map = picks.map;
      if (picks.normalMap) {
        m.normalMap = picks.normalMap;
        if (m.normalScale) m.normalScale.set(1.0, 1.0);
      }
      if (picks.roughMap) m.roughnessMap = picks.roughMap;
      if (!debugSeen.has(m.name)) {
        debugSeen.add(m.name);
        console.log(`bobcat material: "${m.name}" → map=${m.map ? 'yes' : 'NO'}`);
      }
      if ('metalness' in m) m.metalness = 0.0;
      if ('roughness' in m) m.roughness = Math.min(1, (m.roughness ?? 0.6) + 0.05);
      // GLB ships these materials as alphaMode=BLEND — force them solid so
      // the cat writes depth (water/grass don't bleed through) and so the
      // diffuse renders at full strength rather than alpha-blended.
      m.transparent = false;
      m.opacity = 1.0;
      m.depthTest = true;
      m.depthWrite = true;
      if (m.map) m.alphaTest = 0.35;
      if (m.color) {
        if (m.map) m.color.setRGB(1, 1, 1);
        else m.color.setRGB(0.78, 0.62, 0.42);
      }
      // No emissive fill — the new fur diffuse already has shading baked in,
      // so adding a warm fill flattens the markings and washes the body.
      if (m.emissive) {
        m.emissive.setRGB(0, 0, 0);
        m.emissiveIntensity = 0;
      }
      m.needsUpdate = true;
    }
    o.castShadow = false;
    o.receiveShadow = false;
  });

  // ---- Sizing: scale uniformly so longest axis ≈ 0.85m ------------------
  const _v = new THREE.Vector3();
  const computeVisibleBBox = () => {
    const bb = new THREE.Box3();
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
        bb.expandByPoint(_v);
      }
    });
    return bb;
  };

  const bbox = computeVisibleBBox();
  const size = bbox.getSize(new THREE.Vector3());
  console.log('bobcat bbox (visible only):', size.x.toFixed(2), size.y.toFixed(2), size.z.toFixed(2));

  // Scale uniformly so the LONGEST axis (nose-to-tail length) is ~0.85m,
  // robust to whether the bind pose is standing or lying.
  const targetLength = 0.85;
  const longest = Math.max(size.x, size.y, size.z, 1e-3);
  const scale = targetLength / longest;
  root.scale.setScalar(scale);

  // PZ bind pose lays nose-to-tail along Z, but every animation re-orients
  // the body to lie along X — so it walks sideways relative to motion.
  // Counter-rotate -90° around Y so animated forward (-X) aligns with our +Z
  // motion direction. Quaternius's bobcat doesn't have this offset; detect
  // by skinned-mesh name.
  let isPZ = false;
  root.traverse(o => {
    if (o.isSkinnedMesh && /nabobcat/i.test(o.name || '')) isPZ = true;
  });
  // Apply rotations as YXZ so the PZ yaw fix is the OUTERMOST rotation.
  // That way root.rotation.x (used by the drink-pose tilt below) pivots
  // the cat around its body's true horizontal axis, regardless of the yaw
  // correction. Default order is XYZ which would tilt around world axes
  // and pitch the cat sideways.
  root.rotation.order = 'YXZ';
  if (isPZ) root.rotation.y = -Math.PI / 2;
  console.log('bobcat orientation:', isPZ ? 'Planet Zoo (rotated -90°)' : 'Quaternius (no rotation)');

  // Recompute bbox post-scale, then translate so feet at y=0 and centred on
  // x/z. Same visible-only walk.
  const bbox2 = computeVisibleBBox();
  const size2 = bbox2.getSize(new THREE.Vector3());
  const center2 = bbox2.getCenter(new THREE.Vector3());
  root.position.x -= center2.x;
  root.position.z -= center2.z;
  root.position.y -= bbox2.min.y;
  const footY = root.position.y;

  const support = {
    halfLength: Math.max(0.08, size2.z * 0.32),
    halfWidth:  Math.max(0.05, size2.x * 0.30),
    groundClearance: 0.02
  };

  const pivot = new THREE.Group();
  pivot.add(root);

  // ---- Animations -------------------------------------------------------
  // Strip root motion on locomotion clips: PZ translates the root bone
  // forward through the cycle, but the sim moves the cat itself, so the
  // animation's root translation doubles up and snaps at loop wrap. Dropping
  // .position tracks on root/hips bones fixes the lurch-then-teleport.
  const ROOT_KEY = /(^|_)(c_)?(root|hips)(_joint)?$/i;
  const stripRootMotion = clip => {
    clip.tracks = clip.tracks.filter(t => {
      if (!t.name.endsWith('.position')) return true;
      const bone = t.name.split('.')[0];
      return !ROOT_KEY.test(bone);
    });
  };

  let mixer = null;
  const actions = {};
  if (gltf.animations && gltf.animations.length) {
    mixer = new THREE.AnimationMixer(root);
    for (const clip of gltf.animations) {
      const lc = clip.name.toLowerCase();
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

  // Resolve actions by tokens that uniquely identify each gait. PZ clips
  // are namespaced like `nabobcat_ani_male@walkbase` — match on the suffix
  // (after the last `@` or `_`). For Quaternius we just compare lowercased.
  // Prefix-match catches PZ's idle variants (standidle01/02) without false-
  // matching e.g. climbidle.
  const pickAction = (...names) => {
    const wanted = names.map(s => s.toLowerCase());
    for (const k of wanted) if (actions[k]) return actions[k];
    for (const k of wanted) {
      for (const key of Object.keys(actions)) {
        const tail = key.split('@').pop().split('_').pop();
        if (tail === k || tail.startsWith(k)) return actions[key];
      }
    }
    return null;
  };
  const idle  = pickAction('standidle', 'idle');
  const walkS = pickAction('walkslow', 'walk_slow');
  const walk  = pickAction('walkbase', 'walk');
  const run   = pickAction('runbase', 'run', 'sprint');
  const jump  = pickAction('jumpmid', 'jumpin', 'jump');
  if (idle) idle.setEffectiveWeight(1);

  // ---- Public methods ---------------------------------------------------
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  let gaitClock = 0;

  function setLocomotionBlend(speed, walkSpeed, runSpeed, airborne) {
    if (!mixer) return;
    // Cross-fade idle/walkSlow/walk/run by current speed:
    //   v=0   → idle 1
    //   v=1.6 → walkSlow 1
    //   v=3.6 → walk 1 (≈walkSpeed)
    //   v≥7   → run 1
    const v = speed;
    const wIdle  = clamp01(1 - v / 0.8);
    const wWalkS = clamp01(1 - Math.abs(v - 1.6) / 1.6);
    const wWalk  = clamp01(1 - Math.abs(v - 3.6) / 2.4);
    const wRun   = clamp01((v - 4.0) / 3.0);
    const total  = wIdle + wWalkS + wWalk + wRun + 1e-6;
    // Airborne: fade locomotion out so Jump owns the pose.
    const locoMul = airborne ? 0 : 1;
    if (idle)  idle.setEffectiveWeight(locoMul * wIdle / total);
    if (walkS) walkS.setEffectiveWeight(locoMul * wWalkS / total);
    if (walk)  walk.setEffectiveWeight(locoMul * wWalk / total);
    if (run)   run.setEffectiveWeight(locoMul * wRun / total);
    // Speed up the run/walk clips so footfalls match forward velocity.
    if (run)  run.setEffectiveTimeScale(0.9 + 0.6 * (v / runSpeed));
    if (walk) walk.setEffectiveTimeScale(0.85 + 0.4 * (v / walkSpeed));
  }

  function playJump() {
    if (!jump) return;
    jump.reset();
    jump.setLoop(THREE.LoopOnce, 1);
    jump.clampWhenFinished = true;
    jump.setEffectiveTimeScale(1.1);
    jump.setEffectiveWeight(1);
    jump.fadeIn(0.08);
    jump.play();
  }

  function stopJump() {
    if (jump) jump.fadeOut(0.18);
  }

  /**
   * Per-frame mixer tick. If the GLB has no animations, falls back to a
   * procedural bob/pitch/roll keyed off the sim state.
   */
  function tick(dt, sim) {
    if (mixer) {
      mixer.update(dt);
    } else {
      const speedT = Math.min(1, sim.speed / sim.runSpeed);
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

  // Drink pose — when active, lerps the root's pitch toward `drinkAngle` so
  // the cat visibly leans forward (head down) toward the water. Released
  // smoothly when inactive. With root.rotation.order = 'YXZ', the X-axis
  // tilt happens AFTER the yaw fix, so the cat tilts around its body's
  // forward axis correctly.
  let drinkPose = 0;
  const DRINK_ANGLE = 0.55;   // radians forward — about 31°, "stooped"
  function setDrinkPose(active, dt) {
    const target = active ? 1.0 : 0.0;
    const k = Math.min(1, dt * 6);
    drinkPose += (target - drinkPose) * k;
    // Animation mixer drives the rest of the pose; we layer the drink tilt
    // by writing root.rotation.x. (Mixer-controlled bones aren't on the
    // root transform, so we don't fight with it.) Slight Y dip too — the
    // cat lowers itself a touch as it bends.
    if (mixer) {
      root.rotation.x = drinkPose * DRINK_ANGLE;
      root.position.y = footY - drinkPose * 0.06;
    }
  }

  return {
    object: pivot,
    pivot,
    root,
    mixer,
    actions,
    support,
    setLocomotionBlend,
    playJump,
    stopJump,
    setDrinkPose,
    tick
  };
}
