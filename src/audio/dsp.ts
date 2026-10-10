/**
 * Offline sound-building toolkit. Every sample and sound effect in the game is synthesized ONCE at
 * load time inside an OfflineAudioContext (rendered off the main thread), so playback at runtime is
 * just "buffer → gain → pan" — cheap, glitch-free, and free to use heavy layering and processing.
 */

export const SR = 44100;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

function offlineCtor(): OfflineCtor | null {
  // The prefixed WebKit version (Safari < 14.1) has no promise-based startRendering and no
  // StereoPannerNode, so those browsers simply run without sound rather than half-working.
  const g = globalThis as unknown as { OfflineAudioContext?: OfflineCtor; StereoPannerNode?: unknown };
  return g.OfflineAudioContext && g.StereoPannerNode ? g.OfflineAudioContext : null;
}

export const canRender = () => offlineCtor() !== null;

/** Render `seconds` of audio produced by `build`, which wires its graph into `out` starting at t = 0. */
export async function render(seconds: number, channels: 1 | 2, build: (ctx: OfflineAudioContext, out: AudioNode) => void): Promise<AudioBuffer> {
  const Ctor = offlineCtor();
  if (!Ctor) throw new Error('OfflineAudioContext unavailable');
  const ctx = new Ctor(channels, Math.max(1, Math.ceil(seconds * SR)), SR);
  build(ctx, ctx.destination);
  return ctx.startRendering();
}

// ------------------------------------------------------------------ shared raw material

let rngState = 0x9e3779b9;
/** Deterministic PRNG so every load renders identical sounds. */
export function rand() {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function reseed(seed: number) {
  rngState = seed >>> 0;
}


const noiseCache = new Map<string, AudioBuffer>();

/** 3 s of white / pink / brown noise, shared by every render (AudioBuffers are context-independent). */
export function noiseBuffer(ctx: BaseAudioContext, color: 'white' | 'pink' | 'brown' = 'white'): AudioBuffer {
  const key = `${color}:${ctx.sampleRate}`;
  let b = noiseCache.get(key);
  if (b) return b;
  const len = Math.floor(ctx.sampleRate * 3);
  b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  reseed(color === 'white' ? 11 : color === 'pink' ? 23 : 37);
  fillNoise(d, color);
  noiseCache.set(key, b);
  return b;
}

function fillNoise(d: Float32Array, color: 'white' | 'pink' | 'brown') {
  const len = d.length;
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    b3 = 0,
    b4 = 0,
    b5 = 0,
    b6 = 0,
    last = 0;
  for (let i = 0; i < len; i++) {
    const w = rand() * 2 - 1;
    if (color === 'white') d[i] = w;
    else if (color === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
}

/** Raw stereo reverb tail: decorrelated, darkening noise (unnormalized). */
function impulseTail(sampleRate: number, seconds: number, decay: number, damp: number): [Float32Array, Float32Array] {
  const len = Math.max(1, Math.floor(sampleRate * seconds));
  const pre = Math.floor(sampleRate * 0.008);
  const out: [Float32Array, Float32Array] = [new Float32Array(len), new Float32Array(len)];
  reseed(Math.round(seconds * 1000 + decay * 77));
  for (const d of out) {
    let lp = 0;
    // the decay curve is evaluated every 32 samples and interpolated: pow() per sample is the slow part
    let env = 1;
    let next = 1;
    for (let i = pre; i < len; i++) {
      if ((i - pre) % 32 === 0) {
        env = Math.pow(1 - i / len, decay);
        next = Math.pow(Math.max(0, 1 - Math.min(len, i + 32) / len), decay);
      }
      const p = i / len;
      // the tail gets darker as it decays, like real air absorption
      const k = damp + (1 - damp) * (1 - p) * 0.9;
      lp += k * (rand() * 2 - 1 - lp);
      d[i] = lp * (env + ((next - env) * ((i - pre) % 32)) / 32);
    }
  }
  return out;
}

/** cached impulses, with the random-generator state their generation leaves behind */
const impulseCache = new Map<string, { buffer: AudioBuffer; rng: number }>();

/** Free the impulses cached while the library renders. */
export function clearImpulseCache() {
  impulseCache.clear();
}

/** Stereo reverb impulse: decorrelated, darkening noise tail (cached while the library renders). */
export function impulse(ctx: BaseAudioContext, seconds: number, decay = 3, damp = 0.35): AudioBuffer {
  const key = `${ctx.sampleRate}:${seconds}:${decay}:${damp}`;
  const hit = impulseCache.get(key);
  if (hit) {
    // a cache hit must leave the generator exactly where generating would have: sounds stay identical
    rngState = hit.rng;
    return hit.buffer;
  }
  const [l, r] = impulseTail(ctx.sampleRate, seconds, decay, damp);
  const b = ctx.createBuffer(2, l.length, ctx.sampleRate);
  b.getChannelData(0).set(l);
  b.getChannelData(1).set(r);
  impulseCache.set(key, { buffer: b, rng: rngState });
  return b;
}

const curves = new Map<number, Float32Array>();

/** Smooth tanh saturation curve — adds harmonics so low end is audible on small speakers. */
export function satCurve(drive: number): Float32Array {
  const key = Math.round(drive * 100);
  let c = curves.get(key);
  if (c) return c;
  const n = 2048;
  c = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * drive) / norm;
  }
  curves.set(key, c);
  return c;
}

// ------------------------------------------------------------------ graph helpers

export interface Env {
  /** attack seconds */
  a?: number;
  /** hold seconds at peak */
  h?: number;
  /** decay seconds (to silence, or to `sus` when given) */
  d: number;
  peak?: number;
  sus?: number;
  /** if `sus` is set: how long to sustain before the release */
  hold?: number;
  r?: number;
}

/** Schedule an envelope on a gain param starting at `t`; returns the end time. */
export function envelope(p: AudioParam, t: number, e: Env): number {
  const a = e.a ?? 0.002;
  const peak = e.peak ?? 1;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  let tt = t + a + (e.h ?? 0);
  p.setValueAtTime(peak, tt);
  if (e.sus !== undefined) {
    p.setTargetAtTime(e.sus * peak, tt, e.d / 3);
    tt += e.d + (e.hold ?? 0);
    p.setTargetAtTime(0, tt, (e.r ?? 0.1) / 5);
    return tt + (e.r ?? 0.1);
  }
  // time constant d/5: ~-43 dB by the end time, so stopping the source there is inaudible
  p.setTargetAtTime(0, tt, e.d / 5);
  return tt + e.d;
}

export function gainNode(ctx: BaseAudioContext, v: number, dest?: AudioNode) {
  const g = ctx.createGain();
  g.gain.value = v;
  if (dest) g.connect(dest);
  return g;
}

export function filter(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q = 0.7, dest?: AudioNode) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  if (dest) f.connect(dest);
  return f;
}

export function sat(ctx: BaseAudioContext, drive: number, dest?: AudioNode) {
  const s = ctx.createWaveShaper();
  s.curve = satCurve(drive) as Float32Array<ArrayBuffer>;
  s.oversample = '4x';
  if (dest) s.connect(dest);
  return s;
}

export function panner(ctx: BaseAudioContext, pan: number, dest?: AudioNode) {
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  if (dest) p.connect(dest);
  return p;
}

/** Sweep a param exponentially from `from` to `to` over `dur` (values must be > 0). */
export function sweep(p: AudioParam, t: number, from: number, to: number, dur: number) {
  p.setValueAtTime(from, t);
  p.exponentialRampToValueAtTime(Math.max(1e-4, to), t + Math.max(0.001, dur));
}

export interface ToneSpec {
  type?: OscillatorType;
  f: number;
  /** pitch sweep target and time */
  to?: number;
  glide?: number;
  detune?: number;
  env: Env;
  t?: number;
}

/** One oscillator with a pitch sweep and amp envelope. */
export function tone(ctx: BaseAudioContext, dest: AudioNode, s: ToneSpec) {
  const t = s.t ?? 0;
  const o = ctx.createOscillator();
  o.type = s.type ?? 'sine';
  if (s.to !== undefined) sweep(o.frequency, t, s.f, s.to, s.glide ?? s.env.d);
  else o.frequency.value = s.f;
  if (s.detune) o.detune.value = s.detune;
  const g = ctx.createGain();
  const end = envelope(g.gain, t, s.env);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(end + 0.05);
  return o;
}

export interface NoiseSpec {
  color?: 'white' | 'pink' | 'brown';
  type?: BiquadFilterType;
  f?: number;
  to?: number;
  glide?: number;
  q?: number;
  env: Env;
  t?: number;
  /** offset into the noise buffer, so stacked layers decorrelate */
  offset?: number;
}

/** Filtered noise burst with optional filter sweep. */
export function noise(ctx: BaseAudioContext, dest: AudioNode, s: NoiseSpec) {
  const t = s.t ?? 0;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, s.color ?? 'white');
  const g = ctx.createGain();
  const end = envelope(g.gain, t, s.env);
  if (s.type) {
    const f = filter(ctx, s.type, s.f ?? 1000, s.q ?? 0.7);
    if (s.to !== undefined) sweep(f.frequency, t, s.f ?? 1000, s.to, s.glide ?? s.env.d);
    src.connect(f);
    f.connect(g);
  } else {
    src.connect(g);
  }
  g.connect(dest);
  src.start(t, s.offset ?? rand() * 2);
  src.stop(end + 0.05);
  return src;
}

/**
 * Inharmonic metallic ring (bell / armor clank) from a few decaying sine partials.
 * `ratios` are multiples of `f`.
 */
export function metal(ctx: BaseAudioContext, dest: AudioNode, f: number, ratios: number[], decay: number, peak: number, t = 0) {
  ratios.forEach((r, i) => {
    tone(ctx, dest, { f: f * r, env: { d: decay * (1 - i * 0.12), peak: peak / (1 + i * 0.6) }, t });
  });
}

/** Simple FM voice: sine carrier modulated by a sine at `ratio`, index sweeping from i0 to i1. */
export function fm(ctx: BaseAudioContext, dest: AudioNode, f: number, ratio: number, i0: number, i1: number, env: Env, t = 0) {
  const car = ctx.createOscillator();
  car.frequency.value = f;
  const mod = ctx.createOscillator();
  mod.frequency.value = f * ratio;
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(f * i0, t);
  depth.gain.exponentialRampToValueAtTime(Math.max(0.01, f * i1), t + env.d);
  mod.connect(depth).connect(car.frequency);
  const g = ctx.createGain();
  const end = envelope(g.gain, t, env);
  car.connect(g).connect(dest);
  car.start(t);
  mod.start(t);
  car.stop(end + 0.05);
  mod.stop(end + 0.05);
}

export function reverb(ctx: BaseAudioContext, dest: AudioNode, seconds: number, wet: number, decay = 3) {
  const c = ctx.createConvolver();
  c.buffer = impulse(ctx, seconds, decay);
  const g = gainNode(ctx, wet, dest);
  c.connect(g);
  return c;
}

// ------------------------------------------------------------------ post-processing (plain sample math)

/** RBJ biquad, applied in place. */
function biquad(d: Float32Array, b0: number, b1: number, b2: number, a0: number, a1: number, a2: number) {
  // normalize once instead of dividing every sample
  b0 /= a0;
  b1 /= a0;
  b2 /= a0;
  a1 /= a0;
  a2 /= a0;
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < d.length; i++) {
    const x = d[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    d[i] = y;
  }
}

/**
 * Perceived-loudness weighting (in the spirit of ITU BS.1770's K-weighting, tuned for small
 * speakers): a 90 Hz high-pass plus a +4 dB presence shelf above 1.5 kHz. Sub-bass the listener
 * can't hear on a phone stops counting toward "loud".
 */
function weighted(src: Float32Array, rate: number) {
  const d = new Float32Array(src);
  let w0 = (2 * Math.PI * 90) / rate;
  let cw = Math.cos(w0);
  let al = Math.sin(w0) / (2 * 0.7);
  biquad(d, (1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + al, -2 * cw, 1 - al);
  const A = Math.pow(10, 4 / 40);
  w0 = (2 * Math.PI * 1500) / rate;
  cw = Math.cos(w0);
  al = (Math.sin(w0) / 2) * Math.sqrt(2);
  const sq = 2 * Math.sqrt(A) * al;
  biquad(
    d,
    A * (A + 1 + (A - 1) * cw + sq),
    -2 * A * (A - 1 + (A + 1) * cw),
    A * (A + 1 + (A - 1) * cw - sq),
    A + 1 - (A - 1) * cw + sq,
    2 * (A - 1 - (A + 1) * cw),
    A + 1 - (A - 1) * cw - sq,
  );
  return d;
}

/**
 * Loudness proxy: RMS of the loudest 300 ms window, in dB (all channels) — perceptually weighted
 * for sound effects, flat for instrument samples (whose balance is set by the song mix).
 */
export function loudness(b: AudioBuffer, perceptual = true) {
  const w = Math.min(b.length, Math.floor(b.sampleRate * 0.3));
  let best = 0;
  for (let ch = 0; ch < b.numberOfChannels; ch++) {
    const d = perceptual ? weighted(b.getChannelData(ch), b.sampleRate) : b.getChannelData(ch);
    let acc = 0;
    for (let i = 0; i < w; i++) acc += d[i] * d[i];
    best = Math.max(best, acc);
    for (let i = w; i < d.length; i++) {
      acc += d[i] * d[i] - d[i - w] * d[i - w];
      if (acc > best) best = acc;
    }
  }
  return 10 * Math.log10(best / w + 1e-12);
}

export function peak(b: AudioBuffer) {
  let p = 0;
  for (let ch = 0; ch < b.numberOfChannels; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i]);
      if (v > p) p = v;
    }
  }
  return p;
}

/**
 * Scale a buffer so its loudness proxy hits `targetDb`, soft-limiting any peaks the gain would push
 * past -0.5 dBFS. Keeps every sound in a category equally loud no matter how it was synthesized.
 */
export function calibrate(b: AudioBuffer, targetDb: number, perceptual = true) {
  const k = Math.pow(10, (targetDb - loudness(b, perceptual)) / 20);
  const ceil = 0.944;
  for (let ch = 0; ch < b.numberOfChannels; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const v = d[i] * k;
      d[i] = Math.abs(v) <= ceil * 0.7 ? v : Math.sign(v) * (ceil * 0.7 + ceil * 0.3 * Math.tanh((Math.abs(v) - ceil * 0.7) / (ceil * 0.3)));
    }
  }
}

export function makeBuffer(channels: number, length: number, rate: number): AudioBuffer {
  return new AudioBuffer({ numberOfChannels: channels, length, sampleRate: rate });
}

/** Trim trailing near-silence (keeps buffers small). */
export function trim(b: AudioBuffer, threshold = 0.0006): AudioBuffer {
  let last = 0;
  for (let ch = 0; ch < b.numberOfChannels; ch++) {
    const d = b.getChannelData(ch);
    for (let i = d.length - 1; i > last; i--) {
      if (Math.abs(d[i]) > threshold) {
        last = i;
        break;
      }
    }
  }
  const len = Math.min(b.length, last + Math.floor(b.sampleRate * 0.02));
  if (len >= b.length - 32) return b;
  const out = makeBuffer(b.numberOfChannels, len, b.sampleRate);
  for (let ch = 0; ch < b.numberOfChannels; ch++) {
    const src = b.getChannelData(ch).subarray(0, len);
    const dst = out.getChannelData(ch);
    dst.set(src);
    // short fade so the cut is silent
    const f = Math.min(len, Math.floor(b.sampleRate * 0.015));
    for (let i = 0; i < f; i++) dst[len - 1 - i] *= i / f;
  }
  return out;
}

/**
 * Make [start, end) loop seamlessly: the first `xfade` seconds of the loop are replaced by a blend
 * that begins as the material just past `end` (what naturally follows the loop's last sample) and
 * ends as the original start. The buffer must extend at least `xfade` past `end`.
 */
export function makeLoop(b: AudioBuffer, start: number, end: number, xfade: number) {
  const s = Math.floor(start * b.sampleRate);
  const e = Math.floor(end * b.sampleRate);
  const x = Math.min(Math.floor(xfade * b.sampleRate), b.length - e);
  for (let ch = 0; ch < b.numberOfChannels; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < x; i++) {
      const k = i / x;
      d[s + i] = d[s + i] * Math.sin((k * Math.PI) / 2) + d[e + i] * Math.cos((k * Math.PI) / 2);
    }
  }
}
