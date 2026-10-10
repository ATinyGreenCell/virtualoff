/**
 * Master signal chain, shared by the live engine and offline test renders:
 *
 *   songs ──► musicIn ─► musicVol ─► duck ──┐
 *   sends ──► reverbIn ─► hall reverb ──────┤ (inside musicVol)
 *   sfx ────► sfxIn ───► sfxVol ────────────┼─► rumble HP ─► glue comp ─► warmth ─► limiter ─► clipper ─► master
 */
import { gainNode, impulse } from './dsp';

/** Static trims that balance the music bed against the effects (set from loudness measurements). */
export const MUSIC_TRIM = 1;
export const SFX_TRIM = 2.2;

/**
 * DynamicsCompressorNode adds automatic makeup gain (the spec's (1/fullRangeGain)^0.6). These are
 * the measured below-threshold gains for the settings used here; the chain divides them back out
 * so every stage is unity gain until it actually compresses and the trims above mean what they say.
 */
const GLUE_MAKEUP_DB = 5.12;
const LIMITER_MAKEUP_DB = 2.1;
const undoDb = (db: number) => Math.pow(10, -db / 20);

function curve(fn: (x: number) => number, n = 4096) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
  return c;
}

/** Transparent below 0.8, then a smooth knee into a hard ceiling just under full scale. */
const clipCurve = curve((x) => {
  const a = Math.abs(x);
  return a <= 0.8 ? x : Math.sign(x) * (0.8 + 0.18 * Math.tanh((a - 0.8) / 0.18));
});
/** Gentle tanh saturation with unity small-signal gain; the curve spans ±4 (fed through a 1/4 pre-gain) so overshoots bend instead of hard-clipping. */
const WARM_RANGE = 4;
const warmCurve = curve((x) => Math.tanh(x * WARM_RANGE * 1.15) / 1.15);

export class Mixer {
  readonly musicIn: GainNode;
  readonly reverbIn: GainNode;
  readonly sfxIn: GainNode;
  readonly musicVol: GainNode;
  readonly duck: GainNode;
  readonly sfxVol: GainNode;
  readonly master: GainNode;
  private readonly nodes: AudioNode[] = [];

  constructor(ctx: BaseAudioContext, dest: AudioNode) {
    this.master = gainNode(ctx, 1, dest);
    const clip = ctx.createWaveShaper();
    clip.curve = clipCurve as Float32Array<ArrayBuffer>;
    clip.oversample = '2x';
    clip.connect(this.master);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 1;
    limiter.ratio.value = 18;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.09;
    const limiterOut = gainNode(ctx, undoDb(LIMITER_MAKEUP_DB), clip);
    limiter.connect(limiterOut);
    const warmth = ctx.createWaveShaper();
    warmth.curve = warmCurve as Float32Array<ArrayBuffer>;
    warmth.oversample = '2x';
    warmth.connect(limiter);
    const warmIn = gainNode(ctx, 1 / WARM_RANGE, warmth);
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -18;
    glue.knee.value = 8;
    glue.ratio.value = 2.5;
    glue.attack.value = 0.012;
    glue.release.value = 0.16;
    const glueOut = gainNode(ctx, undoDb(GLUE_MAKEUP_DB), warmIn);
    glue.connect(glueOut);
    const rumble = ctx.createBiquadFilter();
    rumble.type = 'highpass';
    rumble.frequency.value = 24;
    rumble.Q.value = 0.6;
    rumble.connect(glue);

    this.duck = gainNode(ctx, 1, rumble);
    this.musicVol = gainNode(ctx, 1, this.duck);
    this.musicIn = gainNode(ctx, MUSIC_TRIM, this.musicVol);
    this.reverbIn = gainNode(ctx, 1);
    const hall = ctx.createConvolver();
    hall.buffer = impulse(ctx, 1.8, 2.6);
    this.reverbIn.connect(hall);
    hall.connect(gainNode(ctx, 0.9 * MUSIC_TRIM, this.musicVol));

    this.sfxVol = gainNode(ctx, 1, rumble);
    this.sfxIn = gainNode(ctx, SFX_TRIM, this.sfxVol);
    this.nodes.push(this.master, clip, limiterOut, limiter, warmth, warmIn, glueOut, glue, rumble, this.duck, this.musicVol, this.musicIn, this.reverbIn, hall, this.sfxVol, this.sfxIn);
  }

  dispose() {
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        // ignore
      }
    }
  }
}
