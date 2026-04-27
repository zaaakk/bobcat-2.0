import * as THREE from 'three';

/**
 * Pure motion simulation for the bobcat: yaw turning, speed damping, jump
 * state, gravity, terrain alignment. No GLB, no animation, no textures.
 *
 * The sim mutates a shared `state` object that's also the public face of
 * the bobcat controller (so main.js / camera can read state.position,
 * state.yaw, etc.). The rig writes to state.pivot's transform — its job;
 * the sim writes to state.position and state.pivot.quaternion (terrain tilt).
 *
 * Animation triggers (jump start, jump landing) are routed through the rig
 * passed into `update`, plus optional state.onJumpStart / state.onJumpLand
 * callbacks for things like dust puffs.
 */
export function createBobcatSim({ pivot, support }) {
  const state = {
    object: pivot,
    pivot,
    position: pivot.position,
    velocity: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 0, 1),
    yaw: 0,
    speed: 0,
    walkSpeed: 3.2,
    runSpeed: 14.8,
    airborne: false,
    vy: 0,
    jumpInitialVy: 5.4,
    gravity: 14.0,
    // Number of jumps remaining mid-air. Starts at maxJumps when grounded
    // and decrements with each Space press; resets on landing. Default
    // maxJumps=2 → grounded jump + one mid-air "double-jump".
    jumpsRemaining: 2,
    maxJumps: 2,
    onJumpStart: null,    // (pos, jumpsLeft) => void — main.js wires dust here
    onJumpLand: null,
    setGroundFn(fn) { groundFn = fn; },
    // Drink state. main.js sets `canDrink` each frame from pool proximity;
    // pressing E (inputs.drinkPressed) starts a 2-second drink during which
    // the cat is locked in place. `hydration` is informational for now —
    // ticks down slowly, refills on drink. Future systems (thirst-driven
    // navigation, etc.) read it.
    canDrink: false,
    nearestPool: null,    // { x, y, z, r } or null
    isDrinking: false,
    drinkTimer: 0,
    drinkDuration: 2.0,
    hydration: 1.0,
    onDrinkStart: null,
    onDrinkEnd: null,
  };

  let groundFn = (x, z) => 0;

  // Reusable scratch — the alignment basis is recomputed every frame.
  const tmpRight    = new THREE.Vector3();
  const tmpUp       = new THREE.Vector3();
  const tmpFwd      = new THREE.Vector3();
  const tmpFwdYaw   = new THREE.Vector3();
  const tmpSpanLR   = new THREE.Vector3();
  const tmpSpanFB   = new THREE.Vector3();
  const tmpBasis    = new THREE.Matrix4();
  const tmpQuat     = new THREE.Quaternion();

  function update(dt, inputs, dem, rig) {
    // ---- drink state machine ------------------------------------------
    // E starts a drink when in range; mid-drink, all movement input is
    // ignored and the cat is pinned in place until the timer elapses.
    if (state.isDrinking) {
      state.drinkTimer -= dt;
      if (state.drinkTimer <= 0) {
        state.isDrinking = false;
        state.hydration = Math.min(1, state.hydration + 0.5);
        if (state.onDrinkEnd) state.onDrinkEnd(state.position);
      }
    } else if (inputs.drinkPressed && state.canDrink) {
      state.isDrinking = true;
      state.drinkTimer = state.drinkDuration;
      // Face the pool while drinking — looks intentional.
      if (state.nearestPool) {
        const dx = state.nearestPool.x - state.position.x;
        const dz = state.nearestPool.z - state.position.z;
        if (dx * dx + dz * dz > 0.01) state.yaw = Math.atan2(dx, dz);
      }
      if (state.onDrinkStart) state.onDrinkStart(state.position);
    }

    // Slow ambient hydration loss — won't matter until something reads it.
    state.hydration = Math.max(0, state.hydration - dt * 0.005);

    // ---- yaw + horizontal speed ----------------------------------------
    const fwd    = state.isDrinking ? 0 : inputs.move.y;
    const strafe = state.isDrinking ? 0 : inputs.move.x;
    const wantMove = (fwd !== 0 || strafe !== 0);

    if (wantMove) {
      // Camera yaw is direction from target → camera; forward (away from
      // camera) is the opposite, so add π.
      const moveYaw = Math.atan2(strafe, fwd) + inputs.cameraYaw + Math.PI;
      state.yaw = lerpAngle(state.yaw, moveYaw, Math.min(1, dt * 8));
      const target = inputs.sprint ? state.runSpeed : state.walkSpeed;
      state.speed = THREE.MathUtils.damp(state.speed, target, 4, dt);
    } else {
      state.speed = THREE.MathUtils.damp(state.speed, 0, 6, dt);
    }

    // ---- jump trigger --------------------------------------------------
    // Each press consumes one of jumpsRemaining. The first jump leaves the
    // ground; subsequent presses while airborne are double-jumps. The
    // second is slightly weaker so the bobcat doesn't rocket into the sky.
    if (inputs.jumpPressed && state.jumpsRemaining > 0 && !state.isDrinking) {
      const isFirst = state.jumpsRemaining === state.maxJumps;
      state.airborne = true;
      state.vy = state.jumpInitialVy * (isFirst ? 1.0 : 0.85);
      state.jumpsRemaining -= 1;
      rig.playJump();
      if (state.onJumpStart) state.onJumpStart(state.position, state.jumpsRemaining);
    }

    // ---- horizontal motion + DEM clamp ---------------------------------
    state.position.x += Math.sin(state.yaw) * state.speed * dt;
    state.position.z += Math.cos(state.yaw) * state.speed * dt;

    const m = 50;
    const halfW = dem.worldWidth * 0.5 - m;
    const halfH = dem.worldHeight * 0.5 - m;
    state.position.x = Math.max(-halfW, Math.min(halfW, state.position.x));
    state.position.z = Math.max(-halfH, Math.min(halfH, state.position.z));

    // ---- terrain alignment --------------------------------------------
    // Grounding from a single centre sample makes the cat behave as a point
    // collider, which clips/floats as terrain changes under its body. Sample
    // a small support footprint and align the pivot to the local plane.
    tmpFwdYaw.set(Math.sin(state.yaw), 0, Math.cos(state.yaw));
    tmpRight.set(Math.cos(state.yaw), 0, -Math.sin(state.yaw));

    const x = state.position.x;
    const z = state.position.z;
    const hC = groundFn(x, z);
    const hF = groundFn(x + tmpFwdYaw.x * support.halfLength, z + tmpFwdYaw.z * support.halfLength);
    const hB = groundFn(x - tmpFwdYaw.x * support.halfLength, z - tmpFwdYaw.z * support.halfLength);
    const hR = groundFn(x + tmpRight.x  * support.halfWidth,  z + tmpRight.z  * support.halfWidth);
    const hL = groundFn(x - tmpRight.x  * support.halfWidth,  z - tmpRight.z  * support.halfWidth);

    tmpSpanFB.set(tmpFwdYaw.x * (support.halfLength * 2), hF - hB, tmpFwdYaw.z * (support.halfLength * 2));
    tmpSpanLR.set(tmpRight.x  * (support.halfWidth  * 2), hR - hL, tmpRight.z  * (support.halfWidth  * 2));
    tmpUp.crossVectors(tmpSpanFB, tmpSpanLR).normalize();
    if (tmpUp.y < 0) tmpUp.multiplyScalar(-1);

    tmpFwd.copy(tmpFwdYaw).addScaledVector(tmpUp, -tmpFwdYaw.dot(tmpUp)).normalize();
    tmpRight.crossVectors(tmpUp, tmpFwd).normalize();
    tmpFwd.crossVectors(tmpRight, tmpUp).normalize();

    const groundFloor = Math.max(hC, (hF + hB + hR + hL) * 0.25) + support.groundClearance;

    // ---- vertical / jump physics ---------------------------------------
    if (state.airborne) {
      state.vy -= state.gravity * dt;
      state.position.y += state.vy * dt;
      if (state.position.y <= groundFloor && state.vy <= 0) {
        state.position.y = groundFloor;
        state.airborne = false;
        state.vy = 0;
        state.jumpsRemaining = state.maxJumps;
        rig.stopJump();
        if (state.onJumpLand) state.onJumpLand(state.position);
      }
    } else {
      state.position.y = groundFloor;
    }

    // ---- apply terrain tilt to pivot ----------------------------------
    tmpBasis.makeBasis(tmpRight, tmpUp, tmpFwd);
    tmpQuat.setFromRotationMatrix(tmpBasis);
    // Don't slam to terrain-aligned tilt while airborne — it'd pitch the cat
    // around the local ground normal beneath it, even mid-flight.
    const tiltK = state.airborne ? Math.min(1, dt * 2) : Math.min(1, dt * 10);
    pivot.quaternion.slerp(tmpQuat, tiltK);
    state.forward.copy(tmpFwdYaw);
  }

  return { state, update };
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
