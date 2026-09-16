import * as THREE from 'three';

/**
 * Persistent blood splatter decals on the terrain.
 *
 * Each decal is a small terrain-conformed grid quad (vertices displaced to
 * groundY so the stain drapes over bumps and slopes instead of clipping)
 * carrying a procedurally drawn splatter texture. A handful of canvas
 * variants are baked once and shared; each spawn picks one at a random
 * rotation/size so no two kills look stamped.
 *
 * Lifetime: full-strength for `holdSeconds`, then fades out over
 * `fadeSeconds` and is removed. A hard cap recycles the oldest decal so a
 * long hunting session can't accumulate hundreds of draw calls.
 */
const VARIANTS = 4;
const TEX_SIZE = 256;
const SEGMENTS = 6;

export function createBloodDecals(scene, groundY, {
  maxDecals = 24,
  holdSeconds = 90,
  fadeSeconds = 30,
} = {}) {
  const textures = [];
  for (let i = 0; i < VARIANTS; i++) textures.push(makeSplatterTexture(i));

  const decals = [];

  function spawnAt(x, z, { size = 1.4 } = {}) {
    if (decals.length >= maxDecals) {
      const oldest = decals.shift();
      scene.remove(oldest.mesh);
      oldest.mesh.geometry.dispose();
      oldest.mesh.material.dispose();
    }

    // Terrain-conformed patch: displace each grid vertex to the local
    // ground height, lifted a hair to clear the surface.
    const geom = new THREE.PlaneGeometry(size, size, SEGMENTS, SEGMENTS);
    geom.rotateX(-Math.PI / 2);
    const pos = geom.attributes.position;
    const rot = Math.random() * Math.PI * 2;
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    for (let v = 0; v < pos.count; v++) {
      const lx = pos.getX(v), lz = pos.getZ(v);
      const wx = x + lx * cosR - lz * sinR;
      const wz = z + lx * sinR + lz * cosR;
      pos.setXYZ(v, lx, groundY(wx, wz) + 0.025, lz);
    }
    geom.computeVertexNormals();

    const mat = new THREE.MeshBasicMaterial({
      map: textures[(Math.random() * VARIANTS) | 0],
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      color: 0x9c1812,
    });
    const mesh = new THREE.Mesh(geom, mat);
    // World rotation is baked into the vertex displacement; the mesh itself
    // only translates so the heights stay where they were sampled.
    mesh.position.set(x, 0, z);
    mesh.rotation.y = -rot;
    mesh.renderOrder = 3;
    scene.add(mesh);

    decals.push({ mesh, age: 0 });
  }

  function update(dt) {
    for (let i = decals.length - 1; i >= 0; i--) {
      const d = decals[i];
      d.age += dt;
      if (d.age > holdSeconds) {
        const fadeT = (d.age - holdSeconds) / fadeSeconds;
        if (fadeT >= 1) {
          scene.remove(d.mesh);
          d.mesh.geometry.dispose();
          d.mesh.material.dispose();
          decals.splice(i, 1);
        } else {
          d.mesh.material.opacity = 1 - fadeT;
        }
      }
    }
  }

  return { spawnAt, update, decals };
}

/**
 * Canvas-drawn splatter: a dense irregular core pool with radiating
 * droplets and a few streaks. Alpha-only shape; tint comes from the
 * material color so all variants share a palette.
 */
function makeSplatterTexture(seed) {
  const c = document.createElement('canvas');
  c.width = c.height = TEX_SIZE;
  const ctx = c.getContext('2d');
  const cx = TEX_SIZE / 2, cy = TEX_SIZE / 2;
  let s = (seed * 747796405 + 2891336453) >>> 0;
  const rand = () => {
    s = ((s ^ (s << 13)) | 0) >>> 0;
    s = ((s ^ (s >>> 17)) | 0) >>> 0;
    s = ((s ^ (s << 5)) | 0) >>> 0;
    return s / 0xffffffff;
  };

  ctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';

  // Core pool: an irregular radial blob built from overlapping discs.
  const coreR = TEX_SIZE * 0.16;
  for (let i = 0; i < 26; i++) {
    const a = rand() * Math.PI * 2;
    const r = rand() * coreR * 0.8;
    const blobR = coreR * (0.35 + rand() * 0.5);
    ctx.globalAlpha = 0.55 + rand() * 0.4;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, blobR, 0, Math.PI * 2);
    ctx.fill();
  }

  // Radiating droplets — denser near the core, sparser and smaller out to
  // the edge, with slight angular clumping so it reads splashed, not dotted.
  const clumpA = rand() * Math.PI * 2;
  for (let i = 0; i < 70; i++) {
    const clumped = rand() < 0.45;
    const a = clumped ? clumpA + (rand() - 0.5) * 1.2 : rand() * Math.PI * 2;
    const dist = coreR + Math.pow(rand(), 1.6) * (TEX_SIZE * 0.32);
    const dropR = Math.max(1.2, (1 - dist / (TEX_SIZE * 0.5)) * 7 * (0.4 + rand()));
    ctx.globalAlpha = 0.4 + rand() * 0.5;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * dist, cy + Math.sin(a) * dist, dropR, 0, Math.PI * 2);
    ctx.fill();
  }

  // A few elongated streaks flung outward.
  for (let i = 0; i < 6; i++) {
    const a = clumpA + (rand() - 0.5) * 1.6;
    const start = coreR * (0.6 + rand() * 0.5);
    const len = TEX_SIZE * (0.10 + rand() * 0.16);
    ctx.globalAlpha = 0.5 + rand() * 0.3;
    ctx.lineWidth = 2 + rand() * 3.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * start, cy + Math.sin(a) * start);
    ctx.lineTo(cx + Math.cos(a) * (start + len), cy + Math.sin(a) * (start + len));
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
