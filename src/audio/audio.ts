/**
 * Arcade audio engine. Every instrument, effect and loop is synthesized once, offline, at boot
 * (see library.ts); at runtime an effect is just buffer → gain → pan (3 nodes) and a music note is
 * buffer → gain (2 nodes). The music runs through sidechain pumps, echo, a hall reverb and a
 * glue-compressor / limiter master chain (mixer.ts).
 *
 *   import { audio } from './audio/audio';
 *   button.onclick = () => { audio.unlock(); audio.playMusic('title'); };
 *   audio.play('rifle', { pan: -0.3 });
 */
import { NO_AUDIO } from '../core/testmode';
import { clamp, SR } from './dsp';
import { Library } from './library';
import { Mixer } from './mixer';
import { compile, SongPlayer, type Compiled } from './sequencer';
import { SONGS } from './songs';
import type { LoopHandle, LoopName, MusicTrack, PlayOpts, SfxName } from './types';

export type { LoopHandle, LoopName, MusicTrack, PlayOpts, SfxName } from './types';

type AudioGlobals = { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };

/** How far ahead (s) music notes are queued, and how often the queue is topped up (ms). */
const LOOKAHEAD = 0.3;
const TICK_MS = 50;
/** Ceiling on simultaneous effect voices; past it the voice closest to ending is cut. */
const MAX_VOICES = 40;

const DUMMY_LOOP: LoopHandle = { set() {}, stop() {} };

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
  pan: StereoPannerNode;
  end: number;
}

const compiled = new Map<MusicTrack, Compiled>();
function songData(track: MusicTrack) {
  let c = compiled.get(track);
  if (!c) {
    c = compile(SONGS[track]);
    compiled.set(track, c);
  }
  return c;
}

export class AudioEngine {
  /** When false, speak() is a no-op. */
  voiceEnabled = true;

  private ctx: AudioContext | null = null;
  private mixer: Mixer | null = null;
  private readonly lib = new Library();
  private players: SongPlayer[] = [];
  private current: MusicTrack | null = null;
  private pendingTrack: MusicTrack | null = null;
  private readonly vol = { master: 1, music: 0.8, sfx: 0.9 };
  private isMuted = false;
  private readonly voices = new Map<SfxName, Voice[]>();
  private readonly lastPlay = new Map<SfxName, number>();
  private speechVoice: SpeechSynthesisVoice | null = null;
  private pausedByVisibility = false;
  private ticking = false;

  constructor() {
    if (typeof window === 'undefined') return;
    // offline rendering needs no user gesture: get the library going right away, off the main thread
    if (!NO_AUDIO) setTimeout(() => void this.lib.load(), 30);
    this.lib.onMusicReady(() => this.startPending());
    document.addEventListener('visibilitychange', () => this.onVisibility());
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  get muted(): boolean {
    return this.isMuted;
  }

  set muted(m: boolean) {
    this.isMuted = m;
    this.applyVolumes();
    if (m) this.cancelSpeech();
  }

  toggleMute(): boolean {
    this.muted = !this.isMuted;
    return this.isMuted;
  }

  /** Create/resume the AudioContext. Call from a user-gesture handler; safe to call repeatedly. */
  unlock(): void {
    try {
      if (typeof window === 'undefined') return;
      let ctx = this.ctx;
      // the browser can close a context for good (audio device loss, crash recovery): start over
      if (ctx && ctx.state === 'closed') {
        this.teardown();
        ctx = null;
      }
      if (!ctx) {
        const w = window as unknown as AudioGlobals;
        const Ctor = w.AudioContext ?? w.webkitAudioContext;
        if (!Ctor) return;
        const created = new Ctor({ latencyHint: 'interactive' });
        ctx = created;
        this.ctx = created;
        this.mixer = new Mixer(created, created.destination);
        // however the context comes back to life (gesture, tab focus, iOS interruption), restart music
        created.addEventListener?.('statechange', () => {
          if (created.state === 'running') this.startPending();
        });
        this.applyVolumes();
        if (!this.ticking) {
          this.ticking = true;
          this.primeSpeech();
          window.setInterval(() => this.tick(), TICK_MS);
        }
      }
      if (ctx.state !== 'running' && !this.pausedByVisibility) {
        const p: Promise<void> | undefined = ctx.resume();
        p?.then(() => this.startPending()).catch(() => undefined);
      }
      this.startPending();
    } catch {
      // audio is optional
    }
  }

  // ------------------------------------------------------------------ effects

  play(name: SfxName, opts?: PlayOpts): void {
    const ctx = this.ctx;
    const mixer = this.mixer;
    if (!ctx || !mixer || ctx.state !== 'running' || this.isMuted) return;
    const s = this.lib.sfx.get(name);
    if (!s) return;
    const now = ctx.currentTime;
    const def = s.def;
    if (now - (this.lastPlay.get(name) ?? -1) < def.gap) return;
    this.lastPlay.set(name, now);
    let list = this.voices.get(name);
    if (!list) this.voices.set(name, (list = []));
    const active = this.activeVoices(now);
    if (list.length >= def.max || active >= MAX_VOICES) {
      // steal: this effect's oldest voice, or (global ceiling) whichever voice ends soonest
      let from = list;
      if (list.length < def.max) {
        let soonest = Infinity;
        for (const l of this.voices.values()) if (l.length && l[0].end < soonest) [soonest, from] = [l[0].end, l];
      }
      const old = from.shift();
      if (old) {
        old.gain.gain.cancelScheduledValues(now);
        old.gain.gain.setTargetAtTime(0, now, 0.01);
        old.src.stop(now + 0.05);
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = s.buffer;
    const rate = (opts?.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * def.vary);
    src.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, opts?.volume ?? 1);
    const pan = ctx.createStereoPanner();
    pan.pan.value = clamp(opts?.pan ?? 0, -1, 1);
    src.connect(gain).connect(pan).connect(mixer.sfxIn);
    const voice: Voice = { src, gain, pan, end: now + s.buffer.duration / rate };
    list.push(voice);
    src.onended = () => {
      src.disconnect();
      gain.disconnect();
      pan.disconnect();
    };
    src.start(now);
  }

  /** Prune finished voices and count the ones still sounding. */
  private activeVoices(now: number) {
    let n = 0;
    for (const list of this.voices.values()) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].end <= now) list.splice(i, 1);
      n += list.length;
    }
    return n;
  }

  loop(name: LoopName, opts?: PlayOpts): LoopHandle {
    const ctx = this.ctx;
    const mixer = this.mixer;
    if (!ctx || !mixer || ctx.state !== 'running') return DUMMY_LOOP;
    const l = this.lib.loops.get(name);
    if (!l) return DUMMY_LOOP;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = l.buffer;
    src.loop = true;
    src.loopStart = l.def.loopStart;
    src.loopEnd = l.def.loopEnd;
    src.playbackRate.value = opts?.pitch ?? 1;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(Math.max(0, opts?.volume ?? 1), now + 0.08);
    const pan = ctx.createStereoPanner();
    pan.pan.value = clamp(opts?.pan ?? 0, -1, 1);
    src.connect(gain).connect(pan).connect(mixer.sfxIn);
    src.start(now, l.def.loopStart);
    let stopped = false;
    return {
      set: (p) => {
        if (stopped) return;
        const t = ctx.currentTime;
        if (p.volume !== undefined) gain.gain.setTargetAtTime(Math.max(0, p.volume), t, 0.03);
        if (p.pitch !== undefined) src.playbackRate.setTargetAtTime(Math.max(0.1, p.pitch), t, 0.03);
        if (p.pan !== undefined) pan.pan.setTargetAtTime(clamp(p.pan, -1, 1), t, 0.03);
      },
      stop: (fade = 0.12) => {
        if (stopped) return;
        stopped = true;
        const t = ctx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(0, t + Math.max(0.01, fade));
        src.stop(t + fade + 0.05);
        src.onended = () => {
          src.disconnect();
          gain.disconnect();
          pan.disconnect();
        };
      },
    };
  }

  // ------------------------------------------------------------------ music

  /** Crossfade to `track`; victory/defeat are one-shot jingles. Re-requesting the playing loop is a no-op. */
  playMusic(track: MusicTrack): void {
    if (track === this.current && SONGS[track].loop && this.players.some((p) => !p.finished)) return;
    this.pendingTrack = track;
    this.startPending();
  }

  stopMusic(fade = 0.5): void {
    this.pendingTrack = null;
    this.current = null;
    for (const p of this.players) p.stop(fade);
  }

  private startPending() {
    const ctx = this.ctx;
    const mixer = this.mixer;
    const track = this.pendingTrack;
    if (!track || !ctx || !mixer || ctx.state !== 'running' || !this.lib.musicReady) return;
    this.pendingTrack = null;
    const fade = this.players.length ? 0.45 : 0;
    for (const p of this.players) p.stop(0.5);
    const song = SONGS[track];
    const player = new SongPlayer(ctx, mixer, song, songData(track), this.lib.samples, ctx.currentTime + 0.08, song.loop ? fade : 0);
    this.players.push(player);
    this.current = track;
    player.schedule(ctx.currentTime + LOOKAHEAD);
  }

  private tick() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const until = ctx.currentTime + LOOKAHEAD;
    for (const p of this.players) p.schedule(until);
    const now = ctx.currentTime;
    this.players = this.players.filter((p) => {
      if (p.finished && now > p.endTime) {
        p.dispose();
        return false;
      }
      return true;
    });
  }

  // ------------------------------------------------------------------ mix

  setVolumes(v: { master?: number; music?: number; sfx?: number }): void {
    if (v.master !== undefined) this.vol.master = clamp(v.master, 0, 1);
    if (v.music !== undefined) this.vol.music = clamp(v.music, 0, 1);
    if (v.sfx !== undefined) this.vol.sfx = clamp(v.sfx, 0, 1);
    this.applyVolumes();
  }

  private applyVolumes() {
    const ctx = this.ctx;
    const m = this.mixer;
    if (!ctx || !m) return;
    const t = ctx.currentTime;
    // perceptual taper: slider steps feel even
    const taper = (x: number) => x * x;
    m.master.gain.setTargetAtTime(this.isMuted ? 0 : this.vol.master, t, 0.02);
    m.musicVol.gain.setTargetAtTime(taper(this.vol.music), t, 0.02);
    m.sfxVol.gain.setTargetAtTime(taper(this.vol.sfx), t, 0.02);
  }

  /** Temporarily lower the music by `amount` (0..1) and bring it back over `seconds`. */
  duck(amount: number, seconds: number): void {
    const ctx = this.ctx;
    const m = this.mixer;
    if (!ctx || !m) return;
    const t = ctx.currentTime;
    const g = m.duck.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(1 - clamp(amount, 0, 1), t + 0.05);
    g.linearRampToValueAtTime(1, t + 0.05 + Math.max(0.05, seconds));
  }

  /** Stop all processing while the page is hidden (battery), resume when it's back. */
  private onVisibility() {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return;
    if (document.hidden) {
      if (ctx.state === 'running') {
        this.pausedByVisibility = true;
        void ctx.suspend().catch(() => undefined);
      }
    } else {
      // also covers contexts the browser suspended on its own; if it still needs a gesture, the
      // unlock listeners take care of it on the next tap
      this.pausedByVisibility = false;
      if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
    }
  }

  /** Drop a dead context and everything built on it; the playing loop restarts on the next one. */
  private teardown() {
    for (const p of this.players) p.dispose();
    this.players = [];
    if (this.current && SONGS[this.current].loop) this.pendingTrack ??= this.current;
    this.current = null;
    this.voices.clear();
    this.lastPlay.clear();
    this.mixer?.dispose();
    this.mixer = null;
    this.ctx = null;
  }

  // ------------------------------------------------------------------ announcer voice

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
      // speech is optional
    }
  }

  private pickVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
    if (this.speechVoice) return this.speechVoice;
    const voices = synth.getVoices();
    if (!voices.length) return null;
    const en = voices.filter((v) => /^en/i.test(v.lang));
    this.speechVoice = en.find((v) => /google/i.test(v.name)) ?? voices.find((v) => /english/i.test(v.name)) ?? en[0] ?? null;
    return this.speechVoice;
  }

  private primeSpeech(): void {
    try {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
      window.speechSynthesis.getVoices();
      window.speechSynthesis.addEventListener?.('voiceschanged', () => {
        this.speechVoice = null;
      });
    } catch {
      // ignore
    }
  }

  private cancelSpeech(): void {
    try {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }

  // ------------------------------------------------------------------ dev tooling

  /** Render `seconds` of a track through the full master chain, offline (used by the audio tests). */
  async renderTrack(
    track: MusicTrack,
    seconds: number,
    opts: { solo?: string; raw?: boolean; noMusic?: boolean; cues?: [number, SfxName][] } = {},
  ): Promise<AudioBuffer> {
    await this.lib.load();
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SR), SR);
    const mixer = new Mixer(ctx, ctx.destination);
    mixer.musicVol.gain.value = this.vol.music * this.vol.music;
    mixer.sfxVol.gain.value = this.vol.sfx * this.vol.sfx;
    for (const [t, name] of opts.cues ?? []) {
      const s = this.lib.sfx.get(name);
      if (!s) continue;
      const src = ctx.createBufferSource();
      src.buffer = s.buffer;
      src.connect(mixer.sfxIn);
      src.start(t);
    }
    if (opts.raw) {
      // bypass the master dynamics so stems can be compared linearly
      mixer.duck.disconnect();
      mixer.duck.connect(ctx.destination);
    }
    let song = SONGS[track];
    let comp = songData(track);
    if (opts.solo) {
      // other channels muted; kick events stay (silently) so the sidechain still pumps
      const channels = Object.fromEntries(Object.entries(song.channels).map(([k, c]) => [k, k === opts.solo ? c : { ...c, gain: 0 }]));
      song = { ...song, channels };
      comp = { ...comp, events: comp.events.filter((e) => e.ch === opts.solo || e.ch === 'kick') };
    }
    if (!opts.noMusic) new SongPlayer(ctx, mixer, song, comp, this.lib.samples, 0.05).schedule(seconds);
    return ctx.startRendering();
  }

  /** The offline-rendered effect buffers (used by the audio tests). */
  async sfxBuffers() {
    await this.lib.load();
    return this.lib.sfx;
  }
}

export const audio = new AudioEngine();
