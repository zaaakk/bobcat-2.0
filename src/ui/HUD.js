import { asset } from '../assetPath.js';
/**
 * HUD built on the sprite atlas in /assets/ui_spritesheet.png.
 *
 * Layout:
 *   - top-center: fixed dial (empty bezel + cardinal letters around it) with a
 *     3D-tilted arrow inside that rotates with player yaw. The dial does not
 *     rotate; only the arrow does, and it's rotated within a tilted plane so
 *     it reads as a tabletop compass needle viewed from above.
 *   - top-left:  three lines of sprite-font text (no panel backgrounds).
 *   - top-right: sprite-font "FPS 060" (no panel background).
 *   - bottom-left: three icon-tagged status bars (star=name, $=area, i=coords).
 *   - bottom-right: circular minimap inside the empty dial frame; the existing
 *     hillshade canvas is clipped to a circle and panned each frame.
 *   - bottom-center: action prompt — sprite-font text only, no panel.
 *
 * The sprite-font has no lowercase glyphs — all text is uppercased before
 * rendering (renderText handles that for A-Z).
 */

import { loadSpriteManifest, spriteEl, spriteBox, sheetInfo, renderText, setText } from './sprite.js';
import { createCompassArrow3D } from './CompassArrow3D.js';

let manifestPromise = null;
export function ensureSpritesLoaded() {
  if (!manifestPromise) manifestPromise = loadSpriteManifest();
  return manifestPromise;
}

const BLUE_FILL = '#3c6193';
const PANEL_DARK = '#26211f';
const GOLD = '#c0a366';

/* ----------------------------- loading screen ----------------------------- */

let loadingState = { bar: null, status: null, queued: [] };

export function setLoadingProgress(t, status) {
  if (!loadingState.bar) { loadingState.queued.push([t, status]); return; }
  loadingState.bar.style.width = `${Math.max(0, Math.min(1, t)) * 100}%`;
  if (status && loadingState.status) {
    setText(loadingState.status, status.toUpperCase(), { capPx: 10, letterSpacing: 2 });
  }
}

export function hideLoading() {
  const el = document.getElementById('loading');
  if (el) {
    el.classList.add('hidden');
    setTimeout(() => el.remove(), 700);
  }
}

export function initLoadingScreen() {
  const el = document.getElementById('loading');
  if (!el) return;
  el.innerHTML = '';

  const title = document.createElement('div');
  title.style.cssText = 'margin-bottom: 32px;';
  title.appendChild(renderText('BOBCAT SIMULATOR', { capPx: 32, letterSpacing: 4 }));
  el.appendChild(title);

  const barWrap = document.createElement('div');
  barWrap.style.cssText = `
    width: 360px; height: 22px;
    background: ${PANEL_DARK};
    border: 2px solid #100c0a;
    padding: 2px;
    position: relative;
  `;
  const barFill = document.createElement('div');
  barFill.style.cssText = `
    width: 0%; height: 100%;
    background: ${BLUE_FILL};
    transition: width 0.25s linear;
  `;
  barWrap.appendChild(barFill);
  el.appendChild(barWrap);
  loadingState.bar = barFill;

  const status = document.createElement('div');
  status.style.cssText = 'margin-top: 18px; height: 14px;';
  el.appendChild(status);
  loadingState.status = status;

  for (const [t, s] of loadingState.queued) setLoadingProgress(t, s);
  loadingState.queued = [];
}

/* --------------------------------- helpers -------------------------------- */

/**
 * Build a status widget: icon-plate sprite + sprite-font text inside the
 * dark slot. The slot starts ~18% from the left.
 */
function makeStatusWidget(spriteName, text, { scale = 0.5, capPx = 12 } = {}) {
  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  wrap.style.display = 'inline-block';

  const bg = spriteEl(spriteName, { scale });
  wrap.appendChild(bg);

  const b = spriteBox(spriteName);
  const slotLeft = Math.round(b.w * 0.18 * scale);
  const slotW = Math.round(b.w * scale) - slotLeft;
  const slotH = Math.round(b.h * scale);

  const txt = document.createElement('div');
  txt.style.cssText = `
    position: absolute; left: ${slotLeft + 8}px; top: 0; width: ${slotW - 16}px; height: ${slotH}px;
    display: flex; align-items: center;
    color: ${GOLD};
  `;
  txt.appendChild(renderText(text, { capPx, letterSpacing: 2 }));
  wrap.appendChild(txt);
  return wrap;
}

/** Plain sprite-font text with a hard 1px black drop shadow (no blur). */
function plainText(text, { capPx = 16, letterSpacing = 3, color = GOLD, shadow = true } = {}) {
  const el = document.createElement('div');
  el.style.cssText = `
    display: inline-block;
    color: ${color};
    ${shadow ? 'filter: drop-shadow(1px 1px 0 #000);' : ''}
  `;
  el.appendChild(renderText(text, { capPx, letterSpacing }));
  return el;
}

/* ------------------------------- main HUD ------------------------------- */

export function createHUD({ dem, water }) {
  const hud = document.getElementById('hud');
  hud.innerHTML = '';

  // ── top-right compass: fixed dial + 3D rotating chevron ──────────────
  // ~40% smaller than the original 0.62× scale → ~0.37×.
  const COMPASS_SCALE = 0.37;
  const dialBoxRef = spriteBox('dial_empty');
  const compassW = Math.round(dialBoxRef.w * COMPASS_SCALE);
  const compassH = Math.round(dialBoxRef.h * COMPASS_SCALE);

  const compassWrap = document.createElement('div');
  compassWrap.id = 'compass';
  compassWrap.style.cssText = `
    position: absolute; top: 14px; right: 14px;
    width: ${compassW}px; height: ${compassH}px;
    pointer-events: none;
  `;

  // Bezel ring (no letters, no arrow — clean disk)
  const bezel = spriteEl('dial_empty', { scale: COMPASS_SCALE });
  bezel.style.position = 'absolute';
  bezel.style.left = '0';
  bezel.style.top = '0';
  compassWrap.appendChild(bezel);

  // Cardinal letters fixed at compass points — just inside the bezel.
  const cardR = compassW * 0.38;
  const cx = compassW / 2, cy = compassH / 2;
  function addCardinal(ch, angleRad) {
    const x = cx + Math.sin(angleRad) * cardR;
    const y = cy - Math.cos(angleRad) * cardR;
    const lab = plainText(ch, { capPx: 18, letterSpacing: 0, color: '#e8d8b0', shadow: true });
    lab.style.position = 'absolute';
    lab.style.left = `${x}px`;
    lab.style.top  = `${y}px`;
    lab.style.transform = 'translate(-50%, -50%)';
    compassWrap.appendChild(lab);
  }
  addCardinal('N', 0);
  addCardinal('E', Math.PI / 2);
  addCardinal('S', Math.PI);
  addCardinal('W', -Math.PI / 2);

  // 3D chevron arrow, centered inside the dial.
  const arrowCanvasSize = Math.round(compassW * 0.65);
  const compassArrow = createCompassArrow3D({ size: arrowCanvasSize });
  compassArrow.canvas.style.position = 'absolute';
  compassArrow.canvas.style.left = `${(compassW - arrowCanvasSize) / 2}px`;
  compassArrow.canvas.style.top  = `${(compassH - arrowCanvasSize) / 2}px`;
  compassArrow.canvas.style.pointerEvents = 'none';
  compassWrap.appendChild(compassArrow.canvas);

  hud.appendChild(compassWrap);

  // ── top-left: help key hints (plain text, no backgrounds) ─────────────
  const helpWrap = document.createElement('div');
  helpWrap.style.cssText = `
    position: absolute; top: 18px; left: 18px;
    display: flex; flex-direction: column; gap: 8px;
    pointer-events: none;
  `;
  helpWrap.appendChild(plainText('WASD  MOVE',   { capPx: 16, letterSpacing: 3 }));
  helpWrap.appendChild(plainText('SHIFT  SPRINT', { capPx: 16, letterSpacing: 3 }));
  helpWrap.appendChild(plainText('MOUSE  LOOK',  { capPx: 16, letterSpacing: 3 }));
  hud.appendChild(helpWrap);

  // ── FPS (plain text, just below the compass) ──────────────────────────
  const fpsWrap = document.createElement('div');
  fpsWrap.style.cssText = `
    position: absolute; top: ${compassH + 22}px; right: 18px;
    pointer-events: none;
  `;
  hud.appendChild(fpsWrap);
  function setFps(n) {
    const v = Number.isFinite(n) ? String(Math.round(n)).padStart(3, '0') : '000';
    fpsWrap.innerHTML = '';
    fpsWrap.appendChild(plainText(`FPS ${v}`, { capPx: 12, letterSpacing: 2 }));
  }
  setFps(0);

  // ── bottom-left: profile icon + icon status widgets ──────────────────
  const bottomLeft = document.createElement('div');
  bottomLeft.style.cssText = `
    position: absolute; bottom: 14px; left: 14px;
    display: flex; align-items: flex-end; gap: 10px;
    pointer-events: none;
  `;

  // Portrait icon — same flat panel treatment as the rest of the HUD.
  const portrait = document.createElement('div');
  portrait.style.cssText = `
    width: 84px; height: 84px;
    background: #14110d;
    border: 2px solid #100c0a;
    image-rendering: pixelated;
    box-shadow: inset 0 0 0 1px #4a3a26;
    flex: 0 0 auto;
    overflow: hidden;
  `;
  const portraitImg = document.createElement('img');
  portraitImg.src = asset('profile.png');
  portraitImg.alt = 'bobcat';
  portraitImg.style.cssText = `
    width: 100%; height: 100%; object-fit: cover;
    image-rendering: pixelated;
  `;
  portrait.appendChild(portraitImg);
  bottomLeft.appendChild(portrait);

  const statusWrap = document.createElement('div');
  statusWrap.style.cssText = `
    display: flex; flex-direction: column; gap: 6px;
  `;
  statusWrap.appendChild(makeStatusWidget('widget_star_bar', 'LYNX RUFUS', { scale: 0.62, capPx: 18 }));
  statusWrap.appendChild(makeStatusWidget('widget_dollar_bar', 'PANDALE', { scale: 0.62, capPx: 18 }));
  const coordsWidget = makeStatusWidget('widget_info_bar', 'N 30 W 101', { scale: 0.62, capPx: 18 });
  statusWrap.appendChild(coordsWidget);
  bottomLeft.appendChild(statusWrap);
  hud.appendChild(bottomLeft);

  const coordsText = coordsWidget.querySelector('div:last-child');

  // ── bottom-right: circular minimap ────────────────────────────────────
  const dialBox = spriteBox('dial_empty');
  const minimapScale = 0.7;
  const dialDispW = Math.round(dialBox.w * minimapScale);
  const dialDispH = Math.round(dialBox.h * minimapScale);

  const minimap = document.createElement('div');
  minimap.id = 'minimap';
  minimap.style.cssText = `
    position: absolute; bottom: 14px; right: 14px;
    width: ${dialDispW}px; height: ${dialDispH}px;
    pointer-events: none;
  `;
  const innerD = Math.round(dialDispW * 0.78);
  const innerInsetX = Math.round((dialDispW - innerD) / 2);
  const innerInsetY = Math.round((dialDispH - innerD) / 2);

  const clipDisk = document.createElement('div');
  clipDisk.style.cssText = `
    position: absolute; left: ${innerInsetX}px; top: ${innerInsetY}px;
    width: ${innerD}px; height: ${innerD}px;
    border-radius: 50%; overflow: hidden;
    background: #14110d;
  `;
  const minimapPan = document.createElement('div');
  minimapPan.id = 'minimap-pan';
  minimapPan.style.cssText = 'position: absolute; left: 0; top: 0; will-change: transform;';
  // 2048 bake: at the 1.5km zoom the visible window is a small slice of the
  // whole-map canvas, so 640 was rendering ~46 source pixels across the dial.
  const minimapCanvas = document.createElement('canvas');
  minimapCanvas.width = 2048;
  minimapCanvas.height = 2048;
  minimapCanvas.style.cssText = 'display: block; image-rendering: pixelated;';
  minimapPan.appendChild(minimapCanvas);
  clipDisk.appendChild(minimapPan);

  const marker = document.createElement('div');
  marker.id = 'minimap-marker';
  marker.style.cssText = `
    position: absolute; top: 50%; left: 50%;
    width: 14px; height: 14px;
    background: ${GOLD};
    clip-path: polygon(50% 0%, 100% 100%, 50% 78%, 0% 100%);
    transform: translate(-50%, -50%) rotate(0rad);
    transform-origin: center center;
    z-index: 2;
  `;
  clipDisk.appendChild(marker);
  minimap.appendChild(clipDisk);

  const dialFrame = spriteEl('dial_empty', { scale: minimapScale });
  dialFrame.style.position = 'absolute';
  dialFrame.style.left = '0';
  dialFrame.style.top = '0';
  dialFrame.style.pointerEvents = 'none';
  minimap.appendChild(dialFrame);
  hud.appendChild(minimap);

  const minimapCtx = minimapCanvas.getContext('2d');
  renderMinimap(minimapCtx, minimapCanvas, dem);

  // 1.5km across the dial: prey herds spawn 200-360m out, so their dots sit
  // a clear third of the way to the rim instead of hugging the player marker
  // (at the old 5km view a 300m herd was ~8px from centre — unfindable).
  const VIEW_DIAMETER_M = 1500;
  const canvasDisplaySize = (dem.worldWidth / VIEW_DIAMETER_M) * innerD;
  minimapCanvas.style.width = canvasDisplaySize + 'px';
  minimapCanvas.style.height = canvasDisplaySize + 'px';

  if (water && water.pools) {
    for (const p of water.pools) {
      const dot = document.createElement('div');
      dot.style.position = 'absolute';
      dot.style.background = '#4ea3c8';
      dot.style.border = '1px solid #16384b';
      dot.style.borderRadius = '50%';
      const radiusPx = Math.max(2, Math.min(8, (p.r / VIEW_DIAMETER_M) * innerD * 2.5));
      dot.style.width = radiusPx + 'px';
      dot.style.height = radiusPx + 'px';
      dot.style.transform = 'translate(-50%, -50%)';
      const u = (p.x / dem.worldWidth) + 0.5;
      const v = 1 - ((p.z / dem.worldHeight) + 0.5);
      dot.style.left = (u * canvasDisplaySize) + 'px';
      dot.style.top = (v * canvasDisplaySize) + 'px';
      minimapPan.appendChild(dot);
    }
  }

  // ── minimap prey dots ──────────────────────────────────────────────────
  // Live mobs move every frame, so unlike the static water-pool dots these
  // come from a reusable pool that's repositioned in update(). Dots live in
  // minimapPan so the existing pan transform handles world→screen for free;
  // corpses drop off the map (a dead blip reads as "something to chase").
  const PREY_DOT_COLORS = { deer: '#c84e4e' };   // red (goat was cut)
  const preyDotPool = [];
  function updatePreyDots(mobsList) {
    let used = 0;
    if (mobsList) {
      for (const m of mobsList) {
        const color = PREY_DOT_COLORS[m.typeId];
        if (!color || m.state?.mode === 'dead') continue;
        let dot = preyDotPool[used];
        if (!dot) {
          dot = document.createElement('div');
          dot.style.cssText = `
            position: absolute; width: 5px; height: 5px;
            border-radius: 50%; border: 1px solid #14110d;
            transform: translate(-50%, -50%); z-index: 1;
          `;
          minimapPan.appendChild(dot);
          preyDotPool.push(dot);
        }
        dot.style.background = color;
        const u = (m.position.x / dem.worldWidth) + 0.5;
        const v = 1 - ((m.position.z / dem.worldHeight) + 0.5);
        dot.style.left = (u * canvasDisplaySize) + 'px';
        dot.style.top = (v * canvasDisplaySize) + 'px';
        dot.style.display = 'block';
        used++;
      }
    }
    for (let i = used; i < preyDotPool.length; i++) {
      preyDotPool[i].style.display = 'none';
    }
  }

  // ── bottom-center: action prompt (plain text) ─────────────────────────
  const promptEl = document.createElement('div');
  promptEl.id = 'action-prompt';
  promptEl.style.cssText = `
    position: absolute; left: 50%; bottom: 28px;
    transform: translateX(-50%);
    opacity: 0; transition: opacity 0.18s ease;
    pointer-events: none;
  `;
  hud.appendChild(promptEl);

  let lastPrompt = null;

  /* ------------------------------ frame update ------------------------- */
  function update({ playerYaw, playerPos, fps, prompt, prey }) {
    // 3D arrow spins around vertical axis to match player yaw.
    compassArrow.setYaw(playerYaw);
    updatePreyDots(prey);

    const u = (playerPos.x / dem.worldWidth) + 0.5;
    const v = 1 - ((playerPos.z / dem.worldHeight) + 0.5);
    const tx = (innerD * 0.5) - (u * canvasDisplaySize);
    const ty = (innerD * 0.5) - (v * canvasDisplaySize);
    minimapPan.style.transform = `translate(${tx}px, ${ty}px)`;
    marker.style.transform = `translate(-50%, -50%) rotate(${playerYaw}rad)`;

    setFps(fps);

    const lat = 30 + (playerPos.z / dem.worldHeight) * 0.5;
    const lon = 101 + (playerPos.x / dem.worldWidth) * 0.5;
    setText(coordsText, `N ${lat.toFixed(0)} W ${lon.toFixed(0)}`, { capPx: 18, letterSpacing: 2 });

    if (prompt) {
      if (prompt !== lastPrompt) {
        promptEl.innerHTML = '';
        promptEl.appendChild(plainText(prompt, { capPx: 20, letterSpacing: 4 }));
        lastPrompt = prompt;
      }
      promptEl.style.opacity = '1';
    } else {
      promptEl.style.opacity = '0';
      lastPrompt = null;
    }
  }

  return { update };
}

/* ----------------------- minimap hillshade bake -------------------------- */

function renderMinimap(ctx, canvas, dem) {
  const w = canvas.width, h = canvas.height;
  const img = ctx.createImageData(w, h);
  const data = img.data;
  const elevRange = Math.max(1, dem.maxZ - dem.minZ);

  const sunX = -1, sunY = -1;
  const sunLen = Math.sqrt(sunX * sunX + sunY * sunY + 1);
  const sx = sunX / sunLen, sy = sunY / sunLen, sz = 1 / sunLen;

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const u = i / w;
      const v = 1 - j / h;
      const dx = Math.min(dem.width - 1, Math.floor(u * dem.width));
      const dy = Math.min(dem.height - 1, Math.floor(v * dem.height));
      const z = dem.data[dy * dem.width + dx];
      const elevT = (z - dem.minZ) / elevRange;

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

