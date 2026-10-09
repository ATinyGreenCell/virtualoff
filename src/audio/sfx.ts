/**
 * Synthesized sound effects (one recipe per SfxName) and the two sustained loops.
 * Every recipe builds a fresh `Voice` graph that cleans itself up when it finishes.
 */
import { SILENT, Voice, clamp, type NoiseBuffers } from './synth';
import { mtof } from './theory';
import type { LoopHandle, LoopName, PlayOpts, SfxName } from './types';

type Recipe = (v: Voice, t: number, p: number) => void;

// --- shared building blocks --------------------------------------------------------------------

/** Inharmonic square partials through a bandpass: metallic clank. */
function metal(v: Voice, t: number, freqs: readonly number[], peak: number, decay: number, bp: number, q: number): void {
  const f = v.filter('bandpass', bp, q);
  f.connect(v.out);
  for (const fr of freqs) v.tone(t, { type: 'square', f0: fr, peak, decay, dest: f });
}

/** Stacked detuned saws + noise attack + sub: the classic "orchestra hit". */
function orchStab(v: Voice, t: number, midis: readonly number[], peak: number, decay: number): void {
  const lp = v.filter('lowpass', 7000, 0.8);
  v.ramp(lp.frequency, t, 7000, 1400, decay * 0.6);
  const g = v.gain(0);
  v.perc(g.gain, t, peak, 0.003, decay);
  const mix = v.gain(1.6 / (midis.length * 2));
  mix.connect(lp);
  lp.connect(g);
  g.connect(v.out);
  for (const m of midis) {
    for (const d of [-12, 12]) v.osc('sawtooth', mtof(m), t, t + decay + 0.1, d).connect(mix);
  }
  v.noiseBurst(t, { peak: peak * 0.5, decay: 0.08, type: 'bandpass', freq: 1800, q: 0.8 });
  const f0 = mtof(midis[0]);
  v.tone(t, { f0, f1: f0 * 0.5, sweep: 0.2, peak: peak * 0.6, decay: 0.3 });
}

/** Thruster burst: band-passed noise swooping up then down + low hum + push "fwoomp". */
function thrust(v: Voice, t: number, p: number, k: number): void {
  const n = v.noise(t, t + 0.55);
  const bp = v.filter('bandpass', 600 * p * k, 0.9);
  bp.frequency.setValueAtTime(600 * p * k, t);
  bp.frequency.exponentialRampToValueAtTime(2600 * p * k, t + 0.15);
  bp.frequency.exponentialRampToValueAtTime(1100 * p * k, t + 0.45);
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.38, t + 0.025);
  g.gain.exponentialRampToValueAtTime(SILENT, t + 0.5);
  n.connect(bp);
  bp.connect(g);
  g.connect(v.out);
  const lp = v.filter('lowpass', 650);
  lp.connect(v.out);
  v.tone(t, { type: 'sawtooth', f0: 85 * p * k, f1: 140 * p * k, sweep: 0.3, peak: 0.14, attack: 0.02, decay: 0.4, dest: lp });
  v.tone(t, { f0: 210 * p, f1: 70 * p, sweep: 0.1, peak: 0.28, decay: 0.14 });
}

/** Rising filtered-noise riser with a swell envelope. */
function noiseRiser(v: Voice, t: number, type: BiquadFilterType, f0: number, f1: number, q: number, peak: number, dur: number, release: number): void {
  const n = v.noise(t, t + dur + release + 0.05);
  const f = v.filter(type, f0, q);
  v.ramp(f.frequency, t, f0, f1, dur);
  const g = v.gain(0);
  v.swell(g.gain, t, peak * 0.08, peak, dur, release);
  n.connect(f);
  f.connect(g);
  g.connect(v.out);
}

// --- recipes -----------------------------------------------------------------------------------

export const RECIPES: Readonly<Record<SfxName, Recipe>> = {
  rifle(v, t, p) {
    const lp = v.filter('lowpass', 9000, 1.2);
    v.ramp(lp.frequency, t, 9000, 1400, 0.16);
    const hp = v.filter('highpass', 280);
    lp.connect(hp);
    hp.connect(v.out);
    v.tone(t, { type: 'sawtooth', f0: 1900 * p, f1: 210 * p, sweep: 0.14, peak: 0.22, attack: 0.003, decay: 0.17, dest: lp });
    v.tone(t, { type: 'square', f0: 2600 * p, f1: 320 * p, sweep: 0.12, peak: 0.1, attack: 0.003, decay: 0.15, dest: lp });
    v.noiseBurst(t, { peak: 0.2, decay: 0.04, type: 'highpass', freq: 3500 });
  },

  rifleDash(v, t, p) {
    const lp = v.filter('lowpass', 7000);
    const hp = v.filter('highpass', 300);
    lp.connect(hp);
    hp.connect(v.out);
    const offs = [0, 0.045, 0.09];
    const mul = [1, 1.12, 0.94];
    for (let i = 0; i < 3; i++) {
      const tt = t + offs[i];
      const f = 2200 * p * mul[i];
      v.tone(tt, { type: 'sawtooth', f0: f, f1: f * 0.12, sweep: 0.1, peak: 0.17, decay: 0.11, dest: lp });
      v.tone(tt, { type: 'square', f0: f * 1.5, f1: f * 0.2, sweep: 0.08, peak: 0.07, decay: 0.09, dest: lp });
    }
    v.tone(t, { f0: 180 * p, f1: 60 * p, sweep: 0.1, peak: 0.3, decay: 0.12 });
    v.noiseBurst(t, { peak: 0.2, decay: 0.03, type: 'highpass', freq: 3000 });
  },

  cannon(v, t, p) {
    v.tone(t, { f0: 160 * p, f1: 45 * p, sweep: 0.18, peak: 0.55, decay: 0.28 });
    const lp = v.filter('lowpass', 3000);
    v.ramp(lp.frequency, t, 3000, 600, 0.2);
    lp.connect(v.out);
    v.tone(t, { type: 'square', f0: 900 * p, f1: 120 * p, sweep: 0.2, peak: 0.14, decay: 0.22, dest: lp });
    v.tone(t, { type: 'sawtooth', f0: 1400 * p, f1: 300 * p, sweep: 0.08, peak: 0.08, decay: 0.1 });
    v.noiseBurst(t, { peak: 0.3, decay: 0.14, type: 'lowpass', freq: 2500, to: 500 });
  },

  bombThrow(v, t, p) {
    v.tone(t, { type: 'triangle', f0: 320 * p, f1: 85 * p, sweep: 0.12, peak: 0.45, decay: 0.2 });
    v.noiseBurst(t, { peak: 0.18, decay: 0.06, type: 'bandpass', freq: 900, q: 2 });
    v.tone(t + 0.02, { f0: 480 * p, f1: 900 * p, sweep: 0.18, peak: 0.06, attack: 0.03, decay: 0.2 });
  },

  missileLaunch(v, t, p) {
    v.noiseBurst(t, { peak: 0.32, attack: 0.03, decay: 0.5, type: 'bandpass', freq: 700 * p, to: 4200 * p, sweep: 0.45, q: 1.2 });
    const lp = v.filter('lowpass', 320);
    lp.connect(v.out);
    v.tone(t, { type: 'sawtooth', f0: 70 * p, f1: 120 * p, sweep: 0.4, peak: 0.12, attack: 0.02, decay: 0.45, dest: lp });
    v.noiseBurst(t, { peak: 0.15, decay: 0.03, type: 'highpass', freq: 2500 });
  },

  hyperCharge(v, t, p) {
    const dur = 0.45;
    const end = t + dur + 0.08;
    // rising whine with accelerating vibrato
    const o1 = v.osc('sine', 300 * p, t, end);
    v.ramp(o1.frequency, t, 300 * p, 2400 * p, dur);
    const lfo = v.osc('sine', 18, t, end);
    v.ramp(lfo.frequency, t, 18, 32, dur);
    const lg = v.gain(0);
    v.ramp(lg.gain, t, 25, 120, dur, true);
    lfo.connect(lg);
    lg.connect(o1.frequency);
    const g1 = v.gain(0);
    v.swell(g1.gain, t, 0.02, 0.22, dur, 0.05);
    o1.connect(g1);
    g1.connect(v.out);
    // octave-down buzz
    const o2 = v.osc('square', 150 * p, t, end);
    v.ramp(o2.frequency, t, 150 * p, 1200 * p, dur);
    const lp = v.filter('lowpass', 1800);
    const g2 = v.gain(0);
    v.swell(g2.gain, t, 0.005, 0.06, dur, 0.05);
    o2.connect(lp);
    lp.connect(g2);
    g2.connect(v.out);
    noiseRiser(v, t, 'bandpass', 2000, 6000, 3, 0.1, dur, 0.04);
  },

  hyperShot(v, t, p) {
    v.tone(t, { f0: 120 * p, f1: 32 * p, sweep: 0.5, peak: 0.7, decay: 0.65 });
    const lp = v.filter('lowpass', 4000);
    v.ramp(lp.frequency, t, 4000, 350, 0.45);
    lp.connect(v.out);
    v.tone(t, { type: 'sawtooth', f0: 600 * p, f1: 80 * p, sweep: 0.35, peak: 0.16, decay: 0.5, dest: lp });
    v.tone(t, { type: 'sawtooth', f0: 600 * p, f1: 80 * p, sweep: 0.35, peak: 0.16, decay: 0.5, detune: 14, dest: lp });
    v.noiseBurst(t, { peak: 0.35, decay: 0.45, type: 'lowpass', freq: 1800, to: 300, pink: true });
    v.tone(t, { type: 'square', f0: 3000 * p, f1: 800 * p, sweep: 0.1, peak: 0.07, decay: 0.12 });
  },

  laserCharge(v, t, p) {
    const dur = 0.8;
    const end = t + dur + 0.15;
    // resonant sweep over two detuned saws
    const lp = v.filter('lowpass', 300, 6);
    v.ramp(lp.frequency, t, 300, 3000, dur);
    const g = v.gain(0);
    v.swell(g.gain, t, 0.04, 0.26, dur, 0.1);
    lp.connect(g);
    g.connect(v.out);
    for (const d of [-12, 12]) {
      const o = v.osc('sawtooth', 55 * p, t, end, d);
      v.ramp(o.frequency, t, 55 * p, 220 * p, dur);
      o.connect(lp);
    }
    // accelerating tremolo sine
    const s = v.osc('sine', 220 * p, t, end);
    v.ramp(s.frequency, t, 220 * p, 880 * p, dur);
    const trem = v.gain(0.5);
    const lfo = v.osc('sine', 12, t, end);
    v.ramp(lfo.frequency, t, 12, 30, dur);
    const lfoG = v.gain(0.5);
    lfo.connect(lfoG);
    lfoG.connect(trem.gain);
    const sg = v.gain(0);
    v.swell(sg.gain, t, 0.03, 0.1, dur, 0.1);
    s.connect(trem);
    trem.connect(sg);
    sg.connect(v.out);
    noiseRiser(v, t, 'bandpass', 500, 3000, 2, 0.08, dur, 0.1);
  },

  explosionSmall(v, t, p) {
    v.noiseBurst(t, { peak: 0.5, decay: 0.45, type: 'lowpass', freq: 3500 * p, to: 280, q: 0.8 });
    v.tone(t, { f0: 110 * p, f1: 38 * p, sweep: 0.22, peak: 0.5, decay: 0.3 });
    v.noiseBurst(t, { peak: 0.1, decay: 0.08, type: 'highpass', freq: 3000 });
  },

  explosionBig(v, t, p) {
    v.noiseBurst(t, { peak: 0.7, attack: 0.004, decay: 1.1, type: 'lowpass', freq: 4200 * p, to: 140, sweep: 1.0, pink: true });
    v.tone(t, { f0: 90 * p, f1: 28 * p, sweep: 0.45, peak: 0.8, decay: 0.7 });
    v.noiseBurst(t, { peak: 0.22, decay: 0.3, type: 'lowpass', freq: 6000, to: 1500 });
    v.noiseBurst(t + 0.12, { peak: 0.18, decay: 0.25, type: 'bandpass', freq: 1500, q: 0.8 });
  },

  mechExplode(v, t, p) {
    v.noiseBurst(t, { peak: 0.85, attack: 0.004, decay: 1.3, type: 'lowpass', freq: 4500 * p, to: 140, sweep: 1.2, pink: true });
    v.tone(t, { f0: 60 * p, f1: 24 * p, sweep: 1.6, peak: 0.7, decay: 1.8 });
    v.noiseBurst(t, { peak: 0.45, attack: 0.05, decay: 2.1, type: 'lowpass', freq: 420, to: 70, sweep: 2.0, pink: true });
    const booms: ReadonlyArray<readonly [number, number]> = [[0.35, 0.32], [0.75, 0.26], [1.15, 0.2]];
    for (const [dt, pk] of booms) {
      v.noiseBurst(t + dt, { peak: pk, decay: 0.4, type: 'lowpass', freq: 2600, to: 300 });
      v.tone(t + dt, { f0: 100 * p, f1: 40 * p, sweep: 0.2, peak: pk * 1.1, decay: 0.25 });
    }
    for (let i = 0; i < 5; i++) {
      const tt = t + 0.15 + Math.random() * 1.25;
      const f = 900 + Math.random() * 1700;
      v.tone(tt, { type: i % 2 ? 'square' : 'triangle', f0: f, f1: f * 0.9, sweep: 0.05, peak: 0.05, decay: 0.07 });
    }
  },

  hit(v, t, p) {
    metal(v, t, [520 * p, 793 * p, 1187 * p], 0.07, 0.12, 2200, 1.5);
    v.noiseBurst(t, { peak: 0.35, decay: 0.12, type: 'lowpass', freq: 4000, to: 700 });
    v.tone(t, { f0: 180 * p, f1: 60 * p, sweep: 0.08, peak: 0.35, decay: 0.12 });
  },

  hitHeavy(v, t, p) {
    metal(v, t, [380 * p, 571 * p, 853 * p], 0.08, 0.25, 1700, 1.2);
    v.noiseBurst(t, { peak: 0.5, decay: 0.28, type: 'lowpass', freq: 3000, to: 400, pink: true });
    v.tone(t, { f0: 140 * p, f1: 38 * p, sweep: 0.2, peak: 0.6, decay: 0.3 });
    v.noiseBurst(t, { peak: 0.15, decay: 0.05, type: 'highpass', freq: 2500 });
  },

  guardHit(v, t, p) {
    v.tone(t, { f0: 2500 * p, f1: 2350 * p, sweep: 0.3, peak: 0.16, attack: 0.001, decay: 0.35 });
    v.tone(t, { f0: 3720 * p, f1: 3600 * p, sweep: 0.25, peak: 0.08, attack: 0.001, decay: 0.25 });
    v.tone(t, { type: 'triangle', f0: 5100 * p, peak: 0.04, attack: 0.001, decay: 0.12 });
    v.noiseBurst(t, { peak: 0.2, decay: 0.025, type: 'highpass', freq: 4500 });
  },

  down(v, t, p) {
    v.tone(t, { f0: 90 * p, f1: 28 * p, sweep: 0.35, peak: 0.8, decay: 0.5 });
    v.noiseBurst(t, { peak: 0.55, decay: 0.55, type: 'lowpass', freq: 1200, to: 180, pink: true });
    const bp = v.filter('bandpass', 1500, 1);
    bp.connect(v.out);
    for (let i = 0; i < 6; i++) {
      const tt = t + 0.03 + Math.random() * 0.42;
      v.tone(tt, { type: 'square', f0: (250 + Math.random() * 650) * p, peak: 0.05, decay: 0.05, dest: bp });
    }
    v.tone(t + 0.18, { f0: 70 * p, f1: 30 * p, sweep: 0.2, peak: 0.4, decay: 0.3 });
  },

  dash(v, t, p) {
    thrust(v, t, p, 1);
  },

  airDash(v, t, p) {
    thrust(v, t, p, 1.6);
  },

  jump(v, t, p) {
    v.noiseBurst(t, { peak: 0.3, attack: 0.02, decay: 0.38, type: 'bandpass', freq: 380 * p, to: 2600 * p, sweep: 0.3, q: 1 });
    v.tone(t, { type: 'triangle', f0: 200 * p, f1: 650 * p, sweep: 0.22, peak: 0.09, attack: 0.01, decay: 0.25 });
    v.tone(t, { f0: 160 * p, f1: 80 * p, sweep: 0.08, peak: 0.22, decay: 0.1 });
  },

  land(v, t, p) {
    v.tone(t, { f0: 125 * p, f1: 38 * p, sweep: 0.15, peak: 0.6, decay: 0.22 });
    v.noiseBurst(t, { peak: 0.3, decay: 0.15, type: 'lowpass', freq: 900, pink: true });
    metal(v, t, [220 * p, 337 * p], 0.05, 0.08, 1200, 0.8);
  },

  step(v, t, p) {
    v.tone(t, { f0: 105 * p, f1: 48 * p, sweep: 0.06, peak: 0.2, decay: 0.08 });
    v.noiseBurst(t, { peak: 0.07, decay: 0.05, type: 'lowpass', freq: 650 });
  },

  swing(v, t, p) {
    const bp = v.filter('bandpass', 400 * p, 4);
    bp.frequency.setValueAtTime(400 * p, t);
    bp.frequency.exponentialRampToValueAtTime(2600 * p, t + 0.12);
    bp.frequency.exponentialRampToValueAtTime(700 * p, t + 0.3);
    const g = v.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.32, t + 0.03);
    g.gain.exponentialRampToValueAtTime(SILENT, t + 0.32);
    bp.connect(g);
    g.connect(v.out);
    for (const f of [110, 111.5]) {
      const o = v.osc('sawtooth', f * p, t, t + 0.35);
      o.frequency.exponentialRampToValueAtTime(f * 1.5 * p, t + 0.12);
      o.frequency.exponentialRampToValueAtTime(f * 0.9 * p, t + 0.3);
      o.connect(bp);
    }
    v.noiseBurst(t, { peak: 0.14, attack: 0.03, decay: 0.26, type: 'bandpass', freq: 1800 * p, to: 5000 * p, sweep: 0.12, q: 1.5 });
    v.tone(t, { f0: 220 * p, peak: 0.06, attack: 0.02, decay: 0.28 });
  },

  slash(v, t, p) {
    v.noiseBurst(t, { peak: 0.38, decay: 0.2, type: 'highpass', freq: 1600 });
    const lp = v.filter('lowpass', 2200);
    lp.connect(v.out);
    v.tone(t, { type: 'sawtooth', f0: 240 * p, f1: 80 * p, sweep: 0.15, peak: 0.2, decay: 0.2, dest: lp });
    v.tone(t, { type: 'square', f0: 1400 * p, peak: 0.05, decay: 0.1 });
    v.tone(t, { type: 'square', f0: 2130 * p, peak: 0.04, decay: 0.08 });
    v.tone(t, { f0: 150 * p, f1: 50 * p, sweep: 0.1, peak: 0.4, decay: 0.16 });
  },

  lockOn(v, t) {
    const lp = v.filter('lowpass', 4500);
    lp.connect(v.out);
    v.blip(t, 'square', 1320, 0.05, 0.09, lp);
    v.blip(t + 0.08, 'square', 1760, 0.06, 0.09, lp);
  },

  empty(v, t) {
    v.noiseBurst(t, { peak: 0.3, decay: 0.02, type: 'highpass', freq: 2200 });
    const lp = v.filter('lowpass', 1200);
    lp.connect(v.out);
    v.tone(t, { type: 'square', f0: 190, peak: 0.08, decay: 0.03, dest: lp });
    v.noiseBurst(t + 0.05, { peak: 0.15, decay: 0.015, type: 'highpass', freq: 3000 });
  },

  alarm(v, t) {
    const lp = v.filter('lowpass', 3000);
    lp.connect(v.out);
    for (const dt of [0, 0.25]) {
      v.blip(t + dt, 'square', 988, 0.12, 0.1, lp);
      v.blip(t + dt, 'sine', 494, 0.12, 0.08, lp);
    }
  },

  uiMove(v, t) {
    const lp = v.filter('lowpass', 5000);
    lp.connect(v.out);
    v.blip(t, 'square', 1500, 0.035, 0.08, lp, 1200);
  },

  uiSelect(v, t) {
    const lp = v.filter('lowpass', 5000);
    lp.connect(v.out);
    v.blip(t, 'square', 880, 0.05, 0.09, lp);
    v.blip(t + 0.05, 'square', 1320, 0.08, 0.09, lp);
    v.blip(t + 0.05, 'sine', 2640, 0.08, 0.04, lp);
  },

  uiBack(v, t) {
    const lp = v.filter('lowpass', 3500);
    lp.connect(v.out);
    v.blip(t, 'square', 660, 0.05, 0.09, lp);
    v.blip(t + 0.05, 'square', 440, 0.07, 0.09, lp);
  },

  uiConfirmBig(v, t) {
    orchStab(v, t, [48, 55, 60, 64, 67, 72], 0.42, 0.6);
  },

  announceRound(v, t) {
    const dur = 0.9;
    noiseRiser(v, t, 'bandpass', 300, 4000, 1.5, 0.28, dur, 0.08);
    const lp = v.filter('lowpass', 400, 2);
    v.ramp(lp.frequency, t, 400, 5000, dur);
    const cg = v.gain(0);
    v.swell(cg.gain, t, 0.02, 0.16, dur, 0.08);
    lp.connect(cg);
    cg.connect(v.out);
    for (const f of [110, 165, 220]) {
      const o = v.osc('sawtooth', f, t, t + dur + 0.1);
      v.ramp(o.frequency, t, f, f * 2, dur);
      o.connect(lp);
    }
    v.tone(t + dur, { f0: 100, f1: 40, sweep: 0.2, peak: 0.5, decay: 0.3 });
    v.noiseBurst(t + dur, { peak: 0.3, decay: 0.2, type: 'lowpass', freq: 3000 });
  },

  announceReady(v, t) {
    const dur = 0.7;
    const o = v.osc('square', 440, t, t + dur + 0.1);
    v.ramp(o.frequency, t, 440, 880, dur);
    const lp = v.filter('lowpass', 2500);
    // 16 Hz square-wave gate for a pulsing, ticking riser
    const trem = v.gain(0.5);
    const lfo = v.osc('square', 16, t, t + dur + 0.1);
    const lg = v.gain(0.5);
    lfo.connect(lg);
    lg.connect(trem.gain);
    const g = v.gain(0);
    v.swell(g.gain, t, 0.02, 0.14, dur, 0.06);
    o.connect(lp);
    lp.connect(trem);
    trem.connect(g);
    g.connect(v.out);
    noiseRiser(v, t, 'highpass', 2000, 8000, 0.7, 0.12, dur, 0.05);
  },

  announceGo(v, t) {
    orchStab(v, t, [50, 57, 62, 66, 69, 74], 0.5, 0.75);
    v.noiseBurst(t, { peak: 0.25, decay: 1.3, type: 'highpass', freq: 4500 });
    v.tone(t, { f0: 110, f1: 45, sweep: 0.25, peak: 0.6, decay: 0.4 });
    const lp = v.filter('lowpass', 6000);
    lp.connect(v.out);
    v.blip(t, 'square', 1175, 0.08, 0.06, lp);
    v.blip(t + 0.08, 'square', 1760, 0.14, 0.06, lp);
  },

  announceFinish(v, t) {
    v.tone(t, { f0: 80, f1: 22, sweep: 0.6, peak: 0.85, decay: 1.0 });
    v.noiseBurst(t, { peak: 0.55, decay: 1.2, type: 'lowpass', freq: 3000, to: 150, pink: true });
    v.noiseBurst(t, { peak: 0.2, attack: 0.01, decay: 1.3, type: 'bandpass', freq: 5000, to: 200, q: 2 });
    orchStab(v, t, [50, 57, 62, 65, 69], 0.35, 0.9);
  },

  announceWin(v, t) {
    const lp = v.filter('lowpass', 5000);
    lp.connect(v.out);
    [72, 76, 79, 84].forEach((m, i) => {
      v.blip(t + i * 0.06, 'square', mtof(m), 0.07, 0.09, lp);
    });
    orchStab(v, t + 0.24, [48, 55, 60, 64, 67, 72, 76], 0.45, 0.8);
    v.noiseBurst(t + 0.24, { peak: 0.12, decay: 1.0, type: 'highpass', freq: 5000 });
  },

  announceLose(v, t) {
    const lp = v.filter('lowpass', 2200);
    lp.connect(v.out);
    [69, 65, 62].forEach((m, i) => {
      v.blip(t + i * 0.18, 'square', mtof(m), 0.16, 0.07, lp);
      v.blip(t + i * 0.18, 'sawtooth', mtof(m) * 0.5, 0.16, 0.05, lp);
    });
    const lp2 = v.filter('lowpass', 1200);
    v.ramp(lp2.frequency, t + 0.54, 1200, 500, 0.9);
    lp2.connect(v.out);
    for (const m of [50, 53, 57]) v.tone(t + 0.54, { type: 'sawtooth', f0: mtof(m), peak: 0.1, attack: 0.02, decay: 0.9, dest: lp2 });
    v.tone(t + 0.54, { f0: mtof(38), peak: 0.3, decay: 0.7 });
  },

  announceTimeUp(v, t) {
    v.tone(t, { f0: 1568, peak: 0.1, attack: 0.001, decay: 0.5 });
    const lp = v.filter('lowpass', 2000);
    const g = v.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.3, t + 0.01);
    g.gain.setValueAtTime(0.3, t + 0.75);
    g.gain.linearRampToValueAtTime(0, t + 0.83);
    lp.connect(g);
    g.connect(v.out);
    const parts: ReadonlyArray<readonly [OscillatorType, number]> = [['sawtooth', 150], ['sawtooth', 159], ['square', 75]];
    for (const [type, f] of parts) v.osc(type, f, t, t + 0.9).connect(lp);
  },
};

export interface SfxLimit {
  /** Max simultaneous instances; the oldest is stolen beyond that. */
  readonly max: number;
  /** Minimum seconds between two triggers (extra triggers are dropped). */
  readonly gap: number;
}

export const DEFAULT_LIMIT: SfxLimit = { max: 2, gap: 0.1 };

export const SFX_LIMITS: Readonly<Partial<Record<SfxName, SfxLimit>>> = {
  rifle: { max: 5, gap: 0.03 },
  rifleDash: { max: 3, gap: 0.05 },
  cannon: { max: 4, gap: 0.04 },
  bombThrow: { max: 3, gap: 0.05 },
  missileLaunch: { max: 4, gap: 0.04 },
  hyperCharge: { max: 2, gap: 0.1 },
  hyperShot: { max: 2, gap: 0.08 },
  laserCharge: { max: 2, gap: 0.2 },
  explosionSmall: { max: 5, gap: 0.035 },
  explosionBig: { max: 3, gap: 0.06 },
  mechExplode: { max: 1, gap: 0.4 },
  hit: { max: 4, gap: 0.03 },
  hitHeavy: { max: 3, gap: 0.05 },
  guardHit: { max: 3, gap: 0.04 },
  down: { max: 2, gap: 0.1 },
  dash: { max: 3, gap: 0.06 },
  airDash: { max: 3, gap: 0.06 },
  jump: { max: 2, gap: 0.06 },
  land: { max: 3, gap: 0.05 },
  step: { max: 4, gap: 0.035 },
  swing: { max: 2, gap: 0.05 },
  slash: { max: 3, gap: 0.04 },
  lockOn: { max: 1, gap: 0.12 },
  empty: { max: 2, gap: 0.08 },
  alarm: { max: 1, gap: 0.5 },
  uiMove: { max: 3, gap: 0.03 },
  uiSelect: { max: 2, gap: 0.05 },
  uiBack: { max: 2, gap: 0.05 },
  uiConfirmBig: { max: 1, gap: 0.15 },
};

/** Tonal cues that must stay in tune (no random pitch variation). */
export const STABLE_PITCH: ReadonlySet<SfxName> = new Set<SfxName>([
  'lockOn', 'empty', 'alarm', 'uiMove', 'uiSelect', 'uiBack', 'uiConfirmBig',
  'announceRound', 'announceReady', 'announceGo', 'announceFinish', 'announceWin', 'announceLose', 'announceTimeUp',
]);

// --- loops -------------------------------------------------------------------------------------

export const DUMMY_LOOP: LoopHandle = {
  set() {
    /* audio not ready */
  },
  stop() {
    /* audio not ready */
  },
};

/** A sustained, controllable sound (beam roar, jet hiss). */
export class LoopVoice implements LoopHandle {
  private readonly out: GainNode;
  private readonly panner: StereoPannerNode | null = null;
  private readonly nodes: AudioNode[] = [];
  private readonly srcs: AudioScheduledSourceNode[] = [];
  /** Params that follow the pitch multiplier, with their base values. */
  private readonly pitched: { p: AudioParam; base: number }[] = [];
  private readonly level: number;
  private volume: number;
  private stopped = false;

  constructor(private readonly ctx: BaseAudioContext, bufs: NoiseBuffers, dest: AudioNode, name: LoopName, opts: PlayOpts | undefined) {
    this.volume = clamp(opts?.volume ?? 1, 0, 4);
    const pitch = clamp(opts?.pitch ?? 1, 0.25, 4);
    const now = ctx.currentTime;
    this.out = this.node(ctx.createGain());
    this.out.gain.value = 0;
    if (typeof ctx.createStereoPanner === 'function') {
      this.panner = this.node(ctx.createStereoPanner());
      this.panner.pan.value = clamp(opts?.pan ?? 0, -1, 1);
      this.out.connect(this.panner);
      this.panner.connect(dest);
    } else {
      this.out.connect(dest);
    }
    const amp = this.node(ctx.createGain());
    amp.connect(this.out);

    if (name === 'laser') {
      this.level = 0.4;
      const lp = this.filter('lowpass', 1300, 5);
      const mix = this.gain(0.33);
      mix.connect(lp);
      lp.connect(amp);
      this.osc('sawtooth', 55, 0).connect(mix);
      this.osc('sawtooth', 55, 14).connect(mix);
      this.osc('sawtooth', 110, -9).connect(mix);
      const wob = this.gain(500);
      this.osc('sine', 7, 0, false).connect(wob);
      wob.connect(lp.frequency);
      const bp = this.filter('bandpass', 2600, 0.7);
      const ng = this.gain(0.18);
      this.noise(bufs.white).connect(bp);
      bp.connect(ng);
      ng.connect(amp);
      const whine = this.osc('sine', 880, 0);
      const vib = this.gain(14);
      this.osc('sine', 9, 0, false).connect(vib);
      vib.connect(whine.frequency);
      const wg = this.gain(0.05);
      whine.connect(wg);
      wg.connect(amp);
      const flutter = this.gain(0.15);
      this.osc('sine', 23, 0, false).connect(flutter);
      flutter.connect(amp.gain);
      this.pitched.push({ p: lp.frequency, base: 1300 }, { p: bp.frequency, base: 2600 });
    } else {
      this.level = 0.35;
      const bp = this.filter('bandpass', 1200, 0.6);
      const g1 = this.gain(0.5);
      this.noise(bufs.white).connect(bp);
      bp.connect(g1);
      g1.connect(amp);
      const lp = this.filter('lowpass', 380, 0.7);
      const g2 = this.gain(0.7);
      this.noise(bufs.pink).connect(lp);
      lp.connect(g2);
      g2.connect(amp);
      const lp2 = this.filter('lowpass', 260, 0.7);
      const g3 = this.gain(0.25);
      this.osc('sawtooth', 72, 0).connect(lp2);
      lp2.connect(g3);
      g3.connect(amp);
      const flutter = this.gain(0.08);
      this.osc('sine', 13, 0, false).connect(flutter);
      flutter.connect(amp.gain);
      this.pitched.push({ p: bp.frequency, base: 1200 }, { p: lp.frequency, base: 380 }, { p: lp2.frequency, base: 260 });
    }
    for (const { p, base } of this.pitched) p.value = base * pitch;
    for (const s of this.srcs) s.start(now);
    this.out.gain.setTargetAtTime(this.volume * this.level, now, 0.02);
  }

  private node<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  private gain(v: number): GainNode {
    const g = this.node(this.ctx.createGain());
    g.gain.value = v;
    return g;
  }

  private filter(type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
    const f = this.node(this.ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  /** Oscillator; `pitched` ones follow set({pitch}). LFOs pass pitched=false. */
  private osc(type: OscillatorType, freq: number, detune: number, pitched = true): OscillatorNode {
    const o = this.node(this.ctx.createOscillator());
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    this.srcs.push(o);
    if (pitched) this.pitched.push({ p: o.frequency, base: freq });
    return o;
  }

  private noise(buf: AudioBuffer): AudioBufferSourceNode {
    const s = this.node(this.ctx.createBufferSource());
    s.buffer = buf;
    s.loop = true;
    this.srcs.push(s);
    return s;
  }

  set(p: { volume?: number; pitch?: number; pan?: number }): void {
    if (this.stopped) return;
    const now = this.ctx.currentTime;
    try {
      if (p.volume !== undefined && Number.isFinite(p.volume)) {
        this.volume = clamp(p.volume, 0, 4);
        this.out.gain.setTargetAtTime(this.volume * this.level, now, 0.04);
      }
      if (p.pitch !== undefined && Number.isFinite(p.pitch)) {
        const k = clamp(p.pitch, 0.25, 4);
        for (const { p: param, base } of this.pitched) param.setTargetAtTime(base * k, now, 0.05);
      }
      if (p.pan !== undefined && Number.isFinite(p.pan) && this.panner) {
        this.panner.pan.setTargetAtTime(clamp(p.pan, -1, 1), now, 0.04);
      }
    } catch {
      /* never break the game loop */
    }
  }

  stop(fade = 0.15): void {
    if (this.stopped) return;
    this.stopped = true;
    const now = this.ctx.currentTime;
    const f = Math.max(0.01, Number.isFinite(fade) ? fade : 0.15);
    try {
      const g = this.out.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + f);
    } catch {
      /* ignore */
    }
    let live = this.srcs.length;
    const done = (): void => {
      if (--live > 0) return;
      for (const n of this.nodes) {
        try {
          n.disconnect();
        } catch {
          /* already disconnected */
        }
      }
    };
    for (const s of this.srcs) {
      s.onended = done;
      try {
        s.stop(now + f + 0.05);
      } catch {
        done();
      }
    }
  }
}
