import * as THREE from 'three';

/**
 * Pack species PNGs into one square atlas. Each species occupies one cell;
 * we store UV offset/scale so the InstancedPlants shader can pick a tile per instance.
 *
 * Cells are arranged in a square grid: cols = ceil(sqrt(N)).
 */
export async function buildSpriteAtlas(species, cellSize = 512) {
  const cols = Math.ceil(Math.sqrt(species.length));
  const rows = Math.ceil(species.length / cols);
  const canvas = document.createElement('canvas');
  canvas.width = cols * cellSize;
  canvas.height = rows * cellSize;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Each cell: draw the sprite centred and bottom-aligned. We treat the bottom
  // edge of the cell as the ground so plants don't float.
  const uvRects = new Array(species.length);
  await Promise.all(species.map(s => loadImage(s.file).then(img => {
    const i = s.atlasIndex;
    const cx = (i % cols) * cellSize;
    const cy = Math.floor(i / cols) * cellSize;
    // Fit the image into cell preserving aspect; rest is transparent.
    const ar = img.width / img.height;
    let w = cellSize, h = cellSize;
    if (ar > 1) { h = cellSize / ar; } else { w = cellSize * ar; }
    const dx = cx + (cellSize - w) * 0.5;
    const dy = cy + (cellSize - h);    // bottom-aligned
    ctx.drawImage(img, dx, dy, w, h);
    uvRects[i] = {
      uOffset: cx / canvas.width,
      vOffset: 1 - (cy + cellSize) / canvas.height, // GL: bottom-up
      uScale: cellSize / canvas.width,
      vScale: cellSize / canvas.height
    };
  })));

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  return { texture, uvRects, cellSize, cols, rows };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
