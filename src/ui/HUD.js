/**
 * HUD: compass strip, minimap rendering, status updates.
 * The UI elements are declared in index.html — this module just animates them.
 *
 * Minimap: the canvas is rendered once at full DEM extent (one hillshade); a
 * "pan" layer wrapping it gets translated each frame so the player sits at
 * the visible centre. Water pools are added as positioned dots inside the
 * pan layer so they pan/zoom together with the canvas.
 */
export function createHUD({ dem, water }) {
  const compassStrip = document.getElementById('compass-strip');
  const minimapEl = document.getElementById('minimap');
  const minimapPan = document.getElementById('minimap-pan');
  const minimapCanvas = document.querySelector('#minimap canvas');
  const minimapCtx = minimapCanvas.getContext('2d');
  const minimapMarker = document.getElementById('minimap-marker');
  const fpsReadout = document.getElementById('fps-readout');

  // Visible window in metres on the minimap. Smaller = more zoomed in; the
  // window stays centred on the player so most of what's visible is the
  // local terrain. ~5km diameter gives a sense of distance without forcing
  // the player to memorise the whole 21km map.
  const VIEW_DIAMETER_M = 5000;
  const minimapSizePx = minimapEl.clientWidth || 168;
  // Canvas displays at (worldWidth / VIEW_DIAMETER_M) × the minimap size, so
  // VIEW_DIAMETER_M of world fills the visible window. Internal canvas
  // resolution stays at its declared 640×640 — large enough that the zoomed
  // hillshade reads sharp.
  const canvasDisplaySize = (dem.worldWidth / VIEW_DIAMETER_M) * minimapSizePx;
  minimapCanvas.style.width = canvasDisplaySize + 'px';
  minimapCanvas.style.height = canvasDisplaySize + 'px';

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

  // Drop a water-pool dot per pool into the pan layer. Sizes scale with the
  // pool radius, but capped so big river pools don't dominate the minimap.
  const waterDots = [];
  if (water && water.pools) {
    for (const p of water.pools) {
      const dot = document.createElement('div');
      dot.className = 'minimap-water';
      // Convert world-metres to display-pixels at the minimap's zoom.
      const radiusPx = Math.max(2, Math.min(8, (p.r / VIEW_DIAMETER_M) * minimapSizePx * 2.5));
      dot.style.width = radiusPx + 'px';
      dot.style.height = radiusPx + 'px';
      dot.style.transform = 'translate(-50%, -50%)';
      // Pool world-position → display pixel within the (canvasDisplaySize)
      // pan layer. (u,v) are in 0..1 across the DEM extent.
      const u = (p.x / dem.worldWidth) + 0.5;
      const v = 1 - ((p.z / dem.worldHeight) + 0.5);
      dot.style.left = (u * canvasDisplaySize) + 'px';
      dot.style.top = (v * canvasDisplaySize) + 'px';
      minimapPan.appendChild(dot);
      waterDots.push(dot);
    }
  }

  // Action prompt that appears when the bobcat can interact with something
  // nearby (water pools first, more later). Stamped panel with the same
  // chiselled bevel as the rest of the HUD; lives at the bottom-centre.
  const promptEl = document.createElement('div');
  promptEl.id = 'action-prompt';
  promptEl.className = 'panel';
  promptEl.style.cssText = [
    'position:absolute',
    'left:50%; bottom:28px',
    'transform:translateX(-50%)',
    'padding:10px 18px',
    'font-family:Work Sans, sans-serif',
    'font-weight:700; font-size:12px; letter-spacing:0.36em',
    'color:var(--ui-tan)',
    'text-transform:uppercase',
    'text-shadow:1px 1px 0 #000',
    'opacity:0; transition:opacity 0.18s ease',
    'pointer-events:none',
  ].join(';');
  promptEl.textContent = 'DRINK [E]';
  document.getElementById('hud').appendChild(promptEl);

  function update({ playerYaw, playerPos, fps, prompt }) {
    // Compass: when player faces +Z (yaw=0), 'N' should be centered.
    // Strip is 220px wide. We position so middle index of stripe ('N' in second copy) sits centered minus yaw offset.
    const centerOffset = -((points.length + 4) * 60 - 110); // start centered on second-block 'N'
    compassStrip.style.left = `${centerOffset + playerYaw * PX_PER_RAD}px`;

    // Translate the pan layer so the player's world position lands at the
    // minimap's visible centre. (u,v) are 0..1 across the DEM; scaling by
    // canvasDisplaySize gives the player's pixel offset *within* the zoomed
    // canvas, which we then negate and add half-minimap so the player ends
    // up dead-centre in the overflow:hidden window.
    const u = (playerPos.x / dem.worldWidth) + 0.5;
    const v = 1 - ((playerPos.z / dem.worldHeight) + 0.5);
    const tx = (minimapSizePx * 0.5) - (u * canvasDisplaySize);
    const ty = (minimapSizePx * 0.5) - (v * canvasDisplaySize);
    minimapPan.style.transform = `translate(${tx}px, ${ty}px)`;
    // Rotate the marker to match the bobcat's facing. yaw=0 → moves +Z =
    // top of the minimap (north), so the default upward-pointing triangle
    // is the correct rest orientation; CSS rotate is clockwise, which
    // matches our world-yaw convention (yaw=π/2 → east → triangle right).
    if (minimapMarker) {
      minimapMarker.style.transform = `translate(-50%, -50%) rotate(${playerYaw}rad)`;
    }

    if (fpsReadout && Number.isFinite(fps)) {
      fpsReadout.textContent = String(Math.round(fps)).padStart(3, '0');
    }

    // Prompt: show when an interaction is available; fade out otherwise.
    if (prompt) {
      promptEl.textContent = prompt;
      promptEl.style.opacity = '1';
    } else {
      promptEl.style.opacity = '0';
    }
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
