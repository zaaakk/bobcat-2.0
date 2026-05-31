/**
 * 3D compass arrow — a chevron extruded into a thin solid, rendered by a tiny
 * Three.js scene to a transparent canvas. The chevron lies flat on the XZ
 * plane and rotates around Y by the player yaw, so as the bobcat turns the
 * arrow swings around and we see it from different perspectives — full
 * silhouette when pointing toward/away, thin profile when pointing east/west.
 *
 * Shape mirrors the gold chevron in the sprite atlas: a pointed top, two
 * outer shoulders, and a V-notch cut into the bottom.
 *
 * The canvas gets embedded inside the compass dial; the dial bezel + cardinal
 * letters are unrelated (DOM elements in HUD.js).
 */

import * as THREE from 'three';

export function createCompassArrow3D({ size = 110 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.style.display = 'block';
  canvas.style.width  = `${size}px`;
  canvas.style.height = `${size}px`;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: false,
    premultipliedAlpha: true,
  });
  renderer.setSize(size, size, false);
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  canvas.style.imageRendering = 'pixelated';

  const scene = new THREE.Scene();

  // Orthographic camera looking down at the chevron from above-front. The
  // 'view diameter' is sized so a 1x1 chevron fills most of the canvas with
  // a bit of headroom for the bevels and shadows.
  const VIEW = 1.25;
  const camera = new THREE.OrthographicCamera(-VIEW, VIEW, VIEW, -VIEW, 0.1, 10);
  // Position: above and slightly forward of the arrow. Looking at origin.
  // Tilt ~30° down — enough perspective to read as 3D but not so much that
  // the arrow gets squashed when pointing toward/away from camera.
  camera.position.set(0, 1.8, 1.6);
  camera.lookAt(0, 0, 0);

  // Chevron shape (in XY plane, tip at +Y).
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.95);          // top tip
  shape.lineTo(0.78, -0.50);      // right outer
  shape.lineTo(0.30, -0.10);      // right inner (start of V notch)
  shape.lineTo(0, 0.08);          // V notch tip
  shape.lineTo(-0.30, -0.10);     // left inner
  shape.lineTo(-0.78, -0.50);     // left outer
  shape.lineTo(0, 0.95);          // close

  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: 0.20,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.04,
    bevelSegments: 2,
    curveSegments: 4,
  });
  // Center the extrusion along Z (default extrudes from 0 to +depth).
  geom.translate(0, 0, -0.10);

  // Flat-shaded yellow — no smooth normals so the bevel faces show as crisp
  // discrete shading steps instead of a gradient.
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffd400,
    metalness: 0.0,
    roughness: 0.55,
    flatShading: true,
  });

  const mesh = new THREE.Mesh(geom, mat);

  // Group holds the mesh tilted into the horizontal plane. Yaw rotation goes
  // on the group's Y so it spins around the world-vertical axis.
  const group = new THREE.Group();
  // Lay flat: shape's +Y axis maps to world -Z (away from camera = top of view).
  // rotation.x = +π/2 rotates shape +Y → world -Z. ✓
  mesh.rotation.x = Math.PI / 2;
  group.add(mesh);
  scene.add(group);

  // Lighting — warm key light from upper-left, cool fill, ambient.
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xfff0c8, 1.4);
  key.position.set(-2, 3, 2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x9ab8d6, 0.35);
  fill.position.set(2, 1, -1);
  scene.add(fill);

  let lastYaw = NaN;
  function setYaw(yaw) {
    if (yaw === lastYaw) return;
    lastYaw = yaw;
    // Player yaw=0 → facing world +Z (north). Arrow tip at world -Z is the
    // top of the canvas (away from camera). When player faces east (+X,
    // yaw=π/2), the arrow tip should rotate to world +X (right of canvas).
    // Y-rotation of +yaw maps -Z (tip) → +X at yaw=π/2.  ✓
    group.rotation.y = yaw;
    renderer.render(scene, camera);
  }

  // Render once immediately so the first frame isn't blank.
  renderer.render(scene, camera);

  function dispose() {
    geom.dispose();
    mat.dispose();
    renderer.dispose();
  }

  return { canvas, setYaw, dispose };
}
