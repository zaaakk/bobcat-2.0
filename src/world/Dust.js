import * as THREE from 'three';

/**
 * Cheap dust-puff system.
 *
 * One BufferGeometry of MAX particles, drawn as THREE.Points with a soft-disc
 * shader. Each particle has a position, velocity and age tracked CPU-side; the
 * shader fades opacity over its lifetime and grows the point size with age so
 * the puff puffs.
 *
 * `spawn(x, y, z, opts)` writes a small burst into the next free slot (ring
 * buffer — old particles get overwritten if we run out, which is fine because
 * MAX is generous). Particles render with depthWrite off so multiple puffs
 * blend without z-fighting against each other.
 */
export function createDust(scene, { max = 320 } = {}) {
  const positions = new Float32Array(max * 3);
  const velocities = new Float32Array(max * 3);
  const ages = new Float32Array(max);
  const lifetimes = new Float32Array(max);
  const sizes = new Float32Array(max);
  // ages are init'd to "expired" so nothing renders before the first spawn.
  for (let i = 0; i < max; i++) ages[i] = 999;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geom.setAttribute('aAge', new THREE.BufferAttribute(ages, 1));
  geom.setAttribute('aLife', new THREE.BufferAttribute(lifetimes, 1));
  // Disable frustum culling — particles spawn where the bobcat is, which is
  // always near the camera, but the bbox computed at construction time is
  // empty so three would cull the whole points cloud.
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    uniforms: {
      // gl_PointSize = aSize * scale * (uPxScale / -mv.z). With aSize ≈ 5..12
      // and a 3rd-person camera ~4m back, this gives ~25..70px particles —
      // roughly the apparent size of a 0.1m dust puff at that distance.
      uPxScale: { value: 32.0 },
      uColor: { value: new THREE.Color(0xc4ad84) }   // tan desert dust
    },
    vertexShader: /* glsl */`
      attribute float aSize;
      attribute float aAge;
      attribute float aLife;
      uniform float uPxScale;
      varying float vT;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vT = aAge / max(aLife, 1e-3);
        // Cull dead particles AND anything behind / very close to the camera —
        // a particle inside the near plane would otherwise render at huge
        // pixel size from the (1.0/-mv.z) clamp and smear the lower screen.
        if (vT >= 1.0 || mv.z > -1.5) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          gl_PointSize = 0.0;
          return;
        }
        // Grow with age, perspective-correct size in pixels.
        float scale = mix(0.6, 1.6, vT);
        gl_PointSize = aSize * scale * (uPxScale / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      precision mediump float;
      uniform vec3 uColor;
      varying float vT;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r = length(c) * 2.0;
        if (r > 1.0) discard;
        float disc = 1.0 - smoothstep(0.65, 1.0, r);
        // Fade in fast (0.0..0.1), out slowly (0.4..1.0).
        float fadeIn = smoothstep(0.0, 0.10, vT);
        float fadeOut = 1.0 - smoothstep(0.45, 1.0, vT);
        float a = disc * fadeIn * fadeOut * 0.55;
        gl_FragColor = vec4(uColor, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `
  });

  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;
  // Render after terrain/plants so the alpha sorts on top of the ground; this
  // is purely a visual hint, dust is basically near-ground anyway.
  points.renderOrder = 2;
  scene.add(points);

  let cursor = 0;
  const _vec = new THREE.Vector3();

  function spawnOne(x, y, z, vx, vy, vz, size, life) {
    const k = cursor;
    positions[k * 3 + 0] = x;
    positions[k * 3 + 1] = y;
    positions[k * 3 + 2] = z;
    velocities[k * 3 + 0] = vx;
    velocities[k * 3 + 1] = vy;
    velocities[k * 3 + 2] = vz;
    sizes[k] = size;
    ages[k] = 0;
    lifetimes[k] = life;
    cursor = (cursor + 1) % max;
  }

  function spawn(x, y, z, opts = {}) {
    const count = opts.count || 4;
    const speedT = opts.speedT ?? 0.5;          // 0..1, scales puff outward speed
    const baseSize = opts.size ?? 7;
    const baseLife = opts.life ?? 0.7;
    for (let i = 0; i < count; i++) {
      // Outward fan biased away from the motion direction the caller gave.
      // If no direction supplied, omnidirectional puff.
      const angle = Math.random() * Math.PI * 2;
      const horiz = (0.5 + Math.random() * 0.9) * (0.6 + speedT * 1.6);
      let vx = Math.cos(angle) * horiz;
      let vz = Math.sin(angle) * horiz;
      if (opts.dir) {
        // Bias outward kick along the *backward* direction (opposite motion),
        // so dust trails behind a running cat.
        vx -= opts.dir.x * (0.8 + speedT * 1.6);
        vz -= opts.dir.z * (0.8 + speedT * 1.6);
      }
      const vy = 0.4 + Math.random() * 0.7;
      const px = x + (Math.random() - 0.5) * 0.18;
      const py = y + 0.04 + Math.random() * 0.06;
      const pz = z + (Math.random() - 0.5) * 0.18;
      const size = baseSize * (0.7 + Math.random() * 0.7);
      const life = baseLife * (0.8 + Math.random() * 0.5);
      spawnOne(px, py, pz, vx, vy, vz, size, life);
    }
    geom.attributes.position.needsUpdate = true;
    geom.attributes.aSize.needsUpdate = true;
    geom.attributes.aAge.needsUpdate = true;
    geom.attributes.aLife.needsUpdate = true;
  }

  function update(dt) {
    let any = false;
    for (let i = 0; i < max; i++) {
      if (ages[i] >= lifetimes[i]) continue;
      ages[i] += dt;
      // Integrate position; apply mild drag and a touch of gravity so the
      // puff settles instead of drifting forever. Constants tuned by eye.
      positions[i * 3 + 0] += velocities[i * 3 + 0] * dt;
      positions[i * 3 + 1] += velocities[i * 3 + 1] * dt;
      positions[i * 3 + 2] += velocities[i * 3 + 2] * dt;
      const drag = Math.exp(-2.4 * dt);
      velocities[i * 3 + 0] *= drag;
      velocities[i * 3 + 2] *= drag;
      velocities[i * 3 + 1] = velocities[i * 3 + 1] * drag - 0.9 * dt;
      any = true;
    }
    if (any) {
      geom.attributes.position.needsUpdate = true;
      geom.attributes.aAge.needsUpdate = true;
    }
  }

  return { spawn, update, points };
}
