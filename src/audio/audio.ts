/**
 * Procedural arcade audio engine: synthesized SFX, sustained loops, original sequenced music and an
 * optional speech-synthesis announcer. No audio files are loaded.
 *
 *   import { audio } from './audio/audio';
 *   button.onclick = () => { audio.unlock(); audio.playMusic('title'); };
 *   audio.play('rifle', { pan: -0.3 });
 */
import { MusicSystem } from './music';
import { DEFAULT_LIMIT, DUMMY_LOOP, LoopVoice, RECIPES, SFX_LIMITS, STABLE_PITCH } from './sfx';
import { Voice, clamp, makeNoise, type NoiseBuffers } from './synth';
import type { LoopHandle, LoopName, MusicTrack, PlayOpts, SfxName } from './types';

export type { LoopHandle, LoopName, MusicTrack, PlayOpts, SfxName } from './types';

type AudioGlobals = { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };

export class AudioEngine {
  /** When false, speak() is a no-op. */
  voiceEnabled = true;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private duckGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private bufs: NoiseBuffers | null = null;
  private music: MusicSystem | null = null;
  private readonly vol = { master: 1, music: 0.42, sfx: 0.8 };
  private isMuted = false;
  private pendingTrack: MusicTrack | null = null;
  private readonly voices = new Map<SfxName, Voice[]>();
  private readonly lastPlay = new Map<SfxName, number>();
  private speechVoice: SpeechSynthesisVoice | null = null;

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  get muted(): boolean {
    return this.isMuted;
  }

  set muted(m: boolean) {
    this.isMuted = m;
    this.applyMaster();
    if (m) this.cancelSpeech();
  }

  toggleMute(): boolean {
    this.muted = !this.isMuted;
    return this.isMuted;
  }

  /** Create/resume the AudioContext. Call from a user-gesture handler; safe to call repeatedly. */
  unlock(): void {
    try {
      let ctx = this.ctx;
      if (!ctx) {
        if (typeof window === 'undefined') return;
        const w = window as unknown as AudioGlobals;
        const Ctor = w.AudioContext ?? w.webkitAudioContext;
        if (!Ctor) return;
        ctx = new Ctor({ latencyHint: 'interactive' });
        this.ctx = ctx;
        this.build(ctx);
        this.primeSpeech();
      }
      if (ctx.state !== 'running') {
        try {
          // older Safari returns undefined instead of a promise
          const p: Promise<void> | undefined = ctx.resume();
          p?.catch(() => {
            /* will retry on the next gesture */
          });
        } catch {
          /* will retry on the next gesture */
        }
      }
      if (this.pendingTrack) {
        const t = this.pendingTrack;
        this.pendingTrack = null;
        this.playMusic(t);
      }
    } catch {
      /* audio unavailable — every other method stays a safe no-op */
    }
  }

  private build(ctx: AudioContext): void {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 8;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.22;
    comp.connect(ctx.destination);

    const master = ctx.createGain();
    master.connect(comp);
    const music = ctx.createGain();
    music.gain.value = this.vol.music;
    const duck = ctx.createGain();
    duck.gain.value = 1;
    music.connect(duck);
    duck.connect(master);
    const sfx = ctx.createGain();
    sfx.gain.value = this.vol.sfx;
    sfx.connect(master);

    this.master = master;
    this.musicGain = music;
    this.duckGain = duck;
    this.sfxGain = sfx;
    this.applyMaster();
    this.bufs = makeNoise(ctx);
    this.music = new MusicSystem(ctx, music, this.bufs);
  }

  private applyMaster(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    this.master.gain.setTargetAtTime(this.isMuted ? 0 : this.vol.master * 0.9, ctx.currentTime, 0.015);
  }

  play(name: SfxName, opts?: PlayOpts): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.sfxGain || !this.bufs || this.isMuted) return;
    const recipe = RECIPES[name];
    if (!recipe) return;
    try {
      const now = ctx.currentTime;
      const lim = SFX_LIMITS[name] ?? DEFAULT_LIMIT;
      const last = this.lastPlay.get(name);
      if (last !== undefined && now - last < lim.gap) return;
      const volume = clamp(Number.isFinite(opts?.volume) ? (opts?.volume as number) : 1, 0, 4);
      if (volume < 0.001) return;
      const pan = clamp(Number.isFinite(opts?.pan) ? (opts?.pan as number) : 0, -1, 1);
      let pitch = clamp(Number.isFinite(opts?.pitch) ? (opts?.pitch as number) : 1, 0.1, 8);
      if (!STABLE_PITCH.has(name)) pitch *= 1 + (Math.random() * 2 - 1) * 0.03;
      this.lastPlay.set(name, now);

      let list = this.voices.get(name);
      if (!list) {
        list = [];
        this.voices.set(name, list);
      }
      while (list.length >= lim.max) list.shift()?.kill(now);

      const v = new Voice(ctx, this.bufs, this.sfxGain, volume, pan);
      const owner = list;
      v.onDone = () => {
        const i = owner.indexOf(v);
        if (i >= 0) owner.splice(i, 1);
      };
      owner.push(v);
      recipe(v, now + 0.004, pitch);
    } catch {
      /* never break the game loop over a sound */
    }
  }

  loop(name: LoopName, opts?: PlayOpts): LoopHandle {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.sfxGain || !this.bufs) return DUMMY_LOOP;
    try {
      return new LoopVoice(ctx, this.bufs, this.sfxGain, name, opts);
    } catch {
      return DUMMY_LOOP;
    }
  }

  playMusic(track: MusicTrack): void {
    if (!this.ctx || !this.music) {
      this.pendingTrack = track;
      return;
    }
    try {
      this.music.play(track);
    } catch {
      /* ignore */
    }
  }

  stopMusic(fade = 0.5): void {
    this.pendingTrack = null;
    try {
      this.music?.stop(fade);
    } catch {
      /* ignore */
    }
  }

  setVolumes(v: { master?: number; music?: number; sfx?: number }): void {
    if (v.master !== undefined && Number.isFinite(v.master)) this.vol.master = clamp(v.master, 0, 1);
    if (v.music !== undefined && Number.isFinite(v.music)) this.vol.music = clamp(v.music, 0, 1);
    if (v.sfx !== undefined && Number.isFinite(v.sfx)) this.vol.sfx = clamp(v.sfx, 0, 1);
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      this.applyMaster();
      this.musicGain?.gain.setTargetAtTime(this.vol.music, ctx.currentTime, 0.03);
      this.sfxGain?.gain.setTargetAtTime(this.vol.sfx, ctx.currentTime, 0.03);
    } catch {
      /* ignore */
    }
  }

  duck(amount: number, seconds: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.duckGain) return;
    try {
      const g = this.duckGain.gain;
      const now = ctx.currentTime;
      const a = clamp(Number.isFinite(amount) ? amount : 0, 0, 1);
      const s = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.setTargetAtTime(1 - a, now, 0.04);
      g.setTargetAtTime(1, now + s, 0.3);
    } catch {
      /* ignore */
    }
  }

  speak(text: string): void {
    if (!this.voiceEnabled || this.isMuted) return;
    try {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
      if (typeof SpeechSynthesisUtterance === 'undefined') return;
      const synth = window.speechSynthesis;
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const voice = this.pickVoice(synth);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      } else {
        u.lang = 'en-US';
      }
      u.rate = 1.05;
      u.pitch = 0.6;
      u.volume = clamp(0.9 * this.vol.master, 0, 1);
      synth.speak(u);
    } catch {
      /* speech is optional */
    }
  }

  private pickVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
    if (this.speechVoice) return this.speechVoice;
    const voices = synth.getVoices();
    if (!voices.length) return null; // still loading; try again next time
    const en = voices.filter((v) => /^en/i.test(v.lang));
    this.speechVoice =
      en.find((v) => /google/i.test(v.name)) ?? voices.find((v) => /english/i.test(v.name)) ?? en[0] ?? null;
    return this.speechVoice;
  }

  /** Chrome loads voices asynchronously; ask early so the first announcement has one. */
  private primeSpeech(): void {
    try {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
      window.speechSynthesis.getVoices();
      window.speechSynthesis.addEventListener?.('voiceschanged', () => {
        this.speechVoice = null;
      });
    } catch {
      /* ignore */
    }
  }

  private cancelSpeech(): void {
    try {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
}

export const audio = new AudioEngine();
