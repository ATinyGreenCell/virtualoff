import type { MechSpec, Slot } from '../game/specs';

const SLOTS: Slot[] = ['lw', 'cw', 'rw'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

interface Bar {
  fill: HTMLDivElement;
  lag: HTMLDivElement;
  num: HTMLSpanElement;
  pips: HTMLSpanElement[];
  root: HTMLDivElement;
  last: number;
}

/** DOM overlay for the battle screen. */
export class HUD {
  readonly root: HTMLDivElement;
  private bars: Bar[] = [];
  private timer: HTMLDivElement;
  private gauges = {} as Record<Slot, { root: HTMLDivElement; fill: HTMLDivElement; last: number; ready: boolean }>;
  private reticle: HTMLDivElement;
  private retDist: HTMLDivElement;
  private arrow: HTMLDivElement;
  private announceEl: HTMLDivElement;
  private announceSub: HTMLDivElement;
  private vignette: HTMLDivElement;
  private status: HTMLDivElement;
  private hint: HTMLDivElement;
  private banner: HTMLDivElement;
  private lastTimer = -1;
  private lastStatus = '';
  private lastRet = '';

  constructor(parent: HTMLElement, p1: MechSpec, p2: MechSpec, stageName: string, round: number, tags: [string, string] = ['1P', 'CPU']) {
    this.root = el('div', 'hud', parent);
    const top = el('div', 'hud-top', this.root);
    const mkBar = (spec: MechSpec, side: 'p1' | 'p2', tag: string) => {
      const root = el('div', `pl ${side}`, top);
      const name = el('div', 'pl-name', root);
      el('span', 'pl-tag', name, tag);
      el('span', 'pl-mech', name, spec.name);
      const bar = el('div', 'hpbar', root);
      const lag = el('div', 'hp-lag', bar);
      const fill = el('div', 'hp-fill', bar);
      el('div', 'hp-ticks', bar);
      const row = el('div', 'pl-row', root);
      const num = el('span', 'hp-num', row, '100');
      el('span', 'hp-label', row, 'V.ARMOR');
      const pipBox = el('span', 'pips', row);
      const pips = [el('span', 'pip', pipBox), el('span', 'pip', pipBox)];
      this.bars.push({ fill, lag, num, pips, root, last: -1 });
    };
    mkBar(p1, 'p1', tags[0]);
    const tbox = el('div', 'timer-box', top);
    el('div', 'timer-label', tbox, 'TIME');
    this.timer = el('div', 'timer', tbox, '60');
    el('div', 'round-label', tbox, `ROUND ${round}`).dataset.round = '1';
    mkBar(p2, 'p2', tags[1]);

    this.reticle = el('div', 'reticle', this.root);
    el('div', 'ret-ring', this.reticle);
    el('div', 'ret-ring ret-ring2', this.reticle);
    this.retDist = el('div', 'ret-dist', this.reticle, '000');
    el('div', 'ret-lock', this.reticle, 'LOCK');
    this.arrow = el('div', 'off-arrow', this.root);

    const gbox = el('div', 'gauges', this.root);
    for (const s of SLOTS) {
      const g = el('div', `gauge g-${s}`, gbox);
      el('div', 'g-label', g, s.toUpperCase());
      const bar = el('div', 'g-bar', g);
      const fill = el('div', 'g-fill', bar);
      el('div', 'g-name', g, p1.weapons[s].name);
      this.gauges[s] = { root: g, fill, last: -1, ready: false };
    }

    this.vignette = el('div', 'dmg-vignette', this.root);
    this.status = el('div', 'status', this.root);
    const ann = el('div', 'announce', this.root);
    this.announceEl = el('div', 'ann-text', ann);
    this.announceSub = el('div', 'ann-sub', ann);
    this.banner = el('div', 'stage-banner', this.root);
    el('div', 'sb-stage', this.banner, `STAGE · ${stageName}`);
    el('div', 'sb-vs', this.banner, `${p1.name}  VS  ${p2.name}`);
    this.hint = el('div', 'controls-hint', this.root);
    this.hint.innerHTML =
      '<b>WASD</b> move · <b>Q/E</b> turn · <b>SPACE</b> jump · <b>SHIFT</b> dash · <b>J</b> LW · <b>L</b> RW · <b>K</b> or <b>J+L</b> CW · <b>C</b> guard · <b>ESC</b> pause';
  }

  setRoundLabel(round: number) {
    const r = this.root.querySelector('.round-label');
    if (r) r.textContent = `ROUND ${round}`;
  }

  showBanner(on: boolean) {
    this.banner.classList.toggle('show', on);
  }

  showHint(on: boolean) {
    this.hint.classList.toggle('show', on);
  }

  setHP(i: number, frac: number) {
    const b = this.bars[i];
    const pct = Math.max(0, Math.min(1, frac));
    const n = Math.ceil(pct * 100);
    if (n === b.last) return;
    b.last = n;
    b.fill.style.transform = `scaleX(${pct})`;
    b.lag.style.transform = `scaleX(${pct})`;
    b.num.textContent = String(n).padStart(3, '0');
    b.root.classList.toggle('warn', pct < 0.5 && pct >= 0.25);
    b.root.classList.toggle('danger', pct < 0.25);
  }

  setWins(wins: number[]) {
    wins.forEach((w, i) => this.bars[i].pips.forEach((p, k) => p.classList.toggle('on', k < w)));
  }

  setTimer(t: number) {
    const v = Math.max(0, Math.ceil(t));
    if (v === this.lastTimer) return;
    this.lastTimer = v;
    this.timer.textContent = String(v).padStart(2, '0');
    this.timer.classList.toggle('low', v <= 10);
  }

  setGauges(g: Record<Slot, number>, costs: Record<Slot, number>) {
    for (const s of SLOTS) {
      const gg = this.gauges[s];
      const v = Math.round(g[s] * 200) / 200;
      if (v !== gg.last) {
        gg.last = v;
        gg.fill.style.transform = `scaleX(${v})`;
      }
      const ready = g[s] >= costs[s] - 1e-4;
      if (ready !== gg.ready) {
        gg.ready = ready;
        gg.root.classList.toggle('ready', ready);
        if (ready) {
          gg.root.classList.remove('pulse');
          void gg.root.offsetWidth;
          gg.root.classList.add('pulse');
        }
      }
    }
  }

  /** x,y in CSS pixels; null hides the reticle. */
  setReticle(x: number | null, y: number, locked: boolean, dist: number) {
    if (x === null) {
      if (this.lastRet !== 'hidden') {
        this.reticle.style.display = 'none';
        this.lastRet = 'hidden';
      }
      return;
    }
    if (this.lastRet === 'hidden') this.reticle.style.display = '';
    this.lastRet = 'shown';
    this.reticle.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    this.reticle.classList.toggle('locked', locked);
    const d = String(Math.min(999, Math.round(dist))).padStart(3, '0');
    if (this.retDist.textContent !== d) this.retDist.textContent = d;
  }

  /** angle in screen space (radians, 0 = right, clockwise positive since y points down); null hides */
  setArrow(angle: number | null) {
    if (angle === null) {
      this.arrow.style.display = 'none';
      return;
    }
    const w = window.innerWidth;
    const h = window.innerHeight;
    const rx = w * 0.42;
    const ry = h * 0.38;
    const x = w / 2 + Math.cos(angle) * rx;
    const y = h / 2 + Math.sin(angle) * ry;
    this.arrow.style.display = '';
    this.arrow.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${angle}rad)`;
  }

  announce(text: string, cls = '', sub = '') {
    const a = this.announceEl;
    a.textContent = text;
    a.className = 'ann-text';
    this.announceSub.textContent = sub;
    void a.offsetWidth;
    a.className = `ann-text show ${cls}`;
  }

  clearAnnounce() {
    this.announceEl.className = 'ann-text';
    this.announceSub.textContent = '';
  }

  damageFlash(heavy: boolean) {
    const v = this.vignette;
    v.classList.remove('hit', 'heavy');
    void v.offsetWidth;
    v.classList.add('hit');
    if (heavy) v.classList.add('heavy');
  }

  setStatus(text: string, cls = '') {
    const key = text + cls;
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.status.textContent = text;
    this.status.className = `status ${cls}`;
  }

  setVisible(on: boolean) {
    this.root.classList.toggle('hidden', !on);
  }

  dispose() {
    this.root.remove();
  }
}
