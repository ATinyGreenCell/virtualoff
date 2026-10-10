/**
 * The music instrument library: every instrument is synthesized once, offline, into a sample.
 * The sequencer then plays samples at any pitch via playbackRate (2 nodes per note), so the band
 * can afford fat unison supersaws, saturation and filter envelopes for free at runtime.
 */
import {
  envelope,
  filter,
  fm,
  gainNode,
  mtof,
  noise,
  panner,
  reverb,
  sat,
  sweep,
  tone,
  type Env,
} from './dsp';

export interface SampleDef {
  /** MIDI note the sample is rendered at (drums: the rate-1 reference) */
  root: number;
  seconds: number;
  stereo?: boolean;
  /** loudness the rendered sample is calibrated to (dB, loudest-300 ms RMS) */
  level: number;
  build(ctx: OfflineAudioContext, out: AudioNode, f: number): void;
}

/** 808-style metallic cluster: six detuned squares, the classic hi-hat / cymbal source. */
function metallic(ctx: BaseAudioContext, dest: AudioNode, env: Env, t = 0, scale = 1) {
  const g = ctx.createGain();
  const end = envelope(g.gain, t, env);
  g.connect(dest);
  for (const f of [205.3, 304.4, 369.6, 522.7, 540, 800]) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f * 1.7 * scale;
    const og = gainNode(ctx, 0.16, g);
    o.connect(og);
    o.start(t);
    o.stop(end + 0.05);
  }
}

/** Unison saw stack with stereo spread, all through one amp envelope. */
function unison(
  ctx: BaseAudioContext,
  dest: AudioNode,
  f: number,
  detunes: number[],
  spread: number,
  env: Env,
  type: OscillatorType = 'sawtooth',
  level = 0.2,
) {
  const amp = ctx.createGain();
  const end = envelope(amp.gain, 0, env);
  amp.connect(dest);
  detunes.forEach((d, i) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.detune.value = d;
    const pan = detunes.length > 1 ? (i / (detunes.length - 1)) * 2 - 1 : 0;
    const p = panner(ctx, pan * spread);
    const g = gainNode(ctx, level, p);
    o.connect(g);
    p.connect(amp);
    // staggered starts give each unison voice its own phase
    o.start(i * 0.0011);
    o.stop(end + 0.05);
  });
  return end;
}

/** Oscillator straight into a node (no own envelope) — for sources sharing one amp. */
function osc(ctx: BaseAudioContext, dest: AudioNode, type: OscillatorType, f: number, level: number, stop: number, detune = 0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = f;
  o.detune.value = detune;
  o.connect(gainNode(ctx, level, dest));
  o.start(0);
  o.stop(stop);
  return o;
}

function acid(cut: number): SampleDef {
  return {
    root: 36,
    seconds: 0.5,
    level: -13,
    build(ctx, out, f) {
      const s = sat(ctx, 2.6, filter(ctx, 'lowpass', 7000, 0.5, out));
      const lp2 = filter(ctx, 'lowpass', 2600, 0.9, s);
      const lp = filter(ctx, 'lowpass', cut, 13, lp2);
      sweep(lp.frequency, 0, cut, 230, 0.17);
      const amp = ctx.createGain();
      const end = envelope(amp.gain, 0, { a: 0.002, d: 0.1, sus: 0.75, hold: 0.22, r: 0.06 });
      amp.connect(lp);
      osc(ctx, amp, 'sawtooth', f, 0.8, end);
    },
  };
}

export const SAMPLES: Record<string, SampleDef> = {
  // ---------------------------------------------------------------- drums
  kick: {
    root: 36,
    seconds: 0.55,
    level: -9,
    build(ctx, out) {
      const lp = filter(ctx, 'lowpass', 8500, 0.5, out);
      const s = sat(ctx, 2.2, lp);
      tone(ctx, s, { f: 190, to: 50, glide: 0.075, env: { a: 0.001, h: 0.025, d: 0.36, peak: 1 } });
      // mid knock: what makes a kick read on laptop and phone speakers
      tone(ctx, s, { type: 'triangle', f: 160, to: 85, glide: 0.04, env: { a: 0.001, d: 0.07, peak: 0.6 } });
      noise(ctx, s, { type: 'highpass', f: 1800, env: { a: 0.0005, d: 0.011, peak: 0.45 } });
    },
  },
  snare: {
    root: 36,
    seconds: 0.45,
    level: -12,
    build(ctx, out) {
      const bus = gainNode(ctx, 1);
      bus.connect(sat(ctx, 1.6, out));
      bus.connect(reverb(ctx, out, 0.35, 0.16, 4));
      tone(ctx, bus, { type: 'triangle', f: 215, to: 178, glide: 0.05, env: { a: 0.001, d: 0.12, peak: 0.85 } });
      tone(ctx, bus, { f: 330, env: { a: 0.001, d: 0.05, peak: 0.3 } });
      noise(ctx, bus, { type: 'bandpass', f: 3800, q: 0.6, env: { a: 0.001, d: 0.2, peak: 0.85 } });
      noise(ctx, bus, { type: 'highpass', f: 6500, env: { a: 0.001, d: 0.08, peak: 0.25 } });
    },
  },
  clap: {
    root: 36,
    seconds: 0.5,
    level: -12,
    build(ctx, out) {
      const hp = filter(ctx, 'highpass', 520, 0.7);
      hp.connect(sat(ctx, 1.3, out));
      hp.connect(reverb(ctx, out, 0.5, 0.24, 3.5));
      const bp = filter(ctx, 'bandpass', 1250, 0.9, hp);
      for (const [t, pk] of [
        [0, 0.8],
        [0.011, 0.7],
        [0.023, 0.9],
      ])
        noise(ctx, bp, { t, env: { a: 0.0008, d: 0.012, peak: pk } });
      noise(ctx, bp, { t: 0.034, env: { a: 0.001, d: 0.2, peak: 0.9 } });
    },
  },
  hat: {
    root: 36,
    seconds: 0.14,
    level: -18,
    build(ctx, out) {
      const lp = filter(ctx, 'lowpass', 14000, 0.5, out);
      const hp = filter(ctx, 'highpass', 7200, 0.7, lp);
      metallic(ctx, hp, { a: 0.001, d: 0.05, peak: 1 });
      noise(ctx, hp, { env: { a: 0.001, d: 0.04, peak: 0.45 } });
    },
  },
  ohat: {
    root: 36,
    seconds: 0.5,
    level: -16,
    build(ctx, out) {
      const lp = filter(ctx, 'lowpass', 13500, 0.5, out);
      const hp = filter(ctx, 'highpass', 6800, 0.7, lp);
      metallic(ctx, hp, { a: 0.002, d: 0.34, peak: 1 });
      noise(ctx, hp, { env: { a: 0.002, d: 0.3, peak: 0.4 } });
    },
  },
  crash: {
    root: 36,
    seconds: 2.4,
    stereo: true,
    level: -16,
    build(ctx, out) {
      const lp = filter(ctx, 'lowpass', 12500, 0.5, out);
      const hp = filter(ctx, 'highpass', 4200, 0.6, lp);
      noise(ctx, panner(ctx, -0.6, hp), { env: { a: 0.002, d: 2.0, peak: 0.55 }, offset: 0.2 });
      noise(ctx, panner(ctx, 0.6, hp), { env: { a: 0.002, d: 2.0, peak: 0.55 }, offset: 1.4 });
      metallic(ctx, hp, { a: 0.002, d: 1.4, peak: 0.6 }, 0, 1.3);
    },
  },
  perc: {
    root: 36,
    seconds: 0.2,
    level: -16,
    build(ctx, out) {
      const bp = filter(ctx, 'bandpass', 1400, 1.2, out);
      tone(ctx, bp, { type: 'square', f: 830, env: { a: 0.001, d: 0.07, peak: 0.6 } });
      tone(ctx, bp, { type: 'square', f: 1250, env: { a: 0.001, d: 0.05, peak: 0.4 } });
      noise(ctx, out, { type: 'bandpass', f: 3000, env: { a: 0.0005, d: 0.006, peak: 0.3 } });
    },
  },
  tom: {
    root: 45,
    seconds: 0.5,
    level: -12,
    build(ctx, out, f) {
      const s = sat(ctx, 1.8, out);
      tone(ctx, s, { f: f * 1.35, to: f, glide: 0.09, env: { a: 0.001, d: 0.38, peak: 1 } });
      noise(ctx, s, { type: 'lowpass', f: 900, env: { a: 0.001, d: 0.05, peak: 0.4 } });
    },
  },
  riser: {
    root: 36,
    seconds: 4,
    stereo: true,
    level: -14,
    build(ctx, out) {
      const lp = filter(ctx, 'lowpass', 9000, 0.5, out);
      const env: Env = { a: 3.7, h: 0.05, d: 0.2, peak: 1 };
      noise(ctx, panner(ctx, -0.5, lp), { type: 'bandpass', f: 300, to: 7000, glide: 3.8, q: 3.5, env, offset: 0.1 });
      noise(ctx, panner(ctx, 0.5, lp), { type: 'bandpass', f: 320, to: 7400, glide: 3.8, q: 3.5, env, offset: 1.7 });
      const sl = filter(ctx, 'lowpass', 2500, 0.7, lp);
      tone(ctx, sl, { type: 'sawtooth', f: 110, to: 880, glide: 3.8, env: { ...env, peak: 0.35 } });
    },
  },
  impact: {
    root: 36,
    seconds: 2.6,
    stereo: true,
    level: -12,
    build(ctx, out) {
      const s = sat(ctx, 2, out);
      s.connect(reverb(ctx, out, 2, 0.35, 2.5));
      tone(ctx, s, { f: 68, to: 32, glide: 0.6, env: { a: 0.001, h: 0.05, d: 1.6, peak: 1 } });
      noise(ctx, s, { type: 'lowpass', f: 5000, to: 180, glide: 1.6, env: { a: 0.002, d: 2, peak: 0.6 } });
    },
  },

  // ---------------------------------------------------------------- bass
  bass: {
    root: 36,
    seconds: 0.9,
    level: -12,
    build(ctx, out, f) {
      const s = sat(ctx, 1.8, filter(ctx, 'lowpass', 6000, 0.5, out));
      const lp = filter(ctx, 'lowpass', 3200, 4.5, s);
      sweep(lp.frequency, 0, 3200, 640, 0.14);
      const amp = ctx.createGain();
      const end = envelope(amp.gain, 0, { a: 0.003, d: 0.08, sus: 0.75, hold: 0.55, r: 0.12 });
      amp.connect(lp);
      osc(ctx, amp, 'sawtooth', f, 0.6, end);
      osc(ctx, amp, 'square', f, 0.32, end, 6);
      osc(ctx, amp, 'sine', f, 0.55, end);
    },
  },
  bassFunk: {
    root: 36,
    seconds: 0.7,
    level: -12,
    build(ctx, out, f) {
      const s = sat(ctx, 2.2, filter(ctx, 'lowpass', 7000, 0.5, out));
      const lp = filter(ctx, 'lowpass', 7000, 3.5, s);
      sweep(lp.frequency, 0, 7000, 620, 0.07);
      const amp = ctx.createGain();
      const end = envelope(amp.gain, 0, { a: 0.002, d: 0.12, sus: 0.5, hold: 0.32, r: 0.1 });
      amp.connect(lp);
      osc(ctx, amp, 'sawtooth', f, 0.6, end);
      osc(ctx, amp, 'square', f * 2, 0.22, end);
      osc(ctx, amp, 'sine', f, 0.55, end);
      // the "slap": a bright transient on top of the note
      noise(ctx, s, { type: 'bandpass', f: 2600, q: 1.2, env: { a: 0.0005, d: 0.016, peak: 0.35 } });
      tone(ctx, s, { type: 'triangle', f: f * 4, env: { a: 0.001, d: 0.03, peak: 0.25 } });
    },
  },
  acid1: acid(900),
  acid2: acid(1900),
  acid3: acid(3400),
  sub: {
    root: 36,
    seconds: 1.1,
    level: -12,
    build(ctx, out, f) {
      const s = sat(ctx, 1.5, out);
      tone(ctx, s, { f, env: { a: 0.005, d: 0.1, sus: 0.9, hold: 0.8, r: 0.15 } });
    },
  },

  // ---------------------------------------------------------------- keys / leads
  pluck: {
    root: 72,
    seconds: 0.8,
    level: -16,
    build(ctx, out, f) {
      const s = sat(ctx, 1.2, out);
      const lp = filter(ctx, 'lowpass', 8000, 2.5, s);
      sweep(lp.frequency, 0, 8000, 1300, 0.22);
      const amp = ctx.createGain();
      const end = envelope(amp.gain, 0, { a: 0.002, d: 0.45, peak: 1 });
      amp.connect(lp);
      osc(ctx, amp, 'sawtooth', f, 0.6, end);
      osc(ctx, amp, 'square', f * 2, 0.18, end);
    },
  },
  lead: {
    root: 72,
    seconds: 2.4,
    stereo: true,
    level: -14,
    build(ctx, out, f) {
      const lp = filter(ctx, 'lowpass', 9500, 0.6, out);
      const hp = filter(ctx, 'highpass', 230, 0.6, lp);
      const env: Env = { a: 0.008, d: 0.35, sus: 0.8, hold: 1.8, r: 0.15 };
      unison(ctx, hp, f, [-22, -14, -6, 0, 6, 14, 22], 0.85, env, 'sawtooth', 0.18);
      unison(ctx, hp, f / 2, [0], 0, env, 'sawtooth', 0.12);
    },
  },
  squareLead: {
    root: 72,
    seconds: 1.8,
    stereo: true,
    level: -14,
    build(ctx, out, f) {
      const lp = filter(ctx, 'lowpass', 5600, 1.1, out);
      const amp = ctx.createGain();
      const end = envelope(amp.gain, 0, { a: 0.006, d: 0.25, sus: 0.85, hold: 1.2, r: 0.12 });
      amp.connect(lp);
      // delayed vibrato, the classic arcade lead wobble
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5.6;
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(0, 0);
      depth.gain.setValueAtTime(0, 0.2);
      depth.gain.linearRampToValueAtTime(16, 0.55);
      lfo.connect(depth);
      lfo.start(0);
      lfo.stop(end + 0.05);
      for (const [type, lvl, det, pan] of [
        ['square', 0.32, -5, -0.3],
        ['sawtooth', 0.26, 7, 0.3],
        ['square', 0.12, 1200, 0],
      ] as const) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f;
        o.detune.value = det;
        depth.connect(o.detune);
        o.connect(gainNode(ctx, lvl, panner(ctx, pan, amp)));
        o.start(0);
        o.stop(end + 0.05);
      }
    },
  },
  pad: {
    root: 48,
    seconds: 4.2,
    stereo: true,
    level: -16,
    build(ctx, out, f) {
      const lp = filter(ctx, 'lowpass', 4200, 0.5, filter(ctx, 'highpass', 180, 0.6, out));
      const env: Env = { a: 0.35, d: 0.6, sus: 0.9, hold: 2.8, r: 0.4 };
      unison(ctx, lp, f, [-18, -9, 0, 9, 18], 0.9, env, 'sawtooth', 0.2);
      unison(ctx, lp, f * 2, [-5, 5], 0.6, env, 'triangle', 0.12);
    },
  },
  stab: {
    root: 60,
    seconds: 0.6,
    stereo: true,
    level: -14,
    build(ctx, out, f) {
      const lp = filter(ctx, 'lowpass', 5200, 1.6, out);
      sweep(lp.frequency, 0, 5200, 1400, 0.18);
      const env: Env = { a: 0.003, d: 0.32, peak: 1 };
      unison(ctx, lp, f, [-9, 0, 9], 0.5, env, 'sawtooth', 0.3);
      unison(ctx, lp, f, [0], 0, env, 'square', 0.18);
    },
  },
  brass: {
    root: 60,
    seconds: 1.4,
    stereo: true,
    level: -14,
    build(ctx, out, f) {
      const s = sat(ctx, 1.3, out);
      const lp = filter(ctx, 'lowpass', 500, 1.2, s);
      lp.frequency.setValueAtTime(500, 0);
      lp.frequency.exponentialRampToValueAtTime(3600, 0.07);
      lp.frequency.exponentialRampToValueAtTime(2200, 0.4);
      const env: Env = { a: 0.02, d: 0.2, sus: 0.85, hold: 0.9, r: 0.15 };
      unison(ctx, lp, f, [-7, 7], 0.6, env, 'sawtooth', 0.32);
      unison(ctx, lp, f, [0], 0, env, 'square', 0.2);
    },
  },
  piano: {
    root: 60,
    seconds: 1.8,
    level: -15,
    build(ctx, out, f) {
      const lp = filter(ctx, 'lowpass', 7000, 0.5, out);
      fm(ctx, lp, f, 1, 2.2, 0.25, { a: 0.002, d: 1.6, peak: 0.6 });
      fm(ctx, lp, f * 1.0023, 1, 1.6, 0.2, { a: 0.002, d: 1.4, peak: 0.3 });
      fm(ctx, lp, f * 2, 1, 1, 0.1, { a: 0.002, d: 0.9, peak: 0.22 });
      noise(ctx, lp, { type: 'lowpass', f: 3000, env: { a: 0.0005, d: 0.012, peak: 0.12 } });
    },
  },
  orch: {
    root: 60,
    seconds: 1.6,
    stereo: true,
    level: -12,
    build(ctx, out, f) {
      const s = sat(ctx, 1.5, out);
      s.connect(reverb(ctx, out, 1.2, 0.3, 3));
      const lp = filter(ctx, 'lowpass', 7000, 1, s);
      sweep(lp.frequency, 0, 7000, 1500, 0.28);
      const env: Env = { a: 0.004, d: 0.9, peak: 1 };
      for (const mult of [0.5, 1, 1.5, 2]) unison(ctx, lp, f * mult, [-10, 10], 0.6, env, 'sawtooth', 0.16);
      noise(ctx, s, { type: 'highpass', f: 1500, env: { a: 0.002, d: 0.12, peak: 0.35 } });
      tone(ctx, s, { f: 75, to: 45, glide: 0.2, env: { a: 0.002, d: 0.4, peak: 0.6 } });
    },
  },
  bell: {
    root: 84,
    seconds: 2.2,
    level: -18,
    build(ctx, out, f) {
      fm(ctx, out, f, 3.5, 4, 0.2, { a: 0.001, d: 2, peak: 0.6 });
      fm(ctx, out, f * 2.01, 1.4, 1.5, 0.1, { a: 0.001, d: 1, peak: 0.2 });
    },
  },
  choir: {
    root: 48,
    seconds: 4,
    stereo: true,
    level: -16,
    build(ctx, out, f) {
      const mix = gainNode(ctx, 1);
      mix.connect(filter(ctx, 'bandpass', 720, 5, out));
      mix.connect(filter(ctx, 'bandpass', 1150, 6, gainNode(ctx, 0.7, out)));
      mix.connect(filter(ctx, 'lowpass', 3000, 0.5, gainNode(ctx, 0.35, out)));
      unison(ctx, mix, f, [-16, -8, 0, 8, 16], 0.8, { a: 0.4, d: 0.5, sus: 0.9, hold: 2.5, r: 0.5 }, 'sawtooth', 0.22);
    },
  },
  timp: {
    root: 36,
    seconds: 1.2,
    level: -12,
    build(ctx, out, f) {
      const s = sat(ctx, 1.6, out);
      tone(ctx, s, { f: f * 1.15, to: f, glide: 0.06, env: { a: 0.002, d: 1, peak: 1 } });
      tone(ctx, s, { f: f * 1.5, env: { a: 0.002, d: 0.4, peak: 0.3 } });
      noise(ctx, s, { type: 'lowpass', f: 500, env: { a: 0.001, d: 0.3, peak: 0.4 } });
    },
  },
};

export const freqOf = (def: SampleDef) => mtof(def.root);
