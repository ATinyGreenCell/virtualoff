/**
 * Renders the whole sound library (instruments, effects, loops) once, offline and in the
 * background, as soon as the game boots — no user gesture needed for offline rendering.
 */
import { calibrate, canRender, clearImpulseCache, makeLoop, mtof, render, trim } from './dsp';
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
    } catch (err) {
      console.warn('[audio] could not render the sound library', err);
    }
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
