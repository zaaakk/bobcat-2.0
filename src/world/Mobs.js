import * as THREE from 'three';

/**
 * Lightweight mob system.
 *
 * The pattern: each mob *type* defines (a) how to build a single instance
 * (texture, material, scratch state) and (b) how to update one each frame.
 * Spawning a mob just runs the type's factory at a chosen world position and
 * pushes the result into a flat array — `update(dt, t, ctx)` walks the array
 * and calls each mob's update.
 *
 * Designed cheap: every mob is a single billboarded sprite by default
 * (PlaneGeometry + a shared material), so 50 of them is ~50 draw calls — no
 * skinned meshes, no per-mob shader. If a future mob needs animation, swap
 * the type's factory to spawn an InstancedMesh or a tiny shader.
 *
 * Use `spawnAt(typeId, x, y, z, opts)` from main.js. Each mob can also be
 * replaced with a smarter implementation later without touching the loop.
 */
export function createMobs(scene) {
  const types = new Map();
  const mobs = [];

  function registerType(id, type) { types.set(id, type); }

  function spawnAt(typeId, x, y, z, opts = {}) {
    const type = types.get(typeId);
    if (!type) {
      console.warn(`mob: unknown type "${typeId}"`);
      return null;
    }
    const mob = type.spawn({ x, y, z, opts });
    mob.typeId = typeId;
    if (mob.object) scene.add(mob.object);
    mobs.push(mob);
    return mob;
  }

  function update(dt, t, ctx) {
    for (const m of mobs) m.update?.(dt, t, ctx);
  }

  /** Remove a single mob (streaming despawn). Safe to call mid-update —
   *  splice happens immediately but update() iterates a stale index at
   *  worst one frame. */
  function remove(mob) {
    const i = mobs.indexOf(mob);
    if (i === -1) return;
    mobs.splice(i, 1);
    if (mob.object) scene.remove(mob.object);
    mob.dispose?.();
  }

  function dispose() {
    for (const m of mobs) {
      if (m.object) scene.remove(m.object);
      m.dispose?.();
    }
    mobs.length = 0;
  }

  return { registerType, spawnAt, update, remove, dispose, mobs };
}

/**
 * Turkey vulture: a flat sprite billboard high in the sky, tracing a slow
 * horizontal circle around an anchor point. Kettles of vultures often soar
 * together, so multiple instances spawned at the same anchor with phase
 * offsets read as a flock.
 *
 * Anatomy: PlaneGeometry quad, sprite-aligned billboarded toward the camera
 * but rotated about its forward axis to match the bird's banking angle as it
 * turns — that single tilt sells the soaring read better than a flat decal.
 */
/**
 * Streaming vulture kettles: keeps `maxKettles` kettles of circling vultures
 * in a middle-distance ring around the player, recycling any that fall too
 * far behind. Real kettles are a column of birds sharing one thermal —
 * each kettle stacks 5-9 vultures at staggered altitudes and radii, all
 * turning the same direction at slightly different rates.
 *
 * Unlike prey herds these never need to be close — the ring is tuned so a
 * kettle is always visible somewhere on the horizon without ever circling
 * directly over the player.
 */
export function createVultureKettles({ mobs, player, groundY, opts = {} }) {
  const {
    maxKettles = 4,
    spawnMin = 450, spawnMax = 1300,
    despawnRadius = 2200,
    birdsMin = 5, birdsMax = 9,
    tickInterval = 3.0,
  } = opts;

  const kettles = [];
  let tickTimer = 0;

  function spawnKettle() {
    const bearing = Math.random() * Math.PI * 2;
    const dist = spawnMin + Math.random() * (spawnMax - spawnMin);
    const ax = player.position.x + Math.sin(bearing) * dist;
    const az = player.position.z + Math.cos(bearing) * dist;
    const ay = groundY ? groundY(ax, az) : player.position.y;

    const n = birdsMin + Math.floor(Math.random() * (birdsMax - birdsMin + 1));
    const baseRadius = 45 + Math.random() * 35;
    const baseAltitude = 55 + Math.random() * 35;
    const baseSpeed = 0.10 + Math.random() * 0.05;
    const members = [];
    for (let i = 0; i < n; i++) {
      // Column structure: birds stack upward with widening circles, like a
      // thermal. Phases spread evenly so the column reads as a swirl, not a
      // line.
      const t = i / Math.max(1, n - 1);
      const mob = mobs.spawnAt('vulture', ax, ay, az, {
        phase: t * Math.PI * 2 * 1.7 + Math.random() * 0.4,
        radius: baseRadius + t * 40 + Math.random() * 8,
        altitude: baseAltitude + t * 55 + Math.random() * 6,
        angularSpeed: baseSpeed * (1 - t * 0.35) * (0.92 + Math.random() * 0.16),
        wingSpan: 8,
      });
      if (mob) members.push(mob);
    }
    kettles.push({ x: ax, z: az, members });
  }

  function update(dt) {
    tickTimer -= dt;
    if (tickTimer > 0) return;
    tickTimer = tickInterval;

    for (let i = kettles.length - 1; i >= 0; i--) {
      const k = kettles[i];
      const d = Math.hypot(k.x - player.position.x, k.z - player.position.z);
      if (d > despawnRadius) {
        for (const m of k.members) mobs.remove(m);
        kettles.splice(i, 1);
      }
    }
    if (kettles.length < maxKettles) spawnKettle();
  }

  return { update, kettles };
}

export function createVultureType(texture, defaults = {}) {
  // One material is shared across every vulture instance — saves on uploads
  // and lets the GPU batch all of them in a single draw if Three decides to.
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.5,         // hard alpha — the source PNG has clean edges
    depthWrite: false,
    side: THREE.DoubleSide
  });

  // Width:height of the source sprite (top-down, wings spread). 256x256 → 1.
  const geom = new THREE.PlaneGeometry(1, 1);

  function spawn({ x, y, z, opts }) {
    const radius = opts.radius ?? defaults.radius ?? 65;
    const altitude = opts.altitude ?? defaults.altitude ?? 70;
    const angularSpeed = opts.angularSpeed ?? defaults.angularSpeed ?? 0.18;
    const wingSpan = opts.wingSpan ?? defaults.wingSpan ?? 1.7;
    const phase = opts.phase ?? Math.random() * Math.PI * 2;
    // Optional moving target — if main passes the bobcat, the kettle drifts to
    // stay above it. The anchor lerps toward `target` so it lags realistically
    // (real vultures glide, they don't teleport).
    const followTarget = opts.followTarget ?? defaults.followTarget ?? null;
    const followLerp = opts.followLerp ?? defaults.followLerp ?? 0.4;

    // Anchor is the centre of the lazy circle. Each vulture spins around it
    // independently, so giving the same anchor to several vultures creates a
    // visible kettle.
    const anchor = new THREE.Vector3(x, y + altitude, z);

    const mesh = new THREE.Mesh(geom, mat);
    mesh.scale.setScalar(wingSpan);
    // PlaneGeometry is XY-facing; rotating it -π/2 around X makes it lie flat
    // (XZ plane) so the sprite faces UP — readable from below.
    mesh.rotation.x = -Math.PI / 2;
    mesh.frustumCulled = true;

    const state = { phase, anchor, radius, angularSpeed, mesh };
    const tmpEuler = new THREE.Euler();

    function update(dt, t, ctx) {
      // Drift the anchor toward the follow-target — slow lag so the kettle
      // glides into the new centre instead of snapping. damp() with the same
      // followLerp const for X/Z; altitude stays at the spawn-time offset
      // above the *current* target Y so they don't dive into the ground when
      // it climbs.
      if (followTarget) {
        const k = 1 - Math.exp(-followLerp * dt);
        anchor.x += (followTarget.position.x - anchor.x) * k;
        anchor.z += (followTarget.position.z - anchor.z) * k;
        anchor.y += ((followTarget.position.y + altitude) - anchor.y) * k;
      }
      state.phase += angularSpeed * dt;
      const cx = anchor.x + Math.cos(state.phase) * radius;
      const cz = anchor.z + Math.sin(state.phase) * radius;
      // Slight altitude bob so the kettle feels alive instead of clockwork.
      const cy = anchor.y + Math.sin(t * 0.4 + state.phase * 1.3) * 1.6;
      mesh.position.set(cx, cy, cz);

      // Yaw so the sprite's "head" points in the direction of motion. With
      // PlaneGeometry's authored +Y as the bird's head and rotation.x=-π/2
      // baked in (Euler order YXZ), the head's world direction works out to
      // (-sin(yaw), 0, -cos(yaw)). Velocity tangent at phase p is
      // (-sin(p), 0, cos(p)), so head = velocity ⇒ yaw = π - phase.
      const yaw = Math.PI - state.phase;
      // Bank tilt: lean inward into the turn. ~12° looks soaring-natural.
      const bank = 0.20;
      tmpEuler.set(-Math.PI / 2, yaw, bank, 'YXZ');
      mesh.rotation.copy(tmpEuler);
    }

    return { object: mesh, update };
  }

  return { spawn };
}
