import { Input } from './core/input';
import { settings } from './core/settings';
import { Renderer } from './render/renderer';

export interface Screen {
  update(dt: number): void;
  render(): void;
  dispose(): void;
  /** The page lost focus or was hidden — pause if that matters for this screen. */
  suspend?(): void;
  /** split screen (two views stacked); the renderer switches over when the screen goes live */
  readonly split?: boolean;
}

/** Implemented by the on-screen touch controls (src/core/touch.ts). */
export interface TouchHooks {
  /** Show the battle controls (only while a fight is live and unpaused). */
  setBattleActive(on: boolean): void;
}

/** Physics never steps more than this at once; slow frames are split into several sub-steps. */
const MAX_STEP = 1 / 60;
const MAX_SUBSTEPS = 4;

/**
 * Adaptive quality: watches frame times and trades resolution for frame rate on weak devices,
 * then claws resolution back when there's headroom. Uses hysteresis so it never oscillates.
 */
class Governor {
  private ema = 16.7;
  private timer = 0;
  private goodFor = 0;
  level = 1;

  sample(rawMs: number, dt: number): number | null {
    if (rawMs > 250) return null; // tab switch / breakpoint, not a real frame
    this.ema += (rawMs - this.ema) * 0.06;
    this.timer += dt;
    if (this.timer < 1) return null;
    this.timer = 0;
    if (this.ema > 24 && this.level > 0.5) {
      this.goodFor = 0;
      this.level = Math.max(0.5, this.level - 0.15);
      return this.level;
    }
    this.goodFor = this.ema < 17.6 ? this.goodFor + 1 : 0;
    if (this.goodFor >= 5 && this.level < 1) {
      this.goodFor = 0;
      this.level = Math.min(1, this.level + 0.1);
      return this.level;
    }
    return null;
  }
}

/** Owns the renderer, input and the active screen; runs the frame loop. */
export class App {
  readonly renderer: Renderer;
  readonly input: Input;
  readonly ui: HTMLDivElement;
  touch: TouchHooks | null = null;
  /** Called when the active screen keeps throwing — the flow sends the player back to the title. */
  onRecover: (() => void) | null = null;
  private screen: Screen | null = null;
  private pending: Screen | null = null;
  private last = 0;
  private governor = new Governor();
  private errors: number[] = [];
  private fpsEl: HTMLDivElement | null = null;
  private fpsAcc = 0;
  private fpsFrames = 0;

  constructor(readonly root: HTMLElement) {
    this.renderer = new Renderer(root);
    this.ui = document.createElement('div');
    this.ui.className = 'ui';
    root.appendChild(this.ui);
    this.input = new Input(root);
    this.applyPerf();
    const suspend = () => this.screen?.suspend?.();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) suspend();
    });
    window.addEventListener('blur', suspend);
    this.input.onDeviceLost = suspend;
    window.addEventListener('error', (e) => console.error('[virtual-off]', e.error ?? e.message));
    window.addEventListener('unhandledrejection', (e) => console.error('[virtual-off] unhandled rejection', e.reason));
  }

  /** Apply the PERFORMANCE setting (auto lets the governor decide). */
  applyPerf() {
    if (settings.perf === 'high') this.renderer.setScale(1);
    else if (settings.perf === 'low') this.renderer.setScale(0.6);
    else this.renderer.setScale(this.governor.level);
  }

  /** Particle density for the current performance level. */
  get fxDensity() {
    if (settings.perf === 'low') return 0.5;
    if (settings.perf === 'high') return 1;
    return this.governor.level < 0.75 ? 0.6 : 1;
  }

  /** Swap screens at the start of the next frame, so a screen can request a change mid-update. */
  setScreen(s: Screen) {
    this.pending?.dispose();
    this.pending = s;
  }

  start() {
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    requestAnimationFrame(this.frame);
    const rawMs = now - this.last;
    this.last = now;
    // clamp: a background tab or a long GC pause must not fast-forward the fight
    const dt = Math.min(0.1, Math.max(0, rawMs / 1000) || 0);
    if (this.pending) {
      const old = this.screen;
      this.screen = this.pending;
      this.pending = null;
      try {
        old?.dispose();
      } catch (err) {
        console.error('[virtual-off] dispose failed', err);
      }
      this.renderer.setViews(this.screen.split ? 2 : 1);
      this.input.flush();
    }
    if (this.renderer.lost || !this.screen) return;

    if (settings.perf === 'auto') {
      const lvl = this.governor.sample(rawMs, dt);
      if (lvl !== null) this.renderer.setScale(lvl);
    }
    this.updateFps(rawMs);

    try {
      // (checked before update(), which consumes this frame's key presses)
      if (this.input.wasPressed('Backquote')) this.toggleFps();
      this.input.update(dt, settings.pad);
      // sub-step slow frames so collisions and jump arcs behave the same at 20 fps as at 144 fps
      const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt / MAX_STEP - 1e-6)));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        this.screen.update(h);
        if (this.pending) break;
        // one-shot presses must only be seen by the first sub-step of a frame
        if (i === 0) this.input.clearEdges();
      }
      this.renderer.gl.info.reset();
      this.screen.render();
    } catch (err) {
      this.handleError(err, now);
    }
  };

  private handleError(err: unknown, now: number) {
    console.error('[virtual-off] frame error', err);
    this.errors.push(now);
    this.errors = this.errors.filter((t) => now - t < 3000);
    // a one-off glitch is survivable; a screen that throws every frame gets replaced
    if (this.errors.length >= 5 && this.onRecover) {
      this.errors.length = 0;
      this.onRecover();
    }
  }

  private toggleFps() {
    if (this.fpsEl) {
      this.fpsEl.remove();
      this.fpsEl = null;
      return;
    }
    this.fpsEl = document.createElement('div');
    this.fpsEl.className = 'fps-meter';
    this.root.appendChild(this.fpsEl);
  }

  private updateFps(ms: number) {
    if (!this.fpsEl) return;
    this.fpsAcc += ms;
    this.fpsFrames++;
    if (this.fpsAcc < 500) return;
    const fps = (this.fpsFrames * 1000) / this.fpsAcc;
    const info = this.renderer.gl.info.render;
    this.fpsEl.textContent = `${fps.toFixed(0)} FPS · ${this.renderer.width}×${this.renderer.height} · ${info.calls} calls · q${this.renderer.scale.toFixed(2)}`;
    this.fpsAcc = 0;
    this.fpsFrames = 0;
  }
}
