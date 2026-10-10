/**
 * Renders the whole sound library (instruments, effects, loops) once, offline and in the
 * background, as soon as the game boots — no user gesture needed for offline rendering. Return
 * visits restore the finished library from IndexedDB instead (cache.ts).
 */
import { cacheEnabled, readCache, writeCache } from './cache';
import { calibrate, canRender, clearImpulseCache, makeLoop, mtof, render, SR, trim } from './dsp';
import { SAMPLES } from './samples';
import type { SampleBuf } from './sequencer';
import { LOOPS, SFX, type LoopDef, type SfxDef } from './sfx';
import type { LoopName, SfxName } from './types';

const DRUMS = new Set(['kick', 'snare', 'clap', 'hat', 'ohat', 'crash', 'perc', 'riser', 'impact', 'tom', 'timp']);

/** Sounds the title screen needs first, so menus are never silent while the rest renders. */
const FIRST: SfxName[] = ['uiMove', 'uiSelect', 'uiBack', 'uiConfirmBig', 'rifle', 'lockOn'];

export class Library {
  readonly samples = new Map<string, SampleBuf>();
  readonly sfx = new Map<SfxName, { buffer: AudioBuffer; def: SfxDef }>();
  readonly loops = new Map<LoopName, { buffer: AudioBuffer; def: LoopDef }>();
  /** resolves once every instrument is ready (music can start) */
  musicReady = false;
  done = false;
  private loading: Promise<void> | null = null;
  private listeners: Array<() => void> = [];

  onMusicReady(fn: () => void) {
    if (this.musicReady) fn();
    else this.listeners.push(fn);
  }

  load(): Promise<void> {
    if (!this.loading) this.loading = this.run();
    return this.loading;
  }

  private async run() {
    if (!canRender()) return;
    const t0 = performance.now();
    if (cacheEnabled() && (await this.restore())) {
      if (import.meta.env.DEV) console.info(`[audio] library restored in ${Math.round(performance.now() - t0)} ms`);
      return;
    }
    const sfxJob = (name: SfxName) => async () => {
      const def = SFX[name];
      const buf = trim(await render(def.seconds, def.stereo ? 2 : 1, (ctx, out) => def.build(ctx, out)));
      calibrate(buf, def.level);
      this.sfx.set(name, { buffer: buf, def });
    };
    const sampleJob = (id: string) => async () => {
      const def = SAMPLES[id];
      const buf = trim(await render(def.seconds, def.stereo ? 2 : 1, (ctx, out) => def.build(ctx, out, mtof(def.root))));
      calibrate(buf, def.level, false);
      this.samples.set(id, { buffer: buf, root: def.root, drum: DRUMS.has(id) });
    };
    const loopJob = (name: LoopName) => async () => {
      const def = LOOPS[name];
      const buf = await render(def.seconds, def.stereo ? 2 : 1, (ctx, out) => def.build(ctx, out));
      calibrate(buf, def.level);
      makeLoop(buf, def.loopStart, def.loopEnd, def.xfade);
      this.loops.set(name, { buffer: buf, def });
    };
    // a render can fail transiently (e.g. memory pressure on a phone): give each batch one retry
    const run = async (jobs: (() => Promise<void>)[]) => {
      const failed = await this.pool(jobs, 4);
      if (failed.length) await this.pool(failed, 2);
    };
    try {
      await run(FIRST.map(sfxJob));
      await run(Object.keys(SAMPLES).map(sampleJob));
      this.musicReady = true;
      for (const fn of this.listeners.splice(0)) fn();
      const rest = (Object.keys(SFX) as SfxName[]).filter((n) => !FIRST.includes(n));
      await run([...rest.map(sfxJob), ...(Object.keys(LOOPS) as LoopName[]).map(loopJob)]);
      this.done = true;
      clearImpulseCache();
      if (import.meta.env.DEV) console.info(`[audio] library rendered in ${Math.round(performance.now() - t0)} ms`);
      if (cacheEnabled()) this.saveWhenIdle();
    } catch (err) {
      console.warn('[audio] could not render the sound library', err);
    }
  }

  /** Cache keys for every buffer the library holds. */
  private keys() {
    return [
      ...Object.keys(SAMPLES).map((id) => `sample:${id}`),
      ...Object.keys(SFX).map((n) => `sfx:${n}`),
      ...Object.keys(LOOPS).map((n) => `loop:${n}`),
    ];
  }

  /** Fill the library from the cache; false (and nothing filled) when it can't be used. */
  private async restore() {
    const got = await readCache(__SOUND_VERSION__, this.keys(), SR);
    if (!got) return false;
    for (const [id, def] of Object.entries(SAMPLES)) this.samples.set(id, { buffer: got.get(`sample:${id}`)!, root: def.root, drum: DRUMS.has(id) });
    for (const [name, def] of Object.entries(SFX) as [SfxName, SfxDef][]) this.sfx.set(name, { buffer: got.get(`sfx:${name}`)!, def });
    for (const [name, def] of Object.entries(LOOPS) as [LoopName, LoopDef][]) this.loops.set(name, { buffer: got.get(`loop:${name}`)!, def });
    this.musicReady = true;
    for (const fn of this.listeners.splice(0)) fn();
    this.done = true;
    return true;
  }

  /** Store the finished library once the page is idle, so it never competes with play. */
  private saveWhenIdle() {
    // only a complete library is worth keeping
    if (this.samples.size + this.sfx.size + this.loops.size !== this.keys().length) return;
    const entries: [string, AudioBuffer][] = [
      ...[...this.samples].map(([id, s]) => [`sample:${id}`, s.buffer] as [string, AudioBuffer]),
      ...[...this.sfx].map(([n, s]) => [`sfx:${n}`, s.buffer] as [string, AudioBuffer]),
      ...[...this.loops].map(([n, s]) => [`loop:${n}`, s.buffer] as [string, AudioBuffer]),
    ];
    const save = () => void writeCache(__SOUND_VERSION__, entries);
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(save, { timeout: 8000 });
    else setTimeout(save, 3000);
  }

  /** Run async jobs with bounded concurrency; resolves with the jobs that failed. */
  private async pool(jobs: (() => Promise<void>)[], n: number) {
    const failed: (() => Promise<void>)[] = [];
    let i = 0;
    const worker = async () => {
      while (i < jobs.length) {
        const job = jobs[i++];
        try {
          await job();
        } catch (err) {
          failed.push(job);
          console.warn('[audio] render failed', err);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
    return failed;
  }
}
