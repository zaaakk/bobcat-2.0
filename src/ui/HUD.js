/**
 * HUD: compass strip, minimap rendering, status updates.
 * The UI elements are declared in index.html — this module just animates them.
 */
export function createHUD({ dem }) {
  const compassStrip = document.getElementById('compass-strip');
  const minimapCanvas = document.querySelector('#minimap canvas');
  const minimapCtx = minimapCanvas.getContext('2d');
  const minimapMarker = document.getElementById('minimap-marker');

  // Build a 720° compass strip (so the stripe never runs out as you spin).
  // Each character spans 60px in CSS; full rotation = 360 * (60 / 30deg) … we'll
  // simply repeat N/E/S/W three times and shift left/right based on yaw.
  const points = ['N','NE','E','SE','S','SW','W','NW'];
  const labels = [...points, ...points, ...points]; // 24 labels
  compassStrip.innerHTML = labels.map(p => `<span>${p}</span>`).join('');
  const stripWidth = 60 * labels.length;
  compassStrip.style.width = `${stripWidth}px`;
  // Each label = 45° of yaw → 60px CSS. So 1 rad = 60 / (Math.PI/4) ≈ 76.39 px.
  const PX_PER_RAD = 60 / (Math.PI / 4);

  // Pre-render a static minimap from the DEM (once).
  renderMinimap(minimapCtx, minimapCanvas, dem);

  function update({ playerYaw, playerPos }) {
    // Compass: when player faces +Z (yaw=0), 'N' should be centered.
    // Strip is 220px wide. We position so middle index of stripe ('N' in second copy) sits centered minus yaw offset.
    const centerOffset = -((points.length + 4) * 60 - 110); // start centered on second-block 'N'
    compassStrip.style.left = `${centerOffset + playerYaw * PX_PER_RAD}px`;

    // Minimap marker: convert world position to canvas-relative %.
    const u = (playerPos.x / dem.worldWidth) + 0.5;
    const v = 1 - ((playerPos.z / dem.worldHeight) + 0.5);
    minimapMarker.style.left = `${u * 100}%`;
    minimapMarker.style.top  = `${v * 100}%`;
  }

  return { update };
}

/**
 * Bake a top-down hillshade of the DEM into the minimap canvas.
 */
function renderMinimap(ctx, canvas, dem) {
  const w = canvas.width, h = canvas.height;
  const img = ctx.createImageData(w, h);
  const data = img.data;
  const elevRange = Math.max(1, dem.maxZ - dem.minZ);

  // sun direction (top-left lit)
  const sunX = -1, sunY = -1;
  const sunLen = Math.sqrt(sunX * sunX + sunY * sunY + 1);
  const sx = sunX / sunLen, sy = sunY / sunLen, sz = 1 / sunLen;

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const u = i / w;
      // Map canvas y top→bottom to dem y bottom→top (north up).
      const v = 1 - j / h;
      const dx = Math.min(dem.width - 1, Math.floor(u * dem.width));
      const dy = Math.min(dem.height - 1, Math.floor(v * dem.height));
      const z = dem.data[dy * dem.width + dx];
      const elevT = (z - dem.minZ) / elevRange;

      // Slope from neighbours.
      const xL = Math.max(0, dx - 1), xR = Math.min(dem.width - 1, dx + 1);
      const yD = Math.max(0, dy - 1), yU = Math.min(dem.height - 1, dy + 1);
      const hL = dem.data[dy * dem.width + xL];
      const hR = dem.data[dy * dem.width + xR];
      const hD = dem.data[yD * dem.width + dx];
      const hU = dem.data[yU * dem.width + dx];
      const nx = (hL - hR) / (2 * dem.pixelSizeX);
      const ny = (hD - hU) / (2 * dem.pixelSizeY);
      const nz = 1.0;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const shade = Math.max(0.15, (nx * sx + ny * sy + nz * sz) / nl);

      const baseR = 138 + elevT * 50;
      const baseG = 122 + elevT * 30;
      const baseB =  88 + elevT * 8;
      const o = (j * w + i) * 4;
      data[o + 0] = Math.min(255, baseR * shade);
      data[o + 1] = Math.min(255, baseG * shade);
      data[o + 2] = Math.min(255, baseB * shade);
      data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export function setLoadingProgress(t, status) {
  const bar = document.getElementById('loading-bar');
  const st = document.getElementById('loading-status');
  if (bar) bar.style.width = `${Math.round(t * 100)}%`;
  if (st && status) st.textContent = status;
}

export function hideLoading() {
  const el = document.getElementById('loading');
  if (el) {
    el.classList.add('hidden');
    setTimeout(() => el.remove(), 700);
  }
}
