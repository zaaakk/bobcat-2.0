/**
 * Debug menu — toggle with `~` (backtick) or F1.
 *
 * The menu hosts panels (a left-hand tab list, a content area on the right).
 * Each panel is a registered {id, label, render(panelEl)} object. The first
 * panel is "Filters" — saturation, brightness, contrast over the whole scene.
 *
 * The visual chrome matches the rest of the HUD: stamped panel, thick borders,
 * block typography, no thin lines.
 */
export function createDebugMenu({ panels = [] } = {}) {
  const root = document.createElement('div');
  root.id = 'debug-menu';
  root.innerHTML = `
    <div class="dbg-frame">
      <div class="dbg-titlebar">DEBUG</div>
      <div class="dbg-body">
        <div class="dbg-tabs"></div>
        <div class="dbg-panel"></div>
      </div>
      <div class="dbg-footer">~ to close · F1</div>
    </div>
  `;
  Object.assign(root.style, {
    position: 'fixed', top: '60px', right: '18px',
    width: '380px', zIndex: '60', pointerEvents: 'auto',
    display: 'none'
  });
  document.body.appendChild(root);

  // Inject the menu's stylesheet — kept here so the module is drop-in.
  const style = document.createElement('style');
  style.textContent = `
    #debug-menu .dbg-frame {
      background: #1f1a10;
      border: 3px solid #0a0805;
      box-shadow:
        inset 0 0 0 1px #4f3a26,
        inset 0 2px 0 0 rgba(255,220,170,0.06),
        inset 0 -2px 0 0 rgba(0,0,0,0.55),
        0 6px 0 0 rgba(0,0,0,0.55);
      color: #f0e6d0;
      font-family: 'Work Sans', sans-serif;
    }
    #debug-menu .dbg-titlebar {
      padding: 8px 12px;
      font-family: 'Almendra', serif; font-weight: 700;
      font-size: 16px; letter-spacing: 0.3em;
      color: #b39568; text-shadow: 1px 1px 0 #000;
      border-bottom: 2px solid #0a0805;
      background: #1a2e6b;
    }
    #debug-menu .dbg-body { display: flex; }
    #debug-menu .dbg-tabs {
      width: 96px; flex-shrink: 0;
      border-right: 2px solid #0a0805;
    }
    #debug-menu .dbg-tab {
      padding: 10px 10px;
      font-weight: 800; font-size: 11px; letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #b9aa8a; cursor: pointer;
      border-bottom: 1px solid #2a2418;
      text-shadow: 1px 1px 0 #000;
      user-select: none;
    }
    #debug-menu .dbg-tab.active {
      color: #f0e6d0;
      background: #2e1f1a;
      box-shadow: inset 3px 0 0 0 #9c1a1a;
    }
    #debug-menu .dbg-panel {
      flex: 1; padding: 12px 14px;
      max-height: 60vh; overflow-y: auto;
    }
    #debug-menu .dbg-row { margin-bottom: 12px; }
    #debug-menu .dbg-label {
      display: flex; justify-content: space-between;
      font-weight: 700; font-size: 11px; letter-spacing: 0.2em;
      text-transform: uppercase; color: #b9aa8a;
      margin-bottom: 4px;
      text-shadow: 1px 1px 0 #000;
    }
    #debug-menu .dbg-label span:last-child {
      color: #b39568; font-family: 'Almendra', serif;
      font-size: 13px; letter-spacing: 0.05em;
    }
    #debug-menu .dbg-slider {
      -webkit-appearance: none; appearance: none;
      width: 100%; height: 14px;
      background: #08060a;
      border: 2px solid #0a0805;
      box-shadow: inset 0 0 0 1px #4f3a26;
      outline: none;
    }
    #debug-menu .dbg-slider::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 18px; height: 18px;
      background: #9c1a1a;
      border: 2px solid #f0e6d0;
      cursor: pointer;
      box-shadow: 0 2px 0 0 rgba(0,0,0,0.6);
    }
    #debug-menu .dbg-slider::-moz-range-thumb {
      width: 18px; height: 18px;
      background: #9c1a1a;
      border: 2px solid #f0e6d0;
      cursor: pointer;
    }
    #debug-menu .dbg-color {
      width: 100%; height: 24px;
      padding: 0;
      background: #08060a;
      border: 2px solid #0a0805;
      box-shadow: inset 0 0 0 1px #4f3a26;
      cursor: pointer;
    }
    #debug-menu .dbg-button {
      display: inline-block;
      padding: 6px 14px;
      font-weight: 800; font-size: 11px; letter-spacing: 0.2em;
      color: #f0e6d0; text-transform: uppercase;
      background: #1f1a10;
      border: 2px solid #0a0805;
      box-shadow:
        inset 0 0 0 1px #4f3a26,
        0 3px 0 0 rgba(0,0,0,0.55);
      cursor: pointer;
      text-shadow: 1px 1px 0 #000;
    }
    #debug-menu .dbg-button:active {
      transform: translateY(1px);
      box-shadow: inset 0 0 0 1px #4f3a26, 0 1px 0 0 rgba(0,0,0,0.55);
    }
    #debug-menu .dbg-footer {
      padding: 6px 12px;
      font-size: 10px; letter-spacing: 0.18em;
      color: #b9aa8a; text-transform: uppercase;
      border-top: 2px solid #0a0805;
      text-align: right;
    }
  `;
  document.head.appendChild(style);

  const tabsEl = root.querySelector('.dbg-tabs');
  const panelEl = root.querySelector('.dbg-panel');

  let activeId = null;
  function setActive(id) {
    activeId = id;
    panelEl.innerHTML = '';
    [...tabsEl.children].forEach(el => {
      el.classList.toggle('active', el.dataset.id === id);
    });
    const p = panels.find(p => p.id === id);
    if (p && p.render) p.render(panelEl);
  }

  for (const p of panels) {
    const tab = document.createElement('div');
    tab.className = 'dbg-tab';
    tab.dataset.id = p.id;
    tab.textContent = p.label;
    tab.addEventListener('click', () => setActive(p.id));
    tabsEl.appendChild(tab);
  }
  if (panels.length) setActive(panels[0].id);

  function show() { root.style.display = 'block'; }
  function hide() { root.style.display = 'none'; }
  function toggle() { root.style.display = root.style.display === 'none' ? 'block' : 'none'; }
  // ~ (Backquote) and F1.
  window.addEventListener('keydown', e => {
    if (e.code === 'Backquote' || e.code === 'F1') {
      e.preventDefault();
      toggle();
    }
  });

  return { show, hide, toggle, setActive, root };
}

/**
 * Helper: build a slider row inside a panel container.
 *   panelRow(parent, { label, value, min, max, step, format, onInput })
 */
export function panelRow(parent, opts) {
  const { label, value, min, max, step = 0.01, format = v => v.toFixed(2), onInput } = opts;
  const row = document.createElement('div');
  row.className = 'dbg-row';
  const labelEl = document.createElement('div');
  labelEl.className = 'dbg-label';
  labelEl.innerHTML = `<span>${label}</span><span class="dbg-val">${format(value)}</span>`;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'dbg-slider';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);
  const valEl = labelEl.querySelector('.dbg-val');
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    valEl.textContent = format(v);
    onInput(v);
  });
  row.appendChild(labelEl);
  row.appendChild(slider);
  parent.appendChild(row);
  return { row, slider, set value(v) { slider.value = String(v); valEl.textContent = format(v); } };
}

export function panelButton(parent, label, onClick) {
  const btn = document.createElement('button');
  btn.className = 'dbg-button';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  parent.appendChild(btn);
  return btn;
}

export function panelColor(parent, opts) {
  const { label, value, onInput } = opts;
  const row = document.createElement('div');
  row.className = 'dbg-row';
  const labelEl = document.createElement('div');
  labelEl.className = 'dbg-label';
  labelEl.innerHTML = `<span>${label}</span><span class="dbg-val">${value}</span>`;
  const input = document.createElement('input');
  input.type = 'color';
  input.className = 'dbg-color';
  input.value = value;
  const valEl = labelEl.querySelector('.dbg-val');
  input.addEventListener('input', () => {
    valEl.textContent = input.value;
    onInput(input.value);
  });
  row.appendChild(labelEl);
  row.appendChild(input);
  parent.appendChild(row);
  return { row, input, set value(v) { input.value = v; valEl.textContent = v; } };
}
