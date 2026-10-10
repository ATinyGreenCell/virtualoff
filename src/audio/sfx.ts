/**
 * Sound effects, each synthesized once offline from layered parts: a low-mid BODY (weight that still
 * reads on phone speakers thanks to saturation harmonics), a mid PRESENCE layer (the character), and
 * controlled highs (snap/air) — plus a baked room or hall tail. Loudness is auto-calibrated per
 * category so nothing blasts and nothing disappears.
 */
import { filter, gainNode, metal, noise, panner, rand, reverb, reseed, sat, sweep, tone, type Env } from './dsp';
import type { LoopName, SfxName } from './types';

export interface SfxDef {
  seconds: number;
  stereo?: boolean;
  /** loudness target (dB, perceptually weighted loudest-300 ms RMS) */
  level: number;
  /** max simultaneous voices, oldest is stolen */
  max: number;
  /** minimum seconds between two plays */
  gap: number;
  /** random pitch variation (± fraction) */
  vary: number;
  build(ctx: OfflineAudioContext, out: AudioNode): void;
}

export interface LoopDef {
  seconds: number;
  loopStart: number;
  loopEnd: number;
  xfade: number;
  stereo?: boolean;
  level: number;
  build(ctx: OfflineAudioContext, out: AudioNode): void;
}

interface ChainOpts {
  hp?: number;
  lp?: number;
  drive?: number;
  /** [seconds, wet] */
  verb?: [number, number];
}

/** input → [highpass] → [saturation] → [lowpass] → out, with an optional reverb tail. */
function chain(ctx: BaseAudioContext, out: AudioNode, o: ChainOpts): AudioNode {
  const input = ctx.createGain();
  let node: AudioNode = input;
  if (o.hp) node = node.connect(filter(ctx, 'highpass', o.hp, 0.7));
  if (o.drive) node = node.connect(sat(ctx, o.drive));
  if (o.lp) node = node.connect(filter(ctx, 'lowpass', o.lp, 0.6));
  node.connect(out);
  if (o.verb) node.connect(reverb(ctx, out, o.verb[0], o.verb[1], 3));
  return input;
}

/** A resonant lowpass "zap": saw falling in pitch through a falling resonant filter. */
function zap(ctx: BaseAudioContext, dest: AudioNode, f0: number, f1: number, dur: number, peak: number, t = 0, q = 7) {
  const zf = filter(ctx, 'lowpass', f0 * 4, q, dest);
  sweep(zf.frequency, t, f0 * 4, Math.max(300, f1 * 3), dur);
  tone(ctx, zf, { type: 'sawtooth', f: f0, to: f1, glide: dur * 0.85, env: { a: 0.001, d: dur * 1.3, peak }, t });
}

/** Chord of detuned saws through a closing filter — orchestra hit / brass stab. */
function stab(ctx: BaseAudioContext, dest: AudioNode, notes: number[], env: Env, cutoff = 6500, close = 1400, t = 0) {
  const lp = filter(ctx, 'lowpass', cutoff, 1, dest);
  sweep(lp.frequency, t, cutoff, close, env.d * 0.4);
  notes.forEach((f, i) => {
    for (const det of [-9, 9]) {
      const p = panner(ctx, (det > 0 ? 0.35 : -0.35) * (i % 2 ? 1 : 0.6), lp);
      tone(ctx, p, { type: 'sawtooth', f, detune: det, env: { ...env, peak: (env.peak ?? 1) * 0.22 }, t });
    }
  });
}

const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export const SFX: Record<SfxName, SfxDef> = {
  // ---------------------------------------------------------------- weapons
  rifle: {
    seconds: 0.5,
    level: -18,
    max: 5,
    gap: 0.03,
    vary: 0.04,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 1.8, lp: 9000, verb: [0.4, 0.14] });
      zap(ctx, b, 1100, 140, 0.12, 0.7);
      tone(ctx, b, { f: 240, to: 75, glide: 0.08, env: { a: 0.001, d: 0.13, peak: 0.85 } });
      noise(ctx, b, { type: 'bandpass', f: 2400, q: 0.9, env: { a: 0.0005, d: 0.025, peak: 0.6 } });
      tone(ctx, b, { type: 'triangle', f: 980, to: 620, glide: 0.16, env: { a: 0.002, d: 0.2, peak: 0.18 } });
    },
  },
  rifleDash: {
    seconds: 0.6,
    level: -17,
    max: 3,
    gap: 0.05,
    vary: 0.03,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 2, lp: 9000, verb: [0.45, 0.15] });
      [1250, 1100, 980].forEach((f, i) => zap(ctx, b, f, 150, 0.12, 0.55, i * 0.03));
      tone(ctx, b, { f: 260, to: 70, glide: 0.1, env: { a: 0.001, d: 0.18, peak: 0.9 } });
      noise(ctx, b, { type: 'bandpass', f: 2200, q: 0.8, env: { a: 0.0005, d: 0.05, peak: 0.6 } });
    },
  },
  cannon: {
    seconds: 0.9,
    level: -17,
    max: 4,
    gap: 0.04,
    vary: 0.05,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 2.4, lp: 8000, verb: [0.7, 0.2] });
      tone(ctx, b, { f: 210, to: 60, glide: 0.12, env: { a: 0.001, h: 0.02, d: 0.35, peak: 0.8 } });
      tone(ctx, b, { f: 80, to: 40, glide: 0.2, env: { a: 0.002, d: 0.4, peak: 0.3 } });
      noise(ctx, b, { type: 'bandpass', f: 1600, q: 0.9, env: { a: 0.0008, d: 0.1, peak: 3 } });
      noise(ctx, b, { type: 'lowpass', f: 5500, to: 1200, glide: 0.15, env: { a: 0.001, d: 0.22, peak: 1.6 } });
      tone(ctx, b, { type: 'square', f: 300, to: 140, glide: 0.07, env: { a: 0.001, d: 0.08, peak: 0.5 } });
      metal(ctx, b, 420, [1, 2.3, 3.9], 0.15, 0.35);
    },
  },
  bombThrow: {
    seconds: 0.45,
    level: -20,
    max: 3,
    gap: 0.05,
    vary: 0.05,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 1.4, verb: [0.3, 0.1] });
      tone(ctx, b, { f: 220, to: 120, glide: 0.08, env: { a: 0.001, d: 0.12, peak: 0.7 } });
      tone(ctx, b, { type: 'triangle', f: 440, to: 260, glide: 0.06, env: { d: 0.08, peak: 0.6 } });
      noise(ctx, b, { type: 'bandpass', f: 1300, q: 1, env: { a: 0.0005, d: 0.02, peak: 0.6 } });
      noise(ctx, b, { type: 'bandpass', f: 700, to: 1800, glide: 0.25, q: 1.2, env: { a: 0.02, d: 0.28, peak: 0.7 } });
    },
  },
  missileLaunch: {
    seconds: 1,
    level: -20,
    max: 5,
    gap: 0.03,
    vary: 0.06,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 1.6, lp: 8000, verb: [0.5, 0.15] });
      noise(ctx, b, { type: 'bandpass', f: 900, q: 0.8, env: { a: 0.002, d: 0.12, peak: 0.9 } });
      noise(ctx, b, { type: 'bandpass', f: 2600, to: 900, glide: 0.8, q: 1.1, env: { a: 0.03, d: 0.85, peak: 0.6 } });
      tone(ctx, filter(ctx, 'lowpass', 350, 0.8, b), { type: 'sawtooth', f: 62, env: { a: 0.01, d: 0.6, peak: 0.5 } });
      tone(ctx, b, { f: 1500, to: 700, glide: 0.6, env: { a: 0.05, d: 0.6, peak: 0.12 } });
    },
  },
  hyperCharge: {
    seconds: 0.55,
    level: -20,
    max: 2,
    gap: 0.1,
    vary: 0,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 1.5, lp: 9000 });
      const lp = filter(ctx, 'lowpass', 400, 9, b);
      sweep(lp.frequency, 0, 400, 5000, 0.48);
      const env: Env = { a: 0.42, h: 0.02, d: 0.06, peak: 0.6 };
      tone(ctx, lp, { type: 'sawtooth', f: 110, to: 440, glide: 0.48, env });
      tone(ctx, lp, { type: 'sawtooth', f: 111.5, to: 446, glide: 0.48, env: { ...env, peak: 0.5 } });
      tone(ctx, b, { f: 55, to: 110, glide: 0.48, env: { ...env, peak: 0.55 } });
      noise(ctx, b, { type: 'bandpass', f: 500, to: 4000, glide: 0.48, q: 2, env: { ...env, peak: 0.3 } });
    },
  },
  hyperShot: {
    seconds: 1.5,
    stereo: true,
    level: -15,
    max: 2,
    gap: 0.1,
    vary: 0.03,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 2.6, lp: 8500, verb: [1, 0.25] });
      tone(ctx, b, { f: 180, to: 50, glide: 0.3, env: { a: 0.001, h: 0.03, d: 0.6, peak: 0.85 } });
      zap(ctx, b, 700, 90, 0.3, 1, 0, 6);
      zap(ctx, b, 706, 91, 0.3, 0.75, 0.004, 5);
      noise(ctx, b, { type: 'bandpass', f: 1800, q: 0.8, env: { a: 0.0008, d: 0.08, peak: 2.2 } });
      noise(ctx, panner(ctx, -0.5, b), { type: 'lowpass', f: 7000, to: 1100, glide: 0.4, env: { a: 0.001, d: 0.5, peak: 0.7 }, offset: 0.3 });
      noise(ctx, panner(ctx, 0.5, b), { type: 'lowpass', f: 7000, to: 1150, glide: 0.42, env: { a: 0.001, d: 0.52, peak: 0.7 }, offset: 1.6 });
    },
  },
  laserCharge: {
    seconds: 1,
    level: -19,
    max: 2,
    gap: 0.1,
    vary: 0,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 1.8, lp: 7000 });
      const lp = filter(ctx, 'lowpass', 300, 10, b);
      sweep(lp.frequency, 0, 300, 3500, 0.9);
      const env: Env = { a: 0.8, h: 0.05, d: 0.1, peak: 0.45 };
      for (const d of [-12, 0, 12]) tone(ctx, lp, { type: 'sawtooth', f: 55, to: 220, glide: 0.9, detune: d, env });
      tone(ctx, b, { f: 41, to: 82, glide: 0.9, env: { ...env, peak: 0.6 } });
      noise(ctx, b, { type: 'bandpass', f: 300, to: 2500, glide: 0.9, q: 3, env: { ...env, peak: 0.4 } });
    },
  },

  // ---------------------------------------------------------------- explosions & impacts
  explosionSmall: {
    seconds: 1.3,
    stereo: true,
    level: -16,
    max: 4,
    gap: 0.04,
    vary: 0.08,
    build(ctx, out) {
      reseed(101);
      const b = chain(ctx, out, { drive: 2.6, lp: 7000, verb: [0.9, 0.25] });
      tone(ctx, b, { f: 140, to: 45, glide: 0.22, env: { a: 0.001, h: 0.02, d: 0.45, peak: 0.85 } });
      noise(ctx, panner(ctx, -0.4, b), { type: 'lowpass', f: 4500, to: 650, glide: 0.5, env: { a: 0.002, d: 0.6, peak: 0.8 }, offset: 0.2 });
      noise(ctx, panner(ctx, 0.4, b), { type: 'lowpass', f: 4000, to: 600, glide: 0.55, env: { a: 0.002, d: 0.65, peak: 0.8 }, offset: 1.1 });
      noise(ctx, b, { type: 'bandpass', f: 600, q: 0.8, env: { a: 0.002, d: 0.4, peak: 0.6 } });
      for (let i = 0; i < 8; i++) {
        noise(ctx, panner(ctx, rand() * 1.6 - 0.8, b), { type: 'bandpass', f: 1500 + rand() * 2500, q: 2, t: 0.03 + rand() * 0.35, env: { a: 0.001, d: 0.02, peak: 0.5 } });
      }
    },
  },
  explosionBig: {
    seconds: 2.4,
    stereo: true,
    level: -14,
    max: 3,
    gap: 0.06,
    vary: 0.06,
    build(ctx, out) {
      reseed(202);
      const b = chain(ctx, out, { drive: 2.8, lp: 6500, verb: [1.6, 0.3] });
      tone(ctx, b, { f: 120, to: 35, glide: 0.35, env: { a: 0.001, h: 0.04, d: 0.9, peak: 0.85 } });
      noise(ctx, panner(ctx, -0.5, b), { type: 'lowpass', f: 3500, to: 450, glide: 1.2, env: { a: 0.002, d: 1.4, peak: 0.8 }, offset: 0.4 });
      noise(ctx, panner(ctx, 0.5, b), { type: 'lowpass', f: 3300, to: 420, glide: 1.25, env: { a: 0.002, d: 1.45, peak: 0.8 }, offset: 2.1 });
      noise(ctx, b, { type: 'bandpass', f: 500, q: 0.7, env: { a: 0.003, d: 0.9, peak: 0.6 } });
      noise(ctx, b, { color: 'brown', type: 'lowpass', f: 160, env: { a: 0.01, d: 1.6, peak: 0.5 } });
      for (let i = 0; i < 14; i++) {
        noise(ctx, panner(ctx, rand() * 1.8 - 0.9, b), { type: 'bandpass', f: 1200 + rand() * 3000, q: 2, t: 0.04 + rand() * 0.8, env: { a: 0.001, d: 0.025, peak: 0.45 } });
      }
    },
  },
  mechExplode: {
    seconds: 3.4,
    stereo: true,
    level: -13,
    max: 2,
    gap: 0.3,
    vary: 0.02,
    build(ctx, out) {
      reseed(303);
      const b = chain(ctx, out, { drive: 2.8, lp: 6500, verb: [2.2, 0.35] });
      [
        [0, 130],
        [0.15, 110],
        [0.4, 90],
      ].forEach(([t, f]) => tone(ctx, b, { f, to: f * 0.35, glide: 0.4, t, env: { a: 0.001, h: 0.03, d: 0.9, peak: 0.85 } }));
      noise(ctx, b, { type: 'bandpass', f: 550, q: 0.7, env: { a: 0.003, d: 1.2, peak: 0.6 } });
      noise(ctx, panner(ctx, -0.5, b), { type: 'lowpass', f: 4000, to: 150, glide: 1.8, env: { a: 0.002, d: 2, peak: 0.8 }, offset: 0.7 });
      noise(ctx, panner(ctx, 0.5, b), { type: 'lowpass', f: 3800, to: 140, glide: 1.9, env: { a: 0.002, d: 2.1, peak: 0.8 }, offset: 1.9 });
      noise(ctx, b, { color: 'brown', type: 'lowpass', f: 140, env: { a: 0.02, d: 2.6, peak: 0.8 } });
      for (let i = 0; i < 7; i++) metal(ctx, panner(ctx, rand() * 1.6 - 0.8, b), 300 + rand() * 400, [1, 2.7, 5.1], 0.25, 0.25, 0.2 + rand() * 1.3);
    },
  },
  hit: {
    seconds: 0.45,
    level: -16,
    max: 4,
    gap: 0.03,
    vary: 0.06,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 2.2, lp: 9000, verb: [0.3, 0.1] });
      metal(ctx, b, 540, [1, 2.43, 4.1], 0.12, 0.6);
      tone(ctx, b, { f: 180, to: 85, glide: 0.06, env: { a: 0.001, d: 0.1, peak: 0.9 } });
      noise(ctx, b, { type: 'bandpass', f: 1800, q: 0.9, env: { a: 0.001, d: 0.05, peak: 0.6 } });
    },
  },
  hitHeavy: {
    seconds: 0.8,
    level: -14,
    max: 3,
    gap: 0.04,
    vary: 0.05,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 2.4, lp: 8000, verb: [0.6, 0.18] });
      metal(ctx, b, 330, [1, 2.6, 4.7], 0.3, 0.6);
      tone(ctx, b, { f: 160, to: 60, glide: 0.1, env: { a: 0.001, h: 0.02, d: 0.28, peak: 0.9 } });
      noise(ctx, b, { type: 'bandpass', f: 1500, q: 0.8, env: { a: 0.001, d: 0.1, peak: 2.2 } });
    },
  },
  guardHit: {
    seconds: 0.6,
    level: -18,
    max: 3,
    gap: 0.04,
    vary: 0.05,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 1.6, lp: 10000, verb: [0.5, 0.18] });
      metal(ctx, b, 780, [1, 2.2, 3.6], 0.35, 0.5);
      tone(ctx, b, { f: 260, to: 180, glide: 0.05, env: { a: 0.001, d: 0.08, peak: 1 } });
      tone(ctx, b, { f: 120, env: { a: 0.001, d: 0.06, peak: 0.5 } });
      noise(ctx, b, { type: 'bandpass', f: 3500, env: { a: 0.0005, d: 0.03, peak: 0.4 } });
    },
  },
  down: {
    seconds: 1,
    level: -15,
    max: 2,
    gap: 0.1,
    vary: 0.04,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 2.4, lp: 7000, verb: [0.7, 0.2] });
      tone(ctx, b, { f: 140, to: 48, glide: 0.18, env: { a: 0.001, h: 0.02, d: 0.4, peak: 0.85 } });
      metal(ctx, b, 330, [1, 2.7, 5.1], 0.35, 0.6, 0.02);
      noise(ctx, b, { type: 'bandpass', f: 1200, q: 0.7, env: { a: 0.001, d: 0.25, peak: 2 } });
      noise(ctx, b, { type: 'bandpass', f: 700, q: 0.8, env: { a: 0.05, d: 0.4, peak: 0.35 } });
    },
  },

  // ---------------------------------------------------------------- movement
  dash: {
    seconds: 0.6,
    level: -21,
    max: 3,
    gap: 0.05,
    vary: 0.05,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 1.6, lp: 8000, verb: [0.4, 0.12] });
      noise(ctx, b, { type: 'bandpass', f: 500, to: 1900, glide: 0.18, q: 0.9, env: { a: 0.015, h: 0.05, d: 0.35, peak: 0.8 } });
      tone(ctx, filter(ctx, 'lowpass', 260, 1, b), { type: 'sawtooth', f: 58, env: { a: 0.01, d: 0.4, peak: 0.7 } });
      tone(ctx, b, { f: 95, to: 150, glide: 0.1, env: { a: 0.005, d: 0.25, peak: 0.5 } });
      noise(ctx, b, { type: 'highpass', f: 3000, env: { a: 0.002, d: 0.08, peak: 0.25 } });
    },
  },
  airDash: {
    seconds: 0.55,
    level: -21,
    max: 3,
    gap: 0.05,
    vary: 0.05,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 1.6, lp: 9000, verb: [0.45, 0.14] });
      noise(ctx, b, { type: 'bandpass', f: 800, to: 2800, glide: 0.16, q: 0.9, env: { a: 0.012, h: 0.04, d: 0.32, peak: 0.8 } });
      tone(ctx, filter(ctx, 'lowpass', 300, 1, b), { type: 'sawtooth', f: 70, env: { a: 0.01, d: 0.35, peak: 0.6 } });
      tone(ctx, b, { f: 130, to: 200, glide: 0.1, env: { a: 0.005, d: 0.22, peak: 0.45 } });
    },
  },
  jump: {
    seconds: 0.65,
    level: -21,
    max: 2,
    gap: 0.08,
    vary: 0.04,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 1.5, lp: 8000, verb: [0.4, 0.12] });
      noise(ctx, b, { type: 'bandpass', f: 350, to: 1600, glide: 0.3, q: 1, env: { a: 0.04, d: 0.45, peak: 1 } });
      tone(ctx, b, { f: 90, to: 150, glide: 0.2, env: { a: 0.01, d: 0.35, peak: 0.35 } });
      tone(ctx, filter(ctx, 'lowpass', 300, 1, b), { type: 'sawtooth', f: 65, env: { a: 0.02, d: 0.5, peak: 0.3 } });
    },
  },
  land: {
    seconds: 0.5,
    level: -20,
    max: 3,
    gap: 0.05,
    vary: 0.05,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 2, lp: 8000, verb: [0.35, 0.1] });
      tone(ctx, b, { f: 160, to: 55, glide: 0.09, env: { a: 0.001, d: 0.2, peak: 0.85 } });
      metal(ctx, b, 380, [1, 2.7, 4.4], 0.1, 0.45);
      noise(ctx, b, { type: 'bandpass', f: 1400, q: 0.8, env: { a: 0.001, d: 0.08, peak: 2 } });
      noise(ctx, b, { type: 'bandpass', f: 600, q: 0.8, env: { a: 0.02, d: 0.25, peak: 0.3 } });
    },
  },
  step: {
    seconds: 0.3,
    level: -26,
    max: 4,
    gap: 0.04,
    vary: 0.08,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 1.8, lp: 7000 });
      tone(ctx, b, { f: 170, to: 95, glide: 0.05, env: { a: 0.001, d: 0.08, peak: 0.9 } });
      noise(ctx, b, { type: 'bandpass', f: 2200, q: 1, env: { a: 0.0005, d: 0.025, peak: 2 } });
      tone(ctx, filter(ctx, 'lowpass', 1500, 1, b), { type: 'sawtooth', f: 340, env: { a: 0.001, d: 0.06, peak: 0.4 } });
      metal(ctx, b, 520, [1, 2.4], 0.05, 0.3);
    },
  },

  // ---------------------------------------------------------------- melee
  swing: {
    seconds: 0.55,
    level: -19,
    max: 2,
    gap: 0.08,
    vary: 0.04,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 1.4, lp: 9000, verb: [0.4, 0.14] });
      const bp = filter(ctx, 'bandpass', 500, 3, b);
      bp.frequency.setValueAtTime(500, 0);
      bp.frequency.exponentialRampToValueAtTime(2400, 0.18);
      bp.frequency.exponentialRampToValueAtTime(900, 0.45);
      tone(ctx, bp, { type: 'sawtooth', f: 110, env: { a: 0.02, d: 0.45, peak: 0.9 } });
      noise(ctx, b, { type: 'bandpass', f: 800, to: 2500, glide: 0.3, q: 1.5, env: { a: 0.03, d: 0.35, peak: 0.45 } });
      tone(ctx, b, { f: 330, env: { a: 0.02, d: 0.4, peak: 0.3 } });
    },
  },
  slash: {
    seconds: 0.6,
    level: -16,
    max: 2,
    gap: 0.06,
    vary: 0.04,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 2, lp: 9000, verb: [0.5, 0.18] });
      zap(ctx, b, 1500, 180, 0.15, 0.7);
      tone(ctx, b, { f: 170, to: 70, glide: 0.1, env: { a: 0.001, d: 0.15, peak: 0.9 } });
      noise(ctx, b, { type: 'highpass', f: 3500, env: { a: 0.002, d: 0.3, peak: 0.28 } });
      noise(ctx, b, { type: 'bandpass', f: 2000, env: { a: 0.0005, d: 0.03, peak: 0.6 } });
    },
  },

  // ---------------------------------------------------------------- HUD / UI
  lockOn: {
    seconds: 0.4,
    level: -24,
    max: 2,
    gap: 0.1,
    vary: 0,
    build(ctx, out) {
      const b = chain(ctx, out, { lp: 7000, verb: [0.3, 0.15] });
      tone(ctx, b, { type: 'triangle', f: 880, env: { a: 0.002, d: 0.07, peak: 0.6 } });
      tone(ctx, b, { type: 'triangle', f: 1175, t: 0.09, env: { a: 0.002, d: 0.1, peak: 0.6 } });
      tone(ctx, b, { f: 440, env: { a: 0.002, d: 0.2, peak: 0.35 } });
      tone(ctx, b, { f: 220, env: { a: 0.002, d: 0.12, peak: 0.3 } });
    },
  },
  empty: {
    seconds: 0.15,
    level: -27,
    max: 2,
    gap: 0.08,
    vary: 0.05,
    build(ctx, out) {
      const b = chain(ctx, out, { lp: 6000 });
      noise(ctx, b, { type: 'lowpass', f: 2200, env: { a: 0.0005, d: 0.008, peak: 0.7 } });
      tone(ctx, b, { f: 320, to: 200, glide: 0.03, env: { a: 0.001, d: 0.03, peak: 0.4 } });
    },
  },
  alarm: {
    seconds: 0.8,
    level: -23,
    max: 1,
    gap: 0.5,
    vary: 0,
    build(ctx, out) {
      const b = chain(ctx, out, { lp: 3500, drive: 1.2 });
      [0, 0.22, 0.44].forEach((t, i) => {
        const f = i % 2 ? 560 : 700;
        const env: Env = { a: 0.01, d: 0.05, sus: 0.9, hold: 0.12, r: 0.04 };
        tone(ctx, b, { type: 'triangle', f, t, env: { ...env, peak: 0.6 } });
        tone(ctx, b, { f: f / 2, t, env: { ...env, peak: 0.4 } });
      });
    },
  },
  uiMove: {
    seconds: 0.12,
    level: -26,
    max: 3,
    gap: 0.02,
    vary: 0,
    build(ctx, out) {
      const b = chain(ctx, out, { lp: 8000 });
      tone(ctx, b, { type: 'triangle', f: hz(72), env: { a: 0.001, d: 0.05, peak: 0.6 } });
      tone(ctx, b, { f: hz(60), env: { a: 0.001, d: 0.06, peak: 0.45 } });
      tone(ctx, b, { f: 160, env: { a: 0.001, d: 0.025, peak: 0.3 } });
      noise(ctx, b, { type: 'lowpass', f: 4000, env: { a: 0.0005, d: 0.004, peak: 0.2 } });
    },
  },
  uiSelect: {
    seconds: 0.35,
    level: -23,
    max: 2,
    gap: 0.04,
    vary: 0,
    build(ctx, out) {
      const b = chain(ctx, out, { lp: 9000, verb: [0.35, 0.15] });
      tone(ctx, b, { type: 'triangle', f: hz(72), env: { a: 0.001, d: 0.07, peak: 0.6 } });
      tone(ctx, b, { type: 'triangle', f: hz(79), t: 0.07, env: { a: 0.001, d: 0.12, peak: 0.6 } });
      tone(ctx, b, { f: hz(60), env: { a: 0.001, d: 0.15, peak: 0.45 } });
      tone(ctx, b, { f: hz(48), env: { a: 0.001, d: 0.08, peak: 0.3 } });
    },
  },
  uiBack: {
    seconds: 0.3,
    level: -24,
    max: 2,
    gap: 0.04,
    vary: 0,
    build(ctx, out) {
      const b = chain(ctx, out, { lp: 8000, verb: [0.3, 0.12] });
      tone(ctx, b, { type: 'triangle', f: hz(67), env: { a: 0.001, d: 0.06, peak: 0.6 } });
      tone(ctx, b, { type: 'triangle', f: hz(60), t: 0.07, env: { a: 0.001, d: 0.12, peak: 0.6 } });
      tone(ctx, b, { f: hz(48), env: { a: 0.001, d: 0.15, peak: 0.45 } });
    },
  },
  uiConfirmBig: {
    seconds: 1.4,
    stereo: true,
    level: -18,
    max: 2,
    gap: 0.1,
    vary: 0,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 1.5, lp: 9000, verb: [1.2, 0.3] });
      stab(ctx, b, [hz(48), hz(60), hz(64), hz(67), hz(72)], { a: 0.003, d: 0.8, peak: 1 });
      tone(ctx, b, { f: 80, to: 40, glide: 0.2, env: { a: 0.002, d: 0.45, peak: 0.7 } });
      noise(ctx, b, { type: 'highpass', f: 1800, env: { a: 0.002, d: 0.1, peak: 0.3 } });
    },
  },

  // ---------------------------------------------------------------- announcer stingers
  announceRound: {
    seconds: 1.6,
    stereo: true,
    level: -17,
    max: 1,
    gap: 0.2,
    vary: 0,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 1.6, lp: 9000, verb: [1.4, 0.3] });
      tone(ctx, b, { f: 110, to: 45, glide: 0.3, env: { a: 0.001, h: 0.03, d: 0.7, peak: 0.6 } });
      stab(ctx, b, [hz(50), hz(62), hz(65), hz(69), hz(74)], { a: 0.004, d: 0.9, peak: 1.3 }, 6000, 1500);
      noise(ctx, b, { type: 'highpass', f: 5000, env: { a: 0.002, d: 0.9, peak: 0.25 } });
    },
  },
  announceReady: {
    seconds: 1.4,
    stereo: true,
    level: -18,
    max: 1,
    gap: 0.2,
    vary: 0,
    build(ctx, out) {
      const b = chain(ctx, out, { lp: 9000, verb: [0.8, 0.2] });
      const env: Env = { a: 1.15, h: 0.03, d: 0.12, peak: 0.8 };
      noise(ctx, panner(ctx, -0.4, b), { type: 'bandpass', f: 300, to: 4500, glide: 1.2, q: 3, env, offset: 0.5 });
      noise(ctx, panner(ctx, 0.4, b), { type: 'bandpass', f: 320, to: 4700, glide: 1.2, q: 3, env, offset: 1.5 });
      tone(ctx, filter(ctx, 'lowpass', 1800, 2, b), { type: 'sawtooth', f: 110, to: 440, glide: 1.2, env: { ...env, peak: 0.5 } });
      tone(ctx, b, { f: 55, to: 110, glide: 1.2, env: { ...env, peak: 0.5 } });
    },
  },
  announceGo: {
    seconds: 2,
    stereo: true,
    level: -15,
    max: 1,
    gap: 0.2,
    vary: 0,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 1.8, lp: 10000, verb: [1.8, 0.35] });
      stab(ctx, b, [hz(48), hz(60), hz(67), hz(72), hz(76)], { a: 0.003, d: 1.1, peak: 1 }, 8000, 1800);
      tone(ctx, b, { f: 110, to: 38, glide: 0.35, env: { a: 0.001, h: 0.03, d: 0.9, peak: 0.8 } });
      noise(ctx, panner(ctx, -0.5, b), { type: 'highpass', f: 4500, env: { a: 0.002, d: 1.5, peak: 0.35 }, offset: 0.2 });
      noise(ctx, panner(ctx, 0.5, b), { type: 'highpass', f: 4500, env: { a: 0.002, d: 1.5, peak: 0.35 }, offset: 1.2 });
    },
  },
  announceFinish: {
    seconds: 2.2,
    stereo: true,
    level: -15,
    max: 1,
    gap: 0.2,
    vary: 0,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 2, lp: 8000, verb: [1.8, 0.35] });
      tone(ctx, b, { f: 130, to: 40, glide: 0.5, env: { a: 0.001, h: 0.04, d: 1, peak: 0.7 } });
      noise(ctx, b, { type: 'lowpass', f: 6000, to: 500, glide: 1.4, env: { a: 0.002, d: 1.6, peak: 0.65 } });
      stab(ctx, b, [hz(45), hz(57), hz(60), hz(64)], { a: 0.004, d: 1, peak: 1.2 }, 5000, 1300);
    },
  },
  announceWin: {
    seconds: 1.8,
    stereo: true,
    level: -17,
    max: 1,
    gap: 0.2,
    vary: 0,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 1.3, lp: 10000, verb: [1.4, 0.3] });
      stab(ctx, b, [hz(36), hz(48), hz(55), hz(60), hz(64), hz(67)], { a: 0.03, d: 1.2, peak: 1.1 }, 4200, 1600);
      tone(ctx, b, { f: 70, to: 48, glide: 0.15, env: { a: 0.002, d: 0.6, peak: 0.6 } });
      [84, 88, 91, 96].forEach((m, i) => tone(ctx, b, { type: 'triangle', f: hz(m), t: 0.1 + i * 0.08, env: { a: 0.002, d: 0.5, peak: 0.14 } }));
    },
  },
  announceLose: {
    seconds: 2,
    stereo: true,
    level: -18,
    max: 1,
    gap: 0.2,
    vary: 0,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 1.3, lp: 6000, verb: [1.5, 0.3] });
      stab(ctx, b, [hz(45), hz(57), hz(60), hz(64)], { a: 0.03, d: 0.6, peak: 0.9 }, 3000, 1000);
      stab(ctx, b, [hz(41), hz(53), hz(57), hz(60)], { a: 0.04, d: 1.2, peak: 0.8 }, 2500, 700, 0.6);
      tone(ctx, b, { f: 70, to: 38, glide: 0.3, env: { a: 0.002, d: 0.6, peak: 0.6 } });
    },
  },
  announceTimeUp: {
    seconds: 1.3,
    level: -18,
    max: 1,
    gap: 0.2,
    vary: 0,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 1.4, lp: 2600, verb: [0.6, 0.15] });
      const env: Env = { a: 0.01, d: 0.05, sus: 0.9, hold: 0.7, r: 0.15 };
      tone(ctx, b, { type: 'square', f: 220, env: { ...env, peak: 0.7 } });
      tone(ctx, b, { type: 'square', f: 233, env: { ...env, peak: 0.6 } });
      tone(ctx, b, { f: 110, env: { ...env, peak: 0.2 } });
    },
  },
};

export const LOOPS: Record<LoopName, LoopDef> = {
  laser: {
    seconds: 2.6,
    loopStart: 0.2,
    loopEnd: 2.2,
    xfade: 0.25,
    stereo: true,
    level: -16,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 2.2, lp: 7000 });
      const lp = filter(ctx, 'lowpass', 1100, 2.5, b);
      // 7.5 Hz × 2 s loop = 15 whole wobble cycles, so the loop seam lands on the same phase
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 7.5;
      lfo.connect(gainNode(ctx, 450, undefined)).connect(lp.frequency);
      lfo.start(0);
      lfo.stop(2.6);
      const env: Env = { a: 0.01, d: 0.05, sus: 1, hold: 2.6, r: 0.05 };
      for (const d of [-15, 0, 15]) tone(ctx, lp, { type: 'sawtooth', f: 55, detune: d, env: { ...env, peak: 0.45 } });
      tone(ctx, lp, { type: 'sawtooth', f: 110, env: { ...env, peak: 0.25 } });
      noise(ctx, panner(ctx, -0.4, b), { type: 'bandpass', f: 900, q: 0.6, env: { ...env, peak: 0.55 }, offset: 0.1 });
      noise(ctx, panner(ctx, 0.4, b), { type: 'bandpass', f: 950, q: 0.6, env: { ...env, peak: 0.55 }, offset: 1.3 });
      noise(ctx, b, { type: 'highpass', f: 4500, env: { ...env, peak: 0.15 } });
    },
  },
  thruster: {
    seconds: 2.6,
    loopStart: 0.2,
    loopEnd: 2.2,
    xfade: 0.25,
    stereo: true,
    level: -20,
    build(ctx, out) {
      const b = chain(ctx, out, { drive: 1.4, lp: 6000 });
      const env: Env = { a: 0.01, d: 0.05, sus: 1, hold: 2.6, r: 0.05 };
      noise(ctx, panner(ctx, -0.3, b), { type: 'bandpass', f: 800, q: 0.7, env: { ...env, peak: 0.7 }, offset: 0.4 });
      noise(ctx, panner(ctx, 0.3, b), { type: 'bandpass', f: 840, q: 0.7, env: { ...env, peak: 0.7 }, offset: 1.8 });
      noise(ctx, b, { color: 'brown', type: 'lowpass', f: 260, env: { ...env, peak: 0.8 } });
      tone(ctx, filter(ctx, 'lowpass', 220, 1, b), { type: 'sawtooth', f: 72, env: { ...env, peak: 0.4 } });
    },
  },
};
