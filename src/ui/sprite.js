import { asset } from '../assetPath.js';
/**
 * Sprite helpers backed by /assets/ui_spritesheet.png + .json manifest.
 *
 * The manifest gives pixel-exact bounds for every glyph and ornament. We
 * render each sprite via a div with background-image positioned by negative
 * offset, scaled uniformly. Text rendering positions a row of single-glyph
 * spans aligned to a shared baseline (so digits, caps, and descender chars
 * sit on the same line).
 *
 * Coordinates in the manifest are in source pixels. At render time we scale
 * by `targetCapHeight / sourceCapHeight` so the rendered cap-height matches
 * the requested size.
 */

let MANIFEST = null;
let SHEET_W = 0, SHEET_H = 0, SHEET_URL = '';

export async function loadSpriteManifest(url = asset('ui_spritesheet.json')) {
  const res = await fetch(url);
  MANIFEST = await res.json();
  SHEET_W = MANIFEST.imageWidth;
  SHEET_H = MANIFEST.imageHeight;
  SHEET_URL = MANIFEST.image;
  return MANIFEST;
}

export function spriteBox(name) {
  if (!MANIFEST) throw new Error('sprite manifest not loaded');
  const s = MANIFEST.sprites[name];
  if (!s) throw new Error(`sprite "${name}" not in manifest`);
  return { x: s[0], y: s[1], w: s[2] - s[0], h: s[3] - s[1] };
}

/** Returns { w, h, url } for the sheet itself. */
export function sheetInfo() {
  if (!MANIFEST) throw new Error('sprite manifest not loaded');
  return { w: SHEET_W, h: SHEET_H, url: SHEET_URL };
}

/**
 * Apply background-image style to a div so it shows a single sprite, scaled.
 *  - scale: linear scale factor applied to the sprite's source pixels
 */
function applySpriteBg(el, name, scale) {
  const { x, y, w, h } = spriteBox(name);
  el.style.width  = `${w * scale}px`;
  el.style.height = `${h * scale}px`;
  el.style.backgroundImage = `url(${SHEET_URL})`;
  el.style.backgroundRepeat = 'no-repeat';
  el.style.backgroundSize = `${SHEET_W * scale}px ${SHEET_H * scale}px`;
  el.style.backgroundPosition = `${-x * scale}px ${-y * scale}px`;
  el.style.imageRendering = 'pixelated';
}

/** Create a div displaying a single sprite. */
export function spriteEl(name, { scale = 1, className = '' } = {}) {
  const el = document.createElement('div');
  el.className = className;
  el.style.display = 'inline-block';
  el.style.flex = '0 0 auto';
  applySpriteBg(el, name, scale);
  return el;
}

/**
 * Source pixel cap-height (uppercase A-M block). Most uppercase letters share
 * this height; chars with descenders (Q, X with bottom flourish, etc.) are
 * taller and hang below baseline.
 */
const SRC_CAP_H = 47;
// y-baseline (bottom of caps) per row, in source pixels.
const ROW_BASELINE = {
  am: 408,    // A-M row caps bottom
  nz: 484,    // N-Z row caps bottom
  digits: 568,
  punct: 630,
};

const CHAR_ROW = {};
'ABCDEFGHIJKLM'.split('').forEach(c => CHAR_ROW[c] = 'am');
'NOPQRSTUVWXYZ'.split('').forEach(c => CHAR_ROW[c] = 'nz');
'0123456789'.split('').forEach(c => CHAR_ROW[c] = 'digits');
['.', ',', ':', ';', '!', '?', '-', '/', "'", '"', '(', ')'].forEach(c => CHAR_ROW[c] = 'punct');

// Char to sprite name
const PUNCT_KEY = {
  '.': 'period', ',': 'comma', ':': 'colon', ';': 'semicolon',
  '!': 'excl', '?': 'q', '-': 'dash', '/': 'slash',
  "'": 'apos', '"': 'quote', '(': 'lparen', ')': 'rparen',
};
function spriteNameFor(ch) {
  const u = ch.toUpperCase();
  if (/[A-Z0-9]/.test(u)) return `char_${u}`;
  if (PUNCT_KEY[ch]) return `char_${PUNCT_KEY[ch]}`;
  return null; // space, unknown
}

/**
 * Render a string as a row of sprite glyphs into a container element.
 * Glyphs are scaled so caps are `capPx` tall. Spaces become gaps.
 *
 *  - capPx: target uppercase height in CSS pixels
 *  - letterSpacing: extra px between glyphs (after scale)
 *  - spaceWidth: width of a single space, default 0.4 * capPx
 *  - tint: optional CSS filter (e.g. "brightness(1.1) sepia(0.4)")
 */
export function renderText(text, {
  capPx = 22,
  letterSpacing = 2,
  spaceWidth = null,
  tint = null,
} = {}) {
  if (!MANIFEST) throw new Error('sprite manifest not loaded');
  const scale = capPx / SRC_CAP_H;
  if (spaceWidth == null) spaceWidth = Math.round(capPx * 0.4);

  // Determine line height: tallest glyph in the string, scaled. Caps + descenders.
  // For consistent baseline alignment, we align each glyph by its row's baseline.
  const container = document.createElement('span');
  container.style.display = 'inline-flex';
  container.style.alignItems = 'flex-end'; // baseline alignment
  container.style.gap = `${letterSpacing}px`;
  // Line box height: cap height + tallest descender
  let maxBelow = 0, maxAbove = SRC_CAP_H;
  for (const ch of text) {
    if (ch === ' ') continue;
    const name = spriteNameFor(ch);
    if (!name) continue;
    let box;
    try { box = spriteBox(name); } catch { continue; }
    const row = CHAR_ROW[ch.toUpperCase()];
    const baseline = ROW_BASELINE[row];
    const below = (box.y + box.h) - baseline;       // descender
    const above = baseline - box.y;                 // ascender (cap height for caps)
    if (below > maxBelow) maxBelow = below;
    if (above > maxAbove) maxAbove = above;
  }
  container.style.height = `${Math.ceil((maxAbove + maxBelow) * scale)}px`;
  container.style.lineHeight = '1';

  for (const ch of text) {
    if (ch === ' ') {
      const sp = document.createElement('span');
      sp.style.display = 'inline-block';
      sp.style.width = `${spaceWidth}px`;
      sp.style.height = '1px';
      container.appendChild(sp);
      continue;
    }
    const name = spriteNameFor(ch);
    if (!name) continue;
    let box;
    try { box = spriteBox(name); } catch { continue; }
    const row = CHAR_ROW[ch.toUpperCase()];
    const baseline = ROW_BASELINE[row];
    const below = ((box.y + box.h) - baseline) * scale;
    // Wrap each glyph in a span sized to the glyph's source w/h, padded below
    // by its descender so baseline (align-items: flex-end) lines up.
    const wrap = document.createElement('span');
    wrap.style.display = 'inline-block';
    wrap.style.position = 'relative';
    wrap.style.width  = `${Math.ceil(box.w * scale)}px`;
    wrap.style.height = `${Math.ceil(box.h * scale)}px`;
    wrap.style.marginBottom = `${-Math.ceil(below)}px`; // pull below baseline
    wrap.style.flex = '0 0 auto';
    if (tint) wrap.style.filter = tint;
    applySpriteBg(wrap, name, scale);
    container.appendChild(wrap);
  }
  return container;
}

/** Replace the contents of an element with rendered text. */
export function setText(el, text, opts) {
  el.innerHTML = '';
  el.appendChild(renderText(text, opts));
}
