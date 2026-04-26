/**
 * Ambient + interactive audio layer.
 *
 * The system has four channels:
 *   - WIND      : steady open-land wind, looped
 *   - INSECTS   : day cicadas / night crickets, looped
 *   - DISTANT   : occasional scheduled animal calls
 *   - FOOTSTEPS : triggered by bobcat gait
 *
 * Files are loaded from /public/assets/audio/. Any missing file is replaced by
 * a procedural fallback (filtered noise / synthesised cricket etc.) so the
 * scene still has a soundscape even before the asset folder is populated.
 *
 * To use real recordings, drop CC0/CC-BY files at:
 *   public/assets/audio/wind_open.ogg
 *   public/assets/audio/cicadas_day.ogg
 *   public/assets/audio/crickets_night.ogg
 *   public/assets/audio/grass_rustle.ogg
 *   public/assets/audio/footstep_dirt_1.ogg
 *   public/assets/audio/footstep_dirt_2.ogg
 *   public/assets/audio/footstep_dirt_3.ogg
 *   public/assets/audio/coyote_howl_distant.ogg
 *   public/assets/audio/hawk_call_distant.ogg
 *   public/assets/audio/owl_hoot_distant.ogg
 *
 * Recommended sources: freesound.org (search "open desert wind", "crickets
 * night", "footsteps dirt", "coyote howl") and the BBC Sound Effects archive
 * (sound-effects.bbcrewind.co.uk — pick CC-BY entries).
 */
export function createAudio() {
  let ctx = null;
  let master = null;
  let dayBus = null;
  let nightBus = null;

  // Lazy init on first user gesture (browsers gate AudioContext).
  function ensureCtx() {
    if (ctx) return ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
    dayBus = ctx.createGain();
    nightBus = ctx.createGain();
    dayBus.gain.value = 1;
    nightBus.gain.value = 0;
    dayBus.connect(master);
    nightBus.connect(master);
    return ctx;
  }

  // Resume after gesture (autoplay policy).
  function unlock() {
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }
  ['pointerdown', 'keydown'].forEach(ev =>
    window.addEventListener(ev, () => { ensureCtx(); unlock(); }, { once: false })
  );

  // ---------- file loading ----------
  const buffers = new Map();
  async function tryLoad(name, url) {
    if (!ctx) ensureCtx();
    if (!ctx) return null;
    if (buffers.has(name)) return buffers.get(name);
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const arr = await res.arrayBuffer();
      const buf = await ctx.decodeAudioData(arr);
      buffers.set(name, buf);
      return buf;
    } catch (_) {
      return null;
    }
  }

  // ---------- procedural fallbacks ----------
  function noiseBuffer(duration, type = 'brown') {
    const c = ensureCtx();
    if (!c) return null;
    const len = Math.floor(duration * c.sampleRate);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (type === 'brown') {
        last = (last + 0.018 * w) / 1.018;
        d[i] = last * 3.5;
      } else if (type === 'pink') {
        last = 0.99 * last + 0.1 * w;
        d[i] = last;
      } else {
        d[i] = w;
      }
    }
    return buf;
  }

  function startWindBed(busGain) {
    const c = ensureCtx();
    if (!c) return null;

    // Dry desert wind: white-noise base, mid frequencies notched out so it
    // doesn't read as ocean churn. A high-shelf cut and a low-pass at 1.6 kHz
    // give the airy, dusty character; one slow LFO modulates a single voice
    // so gusts are gentle, not breathy. Quiet by default — this is bed, not
    // foreground.
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(12.0, 'white');
    src.loop = true;

    const overall = c.createGain();
    overall.gain.value = 0.10;            // ← much quieter than before
    overall.connect(busGain);

    // Cut the muddy low-mids that made it feel like surf.
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 350; hp.Q.value = 0.5;
    const notch = c.createBiquadFilter();
    notch.type = 'peaking'; notch.frequency.value = 700; notch.Q.value = 0.9; notch.gain.value = -8;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1600; lp.Q.value = 0.4;

    const voice = c.createGain();
    voice.gain.value = 0.55;
    src.connect(hp).connect(notch).connect(lp).connect(voice).connect(overall);

    // One unhurried gust LFO — not three layered ones.
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = c.createGain();
    lfoGain.gain.value = 0.18;
    lfo.connect(lfoGain).connect(voice.gain);
    lfo.start();

    src.start();
    return { src, overall };
  }

  function startCricketLayer(busGain, baseFreq, rateHz) {
    const c = ensureCtx();
    if (!c) return null;
    const out = c.createGain();
    out.gain.value = 0.0;
    out.connect(busGain);
    let cancelled = false;

    function chirp() {
      if (cancelled || !c) return;
      const osc = c.createOscillator();
      const env = c.createGain();
      osc.type = 'triangle';
      osc.frequency.value = baseFreq * (0.95 + Math.random() * 0.1);
      env.gain.setValueAtTime(0, c.currentTime);
      env.gain.linearRampToValueAtTime(0.025, c.currentTime + 0.005);
      env.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.06);
      osc.connect(env).connect(out);
      osc.start();
      osc.stop(c.currentTime + 0.07);
      const next = (1000 / rateHz) * (0.6 + Math.random() * 0.8);
      setTimeout(chirp, next);
    }
    setTimeout(chirp, Math.random() * 200);
    out.gain.linearRampToValueAtTime(0.5, c.currentTime + 4);
    return { gain: out, stop() { cancelled = true; } };
  }

  // ---------- public API ----------
  let footstepNames = [];
  let distantCallNames = [];
  let started = false;
  let lastFootstepAt = 0;
  let nextDistantCallAt = 0;
  let dayMix = 1.0;

  async function start() {
    if (started) return;
    started = true;
    ensureCtx();
    if (!ctx) return;

    // Try real files; whichever load become layered, the rest fall back to synth.
    const loads = await Promise.all([
      tryLoad('wind', '/assets/audio/wind_open.ogg'),
      tryLoad('cicadas', '/assets/audio/cicadas_day.ogg'),
      tryLoad('crickets', '/assets/audio/crickets_night.ogg'),
      tryLoad('grass', '/assets/audio/grass_rustle.ogg'),
      tryLoad('fs1', '/assets/audio/footstep_dirt_1.ogg'),
      tryLoad('fs2', '/assets/audio/footstep_dirt_2.ogg'),
      tryLoad('fs3', '/assets/audio/footstep_dirt_3.ogg'),
      tryLoad('coyote', '/assets/audio/coyote_howl_distant.ogg'),
      tryLoad('hawk', '/assets/audio/hawk_call_distant.ogg'),
      tryLoad('owl', '/assets/audio/owl_hoot_distant.ogg')
    ]);
    const [wind, cicadas, crickets, grass, fs1, fs2, fs3, coyote, hawk, owl] = loads;

    // Wind bed: real file if present, else synth bed.
    if (wind) {
      const src = ctx.createBufferSource();
      src.buffer = wind; src.loop = true;
      const g = ctx.createGain(); g.gain.value = 0.16;   // bed-volume, not foreground
      src.connect(g).connect(master);
      src.start();
    } else {
      startWindBed(master);
    }

    // Day vs night insect beds, cross-faded by setDayMix().
    if (cicadas) {
      const src = ctx.createBufferSource();
      src.buffer = cicadas; src.loop = true;
      const g = ctx.createGain(); g.gain.value = 0.28;
      src.connect(g).connect(dayBus);
      src.start();
    } else {
      startCricketLayer(dayBus, 5200, 18); // cicada-ish: high & rapid
    }
    if (crickets) {
      const src = ctx.createBufferSource();
      src.buffer = crickets; src.loop = true;
      const g = ctx.createGain(); g.gain.value = 0.32;
      src.connect(g).connect(nightBus);
      src.start();
    } else {
      startCricketLayer(nightBus, 4400, 6); // cricket-ish: lower & sparser
    }

    if (grass) {
      // A second wind variant lightly mixed in — adds grass-rustle character.
      const src = ctx.createBufferSource();
      src.buffer = grass; src.loop = true;
      const g = ctx.createGain(); g.gain.value = 0.18;
      src.connect(g).connect(master);
      src.start();
    }

    footstepNames = [fs1, fs2, fs3].filter(Boolean).map((b, i) => ({ buffer: b }));
    distantCallNames = [coyote, hawk, owl].filter(Boolean).map(b => ({ buffer: b }));
  }

  function setDayMix(t) {
    // t in [0..1], 0 = night, 1 = day.
    dayMix = t;
    if (!ctx) return;
    const now = ctx.currentTime;
    dayBus.gain.cancelScheduledValues(now);
    nightBus.gain.cancelScheduledValues(now);
    dayBus.gain.setTargetAtTime(t, now, 0.6);
    nightBus.gain.setTargetAtTime(1 - t, now, 0.6);
  }

  function footstep(speedT = 1) {
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - lastFootstepAt < 0.21) return; // rate-limit
    lastFootstepAt = now;
    if (footstepNames.length) {
      const pick = footstepNames[(Math.random() * footstepNames.length) | 0];
      const src = ctx.createBufferSource();
      src.buffer = pick.buffer;
      src.playbackRate.value = 0.92 + Math.random() * 0.16;
      const g = ctx.createGain();
      g.gain.value = 0.22 + speedT * 0.18;
      src.connect(g).connect(master);
      src.start(now);
    } else {
      // Procedural footstep: short noise burst, low-pass, fast envelope.
      const dur = 0.10;
      const buf = noiseBuffer(dur, 'pink');
      if (!buf) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 1500 + Math.random() * 600;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0, now);
      env.gain.linearRampToValueAtTime(0.32 + speedT * 0.18, now + 0.005);
      env.gain.exponentialRampToValueAtTime(0.001, now + dur);
      src.connect(lp).connect(env).connect(master);
      src.start(now);
      src.stop(now + dur);
    }
  }

  function tick(timeSec) {
    if (!ctx || !started) return;
    if (timeSec >= nextDistantCallAt && distantCallNames.length && Math.random() < 0.85) {
      const pick = distantCallNames[(Math.random() * distantCallNames.length) | 0];
      const src = ctx.createBufferSource();
      src.buffer = pick.buffer;
      src.playbackRate.value = 0.95 + Math.random() * 0.1;
      const g = ctx.createGain();
      g.gain.value = 0.18;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 1800; // distance attenuation
      src.connect(lp).connect(g).connect(master);
      src.start();
    }
    if (timeSec >= nextDistantCallAt) {
      // 35-90s between calls.
      nextDistantCallAt = timeSec + 35 + Math.random() * 55;
    }
  }

  return { start, footstep, setDayMix, tick };
}
