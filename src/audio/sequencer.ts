/**
 * Song format + compiler + player. Songs are written as chord progressions and per-channel parts;
 * the compiler expands them into a flat, sorted event list once, and the player streams those
 * events into the audio graph slightly ahead of time (2 nodes per note).
 */
import { gainNode } from './dsp';
import { bassNote, chord, midi, voicing } from './theory';

export interface ChannelSpec {
  /** default sample id */
  inst: string;
  gain: number;
  pan?: number;
  /** reverb send */
  rev?: number;
  /** delay send */
  dly?: number;
  /** sidechain pumping from the kick: 0 none, 1 light, 2 heavy */
  pump?: 0 | 1 | 2;
  /** note release (s) */
  rel?: number;
}

interface PartBase {
  vel?: number;
  /** only play in these bar indices of the section */
  only?: number[];
  except?: number[];
}

/** 16-char patterns, one per bar (cycling): '.' rest, 'o' ghost, 'x' hit, 'X' accent */
export interface DrumPart extends PartBase {
  drum: string | string[];
  sample?: string;
}
/** One string per bar (cycling): 'step:note:len[:vel]' tokens, e.g. '0:E5:3 3:D5:1' */
export interface NotesPart extends PartBase {
  notes: string | string[];
  tr?: number;
}
/** [step, semitones above the chord's bass, length in steps, sample index?] per bar */
export interface BassPart extends PartBase {
  bass: [number, number, number, number?][];
  oct?: number;
  samples?: string[];
}
/** chord hits [step, length] voiced inside [lo, hi] */
export interface ChordPart extends PartBase {
  chords: [number, number][];
  lo: number;
  hi: number;
  count?: number;
}
/** 16 chord-tone indices per bar (-1 = rest); indices past the voicing climb octaves */
export interface ArpPart extends PartBase {
  arp: number[];
  lo: number;
  hi: number;
  len?: number;
}

export type Part = DrumPart | NotesPart | BassPart | ChordPart | ArpPart;

export interface Auto {
  p: 'lp' | 'hp';
  from: number;
  to: number;
  /** bar offset within the section */
  at?: number;
  /** duration in bars (0 = jump) */
  bars: number;
}

export interface Section {
  bars: number;
  chords: string[];
  parts: Record<string, Part | Part[]>;
  auto?: Auto[];
}

export interface Song {
  bpm: number;
  /** delay of off-beat 16ths as a fraction of a step */
  swing?: number;
  loop: boolean;
  /** section index the loop returns to */
  loopFrom?: number;
  /** echo time in 16th steps */
  delay?: number;
  /** jingles: seconds to let the last notes ring */
  tail?: number;
  channels: Record<string, ChannelSpec>;
  sections: Section[];
}

export interface Ev {
  step: number;
  ch: string;
  note: number;
  vel: number;
  len: number;
  sample?: string;
}

interface AutoEv {
  step: number;
  steps: number;
  p: 'lp' | 'hp';
  from: number;
  to: number;
}

export interface Compiled {
  events: Ev[];
  autos: AutoEv[];
  totalSteps: number;
  loopStep: number;
  kickSteps: Set<number>;
}

const DRUM_VEL: Record<string, number> = { o: 0.45, x: 0.8, X: 1 };

export function compile(song: Song): Compiled {
  const events: Ev[] = [];
  const autos: AutoEv[] = [];
  const starts: number[] = [];
  let bar0 = 0;
  for (const sec of song.sections) {
    starts.push(bar0);
    const prevVoicing = new Map<object, number[]>();
    for (let b = 0; b < sec.bars; b++) {
      const sym = sec.chords[b % sec.chords.length];
      const c = chord(sym);
      const base = (bar0 + b) * 16;
      for (const [ch, entry] of Object.entries(sec.parts)) {
        for (const part of Array.isArray(entry) ? entry : [entry]) {
          if (part.only && !part.only.includes(b)) continue;
          if (part.except?.includes(b)) continue;
          const v = part.vel ?? 1;
          if ('drum' in part) {
            const pats = Array.isArray(part.drum) ? part.drum : [part.drum];
            const pat = pats[b % pats.length];
            for (let s = 0; s < 16; s++) {
              const vel = DRUM_VEL[pat[s]];
              if (vel) events.push({ step: base + s, ch, note: 0, vel: vel * v, len: 1, sample: part.sample });
            }
          } else if ('notes' in part) {
            const bars = Array.isArray(part.notes) ? part.notes : [part.notes];
            const line = bars[b % bars.length];
            for (const tok of line.split(/\s+/).filter(Boolean)) {
              const [s, n, l, vv] = tok.split(':');
              events.push({ step: base + Number(s), ch, note: midi(n) + (part.tr ?? 0), vel: (vv ? Number(vv) : 0.85) * v, len: Number(l) });
            }
          } else if ('bass' in part) {
            const root = bassNote(c, part.oct ?? 2);
            for (const [s, iv, l, si] of part.bass) {
              events.push({ step: base + s, ch, note: root + iv, vel: 0.85 * v, len: l, sample: si !== undefined && part.samples ? part.samples[si] : undefined });
            }
          } else if ('chords' in part) {
            const notes = voicing(c, part.lo, part.hi, part.count ?? 4, prevVoicing.get(part));
            prevVoicing.set(part, notes);
            for (const [s, l] of part.chords) for (const n of notes) events.push({ step: base + s, ch, note: n, vel: 0.7 * v, len: l });
          } else if ('arp' in part) {
            const notes = voicing(c, part.lo, part.hi, 4, prevVoicing.get(part));
            prevVoicing.set(part, notes);
            part.arp.forEach((idx, s) => {
              if (idx < 0) return;
              const n = notes[idx % notes.length] + 12 * Math.floor(idx / notes.length);
              events.push({ step: base + s, ch, note: n, vel: (s % 4 === 0 ? 0.85 : 0.65) * v, len: part.len ?? 1 });
            });
          }
        }
      }
    }
    for (const a of sec.auto ?? []) autos.push({ step: (bar0 + (a.at ?? 0)) * 16, steps: a.bars * 16, p: a.p, from: a.from, to: a.to });
    bar0 += sec.bars;
  }
  events.sort((a, b) => a.step - b.step);
  autos.sort((a, b) => a.step - b.step);
  const kickSteps = new Set(events.filter((e) => e.ch === 'kick').map((e) => e.step));
  return { events, autos, totalSteps: bar0 * 16, loopStep: song.loop ? starts[song.loopFrom ?? 0] * 16 : bar0 * 16, kickSteps };
}

// ------------------------------------------------------------------ playback

export interface SampleBuf {
  buffer: AudioBuffer;
  root: number;
  drum: boolean;
}

export interface MusicBus {
  musicIn: AudioNode;
  reverbIn: AudioNode;
}

interface Strip {
  input: GainNode;
  rel: number;
}

const PUMP_DEPTH = [1, 0.55, 0.22];

/** One playing song: its own channel strips, pump buses, echo and filter, feeding the music bus. */
export class SongPlayer {
  finished = false;
  /** context time at which the song (or its fade) is over */
  endTime = Infinity;
  private readonly stepDur: number;
  private readonly out: GainNode;
  private readonly lp: BiquadFilterNode;
  private readonly hp: BiquadFilterNode;
  private readonly pumps: GainNode[];
  private readonly delayIn: GainNode;
  private readonly strips = new Map<string, Strip>();
  private readonly nodes: AudioNode[] = [];
  private cursor = 0;
  private autoCursor = 0;
  private cycle = 0;
  private stopped = false;

  constructor(
    private readonly ctx: BaseAudioContext,
    bus: MusicBus,
    private readonly song: Song,
    private readonly comp: Compiled,
    private readonly lib: Map<string, SampleBuf>,
    private readonly t0: number,
    fadeIn = 0,
  ) {
    this.stepDur = 60 / song.bpm / 4;
    this.out = gainNode(ctx, fadeIn > 0 ? 0 : 1, bus.musicIn);
    if (fadeIn > 0) {
      this.out.gain.setValueAtTime(0, t0);
      this.out.gain.linearRampToValueAtTime(1, t0 + fadeIn);
    }
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 20000;
    this.lp.Q.value = 0.9;
    this.lp.connect(this.out);
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 10;
    this.hp.connect(this.lp);
    this.pumps = [gainNode(ctx, 1, this.hp), gainNode(ctx, 1, this.hp), gainNode(ctx, 1, this.hp)];
    // tempo-synced echo, filtered so repeats sit behind the dry sound
    this.delayIn = ctx.createGain();
    const dl = ctx.createDelay(2);
    dl.delayTime.value = Math.min(1.9, (song.delay ?? 3) * this.stepDur);
    const fb = gainNode(ctx, 0.33);
    const fbHp = ctx.createBiquadFilter();
    fbHp.type = 'highpass';
    fbHp.frequency.value = 350;
    const fbLp = ctx.createBiquadFilter();
    fbLp.type = 'lowpass';
    fbLp.frequency.value = 4500;
    this.delayIn.connect(dl);
    dl.connect(fb).connect(fbHp).connect(fbLp).connect(dl);
    dl.connect(gainNode(ctx, 0.8, this.pumps[1]));
    this.nodes.push(this.out, this.lp, this.hp, ...this.pumps, this.delayIn, dl, fb, fbHp, fbLp);
    for (const [name, spec] of Object.entries(song.channels)) {
      const input = gainNode(ctx, spec.gain);
      const pan = ctx.createStereoPanner();
      pan.pan.value = spec.pan ?? 0;
      input.connect(pan);
      pan.connect(this.pumps[spec.pump ?? 0]);
      this.nodes.push(input, pan);
      if (spec.rev) this.nodes.push(pan.connect(gainNode(ctx, spec.rev, bus.reverbIn)) as AudioNode);
      if (spec.dly) this.nodes.push(pan.connect(gainNode(ctx, spec.dly, this.delayIn)) as AudioNode);
      this.strips.set(name, { input, rel: spec.rel ?? 0.08 });
    }
  }

  private stepTime(step: number) {
    const loopLen = this.comp.totalSteps - this.comp.loopStep;
    const s = step + (this.cycle > 0 ? this.cycle * loopLen : 0);
    const swing = step % 2 === 1 ? (this.song.swing ?? 0) * this.stepDur : 0;
    return this.t0 + s * this.stepDur + swing;
  }

  /** Queue every event that starts before `until` (context time). */
  schedule(until: number) {
    if (this.stopped || this.finished) return;
    const evs = this.comp.events;
    for (;;) {
      if (this.cursor >= evs.length) {
        if (!this.song.loop) {
          this.finished = true;
          this.endTime = this.t0 + this.comp.totalSteps * this.stepDur + (this.song.tail ?? 1.5);
          return;
        }
        this.cycle++;
        this.cursor = evs.findIndex((e) => e.step >= this.comp.loopStep);
        this.autoCursor = this.comp.autos.findIndex((a) => a.step >= this.comp.loopStep);
        if (this.cursor < 0) return;
        if (this.autoCursor < 0) this.autoCursor = this.comp.autos.length;
      }
      const ev = evs[this.cursor];
      const t = this.stepTime(ev.step);
      if (t >= until) break;
      this.flushAutos(ev.step);
      if (t > this.ctx.currentTime - 0.05) this.play(ev, Math.max(t, this.ctx.currentTime));
      this.cursor++;
    }
  }

  private flushAutos(uptoStep: number) {
    const autos = this.comp.autos;
    while (this.autoCursor < autos.length && autos[this.autoCursor].step <= uptoStep) {
      const a = autos[this.autoCursor++];
      const t = Math.max(this.ctx.currentTime, this.stepTime(a.step));
      const p = a.p === 'lp' ? this.lp.frequency : this.hp.frequency;
      p.cancelScheduledValues(t);
      p.setValueAtTime(a.from, t);
      if (a.steps > 0) p.exponentialRampToValueAtTime(a.to, t + a.steps * this.stepDur);
    }
  }

  private play(ev: Ev, t: number) {
    const strip = this.strips.get(ev.ch);
    if (!strip) return;
    const id = ev.sample ?? this.song.channels[ev.ch].inst;
    const s = this.lib.get(id);
    if (!s) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = s.buffer;
    const g = ctx.createGain();
    src.connect(g);
    g.connect(strip.input);
    if (s.drum) {
      g.gain.value = ev.vel;
      src.start(t);
    } else {
      src.playbackRate.value = Math.pow(2, (ev.note - s.root) / 12);
      const len = ev.len * this.stepDur;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(ev.vel, t + 0.003);
      g.gain.setValueAtTime(ev.vel, t + len);
      g.gain.linearRampToValueAtTime(0, t + len + strip.rel);
      src.start(t);
      src.stop(t + len + strip.rel + 0.02);
    }
    src.onended = () => {
      src.disconnect();
      g.disconnect();
    };
    if (ev.ch === 'kick') this.pump(t);
  }

  /**
   * Sidechain: duck the pumped buses on every kick, then swell back — the dance-floor "breathing".
   * Exponential targets start from wherever the gain is, so kicks closer than the release never jump.
   */
  private pump(t: number) {
    const beat = this.stepDur * 4;
    for (let i = 1; i < 3; i++) {
      const g = this.pumps[i].gain;
      g.setTargetAtTime(PUMP_DEPTH[i], t, 0.004);
      g.setTargetAtTime(1, t + 0.014, beat * 0.3);
    }
  }

  /** Fade out and release the graph. */
  stop(fade: number) {
    if (this.stopped) return;
    this.stopped = true;
    const now = this.ctx.currentTime;
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + Math.max(0.02, fade));
    this.endTime = now + fade + 0.1;
    this.finished = true;
  }

  dispose() {
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        // already gone
      }
    }
  }
}
