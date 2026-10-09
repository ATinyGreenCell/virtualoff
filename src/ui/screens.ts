import * as THREE from 'three';
import { audio } from '../audio/audio';
import type { App, Screen } from '../app';
import { makeControls } from '../core/input';
import { clamp } from '../core/math';
import { saveSettings, settings, type Difficulty, type PerfMode, type VideoMode } from '../core/settings';
import type { Flow } from '../flow';
import { Mech } from '../game/mech';
import { MechModel, makePose } from '../game/mechModel';
import { FUJIN, JEBE, ROSTER, type MechSpec } from '../game/specs';
import { World } from '../game/world';
import { canvasTexture } from '../render/textures';

const VIDEO_LABEL: Record<VideoMode, string> = { pixel: 'ARCADE PIXELS', crt: 'CRT SCANLINES', sharp: 'SHARP HD' };
const PERF_LABEL: Record<PerfMode, string> = { auto: 'AUTO', high: 'HIGH', low: 'LOW / BATTERY' };
const NEUTRAL = makeControls();

function cycle<T>(list: readonly T[], cur: T, dir: number): T {
  const i = list.indexOf(cur);
  return list[(i + dir + list.length) % list.length];
}

function applyAudioSettings() {
  audio.setVolumes({ music: settings.music, sfx: settings.sfx });
  audio.voiceEnabled = settings.voice;
}

export const CONTROLS_HTML = `
<div class="ctl-cols">
  <div class="ctl-col">
    <h3>KEYBOARD</h3>
    <dl>
      <dt>W A S D</dt><dd>walk / strafe</dd>
      <dt>Q · E</dt><dd>quick turn (also ← →)</dd>
      <dt>SPACE</dt><dd>jump</dd>
      <dt>SHIFT</dt><dd>dash (hold to extend · mid-air = air dash)</dd>
      <dt>J</dt><dd>left weapon · LW</dd>
      <dt>L</dt><dd>right weapon · RW</dd>
      <dt>K or J+L</dt><dd>center weapon · CW</dd>
      <dt>C</dt><dd>guard</dd>
      <dt>MOUSE</dt><dd>left = RW · right = LW · middle = CW</dd>
      <dt>ESC</dt><dd>pause</dd>
    </dl>
  </div>
  <div class="ctl-col">
    <h3>GAMEPAD · MODERN</h3>
    <dl>
      <dt>L-STICK</dt><dd>walk / strafe</dd>
      <dt>R-STICK</dt><dd>quick turn</dd>
      <dt>A · B</dt><dd>jump · dash (also LB / RB)</dd>
      <dt>LT · RT</dt><dd>LW · RW (both = CW)</dd>
      <dt>Y · X</dt><dd>CW · guard</dd>
    </dl>
    <h3>GAMEPAD · TWIN STICK</h3>
    <p>Each stick is one arcade lever. Both forward to walk, opposite directions to turn,
    pull them apart to jump, push them together to guard. LB / RB = turbo (dash), LT / RT = triggers.</p>
  </div>
</div>
<div class="ctl-tips">
  <span>Your VR locks on automatically.</span>
  <span>Fire close to the enemy = melee.</span>
  <span>Shots change while dashing or airborne.</span>
  <span>Big hits knock down — you're invincible while getting up.</span>
</div>`;

// ------------------------------------------------------------------ title

interface MenuItem {
  label: () => string;
  act?: () => void;
  change?: (dir: number) => void;
}

export class TitleScreen implements Screen {
  private readonly cam: THREE.PerspectiveCamera;
  private readonly world: World;
  private readonly el: HTMLDivElement;
  private readonly menuEl: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly offResize: () => void;
  private readonly mainItems: MenuItem[];
  private readonly settingsItems: MenuItem[];
  private page: 'main' | 'settings' = 'main';
  private started = false;
  private startedAt = 0;
  private leaving = false;
  private sel = 0;
  private t = 0;

  constructor(
    private readonly app: App,
    private readonly flow: Flow,
  ) {
    this.cam = new THREE.PerspectiveCamera(46, app.renderer.aspect, 0.3, 2400);
    this.world = new World('harbor', this.cam);
    const a = new Mech(JEBE, JEBE.palette, false);
    const b = new Mech(FUJIN, FUJIN.palette, false);
    a.target = b;
    b.target = a;
    a.reset(new THREE.Vector3(-7, 0, 7), 0);
    b.reset(new THREE.Vector3(8, 0, -7), Math.PI);
    this.world.add(a);
    this.world.add(b);
    this.offResize = app.renderer.onResize(() => {
      this.cam.aspect = app.renderer.aspect;
      this.cam.updateProjectionMatrix();
    });

    this.el = document.createElement('div');
    this.el.className = 'screen title-screen';
    this.el.innerHTML = `
      <div class="logo-wrap">
        <div class="logo-kicker">CYBER TROOPERS</div>
        <div class="logo">VIRTUAL<span class="dash">-</span>OFF</div>
        <div class="logo-sub">LIMITED WAR · BROWSER EDITION</div>
      </div>
      <div class="press-start blink">PRESS START</div>
      <div class="menu"></div>
      <div class="title-foot">unofficial fan tribute · not affiliated with SEGA · all mechs, stages & music are original</div>`;
    this.menuEl = this.el.querySelector('.menu') as HTMLDivElement;
    this.panel = document.createElement('div');
    this.panel.className = 'overlay controls-panel hidden';
    this.panel.innerHTML = `<div class="ov-title small">HOW TO PLAY</div>${CONTROLS_HTML}<div class="ov-hint">ESC / START to close</div>`;
    this.panel.addEventListener('click', () => this.togglePanel(false));
    this.el.appendChild(this.panel);
    app.ui.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      if (!this.started) {
        e.stopPropagation();
        this.begin();
      }
    });

    this.mainItems = [
      { label: () => 'ARCADE MODE', act: () => this.startGame() },
      { label: () => 'VERSUS · 2 PLAYERS', act: () => this.startVersus() },
      { label: () => 'SETTINGS', act: () => this.openPage('settings') },
      { label: () => 'HOW TO PLAY', act: () => this.togglePanel(true) },
    ];
    this.settingsItems = [
      {
        label: () => `DIFFICULTY <i>◂ ${settings.difficulty.toUpperCase()} ▸</i>`,
        change: (d) => (settings.difficulty = cycle<Difficulty>(['easy', 'normal', 'hard'], settings.difficulty, d)),
      },
      {
        label: () => `VIDEO <i>◂ ${VIDEO_LABEL[settings.video]} ▸</i>`,
        change: (d) => {
          settings.video = cycle<VideoMode>(['pixel', 'crt', 'sharp'], settings.video, d);
          this.app.renderer.setMode(settings.video);
        },
      },
      {
        label: () => `PERFORMANCE <i>◂ ${PERF_LABEL[settings.perf]} ▸</i>`,
        change: (d) => {
          settings.perf = cycle<PerfMode>(['auto', 'high', 'low'], settings.perf, d);
          this.app.applyPerf();
        },
      },
      {
        label: () => `GAMEPAD <i>◂ ${settings.pad === 'twin' ? 'TWIN STICK' : 'MODERN'} ▸</i>`,
        change: () => (settings.pad = settings.pad === 'twin' ? 'modern' : 'twin'),
      },
      {
        label: () => `ANNOUNCER <i>◂ ${settings.voice ? 'ON' : 'OFF'} ▸</i>`,
        change: () => {
          settings.voice = !settings.voice;
          applyAudioSettings();
        },
      },
      {
        label: () => `MUSIC <i>◂ ${'■'.repeat(Math.round(settings.music * 10)).padEnd(10, '□')} ▸</i>`,
        change: (d) => {
          settings.music = clamp(Math.round((settings.music + d * 0.1) * 10) / 10, 0, 1);
          applyAudioSettings();
        },
      },
      {
        label: () => `SOUND FX <i>◂ ${'■'.repeat(Math.round(settings.sfx * 10)).padEnd(10, '□')} ▸</i>`,
        change: (d) => {
          settings.sfx = clamp(Math.round((settings.sfx + d * 0.1) * 10) / 10, 0, 1);
          applyAudioSettings();
          audio.play('rifle', { volume: 0.6 });
        },
      },
      { label: () => 'BACK', act: () => this.openPage('main') },
    ];
    this.renderMenu();
    if (audio.ready) this.begin(true);
    this.world.fx.density = app.fxDensity;
    // pose the scene without running menu logic (input from the previous screen may still be live)
    this.world.update(0, [NEUTRAL, NEUTRAL]);
    this.placeCamera();
    try {
      app.renderer.gl.compile(this.world.scene, this.cam);
    } catch (err) {
      console.warn('[virtual-off] shader prewarm failed', err);
    }
  }

  private begin(silent = false) {
    if (this.started) return;
    this.started = true;
    this.startedAt = performance.now();
    audio.unlock();
    applyAudioSettings();
    audio.playMusic('title');
    if (!silent) audio.play('uiConfirmBig');
    this.el.classList.add('started');
  }

  private get items() {
    return this.page === 'main' ? this.mainItems : this.settingsItems;
  }

  private openPage(page: 'main' | 'settings') {
    audio.play(page === 'main' ? 'uiBack' : 'uiSelect');
    this.sel = page === 'main' ? 2 : 0;
    this.page = page;
    this.menuEl.classList.toggle('settings', page === 'settings');
    this.renderMenu();
  }

  private renderMenu() {
    this.menuEl.innerHTML = '';
    this.items.forEach((it, i) => {
      const d = document.createElement('div');
      d.className = `item${i === this.sel ? ' sel' : ''}`;
      d.innerHTML = it.label();
      d.addEventListener('click', (e) => {
        e.stopPropagation();
        // the tap that opened the menu must not also press whatever item appeared under the finger
        if (!this.started || performance.now() - this.startedAt < 400) return;
        this.sel = i;
        if (it.act) it.act();
        else if (it.change) {
          it.change(1);
          saveSettings();
          audio.play('uiMove');
        }
        if (!it.act) this.renderMenu();
      });
      this.menuEl.appendChild(d);
    });
  }

  private togglePanel(on: boolean) {
    this.panel.classList.toggle('hidden', !on);
    audio.play(on ? 'uiSelect' : 'uiBack');
  }

  private startGame() {
    if (this.leaving) return;
    this.leaving = true;
    audio.play('uiConfirmBig');
    this.el.classList.add('leaving');
    setTimeout(() => this.flow.select(), 450);
  }

  private startVersus() {
    if (this.leaving) return;
    this.leaving = true;
    audio.play('uiConfirmBig');
    this.el.classList.add('leaving');
    setTimeout(() => this.flow.versus(), 450);
  }

  private placeCamera() {
    const a = this.t * 0.1 + 0.6;
    this.cam.position.set(Math.sin(a) * 25, 5 + Math.sin(this.t * 0.27) * 2, Math.cos(a) * 25);
    this.cam.lookAt(0, 6.8, 0);
    this.cam.updateMatrixWorld();
  }

  update(dt: number) {
    this.t += dt;
    this.world.viewportHeight = this.app.renderer.height;
    this.world.update(dt, [NEUTRAL, NEUTRAL]);
    this.placeCamera();

    const m = this.app.input.menu;
    if (!this.started) {
      if (m.any) this.begin();
      return;
    }
    if (this.leaving) return;
    if (!this.panel.classList.contains('hidden')) {
      if (m.back || m.confirm || m.pause) this.togglePanel(false);
      return;
    }
    if (m.back && this.page === 'settings') {
      this.openPage('main');
      return;
    }
    if (m.up || m.down) {
      this.sel = (this.sel + (m.down ? 1 : -1) + this.items.length) % this.items.length;
      audio.play('uiMove');
      this.renderMenu();
    }
    const it = this.items[this.sel];
    if ((m.left || m.right) && it.change) {
      it.change(m.right ? 1 : -1);
      saveSettings();
      audio.play('uiMove');
      this.renderMenu();
    }
    if (m.confirm) {
      if (it.act) it.act();
      else if (it.change) {
        it.change(1);
        saveSettings();
        audio.play('uiMove');
        this.renderMenu();
      }
    }
  }

  render() {
    this.app.renderer.render(this.world.scene, this.cam);
  }

  dispose() {
    this.offResize();
    this.world.dispose();
    this.el.remove();
  }
}

// ------------------------------------------------------------------ hangar (select + ending backdrop)

function gridTexture() {
  return canvasTexture(
    256,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = '#070b1f';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(60,200,255,0.55)';
      ctx.fillRect(0, 0, w, 3);
      ctx.fillRect(0, 0, 3, h);
      ctx.fillStyle = 'rgba(60,200,255,0.18)';
      ctx.fillRect(0, h / 2, w, 1);
      ctx.fillRect(w / 2, 0, 1, h);
    },
    true,
  );
}

/** Dark showroom with turntable platforms — backdrop for VR select, versus lobby and the ending. */
export class Hangar {
  readonly scene = new THREE.Scene();
  readonly cam: THREE.PerspectiveCamera;
  readonly platforms: THREE.Group[] = [];
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly disposables: { dispose(): void }[] = [];

  get platform() {
    return this.platforms[0];
  }

  constructor(aspect: number, xs: number[] = [0]) {
    const s = this.scene;
    s.background = new THREE.Color(0x060a1c);
    s.fog = new THREE.Fog(0x060a1c, 30, 140);
    this.cam = new THREE.PerspectiveCamera(38, aspect, 0.3, 500);
    s.add(new THREE.HemisphereLight(0x9aa8ff, 0x141428, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(10, 16, 14);
    const rim = new THREE.DirectionalLight(0x40e0ff, 2.4);
    rim.position.set(-12, 8, -14);
    s.add(key, rim);

    const tex = gridTexture();
    tex.repeat.set(40, 40);
    const floorMat = new THREE.MeshLambertMaterial({ map: tex });
    const floorGeo = new THREE.PlaneGeometry(320, 320);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    s.add(floor);

    const baseGeo = new THREE.CylinderGeometry(6, 6.6, 0.9, 8);
    const baseMat = new THREE.MeshLambertMaterial({ color: 0x232842, flatShading: true });
    const ringGeo = new THREE.TorusGeometry(6.3, 0.14, 6, 48).rotateX(Math.PI / 2);
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0x47e6ff });
    const coneGeo = new THREE.ConeGeometry(7.5, 30, 32, 1, true);
    const coneMat = new THREE.MeshBasicMaterial({
      color: 0x7fd8ff,
      transparent: true,
      opacity: 0.07,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (const x of xs) {
      const platform = new THREE.Group();
      platform.position.x = x;
      const base = new THREE.Mesh(baseGeo, baseMat);
      base.position.y = 0.45;
      const ring = new THREE.Mesh(ringGeo, this.ringMat);
      ring.position.y = 0.92;
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.position.y = 15;
      platform.add(base, ring, cone);
      s.add(platform);
      this.platforms.push(platform);
    }

    // backdrop light bars
    const barGeo = new THREE.BoxGeometry(0.6, 60, 0.6);
    const barMats = [0x2fd4ff, 0xff3fa0, 0xffc21a].map((c) => new THREE.MeshBasicMaterial({ color: c }));
    for (let i = 0; i < 18; i++) {
      const b = new THREE.Mesh(barGeo, barMats[i % 3]);
      const a = -1.3 + (i / 17) * 2.6;
      b.position.set(Math.sin(a) * 60, 30, -Math.cos(a) * 60);
      s.add(b);
    }
    this.disposables.push(tex, floorMat, floorGeo, baseGeo, baseMat, ringGeo, this.ringMat, coneGeo, coneMat, barGeo, ...barMats);
  }

  update(t: number) {
    this.ringMat.color.setHSL(0.53, 1, 0.55 + Math.sin(t * 4) * 0.1);
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}

// ------------------------------------------------------------------ VR select

export class SelectScreen implements Screen {
  private readonly hangar: Hangar;
  private readonly el: HTMLDivElement;
  private readonly offResize: () => void;
  private model: MechModel | null = null;
  private readonly pose = makePose();
  private idx = 0;
  private spin = 0.6;
  private t = 0;
  private timeLeft = 20;
  private chosen = false;
  private chosenT = 0;

  constructor(
    private readonly app: App,
    private readonly flow: Flow,
  ) {
    this.hangar = new Hangar(app.renderer.aspect);
    this.hangar.platform.position.set(3.2, 0, 0);
    this.offResize = app.renderer.onResize(() => {
      this.hangar.cam.aspect = app.renderer.aspect;
      this.hangar.cam.updateProjectionMatrix();
    });
    this.el = document.createElement('div');
    this.el.className = 'screen select-screen';
    this.el.innerHTML = `
      <div class="sel-header"><div class="sel-kicker">LIMITED WAR · PILOT REGISTRATION</div><div class="sel-title">SELECT YOUR VR</div></div>
      <div class="sel-timer"><span>TIME</span><b>20</b></div>
      <div class="sel-info"></div>
      <div class="sel-roster"></div>
      <div class="sel-arrow left">◀</div><div class="sel-arrow right">▶</div>
      <div class="sel-footer">◀ ▶ choose · START / J confirm · ESC back</div>`;
    app.ui.appendChild(this.el);
    this.el.querySelector('.sel-arrow.left')!.addEventListener('click', () => this.move(-1));
    this.el.querySelector('.sel-arrow.right')!.addEventListener('click', () => this.move(1));
    this.el.querySelector('.sel-info')!.addEventListener('click', () => this.confirm());
    audio.playMusic('select');
    this.show(0);
  }

  private show(i: number) {
    this.idx = i;
    const spec = ROSTER[i];
    if (this.model) {
      this.hangar.platform.remove(this.model.root);
      this.model.dispose();
    }
    this.model = new MechModel(spec, spec.palette);
    this.model.root.position.y = 0.9;
    this.hangar.platform.add(this.model.root);
    const statBar = (label: string, v: number) =>
      `<div class="stat"><span>${label}</span><i>${'<b></b>'.repeat(v)}${'<u></u>'.repeat(5 - v)}</i></div>`;
    const info = this.el.querySelector('.sel-info') as HTMLDivElement;
    info.innerHTML = `
      <div class="sel-code">${spec.code}</div>
      <div class="sel-name">${spec.name}</div>
      <div class="sel-blurb">${spec.blurb}</div>
      <div class="sel-stats">${statBar('ARMOR', spec.stats.armor)}${statBar('SPEED', spec.stats.speed)}${statBar('POWER', spec.stats.power)}${statBar('RANGE', spec.stats.range)}</div>
      <div class="sel-weapons">
        <div><em>LW</em>${spec.weapons.lw.name}</div>
        <div><em>RW</em>${spec.weapons.rw.name}</div>
        <div><em>CW</em>${spec.weapons.cw.name}</div>
        <div><em>MELEE</em>${spec.melee.name}</div>
      </div>`;
    info.classList.remove('swap');
    void info.offsetWidth;
    info.classList.add('swap');
    const roster = this.el.querySelector('.sel-roster') as HTMLDivElement;
    roster.innerHTML = ROSTER.map((r, k) => `<div class="chip${k === i ? ' on' : ''}" style="--c:#${r.palette.secondary.toString(16).padStart(6, '0')}">${r.name}</div>`).join('');
    roster.querySelectorAll<HTMLDivElement>('.chip').forEach((c, k) =>
      c.addEventListener('click', () => {
        if (k !== this.idx && !this.chosen) {
          audio.play('uiMove');
          this.show(k);
        }
      }),
    );
  }

  private move(d: number) {
    if (this.chosen) return;
    audio.play('uiMove');
    this.show((this.idx + d + ROSTER.length) % ROSTER.length);
  }

  private confirm() {
    if (this.chosen) return;
    this.chosen = true;
    this.chosenT = 0;
    audio.play('uiConfirmBig');
    audio.speak(ROSTER[this.idx].name);
    this.el.classList.add('chosen');
  }

  update(dt: number) {
    this.t += dt;
    this.hangar.update(this.t);
    const m = this.app.input.menu;
    if (!this.chosen) {
      this.timeLeft -= dt;
      const tEl = this.el.querySelector('.sel-timer b');
      const shown = String(Math.max(0, Math.ceil(this.timeLeft)));
      if (tEl && tEl.textContent !== shown) tEl.textContent = shown;
      if (m.left) this.move(-1);
      if (m.right) this.move(1);
      if (m.confirm || this.timeLeft <= 0) this.confirm();
      else if (m.back) {
        audio.play('uiBack');
        this.chosen = true;
        this.flow.title();
        return;
      }
      this.spin += dt * 0.55;
    } else {
      this.chosenT += dt;
      // swing round to face the pilot and strike a pose
      const target = Math.round(this.spin / (Math.PI * 2)) * Math.PI * 2 + 0.8;
      this.spin += (target - this.spin) * Math.min(1, dt * 5);
      const isJebe = ROSTER[this.idx].id === 'jebe';
      this.pose.aimR = isJebe ? Math.min(1, this.chosenT * 3) : 0;
      this.pose.beam = isJebe ? 0 : Math.min(1, this.chosenT * 3);
      this.pose.charge = Math.min(1, this.chosenT * 1.2);
      this.pose.thrust = this.chosenT < 0.6 ? 0.6 : 0;
      if (this.chosenT > 1.6) {
        this.chosen = true;
        this.flow.start(ROSTER[this.idx]);
        this.chosenT = -1e9;
      }
    }
    if (this.model) {
      this.model.root.rotation.y = this.spin;
      this.model.update(this.pose, dt);
    }
    const c = this.hangar.cam;
    c.position.set(-1.2, 5.2, 18.5);
    c.lookAt(1.6, 4.2, 0);
  }

  render() {
    this.app.renderer.render(this.hangar.scene, this.hangar.cam);
  }

  dispose() {
    this.offResize();
    this.model?.dispose();
    this.hangar.dispose();
    this.el.remove();
  }
}

// ------------------------------------------------------------------ ending

export class EndingScreen implements Screen {
  private readonly hangar: Hangar;
  private readonly el: HTMLDivElement;
  private readonly model: MechModel;
  private readonly pose = makePose();
  private readonly offResize: () => void;
  private t = 0;
  private leaving = false;

  constructor(
    private readonly app: App,
    private readonly flow: Flow,
    spec: MechSpec,
  ) {
    this.hangar = new Hangar(app.renderer.aspect);
    this.offResize = app.renderer.onResize(() => {
      this.hangar.cam.aspect = app.renderer.aspect;
      this.hangar.cam.updateProjectionMatrix();
    });
    this.model = new MechModel(spec, spec.palette);
    this.model.root.position.y = 0.9;
    this.hangar.platform.add(this.model.root);
    this.el = document.createElement('div');
    this.el.className = 'screen ending-screen';
    this.el.innerHTML = `
      <div class="end-kicker">LIMITED WAR · FINAL REPORT</div>
      <div class="end-title">ALL STAGES CLEAR</div>
      <div class="end-sub">CONGRATULATIONS, ${spec.name} PILOT</div>
      <div class="end-credits">
        <div>VIRTUAL-OFF</div>
        <div>a love letter to mid-90s arcade mech duels</div>
        <div>THANK YOU FOR PLAYING</div>
      </div>
      <div class="ov-hint blink">PRESS START</div>`;
    app.ui.appendChild(this.el);
    this.el.addEventListener('click', () => this.leave());
    audio.playMusic('title');
    audio.speak('Congratulations');
  }

  private leave() {
    if (this.leaving || this.t < 1.5) return;
    this.leaving = true;
    audio.play('uiConfirmBig');
    this.flow.title();
  }

  update(dt: number) {
    this.t += dt;
    this.hangar.update(this.t);
    this.model.root.rotation.y = this.t * 0.4;
    this.pose.aimR = Math.sin(this.t * 0.5) > 0.3 ? 1 : 0;
    this.model.update(this.pose, dt);
    const c = this.hangar.cam;
    c.position.set(Math.sin(this.t * 0.15) * 4, 5, 19);
    c.lookAt(0, 4.4, 0);
    if (this.app.input.menu.confirm) this.leave();
  }

  render() {
    this.app.renderer.render(this.hangar.scene, this.hangar.cam);
  }

  dispose() {
    this.offResize();
    this.model.dispose();
    this.hangar.dispose();
    this.el.remove();
  }
}
