import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

/**
 * Prey mobs: skinned Planet Zoo animals (white-tailed deer, pygmy goat) that
 * herd, wander, flee from the bobcat, and die when caught.
 *
 * Three layers, mirroring the bobcat's rig/sim split:
 *   loadPreyAsset()  — one GLB load per species; prepares the template
 *                      (LOD/physics culling, textures, scale, orientation)
 *                      exactly the way BobcatRig.js prepares the bobcat.
 *   createPreyType() — a Mobs.js type whose spawn() clones the template
 *                      (SkeletonUtils — skinned meshes can't .clone()) and
 *                      runs a wander/flee/dead state machine per instance.
 *   createPreyHerds()— streaming spawner: keeps a few herds in a ring around
 *                      the player, despawns what falls behind, so prey is
 *                      findable anywhere on the 21km map.
 *
 * The prey GLBs come from the same cobra-tools pipeline as the bobcat
 * (scripts/extract_pz_ovl.py + extract_pz_animal.py). Same quirks apply:
 * empty material slots (textures bound here by material name), PZ bind pose
 * along Z but animations along X (the -90° yaw fix), root-motion baked into
 * locomotion clips (stripped here, the sim moves the pivot instead).
 */

// ---------------------------------------------------------------------------
// Asset loading / template preparation
// ---------------------------------------------------------------------------

// The GLBs are pre-stripped by scripts/optimize_mob.mjs (single LOD, no
// physics colliders, no fin/shell fur) — these filters are just a second
// line of defense in case a raw export is ever pointed at directly.
const PHYSICS_RE = /_physics/i;
const SHELL_FIN_RE = /fur_fin/i;

/**
 * @param url        GLB path
 * @param textures   { matchSubstring: texturePath } — bound by material name,
 *                   first match wins. e.g. { fur: '...png', antler: '...png' }
 * @param targetLength  desired nose-to-tail length in metres
 */
export async function loadPreyAsset({ url, textures = {}, targetLength = 1.5, onProgress }) {
  const texLoader = new THREE.TextureLoader();
  const loadOpt = path => new Promise(res => texLoader.load(path, t => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.flipY = false;
    res(t);
  }, undefined, () => res(null)));

  const texEntries = Object.entries(textures);
  const [gltf, ...loadedTex] = await Promise.all([
    new Promise((resolve, reject) => new GLTFLoader().load(url, resolve,
      xhr => onProgress && onProgress(xhr.loaded / Math.max(1, xhr.total)), reject)),
    ...texEntries.map(([, path]) => loadOpt(path)),
  ]);
  const texByKey = {};
  texEntries.forEach(([key], i) => { texByKey[key] = loadedTex[i]; });

  const root = gltf.scene;

  // Hide physics colliders, non-L0 LODs and fur shell/fin extrusions — same
  // reasoning as the bobcat: no PZ fur shaders, shells render as boxes.
  const isVisibleMesh = name => {
    if (!name) return true;
    const lc = name.toLowerCase();
    return !PHYSICS_RE.test(lc) && !SHELL_FIN_RE.test(lc);
  };
  root.traverse(o => {
    if ((o.isMesh || o.isSkinnedMesh) && !isVisibleMesh(o.name)) o.visible = false;
  });

  // Bind textures by material-name substring; force solid like the bobcat
  // (GLB ships alphaMode=BLEND which would z-fight with grass/water).
  root.traverse(o => {
    if (!(o.isMesh || o.isSkinnedMesh) || !o.visible) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      const mn = (m.name || '').toLowerCase();
      if (SHELL_FIN_RE.test(mn)) { m.visible = false; continue; }
      for (const [key] of texEntries) {
        if (mn.includes(key) && texByKey[key]) { m.map = texByKey[key]; break; }
      }
      if ('metalness' in m) m.metalness = 0.0;
      m.transparent = false;
      m.opacity = 1.0;
      m.depthWrite = true;
      // The PZ basecolour alpha channel is a marking mask, not opacity —
      // never alpha-test prey bodies or chunks of fur disappear.
      m.alphaTest = 0;
      if (m.color && m.map) m.color.setRGB(1, 1, 1);
      if (m.emissive) { m.emissive.setRGB(0, 0, 0); m.emissiveIntensity = 0; }
      m.needsUpdate = true;
    }
    o.castShadow = false;
    o.receiveShadow = false;
  });

  // Scale so the longest axis ≈ targetLength, then yaw -90° (PZ animations
  // re-orient the body along X; our motion convention is +Z forward).
  const bbox = computeVisibleBBox(root);
  const size = bbox.getSize(new THREE.Vector3());
  const scale = targetLength / Math.max(size.x, size.y, size.z, 1e-3);
  root.scale.setScalar(scale);
  root.rotation.order = 'YXZ';
  root.rotation.y = -Math.PI / 2;

  // Feet to y=0, centred on x/z.
  const bbox2 = computeVisibleBBox(root);
  const size2 = bbox2.getSize(new THREE.Vector3());
  const center2 = bbox2.getCenter(new THREE.Vector3());
  root.position.x -= center2.x;
  root.position.z -= center2.z;
  root.position.y -= bbox2.min.y;

  console.log(`[Prey] ${url}: scaled ×${scale.toFixed(3)} → ` +
    `${size2.x.toFixed(2)}×${size2.y.toFixed(2)}×${size2.z.toFixed(2)}m, ` +
    `${gltf.animations.length} clips`);

  return {
    template: root,
    animations: gltf.animations,
    bodyLength: Math.max(size2.x, size2.z),
  };
}

function computeVisibleBBox(root) {
  const bb = new THREE.Box3();
  const v = new THREE.Vector3();
  root.updateWorldMatrix(true, true);
  root.traverse(o => {
    if (!(o.isMesh || o.isSkinnedMesh) || !o.visible || !o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const gb = o.geometry.boundingBox;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? gb.max.x : gb.min.x,
            i & 2 ? gb.max.y : gb.min.y,
            i & 4 ? gb.max.z : gb.min.z).applyMatrix4(o.matrixWorld);
      bb.expandByPoint(v);
    }
  });
  return bb;
}

// ---------------------------------------------------------------------------
// Prey mob type
// ---------------------------------------------------------------------------

// Root-motion strip — PZ bakes forward root translation into locomotion
// clips; the state machine moves the pivot, so both together = double-move.
const ROOT_KEY = /(^|_)(c_)?(root|hips)(_joint)?$/i;
function stripRootMotion(clip) {
  clip.tracks = clip.tracks.filter(tr => {
    if (!tr.name.endsWith('.position')) return true;
    return !ROOT_KEY.test(tr.name.split('.')[0]);
  });
}

/**
 * Build a Mobs.js type for one prey species.
 *
 * cfg: {
 *   walkSpeed, runSpeed     — m/s
 *   stealthRadius           — detection range when the bobcat is creeping/
 *                             walking. Small → you can sneak up on foot.
 *   alertRadius             — detection range when the bobcat is at full
 *                             sprint. Detection scales between these two by
 *                             the BOBCAT's speed, so running gives you away
 *                             from far off and walking lets you close in.
 *   panicRadius             — flee floor: this close, they bolt no matter how
 *                             slowly you move (you can't stand on top of them)
 *   calmRadius              — stop fleeing once bobcat farther than this
 *   catchRadius             — bobcat contact distance that kills
 *   wanderRadius            — how far from the herd anchor members roam
 *   corpseSeconds           — how long a body lies before despawn-eligible
 *   onKilled(mob)           — optional hook (HUD, sounds, scoring)
 * }
 */
export function createPreyType(asset, groundY, cfg = {}) {
  const {
    walkSpeed = 1.3, runSpeed = 8.0,
    stealthRadius = 10, alertRadius = 40, panicRadius = 7,
    calmRadius = 60, catchRadius = 1.1,
    wanderRadius = 24, corpseSeconds = 20,
    onKilled = null,
  } = cfg;

  // Prepare shared clip list once: strip root motion on locomotion clips.
  // (Clips are shared across instances; each clone gets its own mixer.)
  const clips = asset.animations.map(c => c);
  for (const clip of clips) {
    if (/walk|run|trot|canter|gallop/i.test(clip.name)) stripRootMotion(clip);
  }

  // Resolve clips by gait token, PZ names look like `<species>@walkbase`.
  const pickClip = (...tokens) => {
    for (const tok of tokens) {
      for (const clip of clips) {
        const tail = clip.name.toLowerCase().split('@').pop();
        if (tail === tok || tail.startsWith(tok)) return clip;
      }
    }
    return null;
  };
  const clipIdle  = pickClip('standidle', 'idle');
  const clipGraze = pickClip('grazeloop', 'eatloop', 'graze');
  const clipWalk  = pickClip('walkbase', 'walk');
  const clipRun   = pickClip('runbase', 'gallopbase', 'gallop', 'canter', 'run', 'trot');
  const clipDeath = pickClip('standdie', 'restdie', 'deathbase', 'death', 'die');
  console.log(`[Prey] clips: idle=${clipIdle?.name} graze=${clipGraze?.name} ` +
    `walk=${clipWalk?.name} run=${clipRun?.name} death=${clipDeath?.name}`);

  function spawn({ x, y, z, opts = {} }) {
    const body = cloneSkeleton(asset.template);
    const pivot = new THREE.Group();
    pivot.add(body);
    pivot.position.set(x, y, z);

    const mixer = new THREE.AnimationMixer(body);
    const mkAction = (clip, loop = THREE.LoopRepeat) => {
      if (!clip) return null;
      const a = mixer.clipAction(clip);
      a.setLoop(loop, loop === THREE.LoopOnce ? 1 : Infinity);
      a.enabled = true;
      a.setEffectiveWeight(0);
      a.play();
      return a;
    };
    const idle  = mkAction(clipIdle);
    const graze = mkAction(clipGraze);
    const walk  = mkAction(clipWalk);
    const run   = mkAction(clipRun);
    const death = clipDeath ? mixer.clipAction(clipDeath) : null;
    if (death) {
      death.setLoop(THREE.LoopOnce, 1);
      death.clampWhenFinished = true;
    }
    if (idle) idle.setEffectiveWeight(1);

    const anchor = new THREE.Vector3(
      opts.anchorX ?? x, 0, opts.anchorZ ?? z);

    const state = {
      mode: 'idle',          // idle | wander | flee | dead
      yaw: opts.yaw ?? Math.random() * Math.PI * 2,
      speed: 0,
      targetSpeed: 0,
      modeTimer: 1 + Math.random() * 3,   // time left in idle/wander leg
      fleeRetargetTimer: 0,
      corpseTimer: 0,
      wanderTarget: new THREE.Vector3(x, 0, z),
    };

    const tmpQ = new THREE.Quaternion();
    const tmpE = new THREE.Euler();

    // Standing animation alternates between alert idle and head-down grazing
    // — re-rolled each time the animal stops, so a herd reads as a mix of
    // lookouts and feeders rather than synchronized statues.
    let standAction = idle;
    function rerollStandAction() {
      const next = (graze && Math.random() < 0.6) ? graze : idle;
      if (next !== standAction && standAction) standAction.setEffectiveWeight(0);
      standAction = next;
    }

    function setLocomotionWeights(speedNow) {
      // idle ↔ walk ↔ run cross-fade by speed, like the bobcat's blend.
      const wT = THREE.MathUtils.clamp(speedNow / walkSpeed, 0, 1);
      const rT = THREE.MathUtils.clamp(
        (speedNow - walkSpeed) / Math.max(0.001, runSpeed - walkSpeed), 0, 1);
      if (standAction) standAction.setEffectiveWeight((1 - wT) * (1 - rT));
      if (walk) {
        walk.setEffectiveWeight(wT * (1 - rT));
        // Stride pacing: play the walk cycle faster when moving faster.
        walk.setEffectiveTimeScale(THREE.MathUtils.clamp(speedNow / walkSpeed, 0.6, 1.6));
      }
      if (run) {
        run.setEffectiveWeight(rT);
        run.setEffectiveTimeScale(THREE.MathUtils.clamp(speedNow / runSpeed, 0.7, 1.5));
      }
    }

    function die() {
      state.mode = 'dead';
      state.targetSpeed = 0;
      state.speed = 0;
      state.corpseTimer = corpseSeconds;
      if (idle) idle.setEffectiveWeight(0);
      if (graze) graze.setEffectiveWeight(0);
      if (walk) walk.setEffectiveWeight(0);
      if (run) run.setEffectiveWeight(0);
      if (death) {
        death.reset();
        death.setEffectiveWeight(1);
        death.play();
      } else {
        // No death clip in the pack: tip the body over sideways.
        pivot.rotation.z = Math.PI / 2;
      }
      if (onKilled) onKilled(mob);
    }

    function update(dt, t, ctx) {
      const cat = ctx?.bobcat || null;

      if (state.mode === 'dead') {
        state.corpseTimer -= dt;
        if (state.corpseTimer <= 0) mob.expired = true;  // herd manager removes
        mixer.update(dt);
        return;
      }

      // ---- threat assessment ------------------------------------------
      if (cat) {
        const dx = pivot.position.x - cat.position.x;
        const dz = pivot.position.z - cat.position.z;
        const dist = Math.hypot(dx, dz);

        if (dist < catchRadius) { die(); return; }

        // Detection range scales with the BOBCAT's own speed (read from the
        // sim state): a slow creep is nearly invisible (stealthRadius), a
        // full sprint is spotted from across the clearing (alertRadius).
        // This is the stealth loop — walk in close, then sprint the last few
        // metres for the pounce. panicRadius is the hard floor they bolt at
        // no matter how slowly you move.
        const catWalk = cat.walkSpeed ?? 3.2;
        const catRun = cat.runSpeed ?? 14.8;
        const speedT = clamp01((cat.speed - catWalk) / Math.max(0.1, catRun - catWalk));
        const detectRadius = Math.max(panicRadius, stealthRadius + (alertRadius - stealthRadius) * speedT);
        if (state.mode !== 'flee' && dist < detectRadius) {
          state.mode = 'flee';
          state.fleeRetargetTimer = 0;
        } else if (state.mode === 'flee' && dist > calmRadius) {
          state.mode = 'idle';
          state.modeTimer = 1.5 + Math.random() * 2;
          state.targetSpeed = 0;
          rerollStandAction();
        }

        if (state.mode === 'flee') {
          state.fleeRetargetTimer -= dt;
          if (state.fleeRetargetTimer <= 0) {
            state.fleeRetargetTimer = 0.35;
            // Run dead away from the cat with a little jitter so a herd
            // fans out instead of stacking on one line.
            state.fleeYaw = Math.atan2(dx, dz) + (Math.random() - 0.5) * 0.5;
          }
          state.yaw = lerpAngle(state.yaw, state.fleeYaw, Math.min(1, dt * 6));
          state.targetSpeed = runSpeed;
        }
      }

      // ---- calm behaviour: idle ↔ wander ------------------------------
      if (state.mode === 'idle' || state.mode === 'wander') {
        state.modeTimer -= dt;
        if (state.mode === 'idle' && state.modeTimer <= 0) {
          state.mode = 'wander';
          state.modeTimer = 4 + Math.random() * 6;
          const a = Math.random() * Math.PI * 2;
          const r = Math.sqrt(Math.random()) * wanderRadius;
          state.wanderTarget.set(anchor.x + Math.sin(a) * r, 0, anchor.z + Math.cos(a) * r);
        } else if (state.mode === 'wander') {
          const dx = state.wanderTarget.x - pivot.position.x;
          const dz = state.wanderTarget.z - pivot.position.z;
          const dist = Math.hypot(dx, dz);
          if (dist < 1.2 || state.modeTimer <= 0) {
            state.mode = 'idle';
            state.modeTimer = 2 + Math.random() * 5;   // graze a while
            state.targetSpeed = 0;
            rerollStandAction();
          } else {
            state.yaw = lerpAngle(state.yaw, Math.atan2(dx, dz), Math.min(1, dt * 3));
            state.targetSpeed = walkSpeed;
          }
        }
      }

      // ---- integrate motion -------------------------------------------
      state.speed = THREE.MathUtils.damp(state.speed, state.targetSpeed,
        state.mode === 'flee' ? 6 : 3, dt);
      if (state.speed > 0.01) {
        pivot.position.x += Math.sin(state.yaw) * state.speed * dt;
        pivot.position.z += Math.cos(state.yaw) * state.speed * dt;
      }
      pivot.position.y = groundY(pivot.position.x, pivot.position.z);

      // Yaw + a light terrain pitch from fore/aft ground samples.
      const fx = Math.sin(state.yaw), fz = Math.cos(state.yaw);
      const half = Math.max(0.2, asset.bodyLength * 0.4);
      const hF = groundY(pivot.position.x + fx * half, pivot.position.z + fz * half);
      const hB = groundY(pivot.position.x - fx * half, pivot.position.z - fz * half);
      const pitch = Math.atan2(hB - hF, half * 2);
      tmpE.set(pitch, state.yaw, 0, 'YXZ');
      tmpQ.setFromEuler(tmpE);
      pivot.quaternion.slerp(tmpQ, Math.min(1, dt * 8));

      setLocomotionWeights(state.speed);
      mixer.update(dt);
    }

    const mob = {
      object: pivot,
      position: pivot.position,
      state,
      update,
      die,
      expired: false,
      bodyLength: asset.bodyLength,
      // Seconds the death clip runs — main.js scales the bobcat's kill latch
      // to this so the cat holds on while the body collapses.
      deathDuration: clipDeath ? clipDeath.duration : 1.2,
      // World-space neck position (x/z) — where a kill bite lands. Computed
      // from the frozen death yaw, ~30% of body length ahead of centre.
      bitePoint() {
        return {
          x: pivot.position.x + Math.sin(state.yaw) * asset.bodyLength * 0.30,
          z: pivot.position.z + Math.cos(state.yaw) * asset.bodyLength * 0.30,
        };
      },
      dispose() { mixer.stopAllAction(); },
    };
    return mob;
  }

  return { spawn };
}

// ---------------------------------------------------------------------------
// Streaming herd spawner
// ---------------------------------------------------------------------------

/**
 * Keeps `maxHerds` herds alive in a ring around the player. Herds whose
 * anchor falls `despawnRadius` behind are removed wholesale; replacements
 * spawn at a random bearing `spawnMin..spawnMax` metres out — far enough
 * that pop-in isn't visible, close enough to stumble into.
 *
 * herdSpecs: [{ typeId, weight, count: [min,max] }]
 */
export function createPreyHerds({ mobs, groundY, player, dem, herdSpecs, opts = {} }) {
  const {
    maxHerds = 3,
    spawnMin = 200, spawnMax = 360,
    despawnRadius = 550,
    tickInterval = 1.5,
  } = opts;

  const herds = [];
  let tickTimer = 0;
  const totalWeight = herdSpecs.reduce((s, h) => s + (h.weight ?? 1), 0);

  function pickSpec() {
    let r = Math.random() * totalWeight;
    for (const spec of herdSpecs) {
      r -= (spec.weight ?? 1);
      if (r <= 0) return spec;
    }
    return herdSpecs[0];
  }

  function spawnHerd() {
    const spec = pickSpec();
    const bearing = Math.random() * Math.PI * 2;
    const dist = spawnMin + Math.random() * (spawnMax - spawnMin);
    const ax = player.position.x + Math.sin(bearing) * dist;
    const az = player.position.z + Math.cos(bearing) * dist;

    // Keep herds inside the DEM (same margin the bobcat sim clamps to).
    const m = 100;
    const halfW = dem.worldWidth * 0.5 - m;
    const halfH = dem.worldHeight * 0.5 - m;
    const cx = Math.max(-halfW, Math.min(halfW, ax));
    const cz = Math.max(-halfH, Math.min(halfH, az));

    const [cMin, cMax] = spec.count;
    const n = cMin + Math.floor(Math.random() * (cMax - cMin + 1));
    const members = [];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 2 + Math.random() * 10;
      const x = cx + Math.sin(a) * r;
      const z = cz + Math.cos(a) * r;
      const mob = mobs.spawnAt(spec.typeId, x, groundY(x, z), z,
        { anchorX: cx, anchorZ: cz });
      if (mob) members.push(mob);
    }
    herds.push({ typeId: spec.typeId, x: cx, z: cz, members });
    console.log(`[Prey] spawned ${spec.typeId} herd ×${n} at ` +
      `${cx.toFixed(0)},${cz.toFixed(0)} (${dist.toFixed(0)}m out)`);
  }

  function update(dt) {
    tickTimer -= dt;
    if (tickTimer > 0) return;
    tickTimer = tickInterval;

    // Despawn herds left behind + expired corpses.
    for (let i = herds.length - 1; i >= 0; i--) {
      const herd = herds[i];
      herd.members = herd.members.filter(m => {
        if (m.expired) { mobs.remove(m); return false; }
        return true;
      });
      const dx = herd.x - player.position.x;
      const dz = herd.z - player.position.z;
      const far = Math.hypot(dx, dz) > despawnRadius;
      if (far || herd.members.length === 0) {
        for (const m of herd.members) mobs.remove(m);
        herds.splice(i, 1);
      }
    }

    if (herds.length < maxHerds) spawnHerd();
  }

  return { update, herds };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
