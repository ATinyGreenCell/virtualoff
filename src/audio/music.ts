/**
 * Music: synth instruments, a lookahead step sequencer and crossfading track playback.
 */
import { SILENT, Voice, adsr, makeImpulse, type NoiseBuffers } from './synth';
import {
  HIT,
  STEPS_PER_BAR,
  chordAt,
  mtof,
  parseTrack,
  rootAbove,
  rowAt,
  voiceChord,
  type Chord,
  type LeadPreset,
  type ParsedTrack,
} from './theory';
import { TRACKS } from './tracks';
import type { MusicTrack } from './types';

/** How far ahead (seconds) notes are scheduled, and how often the scheduler wakes up. */
const LOOKAHEAD = 0.12;
const TICK_MS = 25;
/** Stab / pad / arp voicings start at this MIDI note. */
const CHORD_LOW = 57;
const PAD_LOW = 55;
const ARP_LOW = 60;

/** Lower the level of very high lead notes so square/saw leads don't get shrill. */
function keyTrack(midi: number): number {
  return Math.min(1, Math.max(0.55, 1 - (midi - 76) * 0.03));
}

/** Synth instruments writing into one track instance's dry / delay / reverb buses. */
class Instruments {
  private lastOpenHat: GainNode | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly bufs: NoiseBuffers,
    private readonly dry: AudioNode,
    private readonly dly: AudioNode,
    private readonly rev: AudioNode,
  ) {}

  private voice(): Voice {
    return new Voice(this.ctx, this.bufs, this.dry);
  }

  kick(t: number, vel: number): void {
    const v = this.voice();
    const { osc } = v.tone(t, { f0: 165, f1: 52, sweep: 0.09, peak: 0.8 * vel, attack: 0.002, decay: 0.34 });
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.3);
    v.noiseBurst(t, { peak: 0.18 * vel, decay: 0.008, type: 'highpass', freq: 1500 });
  }

  clap(t: number, vel: number): void {
    const v = this.voice();
    const bp = v.filter('bandpass', 1150, 0.9);
    const hp = v.filter('highpass', 500);
    const g = v.gain(0);
    const n = v.noise(t, t + 0.3);
    n.connect(bp);
    bp.connect(hp);
    hp.connect(g);
    g.connect(v.out);
    // three quick re-triggers then a tail: the classic drum-machine clap
    const a = 0.34 * vel;
    g.gain.setValueAtTime(0, t);
    for (let k = 0; k < 3; k++) {
      const tk = t + k * 0.0095;
      g.gain.setValueAtTime(a, tk);
      g.gain.exponentialRampToValueAtTime(a * 0.12, tk + 0.0085);
    }
    g.gain.setValueAtTime(a * 0.85, t + 0.0285);
    g.gain.exponentialRampToValueAtTime(SILENT, t + 0.24);
    v.tone(t, { type: 'triangle', f0: 205, f1: 165, sweep: 0.08, peak: 0.13 * vel, decay: 0.09 });
    v.send(this.rev, 0.3);
  }

  snare(t: number, vel: number): void {
    const v = this.voice();
    v.noiseBurst(t, { peak: 0.28 * vel, decay: 0.13, type: 'bandpass', freq: 1900, q: 0.7 });
    v.tone(t, { type: 'triangle', f0: 230, f1: 185, sweep: 0.06, peak: 0.17 * vel, decay: 0.07 });
    v.send(this.rev, 0.2);
  }

  tom(t: number, f: number, vel: number): void {
    const v = this.voice();
    v.tone(t, { f0: f * 1.7, f1: f, sweep: 0.06, peak: 0.4 * vel, decay: 0.26 });
    v.noiseBurst(t, { peak: 0.07 * vel, decay: 0.02, type: 'lowpass', freq: 3000 });
    v.send(this.rev, 0.15);
  }

  hat(t: number, open: boolean, vel: number): void {
    const v = this.voice();
    if (open) {
      // separate choke stage so a following closed hat can cut the tail without
      // disturbing the open hat's own envelope
      const choke = v.gain(1);
      choke.connect(v.out);
      v.noiseBurst(t, { peak: 0.1 * vel, decay: 0.26, type: 'highpass', freq: 6500, dest: choke });
      this.lastOpenHat = choke;
    } else {
      v.noiseBurst(t, { peak: 0.12 * vel, decay: 0.045, type: 'highpass', freq: 7800 });
      if (this.lastOpenHat) {
        this.lastOpenHat.gain.setValueAtTime(1, t);
        this.lastOpenHat.gain.setTargetAtTime(0, t, 0.006);
        this.lastOpenHat = null;
      }
    }
  }

  crash(t: number): void {
    const v = this.voice();
    v.noiseBurst(t, { peak: 0.12, decay: 1.5, type: 'highpass', freq: 4200 });
    v.noiseBurst(t, { peak: 0.05, decay: 0.9, type: 'bandpass', freq: 8200, q: 1.5 });
    v.send(this.rev, 0.35);
  }

  /** FM "slap" bass: index envelope gives the bright pluck. */
  bassFM(t: number, midi: number, dur: number, vel: number): void {
    const v = this.voice();
    const f = mtof(midi);
    const end = t + dur + 0.08;
    const car = v.osc('sine', f, t, end);
    const mod = v.osc('sine', f, t, end);
    const mg = v.gain(0);
    mg.gain.setValueAtTime(f * 3.2 * vel, t);
    mg.gain.exponentialRampToValueAtTime(f * 0.5, t + 0.15);
    mod.connect(mg);
    mg.connect(car.frequency);
    const body = v.osc('triangle', f, t, end, 5);
    const bg = v.gain(0.35);
    body.connect(bg);
    const lp = v.filter('lowpass', 2600, 0.8);
    const amp = v.gain(0);
    adsr(amp.gain, t, dur, 0.003, 0.12, 0.34 * vel, 0.19 * vel, 0.045);
    car.connect(lp);
    bg.connect(lp);
    lp.connect(amp);
    amp.connect(v.out);
    v.noiseBurst(t, { peak: 0.045 * vel, decay: 0.012, type: 'highpass', freq: 2500 });
  }

  /** Resonant saw/square bass with a snappy filter envelope (303-ish). */
  bassSaw(t: number, midi: number, dur: number, vel: number, accent: boolean): void {
    const v = this.voice();
    const f = mtof(midi);
    const end = t + dur + 0.08;
    const o1 = v.osc('sawtooth', f, t, end);
    const o2 = v.osc('square', f, t, end, -7);
    const g2 = v.gain(0.45);
    o2.connect(g2);
    const lp = v.filter('lowpass', 2000, accent ? 9 : 6);
    v.ramp(lp.frequency, t, accent ? 3000 : 2000, 240, 0.14);
    const amp = v.gain(0);
    adsr(amp.gain, t, dur, 0.003, 0.09, 0.28 * vel, 0.15 * vel, 0.04);
    o1.connect(lp);
    g2.connect(lp);
    lp.connect(amp);
    amp.connect(v.out);
  }

  lead(t: number, midi: number, dur: number, glideFrom: number | null, P: LeadPreset): void {
    const v = this.voice();
    const f = mtof(midi);
    const end = t + dur + 0.14;
    const lvl = P.level * keyTrack(midi);
    const o1 = v.osc(P.w1, f, t, end);
    const o2 = v.osc(P.w2, f, t, end, P.detune);
    if (glideFrom !== null && glideFrom !== midi) {
      const f0 = mtof(glideFrom);
      for (const o of [o1, o2]) {
        o.frequency.setValueAtTime(f0, t);
        o.frequency.exponentialRampToValueAtTime(f, t + 0.035);
      }
    }
    if (dur > 0.2) {
      // delayed vibrato on held notes
      const lfo = v.osc('sine', 5.6, t, end);
      const lg = v.gain(0);
      lg.gain.setValueAtTime(0, t + 0.14);
      lg.gain.linearRampToValueAtTime(P.vib, t + Math.min(dur, 0.45));
      lfo.connect(lg);
      lg.connect(o1.detune);
      lg.connect(o2.detune);
    }
    const g2 = v.gain(0.7);
    o2.connect(g2);
    const lp = v.filter('lowpass', P.cutoff, P.q);
    lp.frequency.setValueAtTime(P.cutoff * 1.5, t);
    lp.frequency.exponentialRampToValueAtTime(P.cutoff * 0.8, t + 0.3);
    const amp = v.gain(0);
    adsr(amp.gain, t, dur, 0.006, 0.16, lvl, lvl * 0.72, 0.09);
    o1.connect(lp);
    g2.connect(lp);
    lp.connect(amp);
    amp.connect(v.out);
    v.send(this.dly, 0.3);
    v.send(this.rev, 0.22);
  }

  stab(t: number, midis: readonly number[], dur: number, vel: number): void {
    const v = this.voice();
    const len = Math.min(dur, 0.32);
    const end = t + len + 0.14;
    const mix = v.gain(1.5 / (midis.length * 2));
    for (const m of midis) {
      const f = mtof(m);
      v.osc('sawtooth', f, t, end, -7).connect(mix);
      v.osc('sawtooth', f, t, end, 7).connect(mix);
    }
    const lp = v.filter('lowpass', 5200, 1.4);
    v.ramp(lp.frequency, t, 5200, 1100, 0.18);
    const amp = v.gain(0);
    adsr(amp.gain, t, len * 0.6, 0.003, 0.07, 0.16 * vel, 0.065 * vel, 0.08);
    mix.connect(lp);
    lp.connect(amp);
    amp.connect(v.out);
    v.send(this.dly, 0.22);
    v.send(this.rev, 0.18);
  }

  pad(t: number, midis: readonly number[], dur: number): void {
    const v = this.voice();
    const end = t + dur + 0.5;
    const mix = v.gain(1 / (midis.length * 2));
    for (const m of midis) {
      const f = mtof(m);
      v.osc('sawtooth', f, t, end, -10).connect(mix);
      v.osc('sawtooth', f, t, end, 10).connect(mix);
    }
    const lp = v.filter('lowpass', 1500, 0.6);
    const amp = v.gain(0);
    const attack = Math.min(0.22, dur * 0.5);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(0.12, t + attack);
    amp.gain.setValueAtTime(0.12, t + Math.max(dur, attack));
    amp.gain.linearRampToValueAtTime(0, t + Math.max(dur, attack) + 0.4);
    mix.connect(lp);
    lp.connect(amp);
    amp.connect(v.out);
    v.send(this.rev, 0.4);
  }

  pluck(t: number, midi: number, dur: number): void {
    const v = this.voice();
    const d = Math.min(0.2, dur + 0.06);
    const o = v.osc('square', mtof(midi), t, t + d + 0.03);
    const lp = v.filter('lowpass', 4200, 3);
    v.ramp(lp.frequency, t, 4200, 700, 0.09);
    const amp = v.gain(0);
    v.perc(amp.gain, t, 0.08, 0.002, d);
    o.connect(lp);
    lp.connect(amp);
    amp.connect(v.out);
    v.send(this.dly, 0.35);
  }

  orch(t: number, chord: Chord, vel: number): void {
    const v = this.voice();
    const root = rootAbove(chord, 48);
    const third = chord.tones.length > 1 ? chord.tones[1] : 7;
    const fifth = chord.tones.length > 2 ? chord.tones[2] : 7;
    const notes = [root - 12, root, root + fifth, root + 12, root + 12 + third, root + 12 + fifth];
    const mix = v.gain(1.6 / (notes.length * 2));
    for (const m of notes) {
      const f = mtof(m);
      v.osc('sawtooth', f, t, t + 0.65, -13).connect(mix);
      v.osc('sawtooth', f, t, t + 0.65, 13).connect(mix);
    }
    const lp = v.filter('lowpass', 7500, 0.9);
    v.ramp(lp.frequency, t, 7500, 1400, 0.32);
    const amp = v.gain(0);
    v.perc(amp.gain, t, 0.28 * vel, 0.003, 0.55);
    mix.connect(lp);
    lp.connect(amp);
    amp.connect(v.out);
    v.noiseBurst(t, { peak: 0.15 * vel, decay: 0.07, type: 'bandpass', freq: 1700, q: 0.8 });
    v.tone(t, { f0: mtof(root - 12), f1: mtof(root - 24), sweep: 0.15, peak: 0.28 * vel, decay: 0.22 });
    v.send(this.rev, 0.4);
  }

  /** Fill / extra-percussion hit codes (see theory.HIT). */
  perc(t: number, code: number): void {
    switch (code) {
      case HIT.snare:
        this.snare(t, 1);
        break;
      case HIT.snareAccent:
        this.snare(t, 1.3);
        break;
      case HIT.tomLow:
        this.tom(t, 98, 1);
        break;
      case HIT.tomMid:
        this.tom(t, 131, 1);
        break;
      case HIT.tomHigh:
        this.tom(t, 175, 1);
        break;
      case HIT.clap:
        this.clap(t, 1);
        break;
      default:
        break;
    }
  }
}

/** One playing track: owns its faders (for crossfades) and its scheduler position. */
class MusicInstance {
  finished = false;
  stopping = false;
  private readonly inst: Instruments;
  private readonly faders: GainNode[];
  private sec = 0;
  private bar = 0;
  private step = 0;
  /** Absolute step counter (for legato detection across bars). */
  private abs = 0;
  private nextTime = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private leadEnd = -1;
  private leadMidi = 0;
  private errors = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    readonly name: MusicTrack,
    private readonly track: ParsedTrack,
    bufs: NoiseBuffers,
    out: AudioNode,
    delayIn: AudioNode,
    reverbIn: AudioNode,
  ) {
    const fader = (dest: AudioNode): GainNode => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(dest);
      return g;
    };
    const dry = fader(out);
    const dly = fader(delayIn);
    const rev = fader(reverbIn);
    this.faders = [dry, dly, rev];
    this.inst = new Instruments(ctx, bufs, dry, dly, rev);
  }

  start(at: number): void {
    for (const f of this.faders) {
      f.gain.setValueAtTime(0, at);
      f.gain.linearRampToValueAtTime(1, at + 0.08);
    }
    this.nextTime = at;
    this.tick();
  }

  stop(fade: number): void {
    if (this.stopping) return;
    this.stopping = true;
    this.clearTimer();
    const now = this.ctx.currentTime;
    const f = Math.max(0.02, Number.isFinite(fade) ? fade : 0.4);
    for (const g of this.faders) {
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(0, now + f);
    }
    setTimeout(() => this.dispose(), (f + 0.6) * 1000);
  }

  private finish(): void {
    this.finished = true;
    this.clearTimer();
    // let the last notes (and reverb/delay tails fed by them) ring out before disconnecting
    setTimeout(() => this.dispose(), 4000);
  }

  private dispose(): void {
    for (const g of this.faders) {
      try {
        g.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private readonly tick = (): void => {
    this.timer = null;
    if (this.stopping || this.finished) return;
    const sd = this.track.stepDur;
    const now = this.ctx.currentTime;
    if (this.nextTime < now - 0.25) {
      // We fell behind (throttled background tab): skip ahead silently, keeping the
      // musical position consistent with the clock instead of replaying a backlog.
      while (this.nextTime < now) {
        this.nextTime += sd;
        if (!this.advance()) {
          this.finish();
          return;
        }
      }
    }
    while (this.nextTime < now + LOOKAHEAD) {
      const t = this.nextTime;
      try {
        this.scheduleStep(t);
      } catch (err) {
        if (this.errors++ === 0) console.error(`[audio] music step failed (${this.name})`, err);
      }
      this.nextTime += sd;
      if (!this.advance()) {
        this.finish();
        return;
      }
    }
    this.timer = setTimeout(this.tick, TICK_MS);
  };

  /** Move to the next step. Returns false when a one-shot track has ended. */
  private advance(): boolean {
    this.abs++;
    if (++this.step < STEPS_PER_BAR) return true;
    this.step = 0;
    if (++this.bar < this.track.sections[this.sec].bars) return true;
    this.bar = 0;
    if (++this.sec < this.track.sections.length) return true;
    if (!this.track.loop) return false;
    this.sec = this.track.loopStart;
    return true;
  }

  private scheduleStep(t: number): void {
    const S = this.track.sections[this.sec];
    const b = this.bar;
    const s = this.step;
    const sd = this.track.stepDur;
    const I = this.inst;
    const chord = chordAt(S, b, s);

    if (S.crash && b === 0 && s === 0) I.crash(t);

    const k = rowAt(S.kick, b)?.[s];
    if (k) I.kick(t, k.v === HIT.accent ? 1.1 : 1);

    if (b === S.bars - 1 && S.fill) {
      const f = S.fill[s];
      if (f) I.perc(t, f.v);
    } else {
      const c = rowAt(S.clap, b)?.[s];
      if (c) I.clap(t, c.v === HIT.accent ? 1.15 : 1);
      const h = rowAt(S.hat, b)?.[s];
      if (h) I.hat(t, h.v === HIT.open, h.v === HIT.accent ? 1.25 : s % 4 === 0 ? 1 : 0.8);
      const p = rowAt(S.perc, b)?.[s];
      if (p) I.perc(t, p.v);
    }

    const bn = rowAt(S.bass, b)?.[s];
    if (bn) {
      const midi = rootAbove(chord, this.track.bassLow) + bn.v;
      const dur = bn.len * sd * 0.9;
      if (this.track.bassKind === 'fm') I.bassFM(t, midi, dur, s % 4 === 0 ? 1 : 0.85);
      else I.bassSaw(t, midi, dur, s % 4 === 0 ? 1 : 0.85, s % 4 === 0);
    }

    const ln = rowAt(S.lead, b)?.[s];
    if (ln) {
      const glide = this.abs === this.leadEnd ? this.leadMidi : null;
      I.lead(t, ln.v, ln.len * sd * 0.95, glide, this.track.lead);
      this.leadEnd = this.abs + ln.len;
      this.leadMidi = ln.v;
    }

    const st = rowAt(S.stab, b)?.[s];
    if (st) I.stab(t, voiceChord(chord, CHORD_LOW), st.len * sd, st.v === HIT.accent ? 1.2 : 1);

    if (S.pad) {
      const parts = S.chords[b % S.chords.length].length;
      const span = STEPS_PER_BAR / parts;
      if (s % span === 0) I.pad(t, voiceChord(chord, PAD_LOW), span * sd);
    }

    const ar = rowAt(S.arp, b)?.[s];
    if (ar) {
      const tones = voiceChord(chord, ARP_LOW);
      const n = tones.length;
      I.pluck(t, tones[ar.v % n] + 12 * Math.floor(ar.v / n) + S.arpOct, ar.len * sd);
    }

    const o = rowAt(S.orch, b)?.[s];
    if (o) I.orch(t, chord, o.v === HIT.accent ? 1.2 : 1);
  }
}

/** Shared music effects (delay + reverb) and track switching. */
export class MusicSystem {
  private readonly delay: DelayNode;
  private readonly delayIn: GainNode;
  private readonly reverbIn: GainNode;
  private current: MusicInstance | null = null;
  private readonly parsed = new Map<MusicTrack, ParsedTrack | null>();

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly out: AudioNode,
    private readonly bufs: NoiseBuffers,
  ) {
    // dotted-eighth feedback delay with a darkening filter in the loop
    this.delayIn = ctx.createGain();
    this.delay = ctx.createDelay(1.5);
    this.delay.delayTime.value = 0.3;
    const dlp = ctx.createBiquadFilter();
    dlp.type = 'lowpass';
    dlp.frequency.value = 2800;
    const fb = ctx.createGain();
    fb.gain.value = 0.3;
    const dOut = ctx.createGain();
    dOut.gain.value = 0.5;
    this.delayIn.connect(this.delay);
    this.delay.connect(dlp);
    dlp.connect(fb);
    fb.connect(this.delay);
    dlp.connect(dOut);
    dOut.connect(out);

    this.reverbIn = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.buffer = makeImpulse(ctx);
    const rOut = ctx.createGain();
    rOut.gain.value = 0.55;
    this.reverbIn.connect(conv);
    conv.connect(rOut);
    rOut.connect(out);
  }

  play(name: MusicTrack): void {
    const track = this.get(name);
    if (!track) return;
    const cur = this.current;
    if (cur && cur.name === name && track.loop && !cur.stopping && !cur.finished) return;
    const now = this.ctx.currentTime;
    if (cur) cur.stop(0.4);
    this.delay.delayTime.setTargetAtTime(Math.min(1.2, (0.75 * 60) / track.bpm), now, 0.05);
    const inst = new MusicInstance(this.ctx, name, track, this.bufs, this.out, this.delayIn, this.reverbIn);
    this.current = inst;
    inst.start(now + 0.05);
  }

  stop(fade: number): void {
    if (this.current) {
      this.current.stop(fade);
      this.current = null;
    }
  }

  private get(name: MusicTrack): ParsedTrack | null {
    if (!this.parsed.has(name)) {
      let p: ParsedTrack | null = null;
      try {
        p = parseTrack(name, TRACKS[name]);
      } catch (err) {
        console.error(`[audio] bad track data '${name}'`, err);
      }
      this.parsed.set(name, p);
    }
    return this.parsed.get(name) ?? null;
  }
}
