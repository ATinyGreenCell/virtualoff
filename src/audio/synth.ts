/**
 * Low-level WebAudio building blocks shared by the SFX and the music sequencer:
 * cached noise buffers, envelopes, and a self-cleaning `Voice` graph builder.
 */

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Smallest value used as the target of exponential ramps (they cannot reach 0). */
export const SILENT = 0.0001;

export interface NoiseBuffers {
  readonly white: AudioBuffer;
  readonly pink: AudioBuffer;
}

/** Two seconds of white and pink noise (Paul Kellet's filter), generated once per context. */
export function makeNoise(ctx: BaseAudioContext): NoiseBuffers {
  const len = Math.floor(ctx.sampleRate * 2);
  const white = ctx.createBuffer(1, len, ctx.sampleRate);
  const w = white.getChannelData(0);
  for (let i = 0; i < len; i++) w[i] = Math.random() * 2 - 1;

  const pink = ctx.createBuffer(1, len, ctx.sampleRate);
  const p = pink.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const x = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + x * 0.0555179;
    b1 = 0.99332 * b1 + x * 0.0750759;
    b2 = 0.969 * b2 + x * 0.153852;
    b3 = 0.8665 * b3 + x * 0.3104856;
    b4 = 0.55 * b4 + x * 0.5329522;
    b5 = -0.7616 * b5 - x * 0.016898;
    p[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362) * 0.11;
    b6 = x * 0.115926;
  }
  return { white, pink };
}

/** Stereo, slightly darkened noise-tail impulse response for a small "arcade cabinet" room. */
export function makeImpulse(ctx: BaseAudioContext, seconds = 1.6, decay = 2.8): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  const pre = Math.floor(rate * 0.012);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      lp += 0.38 * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

/**
 * Attack / decay / sustain / release on `p`, holding the note for `hold` seconds after `t`.
 * Returns the time the release completes.
 */
export function adsr(
  p: AudioParam,
  t: number,
  hold: number,
  a: number,
  d: number,
  peak: number,
  sus: number,
  r: number,
): number {
  const tA = t + a;
  const tD = Math.max(tA + 0.002, Math.min(tA + d, t + hold));
  const s = Math.max(sus, SILENT);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(Math.max(peak, SILENT), tA);
  p.exponentialRampToValueAtTime(s, tD);
  const tR = Math.max(tD, t + hold);
  p.setValueAtTime(s, tR);
  p.exponentialRampToValueAtTime(SILENT, tR + r);
  p.setValueAtTime(0, tR + r + 0.001);
  return tR + r;
}

export interface ToneOpts {
  type?: OscillatorType;
  f0: number;
  /** End frequency of the pitch sweep (defaults to f0 = no sweep). */
  f1?: number;
  /** Sweep duration (defaults to the whole envelope). */
  sweep?: number;
  /** Linear instead of exponential sweep. */
  lin?: boolean;
  peak: number;
  attack?: number;
  decay: number;
  /** Cents. */
  detune?: number;
  dest?: AudioNode;
}

export interface NoiseOpts {
  peak: number;
  attack?: number;
  decay: number;
  type?: BiquadFilterType;
  freq?: number;
  q?: number;
  /** Filter frequency sweep target. */
  to?: number;
  sweep?: number;
  pink?: boolean;
  rate?: number;
  dest?: AudioNode;
}

/**
 * A short-lived sub-graph (one sound effect or one music note). Every node created through it is
 * tracked; when the last scheduled source ends, the whole graph is disconnected.
 */
export class Voice {
  readonly out: GainNode;
  onDone: (() => void) | null = null;
  private readonly nodes: AudioNode[] = [];
  private readonly srcs: AudioScheduledSourceNode[] = [];
  private live = 0;
  private dead = false;

  constructor(
    readonly ctx: BaseAudioContext,
    private readonly bufs: NoiseBuffers,
    dest: AudioNode,
    volume = 1,
    pan = 0,
  ) {
    const out = ctx.createGain();
    out.gain.value = volume;
    this.out = out;
    this.nodes.push(out);
    if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      out.connect(p);
      p.connect(dest);
      this.nodes.push(p);
    } else {
      out.connect(dest);
    }
  }

  private track<T extends AudioScheduledSourceNode>(s: T): T {
    this.srcs.push(s);
    this.nodes.push(s);
    this.live++;
    s.onended = () => this.ended();
    return s;
  }

  private ended(): void {
    if (--this.live > 0 || this.dead) return;
    this.dead = true;
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.onDone?.();
  }

  /** Fade out quickly and stop everything now (voice stealing). */
  kill(now: number): void {
    if (this.dead) return;
    const g = this.out.gain;
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + 0.015);
    } catch {
      /* ignore */
    }
    for (const s of this.srcs) {
      try {
        s.stop(now + 0.02);
      } catch {
        /* already stopped */
      }
    }
  }

  osc(type: OscillatorType, freq: number, t0: number, t1: number, detune = 0): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (detune) o.detune.setValueAtTime(detune, t0);
    o.start(t0);
    o.stop(t1);
    return this.track(o);
  }

  noise(t0: number, t1: number, pink = false, rate = 1): AudioBufferSourceNode {
    const b = pink ? this.bufs.pink : this.bufs.white;
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(t0, Math.random() * b.duration * 0.9);
    s.stop(t1);
    return this.track(s);
  }

  gain(v = 1): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    this.nodes.push(g);
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    this.nodes.push(f);
    return f;
  }

  /** Route a copy of the voice output to an effect send. */
  send(dest: AudioNode, amount: number): void {
    const g = this.gain(amount);
    this.out.connect(g);
    g.connect(dest);
  }

  /** 0 -> peak (linear attack) -> silence (exponential decay). Returns the end time. */
  perc(p: AudioParam, t: number, peak: number, attack: number, decay: number): number {
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + attack);
    p.exponentialRampToValueAtTime(SILENT, t + attack + decay);
    p.setValueAtTime(0, t + attack + decay + 0.001);
    return t + attack + decay;
  }

  /** Linear rise from `from` to `to`, then exponential release to silence. */
  swell(p: AudioParam, t: number, from: number, to: number, rise: number, release: number): number {
    p.setValueAtTime(from, t);
    p.linearRampToValueAtTime(to, t + rise);
    p.exponentialRampToValueAtTime(SILENT, t + rise + release);
    p.setValueAtTime(0, t + rise + release + 0.001);
    return t + rise + release;
  }

  ramp(p: AudioParam, t: number, from: number, to: number, dur: number, lin = false): void {
    p.setValueAtTime(from, t);
    if (lin) p.linearRampToValueAtTime(to, t + dur);
    else p.exponentialRampToValueAtTime(Math.max(to, SILENT), t + dur);
  }

  /** Enveloped oscillator with optional pitch sweep. */
  tone(t: number, o: ToneOpts): { osc: OscillatorNode; g: GainNode } {
    const attack = o.attack ?? 0.002;
    const end = t + attack + o.decay;
    const osc = this.osc(o.type ?? 'sine', o.f0, t, end + 0.02, o.detune ?? 0);
    if (o.f1 !== undefined && o.f1 !== o.f0) this.ramp(osc.frequency, t, o.f0, o.f1, o.sweep ?? attack + o.decay, o.lin);
    const g = this.gain(0);
    this.perc(g.gain, t, o.peak, attack, o.decay);
    osc.connect(g);
    g.connect(o.dest ?? this.out);
    return { osc, g };
  }

  /** Enveloped (optionally filtered / swept) noise burst. */
  noiseBurst(t: number, o: NoiseOpts): GainNode {
    const attack = o.attack ?? 0.002;
    const end = t + attack + o.decay;
    const n = this.noise(t, end + 0.02, o.pink ?? false, o.rate ?? 1);
    let head: AudioNode = n;
    if (o.type) {
      const freq = o.freq ?? 1000;
      const f = this.filter(o.type, freq, o.q ?? 0.7);
      if (o.to !== undefined) this.ramp(f.frequency, t, freq, o.to, o.sweep ?? attack + o.decay);
      n.connect(f);
      head = f;
    }
    const g = this.gain(0);
    this.perc(g.gain, t, o.peak, attack, o.decay);
    head.connect(g);
    g.connect(o.dest ?? this.out);
    return g;
  }

  /** Gated tone (flat sustain, tiny attack/release) — beeps and UI blips. */
  blip(t: number, type: OscillatorType, f: number, dur: number, peak: number, dest?: AudioNode, f1?: number): OscillatorNode {
    const osc = this.osc(type, f, t, t + dur + 0.03);
    if (f1 !== undefined) this.ramp(osc.frequency, t, f, f1, dur);
    const g = this.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.003);
    g.gain.setValueAtTime(peak, t + Math.max(dur, 0.004));
    g.gain.linearRampToValueAtTime(0, t + Math.max(dur, 0.004) + 0.02);
    osc.connect(g);
    g.connect(dest ?? this.out);
    return osc;
  }
}
