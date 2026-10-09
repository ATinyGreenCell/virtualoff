import * as THREE from 'three';
import { audio } from '../audio/audio';
import type { App, Screen } from '../app';
import { makeControls, type ControlFrame } from '../core/input';
import { clamp } from '../core/math';
import { reducedMotion, type Difficulty } from '../core/settings';
import type { NetLink } from '../net/link';
import {
  EDGE_MASK,
  PHASES,
  edgeBits,
  packInput,
  r2,
  r3,
  unpackInput,
  type InputMsg,
  type NetEvent,
  type ProjSnap,
  type Role,
  type SnapMsg,
} from '../net/protocol';
import { HUD } from '../ui/hud';
import { AIController } from './ai';
import { STAGES } from './arena';
import { ChaseCamera } from './camera';
import { Mech } from './mech';
import type { MechSpec, Palette, StageId } from './specs';
import { World } from './world';

export interface BattleSetup {
  /** arcade: the player; versus: the host's VR */
  mech0: MechSpec;
  palette0: Palette;
  /** arcade: the CPU; versus: the guest's VR */
  mech1: MechSpec;
  palette1: Palette;
  stage: StageId;
  stageNo: number;
  stageCount: number;
  difficulty: Difficulty;
  net?: { link: NetLink; role: Role };
}

export type BattleResult = 'win' | 'continue' | 'gameover' | 'quit' | 'rematch';

const ROUND_TIME = 60;
const WINS_NEEDED = 2;
const NUMBERS = ['one', 'two', 'three', 'four', 'five'];
/** host: snapshot cadence (ms) */
const SNAP_MS = 15;
/** host: a guest that goes quiet this long is treated as letting go of the controls */
const INPUT_STALE_MS = 400;

type Phase = (typeof PHASES)[number];
type Mode = 'cpu' | 'host' | 'guest';

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const NEUTRAL = makeControls();

export class Battle implements Screen {
  private readonly world: World;
  private readonly cam: ChaseCamera;
  private readonly hud: HUD;
  private readonly mode: Mode;
  private readonly mechs: [Mech, Mech];
  private readonly localIdx: 0 | 1;
  private readonly local: Mech;
  private readonly remote: Mech;
  private readonly ai: AIController | null;
  private readonly net: NetLink | null;
  private phase: Phase = 'intro';
  private phaseT = 0;
  private flags = new Set<string>();
  private round = 1;
  private wins = [0, 0];
  private timeLeft = ROUND_TIME;
  private timeScale = 1;
  private roundWinner = -1;
  private finishKind: 'ko' | 'time' = 'ko';
  private orbitAngle = 0;
  private alarmT = 0;
  private paused = false;
  private pauseEl: HTMLDivElement | null = null;
  private pauseIdx = 0;
  private resultEl: HTMLDivElement | null = null;
  private resultT = 0;
  private resultIdx = 0;
  private continueT = 10;
  private gameOver = false;
  private matchWon = false;
  private finished = false;
  private readonly flashEl: HTMLDivElement;
  private readonly offResize: () => void;
  private readonly totals = { damage: 0, shots: 0, time: 0 };

  // ---- versus
  private leaveEl: HTMLDivElement | null = null;
  private leaveIdx = 0;
  private wantRematch = false;
  private rivalRematch = false;
  private rivalGone = false;
  /** host: what the guest is pressing */
  private remoteMsg: InputMsg | null = null;
  private remoteEdges = 0;
  private remoteSeq = -1;
  private remoteAt = 0;
  private readonly remoteCtl = makeControls();
  private outEvents: NetEvent[] = [];
  private lastSnapAt = 0;
  private netClock = 0;
  /** guest: snapshot buffer and render clock */
  private snaps: SnapMsg[] = [];
  private pending: { ht: number; e: NetEvent }[] = [];
  private renderT = -1;
  private jitter = 0.01;
  private lastArrival = 0;
  private lastHt = 0;
  private inputSeq = 0;
  private lastInputKey = '';
  private lastInputAt = 0;
  private readonly projScratch: ProjSnap[] = [];

  constructor(
    private readonly app: App,
    private readonly setup: BattleSetup,
    private readonly done: (r: BattleResult) => void,
  ) {
    this.mode = setup.net ? setup.net.role : 'cpu';
    this.net = setup.net?.link ?? null;
    this.localIdx = this.mode === 'guest' ? 1 : 0;
    this.cam = new ChaseCamera(app.renderer.aspect);
    this.world = new World(setup.stage, this.cam.cam);
    const m0 = new Mech(setup.mech0, setup.palette0, this.localIdx === 0);
    const m1 = new Mech(setup.mech1, setup.palette1, this.localIdx === 1);
    m0.target = m1;
    m1.target = m0;
    this.world.add(m0);
    this.world.add(m1);
    this.mechs = [m0, m1];
    this.local = this.mechs[this.localIdx];
    this.remote = this.mechs[1 - this.localIdx];
    this.ai = this.mode === 'cpu' ? new AIController(setup.difficulty, setup.stageNo * 0.6) : null;
    const tags: [string, string] = this.mode === 'cpu' ? ['1P', 'CPU'] : ['YOU', 'RIVAL'];
    this.hud = new HUD(app.ui, this.local.spec, this.remote.spec, STAGES[setup.stage].name, 1, tags);
    this.flashEl = document.createElement('div');
    this.flashEl.className = 'screen-flash';
    app.ui.appendChild(this.flashEl);
    this.world.onDamageCb = (m, dmg) => {
      if (m === this.local) this.hud.damageFlash(dmg >= 80);
    };
    this.offResize = app.renderer.onResize(() => this.cam.setAspect(app.renderer.aspect));
    this.resetRound();
    this.world.fx.density = app.fxDensity;
    // build every projectile/effect up front and compile all shaders now, during the transition,
    // instead of hitching the first time something explodes
    this.world.projectiles.prewarm([setup.palette0.beam, setup.palette1.beam]);
    this.cam.chase(0, this.local, this.remote, 0);
    try {
      app.renderer.gl.compile(this.world.scene, this.cam.cam);
      this.world.arena.previewFaded(true);
      app.renderer.gl.compile(this.world.scene, this.cam.cam);
      this.world.arena.previewFaded(false);
    } catch (err) {
      console.warn('[virtual-off] shader prewarm failed', err);
    }
    if (this.net) this.attachNet(this.net);
    audio.playMusic(setup.stage === 'harbor' ? 'stageA' : 'stageB');
    this.enter('intro');
  }

  /** Page hidden / window blurred / gamepad unplugged. */
  suspend() {
    if (this.mode === 'cpu') {
      if (this.phase === 'fight' && !this.paused && !this.finished) this.setPaused(true);
    } else if (this.mode === 'guest') {
      // let go of the controls right away rather than walking into a wall while away
      this.net?.sendInput(packInput(++this.inputSeq, NEUTRAL, 0));
    }
  }

  private enter(p: Phase) {
    this.phase = p;
    this.phaseT = 0;
    this.flags.clear();
  }

  private once(key: string) {
    if (this.flags.has(key)) return false;
    this.flags.add(key);
    return true;
  }

  private resetRound() {
    const sp = this.world.arena.spawns;
    this.mechs[0].reset(sp[0].pos, sp[0].yaw);
    this.mechs[1].reset(sp[1].pos, sp[1].yaw);
    this.mechs[0].controlsEnabled = this.mechs[1].controlsEnabled = false;
    this.world.projectiles.clear();
    this.world.fx.clear();
    this.timeLeft = ROUND_TIME;
    this.timeScale = 1;
    this.alarmT = 0;
    this.cam.snap(this.local);
    this.hud.setWins(this.localWins());
    this.hud.setTimer(this.timeLeft);
  }

  private localWins() {
    return [this.wins[this.localIdx], this.wins[1 - this.localIdx]];
  }

  private finish(r: BattleResult) {
    if (this.finished) return;
    this.finished = true;
    this.done(r);
  }

  // ------------------------------------------------------------------ frame

  update(dt: number) {
    if (this.finished) return;
    this.app.touch?.setBattleActive(this.phase === 'fight' && !this.paused && !this.leaveEl);
    if (this.mode === 'guest') {
      this.guestUpdate(dt);
      return;
    }
    const input = this.app.input;
    if (this.paused) {
      this.updatePause();
      return;
    }
    if (this.leaveEl) this.updateLeave();
    else if (this.phase === 'fight' && input.menu.pause) {
      if (this.mode === 'cpu') this.setPaused(true);
      else this.openLeave();
      return;
    }
    if (this.phase === 'result') this.updateResult(dt);

    let sdt = dt * this.timeScale;
    if (this.world.hitStopT > 0) {
      this.world.hitStopT -= dt;
      sdt *= 0.06;
    }
    this.phaseT += dt;
    this.netClock += dt;
    this.updatePhase(dt);
    const c1 = this.ai ? this.ai.update(sdt, this.mechs[1], this.mechs[0], this.world) : this.takeRemoteInput();
    this.world.viewportHeight = this.app.renderer.height;
    this.world.update(sdt, [this.leaveEl ? NEUTRAL : input.controls, c1]);
    if (this.mode === 'host') {
      this.remoteEdges = 0;
      this.sendSnapshot();
    }
    this.updateCamera(dt);
    this.updateHud(dt);
    if (this.phase === 'fight') this.totals.time += dt;
  }

  private updatePhase(dt: number) {
    const t = this.phaseT;
    const [m0, m1] = this.mechs;
    this.presentPhase();
    switch (this.phase) {
      case 'intro':
        if (t > 3.2 || (t > 0.6 && this.mode === 'cpu' && this.app.input.menu.confirm)) {
          this.hud.showBanner(false);
          this.cam.snap(this.local);
          this.cam.blendFromCurrent(0.9);
          this.enter('ready');
        }
        break;
      case 'ready':
        if (this.once('round')) this.ui('round', this.round);
        if (t > 1.3 && this.once('ready')) this.ui('ready');
        if (t > 2.7) {
          this.ui('go');
          m0.controlsEnabled = m1.controlsEnabled = true;
          this.app.input.flush();
          this.enter('fight');
        }
        break;
      case 'fight': {
        this.timeLeft -= dt;
        const d0 = !m0.alive;
        const d1 = !m1.alive;
        if (d0 || d1) {
          this.finishKind = 'ko';
          this.roundWinner = d0 && d1 ? 2 : d0 ? 1 : 0;
          this.endFight();
        } else if (this.timeLeft <= 0) {
          this.timeLeft = 0;
          this.finishKind = 'time';
          const f0 = m0.hpFrac;
          const f1 = m1.hpFrac;
          this.roundWinner = Math.abs(f0 - f1) < 0.005 ? 2 : f0 > f1 ? 0 : 1;
          this.endFight();
        }
        break;
      }
      case 'finish':
        if (this.finishKind === 'ko') this.timeScale = t < 1.3 ? 0.3 : Math.min(1, this.timeScale + dt * 0.8);
        if (!this.flags.has('boom') && (m0.exploded || m1.exploded)) {
          this.flags.add('boom');
          this.ui('flash');
        }
        if (t > 4.0) this.enter('roundEnd');
        break;
      case 'roundEnd':
        if (this.once('result')) {
          this.timeScale = 1;
          if (this.roundWinner === 0 || this.roundWinner === 1) this.wins[this.roundWinner]++;
          this.ui('rres', this.roundWinner, this.wins[0], this.wins[1]);
        }
        if (t > 3.0) {
          if (this.wins[0] >= WINS_NEEDED || this.wins[1] >= WINS_NEEDED || this.round >= 5) {
            this.ui('match', this.wins[0], this.wins[1]);
          } else {
            this.round++;
            this.resetRound();
            this.ui('next', this.round);
            this.enter('ready');
          }
        }
        break;
      case 'result':
        break;
    }
  }

  /** Per-frame presentation that depends only on phase and phase time (host and guest alike). */
  private presentPhase() {
    const t = this.phaseT;
    if (this.phase === 'intro') {
      this.hud.showBanner(t > 0.2 && t < 3.0);
      this.hud.setVisible(t > 0.2);
    } else if (this.phase !== 'result') {
      this.hud.showBanner(false);
      this.hud.setVisible(true);
    }
    if (this.phase === 'fight') {
      if (t > 1.0 && this.once('clear')) this.hud.clearAnnounce();
      if (t > 10 && this.once('hint')) this.hud.showHint(false);
    }
  }

  private endFight() {
    const [m0, m1] = this.mechs;
    m0.controlsEnabled = m1.controlsEnabled = false;
    this.totals.damage += this.local.stats.damage;
    this.totals.shots += this.local.stats.shots;
    this.local.stats.damage = this.local.stats.shots = 0;
    this.enter('finish');
    this.ui('fin', this.finishKind === 'ko' ? 0 : 1);
  }

  /** A presentational beat (announcer, results): played here and mirrored to a versus guest. */
  private ui(name: string, ...args: number[]) {
    if (this.mode === 'host') this.outEvents.push(['u', name, ...args]);
    this.applyUi(name, args);
  }

  private applyUi(name: string, a: number[]) {
    switch (name) {
      case 'round':
        this.hud.announce(`ROUND ${a[0]}`, 'round');
        audio.play('announceRound');
        audio.speak(`Round ${NUMBERS[a[0] - 1] ?? a[0]}`);
        break;
      case 'ready':
        this.hud.announce('GET READY', 'ready');
        audio.play('announceReady');
        audio.speak('Get ready');
        break;
      case 'go':
        this.hud.announce('GO!!', 'go');
        audio.play('announceGo');
        audio.speak('Go!');
        if (this.mode === 'cpu' && this.round === 1 && this.setup.stageNo === 0) this.hud.showHint(true);
        break;
      case 'fin':
        if (a[0] === 0) {
          this.hud.announce('FINISH!!', 'finish');
          audio.play('announceFinish');
          audio.speak('Finish');
        } else {
          this.hud.announce('TIME UP', 'timeup');
          audio.play('announceTimeUp');
          audio.speak('Time up');
        }
        break;
      case 'flash':
        this.screenFlash();
        break;
      case 'rres': {
        this.hud.showHint(false);
        const winner = a[0];
        if (this.mode === 'guest') this.wins = [a[1], a[2]];
        if (winner === 2) {
          this.hud.announce('DRAW', 'draw');
          audio.speak('Draw');
        } else if (winner === this.localIdx) {
          this.hud.announce('YOU WIN', 'win');
          audio.play('announceWin');
          audio.speak('You win');
        } else {
          this.hud.announce('YOU LOSE', 'lose');
          audio.play('announceLose');
          audio.speak('You lose');
        }
        this.hud.setWins(this.localWins());
        break;
      }
      case 'next':
        this.hud.setRoundLabel(a[0]);
        this.hud.clearAnnounce();
        this.cam.snap(this.local);
        this.cam.blendFromCurrent(0.7);
        break;
      case 'match':
        this.wins = [a[0], a[1]];
        this.showResult();
        break;
    }
  }

  private screenFlash() {
    if (reducedMotion) return;
    const f = this.flashEl;
    f.classList.remove('on');
    void f.offsetWidth;
    f.classList.add('on');
  }

  // ------------------------------------------------------------------ versus plumbing

  private attachNet(link: NetLink) {
    const onStatus = (st: string) => {
      if (st === 'lost' || st === 'error') this.rivalLeft('CONNECTION LOST');
    };
    const onLobby = (m: { t: string }) => {
      if (m.t === 'bye') this.rivalLeft('YOUR RIVAL LEFT');
      else if (m.t === 'again') {
        this.rivalRematch = true;
        this.checkRematch();
      }
    };
    if (this.mode === 'host') {
      this.world.recordTo((e) => this.outEvents.push(e));
      link.attach(this, {
        onStatus,
        onLobby,
        onInput: (m) => {
          if (m[0] <= this.remoteSeq) return;
          this.remoteSeq = m[0];
          this.remoteMsg = m;
          this.remoteAt = performance.now();
          this.remoteEdges |= m[4] & EDGE_MASK;
        },
      });
    } else {
      link.attach(this, { onStatus, onLobby, onSnap: (m) => this.receiveSnap(m) });
    }
  }

  private takeRemoteInput(): ControlFrame {
    const msg = this.remoteMsg;
    if (!msg || performance.now() - this.remoteAt > INPUT_STALE_MS) {
      // hold no buttons, but keep any presses that did arrive
      unpackInput([0, 0, 0, 0, 0], this.remoteEdges, this.remoteCtl);
    } else unpackInput(msg, this.remoteEdges, this.remoteCtl);
    return this.remoteCtl;
  }

  private sendSnapshot() {
    const now = performance.now();
    if (now - this.lastSnapAt < SNAP_MS || !this.net) return;
    this.lastSnapAt = now;
    const msg: SnapMsg = {
      ht: r3(this.netClock),
      ph: PHASES.indexOf(this.phase),
      pt: r2(this.phaseT),
      tl: r2(this.timeLeft),
      rd: this.round,
      w: [this.wins[0], this.wins[1]],
      rw: this.roundWinner,
      fk: this.finishKind === 'ko' ? 0 : 1,
      m: [this.mechs[0].writeNet(), this.mechs[1].writeNet()],
      p: this.world.projectiles.writeNet(this.mechs),
      b: this.world.projectiles.writeBeams(this.mechs),
      e: this.outEvents,
    };
    if (this.net.sendSnap(msg)) this.outEvents = [];
    else if (this.outEvents.length > 600) this.outEvents.splice(0, this.outEvents.length - 600);
  }

  private receiveSnap(m: SnapMsg) {
    const last = this.snaps[this.snaps.length - 1];
    if (last && m.ht <= last.ht) return;
    const now = performance.now() / 1000;
    if (this.lastArrival) {
      const dev = Math.abs(now - this.lastArrival - (m.ht - this.lastHt));
      this.jitter += (Math.min(dev, 0.25) - this.jitter) * 0.1;
    }
    this.lastArrival = now;
    this.lastHt = m.ht;
    this.snaps.push(m);
    if (this.snaps.length > 40) this.snaps.shift();
    for (const e of m.e) this.pending.push({ ht: m.ht, e });
  }

  private sendInput() {
    if (!this.net) return;
    const c = this.leaveEl || this.phase === 'result' ? NEUTRAL : this.app.input.controls;
    const edges = edgeBits(c);
    const msg = packInput(this.inputSeq + 1, c, edges);
    const key = `${msg[1]},${msg[2]},${msg[3]},${msg[4]}`;
    const now = performance.now();
    // send on any change or press, plus a 10 Hz heartbeat so the host knows we're still here
    if (edges || key !== this.lastInputKey || now - this.lastInputAt > 100) {
      this.inputSeq++;
      this.net.sendInput(msg);
      this.lastInputKey = key;
      this.lastInputAt = now;
    }
  }

  private guestUpdate(dt: number) {
    this.sendInput();
    if (this.leaveEl) this.updateLeave();
    else if (this.phase === 'fight' && this.app.input.menu.pause) this.openLeave();
    if (this.phase === 'result') this.updateResult(dt);

    const snaps = this.snaps;
    if (snaps.length) {
      const latest = snaps[snaps.length - 1];
      // render a little behind the newest snapshot so there is always something to interpolate toward
      const delay = clamp(0.035 + this.jitter * 2.5, 0.035, 0.2);
      if (this.renderT < 0) this.renderT = latest.ht - delay;
      this.renderT += dt;
      const err = latest.ht - delay - this.renderT;
      if (Math.abs(err) > 0.3) this.renderT += err;
      else this.renderT += err * Math.min(1, dt * 3);
      let i = snaps.length - 1;
      while (i > 0 && snaps[i].ht > this.renderT) i--;
      const a = snaps[i];
      const b = snaps[i + 1] ?? null;
      const k = b ? clamp((this.renderT - a.ht) / Math.max(1e-4, b.ht - a.ht), 0, 1) : 0;
      this.applyFrame(a, b, k);
      if (i > 2) snaps.splice(0, i - 2);
      while (this.pending.length && this.pending[0].ht <= this.renderT) {
        const ev = this.pending.shift()!;
        this.playEvent(ev.e);
      }
    }
    this.presentPhase();
    this.world.viewportHeight = this.app.renderer.height;
    this.world.updatePuppet(dt);
    this.updateCamera(dt);
    this.updateHud(dt);
  }

  private applyFrame(a: SnapMsg, b: SnapMsg | null, k: number) {
    const ph = PHASES[a.ph] ?? 'fight';
    if (ph !== this.phase) {
      this.phase = ph;
      this.flags.clear();
    }
    const same = b && b.ph === a.ph;
    this.phaseT = same ? a.pt + (b.pt - a.pt) * k : a.pt;
    this.timeLeft = same ? a.tl + (b.tl - a.tl) * k : a.tl;
    this.round = a.rd;
    this.roundWinner = a.rw;
    this.finishKind = a.fk ? 'time' : 'ko';
    for (let i = 0; i < 2; i++) this.mechs[i].readNet(a.m[i], b ? b.m[i] : null, k);
    // projectiles: interpolate those in both snapshots, extrapolate the rest
    const out = this.projScratch;
    out.length = 0;
    const ahead = this.renderT - a.ht;
    for (const pa of a.p) {
      const pb = b?.p.find((q) => q[0] === pa[0]);
      if (pb) {
        out.push([pa[0], pa[1], pa[2], pa[3] + (pb[3] - pa[3]) * k, pa[4] + (pb[4] - pa[4]) * k, pa[5] + (pb[5] - pa[5]) * k, pb[6], pb[7], pb[8], pa[9]]);
      } else {
        out.push([pa[0], pa[1], pa[2], pa[3] + pa[6] * ahead, pa[4] + pa[7] * ahead, pa[5] + pa[8] * ahead, pa[6], pa[7], pa[8], pa[9]]);
      }
    }
    this.world.projectiles.applyNet(out, this.mechs);
    this.world.projectiles.applyBeams(b ? b.b : a.b, this.mechs);
  }

  private playEvent(e: NetEvent) {
    if (e[0] === 'u') this.applyUi(e[1] as string, e.slice(2) as number[]);
    else this.world.replay(e);
  }

  private rivalLeft(title: string) {
    if (this.rivalGone || this.finished) return;
    this.rivalGone = true;
    this.leaveEl?.remove();
    this.leaveEl = null;
    this.resultEl?.remove();
    const el = document.createElement('div');
    el.className = 'overlay result lost';
    el.innerHTML = `<div class="ov-title small">${title}</div><div class="menu"><div class="item sel">BACK TO TITLE</div></div>`;
    el.addEventListener('click', () => this.finish('quit'));
    this.app.ui.appendChild(el);
    this.resultEl = el;
    this.resultT = 0;
  }

  private checkRematch() {
    if (this.wantRematch && this.rivalRematch) this.finish('rematch');
  }

  private openLeave() {
    if (this.leaveEl || this.rivalGone) return;
    audio.play('uiSelect');
    this.leaveIdx = 0;
    const el = document.createElement('div');
    el.className = 'overlay pause';
    el.innerHTML = `<div class="ov-title small">LEAVE THE MATCH?</div><div class="ov-hint">the fight keeps going while this is open</div><div class="menu"><div class="item" data-i="0">KEEP FIGHTING</div><div class="item" data-i="1">LEAVE</div></div>`;
    el.querySelectorAll<HTMLDivElement>('.item').forEach((it) =>
      it.addEventListener('click', () => {
        this.leaveIdx = Number(it.dataset.i);
        this.activateLeave();
      }),
    );
    this.app.ui.appendChild(el);
    this.leaveEl = el;
    this.renderMenu(el, this.leaveIdx);
  }

  private activateLeave() {
    if (this.leaveIdx === 0) {
      this.leaveEl?.remove();
      this.leaveEl = null;
      this.app.input.flush();
    } else {
      audio.play('uiBack');
      this.net?.sendLobby({ t: 'bye' });
      this.finish('quit');
    }
  }

  private updateLeave() {
    const m = this.app.input.menu;
    if (m.up || m.down) {
      this.leaveIdx = 1 - this.leaveIdx;
      audio.play('uiMove');
      if (this.leaveEl) this.renderMenu(this.leaveEl, this.leaveIdx);
    }
    if (m.pause || m.back) {
      this.leaveIdx = 0;
      this.activateLeave();
    } else if (m.confirm) this.activateLeave();
  }

  private renderMenu(el: HTMLElement, idx: number) {
    el.querySelectorAll<HTMLDivElement>('.item').forEach((it, i) => it.classList.toggle('sel', i === idx));
  }

  // ------------------------------------------------------------------ camera & HUD

  private updateCamera(dt: number) {
    const shake = this.world.shakeAmt;
    const ph = this.phase;
    const loser = this.roundWinner === 0 ? this.mechs[1] : this.roundWinner === 1 ? this.mechs[0] : this.remote;
    const winner = this.roundWinner === 1 ? this.mechs[1] : this.roundWinner === 0 ? this.mechs[0] : this.local;
    let focus = this.local;
    if (ph === 'intro') {
      const t = this.phaseT;
      focus = this.remote;
      this.cam.orbit(dt, this.remote.pos, 15 + t * 2.2, 2.6 + t * 0.6, this.remote.yaw + 1.0 - t * 0.5, 4.6);
    } else if (ph === 'finish' && this.finishKind === 'ko' && this.phaseT > 0.3) {
      focus = loser;
      if (this.once('kocam')) {
        this.cam.blendFromCurrent(0.6);
        this.orbitAngle = Math.atan2(this.cam.cam.position.x - loser.pos.x, this.cam.cam.position.z - loser.pos.z);
      }
      this.orbitAngle += dt * 0.3;
      this.cam.orbit(dt, loser.pos, 28, 10, this.orbitAngle, 3, shake);
    } else if (ph === 'roundEnd' || ph === 'result') {
      focus = winner;
      if (this.once('wincam')) {
        this.cam.blendFromCurrent(0.8);
        this.orbitAngle = winner.yaw + 0.6;
      }
      this.orbitAngle += dt * 0.25;
      this.cam.orbit(dt, winner.pos, 13, 3.2, this.orbitAngle, 4.6);
    } else {
      this.cam.chase(dt, this.local, this.remote, shake);
    }
    // fade blocks that hide the mech the camera is looking at
    _a.set(focus.pos.x, focus.pos.y + 2.5, focus.pos.z);
    _b.set(focus.pos.x, focus.pos.y + focus.spec.height, focus.pos.z);
    this.world.arena.updateOcclusion(this.cam.cam.position, [_a, _b], dt);
  }

  private updateHud(dt: number) {
    const hud = this.hud;
    const me = this.local;
    const foe = this.remote;
    hud.setHP(0, me.hpFrac);
    hud.setHP(1, foe.hpFrac);
    hud.setTimer(this.timeLeft);
    const w = me.spec.weapons;
    hud.setGauges(me.gauges, { lw: w.lw.cost, rw: w.rw.cost, cw: w.cw.cost });

    const showRet = (this.phase === 'fight' || this.phase === 'ready') && foe.alive;
    if (showRet) {
      foe.centerInto(_v).project(this.cam.cam);
      const behind = _v.z > 1;
      if (!behind && Math.abs(_v.x) < 0.94 && Math.abs(_v.y) < 0.92) {
        const x = ((_v.x + 1) / 2) * window.innerWidth;
        const y = ((1 - _v.y) / 2) * window.innerHeight;
        hud.setReticle(x, y, me.lockedOn, me.pos.distanceTo(foe.pos));
        hud.setArrow(null);
      } else {
        hud.setReticle(null, 0, false, 0);
        let ax = _v.x;
        let ay = -_v.y;
        if (behind) {
          ax = -ax;
          ay = -ay;
        }
        hud.setArrow(Math.atan2(ay, ax));
      }
    } else {
      hud.setReticle(null, 0, false, 0);
      hud.setArrow(null);
    }

    if (this.phase === 'fight') {
      if (me.state === 'down' || me.state === 'getup') hud.setStatus('DOWN', 'down');
      else if (me.state === 'guard') hud.setStatus('GUARD', 'guard');
      else if (me.hpFrac < 0.25) hud.setStatus('WARNING', 'danger');
      else hud.setStatus('');
      if (me.hpFrac < 0.25 && me.alive) {
        this.alarmT -= dt;
        if (this.alarmT <= 0) {
          this.alarmT = 2.2;
          audio.play('alarm', { volume: 0.45 });
        }
      }
    } else hud.setStatus('');
  }

  // ------------------------------------------------------------------ pause (vs CPU only)

  private setPaused(on: boolean) {
    this.paused = on;
    if (on) {
      audio.play('uiSelect');
      this.pauseIdx = 0;
      const el = document.createElement('div');
      el.className = 'overlay pause';
      el.innerHTML = `<div class="ov-title">PAUSE</div><div class="menu"><div class="item" data-i="0">RESUME</div><div class="item" data-i="1">RETIRE</div></div><div class="ov-hint">ESC to resume</div>`;
      el.querySelectorAll<HTMLDivElement>('.item').forEach((it) => {
        it.addEventListener('click', () => {
          this.pauseIdx = Number(it.dataset.i);
          this.activatePause();
        });
      });
      this.app.ui.appendChild(el);
      this.pauseEl = el;
      this.renderMenu(el, this.pauseIdx);
    } else {
      this.pauseEl?.remove();
      this.pauseEl = null;
      this.app.input.flush();
    }
  }

  private activatePause() {
    if (this.pauseIdx === 0) this.setPaused(false);
    else {
      audio.play('uiBack');
      this.finish('quit');
    }
  }

  private updatePause() {
    const m = this.app.input.menu;
    if (m.up || m.down) {
      this.pauseIdx = 1 - this.pauseIdx;
      audio.play('uiMove');
      if (this.pauseEl) this.renderMenu(this.pauseEl, this.pauseIdx);
    }
    if (m.pause || m.back) this.setPaused(false);
    else if (m.confirm) this.activatePause();
  }

  // ------------------------------------------------------------------ results

  private showResult() {
    if (this.resultEl || this.rivalGone) return;
    this.enter('result');
    const mine = this.wins[this.localIdx];
    const theirs = this.wins[1 - this.localIdx];
    this.matchWon = mine > theirs;
    this.resultT = 0;
    this.resultIdx = 0;
    this.continueT = 10;
    this.hud.clearAnnounce();
    this.hud.setVisible(false);
    audio.playMusic(this.matchWon ? 'victory' : 'defeat');
    const el = document.createElement('div');
    el.className = `overlay result ${this.matchWon ? 'won' : 'lost'}`;
    if (this.mode !== 'cpu') {
      el.innerHTML = `
        <div class="ov-kicker">VERSUS · ${this.local.spec.name} VS ${this.remote.spec.name}</div>
        <div class="ov-title">${mine === theirs ? 'DRAW GAME' : this.matchWon ? 'YOU WIN!!' : 'YOU LOSE'}</div>
        <div class="stats"><div><span>ROUNDS</span><b>${mine} - ${theirs}</b></div></div>
        <div class="menu"><div class="item" data-i="0">REMATCH</div><div class="item" data-i="1">QUIT</div></div>
        <div class="ov-hint vs-wait"></div>`;
      el.querySelectorAll<HTMLDivElement>('.item').forEach((it) =>
        it.addEventListener('click', (e) => {
          e.stopPropagation();
          this.resultIdx = Number(it.dataset.i);
          this.activateVersusResult();
        }),
      );
      this.renderMenu(el, this.resultIdx);
    } else if (this.matchWon) {
      const last = this.setup.stageNo + 1 >= this.setup.stageCount;
      const t = Math.round(this.totals.time);
      el.innerHTML = `
        <div class="ov-kicker">STAGE ${this.setup.stageNo + 1} / ${this.setup.stageCount}</div>
        <div class="ov-title">${last ? 'ALL STAGES CLEAR' : 'STAGE CLEAR'}</div>
        <div class="stats">
          <div><span>ROUNDS</span><b>${mine} - ${theirs}</b></div>
          <div><span>DAMAGE DEALT</span><b>${Math.round(this.totals.damage)}</b></div>
          <div><span>SHOTS FIRED</span><b>${this.totals.shots}</b></div>
          <div><span>BATTLE TIME</span><b>${Math.floor(t / 60)}'${String(t % 60).padStart(2, '0')}"</b></div>
        </div>
        <div class="ov-hint blink">PRESS START</div>`;
      el.addEventListener('click', () => this.resultConfirm());
    } else {
      el.innerHTML = `
        <div class="ov-title">CONTINUE?</div>
        <div class="count">9</div>
        <div class="ov-hint">START to continue · ESC to skip</div>`;
      el.addEventListener('click', () => this.resultConfirm());
    }
    this.app.ui.appendChild(el);
    this.resultEl = el;
  }

  private activateVersusResult() {
    if (this.resultT < 0.8 || this.rivalGone) return;
    if (this.resultIdx === 1) {
      audio.play('uiBack');
      this.net?.sendLobby({ t: 'bye' });
      this.finish('quit');
      return;
    }
    if (this.wantRematch) return;
    this.wantRematch = true;
    audio.play('uiConfirmBig');
    this.net?.sendLobby({ t: 'again' });
    const hint = this.resultEl?.querySelector('.vs-wait');
    if (hint) hint.textContent = 'WAITING FOR YOUR RIVAL…';
    this.checkRematch();
  }

  private resultConfirm() {
    if (this.resultT < 1.0) return;
    if (this.matchWon) {
      audio.play('uiConfirmBig');
      this.finish('win');
    } else if (!this.gameOver) {
      audio.play('uiConfirmBig');
      this.finish('continue');
    }
  }

  private updateResult(dt: number) {
    this.resultT += dt;
    const m = this.app.input.menu;
    if (this.rivalGone) {
      if (this.resultT > 0.5 && (m.confirm || m.back)) this.finish('quit');
      return;
    }
    if (this.mode !== 'cpu') {
      if (!this.resultEl) return;
      if ((m.up || m.down) && !this.wantRematch) {
        this.resultIdx = 1 - this.resultIdx;
        audio.play('uiMove');
        this.renderMenu(this.resultEl, this.resultIdx);
      }
      if (m.confirm) this.activateVersusResult();
      return;
    }
    if (this.matchWon) {
      if (m.confirm) this.resultConfirm();
      return;
    }
    if (this.gameOver) {
      if (this.resultT > 3 || (this.resultT > 1 && m.confirm)) this.finish('gameover');
      return;
    }
    if (this.resultT > 1.0) this.continueT -= dt * (m.back ? 8 : 1);
    if (m.back) this.continueT = Math.floor(this.continueT);
    const count = this.resultEl?.querySelector('.count');
    const shown = Math.max(0, Math.ceil(this.continueT - 1));
    if (count && count.textContent !== String(shown)) {
      count.textContent = String(shown);
      audio.play('uiMove');
    }
    if (m.confirm) this.resultConfirm();
    if (this.continueT <= 0) {
      this.gameOver = true;
      this.resultT = 0;
      if (this.resultEl) this.resultEl.innerHTML = '<div class="ov-title gameover">GAME OVER</div>';
      audio.stopMusic(1.5);
    }
  }

  render() {
    this.app.renderer.render(this.world.scene, this.cam.cam);
  }

  dispose() {
    this.app.touch?.setBattleActive(false);
    this.net?.detach(this);
    this.offResize();
    this.world.dispose();
    this.hud.dispose();
    this.flashEl.remove();
    this.pauseEl?.remove();
    this.resultEl?.remove();
    this.leaveEl?.remove();
  }
}
