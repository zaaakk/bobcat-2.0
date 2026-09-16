import { asset } from '../assetPath.js';
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
    // doesn't read as ocean churn.
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(12.0, 'white');
    src.loop = true;

    // The OUTER gain holds the on/off envelope (long stretches of silence
    // alternating with audible gusts). The INNER 'voice' gain hosts the slow
    // amplitude LFO so within each "on" stretch the wind still breathes.
    const outer = c.createGain();
    outer.gain.value = 0.0;
    outer.connect(busGain);

    // Cut everything below ~900 Hz and let the noise sing in 1-6 kHz so it
    // reads as dry, high air-flow rather than mid-range "leaves blowing".
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 900; hp.Q.value = 0.4;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 5800; lp.Q.value = 0.3;
    // A small lift in the very high band (~3.5 kHz) so the whisper has a touch
    // of bite, not a smooth pillow.
    const tilt = c.createBiquadFilter();
    tilt.type = 'highshelf'; tilt.frequency.value = 3200; tilt.gain.value = 3;

    const voice = c.createGain();
    voice.gain.value = 0.55;
    src.connect(hp).connect(lp).connect(tilt).connect(voice).connect(outer);

    // Slow gust LFO (when wind is on).
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = c.createGain();
    lfoGain.gain.value = 0.18;
    lfo.connect(lfoGain).connect(voice.gain);
    lfo.start();
    src.start();

    // Long-form on/off scheduler: pick a random "on" stretch (15–45 s) and
    // "off" stretch (10–30 s), fade in and out smoothly between them.
    function scheduleNext(now) {
      const onDur  = 15 + Math.random() * 30;
      const offDur = 10 + Math.random() * 20;
      const fadeIn  = 2.0 + Math.random() * 2.0;
      const fadeOut = 3.0 + Math.random() * 3.0;
      const target = 0.10;
      outer.gain.cancelScheduledValues(now);
      outer.gain.setValueAtTime(outer.gain.value, now);
      outer.gain.linearRampToValueAtTime(target, now + fadeIn);
      outer.gain.linearRampToValueAtTime(target, now + onDur - fadeOut);
      outer.gain.linearRampToValueAtTime(0.0, now + onDur);
      const total = onDur + offDur;
      setTimeout(() => scheduleNext(c.currentTime), total * 1000);
    }
    scheduleNext(c.currentTime + 0.5);

    return { src, outer };
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
  let eatBuffer = null;
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
    // Try mp3 first (drop-in convention); ogg fallback keeps the door open
    // for higher-quality replacements without forcing a re-export.
    async function loadFirst(name, urls) {
      for (const u of urls) {
        const b = await tryLoad(name, u);
        if (b) return b;
      }
      return null;
    }
    const loads = await Promise.all([
      loadFirst('wind', [asset('audio/wind_open.mp3'), asset('audio/wind_open.ogg')]),
      loadFirst('cicadas', [asset('audio/cicadas_day.mp3'), asset('audio/cicadas_day.ogg')]),
      loadFirst('crickets', [asset('audio/crickets_night.mp3'), asset('audio/crickets_night.ogg')]),
      loadFirst('grass', [asset('audio/grass_rustle.mp3'), asset('audio/grass_rustle.ogg')]),
      loadFirst('fs1', [asset('audio/footstep_dirt_1.mp3'), asset('audio/footstep_dirt_1.ogg')]),
      loadFirst('fs2', [asset('audio/footstep_dirt_2.mp3'), asset('audio/footstep_dirt_2.ogg')]),
      loadFirst('fs3', [asset('audio/footstep_dirt_3.mp3'), asset('audio/footstep_dirt_3.ogg')]),
      loadFirst('coyote', [asset('audio/coyote_howl_distant.mp3'), asset('audio/coyote_howl_distant.ogg')]),
      loadFirst('hawk', [asset('audio/hawk_call_distant.mp3'), asset('audio/hawk_call_distant.ogg')]),
      loadFirst('owl', [asset('audio/owl_hoot_distant.mp3'), asset('audio/owl_hoot_distant.ogg')]),
      loadFirst('eat', [asset('audio/bobcat_eat.ogg')])
    ]);
    const [wind, cicadas, crickets, grass, fs1, fs2, fs3, coyote, hawk, owl, eat] = loads;
    eatBuffer = eat;

    // Wind bed: real file if present, else synth bed.
    if (wind) {
      // Real wind file — apply the same on/off scheduler so even the
      // dropped-in recording fades out for 10-30 s stretches and back in.
      const src = ctx.createBufferSource();
      src.buffer = wind; src.loop = true;
      const outer = ctx.createGain();
      outer.gain.value = 0;
      src.connect(outer).connect(master);
      src.start();
      const peakLevel = 0.22;  // real recording → can sit a touch louder than the synth bed
      function scheduleNext(now) {
        const onDur  = 15 + Math.random() * 30;
        const offDur = 10 + Math.random() * 20;
        const fadeIn  = 2.0 + Math.random() * 2.0;
        const fadeOut = 3.0 + Math.random() * 3.0;
        outer.gain.cancelScheduledValues(now);
        outer.gain.setValueAtTime(outer.gain.value, now);
        outer.gain.linearRampToValueAtTime(peakLevel, now + fadeIn);
        outer.gain.linearRampToValueAtTime(peakLevel, now + onDur - fadeOut);
        outer.gain.linearRampToValueAtTime(0.0, now + onDur);
        setTimeout(() => scheduleNext(ctx.currentTime), (onDur + offDur) * 1000);
      }
      scheduleNext(ctx.currentTime + 0.5);
    } else {
      startWindBed(master);
    }

    // Day vs night insect beds, cross-faded by setDayMix().
    // Procedural cricket synth was a constant high-pitched whine — we leave
    // the bus silent unless a real recording is provided.
    if (cicadas) {
      const src = ctx.createBufferSource();
      src.buffer = cicadas; src.loop = true;
      const g = ctx.createGain(); g.gain.value = 0.28;
      src.connect(g).connect(dayBus);
      src.start();
    }
    if (crickets) {
      const src = ctx.createBufferSource();
      src.buffer = crickets; src.loop = true;
      const g = ctx.createGain(); g.gain.value = 0.32;
      src.connect(g).connect(nightBus);
      src.start();
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

  // One-shot for a prey kill: low body-thump + a sharp bite snap + a short
  // wet squelch. All procedural (same as the fallback footstep) so it works
  // without any sound file. Layer timings staggered a few ms so it reads as
  // one impact, not three sounds.
  function kill() {
    if (!ctx) return;
    const now = ctx.currentTime;

    // 1. Thump — sine pitch-drop, the body hitting the ground.
    {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(110, now);
      osc.frequency.exponentialRampToValueAtTime(42, now + 0.16);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0, now);
      env.gain.linearRampToValueAtTime(0.5, now + 0.012);
      env.gain.exponentialRampToValueAtTime(0.001, now + 0.30);
      osc.connect(env).connect(master);
      osc.start(now);
      osc.stop(now + 0.32);
    }

    // 2. Snap — tight band-passed noise click, the bite itself.
    {
      const buf = noiseBuffer(0.06, 'pink');
      if (buf) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 1.2;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0, now + 0.015);
        env.gain.linearRampToValueAtTime(0.45, now + 0.022);
        env.gain.exponentialRampToValueAtTime(0.001, now + 0.075);
        src.connect(bp).connect(env).connect(master);
        src.start(now + 0.015);
        src.stop(now + 0.09);
      }
    }

    // 3. Squelch — low-passed brown noise tail.
    {
      const buf = noiseBuffer(0.28, 'brown');
      if (buf) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 650;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0, now + 0.03);
        env.gain.linearRampToValueAtTime(0.28, now + 0.06);
        env.gain.exponentialRampToValueAtTime(0.001, now + 0.34);
        src.connect(lp).connect(env).connect(master);
        src.start(now + 0.03);
        src.stop(now + 0.36);
      }
    }
  }

  // Bobcat snarl/feeding vocal — pre-trimmed to 3s with a baked fade-out
  // (public/assets/audio/bobcat_eat.ogg). Played at the kill, slightly after
  // the bite impact so the thump lands first.
  function eat() {
    if (!ctx || !eatBuffer) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = eatBuffer;
    const g = ctx.createGain();
    g.gain.value = 0.5;
    src.connect(g).connect(master);
    src.start(now + 0.22);
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

  return { start, footstep, kill, eat, setDayMix, tick };
}
