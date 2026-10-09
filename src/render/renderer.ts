import * as THREE from 'three';
import { settings, type VideoMode } from '../core/settings';

/** Target scanline count for the arcade modes — Sega's Model 2 board output 496x384. */
const ARCADE_LINES = 400;

/**
 * Wraps the WebGL renderer. In 'pixel' and 'crt' modes the scene is rendered at roughly
 * Model 2 resolution and the canvas is upscaled by an integer factor via CSS.
 */
export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  mode: VideoMode = 'pixel';
  width = 1;
  height = 1;
  /** 0.5..1 resolution multiplier driven by the performance governor */
  scale = 1;
  /** true while the GPU context is lost (driver reset, too many tabs, etc.) */
  lost = false;
  private scan: HTMLDivElement;
  private lostEl: HTMLDivElement;
  private listeners: Array<() => void> = [];

  constructor(container: HTMLElement) {
    // Model 2 lit everything in gamma space; skipping color management gives the same punchy falloff.
    THREE.ColorManagement.enabled = false;
    this.gl = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    this.gl.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.gl.setPixelRatio(1);
    this.canvas = this.gl.domElement;
    this.canvas.id = 'view';
    container.appendChild(this.canvas);
    this.scan = document.createElement('div');
    this.scan.className = 'scanlines';
    container.appendChild(this.scan);
    this.lostEl = document.createElement('div');
    this.lostEl.className = 'context-lost hidden';
    this.lostEl.innerHTML = '<b>GRAPHICS RESET</b><span>Waiting for the GPU to come back… tap to reload if this sticks.</span>';
    this.lostEl.addEventListener('click', () => location.reload());
    container.appendChild(this.lostEl);
    // Let the browser restore the context instead of killing the page; three.js re-uploads everything.
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.lostEl.classList.remove('hidden');
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.lostEl.classList.add('hidden');
      this.resize();
    });
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));
    this.setMode(settings.video);
  }

  setScale(s: number) {
    const v = Math.min(1, Math.max(0.5, s));
    if (Math.abs(v - this.scale) < 0.01) return;
    this.scale = v;
    this.resize();
  }

  get aspect() {
    return this.width / this.height;
  }

  onResize(fn: () => void) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn);
    };
  }

  setMode(mode: VideoMode) {
    this.mode = mode;
    this.canvas.classList.toggle('pixelated', mode === 'pixel');
    this.scan.style.display = mode === 'crt' ? 'block' : 'none';
    this.resize();
  }

  resize() {
    const cssW = Math.max(1, window.innerWidth);
    const cssH = Math.max(1, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w: number;
    let h: number;
    if (this.mode === 'sharp') {
      // full resolution, but never more than ~1440 lines, and scaled down by the governor
      const k = Math.min(dpr, 1440 / cssH) * this.scale;
      w = Math.max(200, Math.round(cssW * k));
      h = Math.max(150, Math.round(cssH * k));
    } else {
      const devH = cssH * dpr;
      const lines = ARCADE_LINES * Math.max(0.7, this.scale);
      const scale = Math.max(1, Math.round(devH / lines));
      h = Math.max(150, Math.round(devH / scale));
      w = Math.max(200, Math.round((cssW * dpr) / scale));
    }
    this.width = w;
    this.height = h;
    this.gl.setSize(w, h, false);
    this.scan.style.backgroundSize = `100% ${cssH / h}px`;
    for (const fn of this.listeners) fn();
  }

  render(scene: THREE.Scene, camera: THREE.Camera) {
    this.gl.render(scene, camera);
  }
}
