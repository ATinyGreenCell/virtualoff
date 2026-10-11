import * as THREE from 'three';
import { audio } from '../audio/audio';
import type { App, Screen } from '../app';
import { deviceLabel, makeControls, type ControlFrame, type DeviceId } from '../core/input';
import { clamp, hdist, rand, rightOf } from '../core/math';
import { IS_XBOX, XBOX_REFOCUS } from '../core/platform';
import { reducedMotion, type Difficulty } from '../core/settings';
import { ceremony } from '../core/testmode';
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
import type { MechSpec, Palette, StageId, WeaponDef } from './specs';
import { World } from './world';

/** The two players' controllers: [1P (top view), 2P (bottom view)], each with the connection generation
 *  it was claimed at (see Device.generation). Shared with the flow's pick, so a takeover sticks. */
export interface LocalSeats {
  devices: [DeviceId, DeviceId];
  gens: [number, number];
}

/** Two players on one screen, each on their own controller: split-screen versus or co-op vs the CPU. */
export type LocalSetup =
  | ({ mode: 'versus' } & LocalSeats)
  | ({
      mode: 'coop';
      /** the CPU both players take on (its armor is boosted: it's two on one) */
      boss: { spec: MechSpec; palette: Palette };
    } & LocalSeats);

export interface BattleSetup {
  /** arcade: the player; versus: the host's VR; split screen: 1P (top view) */
  mech0: MechSpec;
  palette0: Palette;
  /** arcade: the CPU; versus: the guest's VR; split screen: 2P (bottom view) */
  mech1: MechSpec;
  palette1: Palette;
  stage: StageId;
  stageNo: number;
  stageCount: number;
  difficulty: Difficulty;
  net?: { link: NetLink; role: Role };
  local?: LocalSetup;
}

export type BattleResult = 'win' | 'continue' | 'gameover' | 'quit' | 'rematch' | 'select';

const ROUND_TIME = 60;
const WINS_NEEDED = 2;
const NUMBERS = ['one', 'two', 'three', 'four', 'five'];
/** host: snapshot cadence (ms) */
const SNAP_MS = 15;
/** host: a guest that goes quiet this long is treated as letting go of the controls */
const INPUT_STALE_MS = 400;
/**
 * Co-op: it's two on one, so the boss gets more armor, hits harder, recharges faster and shrugs off
 * light hits (two players could otherwise stagger it forever), and its pilot is sharper than the
 * stage's usual CPU. In simulation, two normal-level CPU pilots beat the first boss about four times
 * in five and the second (sharper still) a bit under half the time.
 */
const BOSS = { armor: 1.6, power: 1.45, regen: 1.35, poise: 2, edge: 0.8 };
/** co-op: the two players start this far either side of their spawn point */
const COOP_SPREAD = 11;
/** co-op: a destroyed player watches their wreck this long before the camera moves to their partner */
const WATCH_WRECK = 2.6;

type Phase = (typeof PHASES)[number];
type Mode = 'cpu' | 'host' | 'guest' | 'local' | 'coop';

/** One player's window on the fight: a camera and a HUD. Split screen has two, stacked. */
interface View {
  /** whose eyes these are */
  mech: Mech;
  /** the enemy on the right of the HUD (co-op: the boss) */
  foe: Mech;
  /** co-op: the partner */
  ally: Mech | null;
  /** who the camera chases — a destroyed co-op player watches their partner */
  follow: Mech;
  cam: ChaseCamera;
  hud: HUD;
  /** split screen: this view's half of the screen, holding its HUD */
  box: HTMLDivElement | null;
  /** split screen: the controller this player is on, and its connection generation when claimed */
  device: DeviceId | null;
  gen: number;
  orbitAngle: number;
}

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const NEUTRAL = makeControls();
/** per-view one-shot flags for the KO and winner camera moves */
const KO_CAM = ['kocam', 'kocam1'];
const WIN_CAM = ['wincam', 'wincam1'];

export class Battle implements Screen {
  /** split screen: the renderer draws two stacked views */
  readonly split: boolean;
  private readonly world: World;
  private readonly views: View[] = [];
  private readonly mode: Mode;
  private readonly mechs: Mech[];
  /** co-op: the CPU both players fight */
  private readonly boss: Mech | null = null;
  private readonly localIdx: 0 | 1;
  /** the first view's pilot and opponent (the one-screen modes have no other) */
  private readonly local: Mech;
  private readonly remote: Mech;
  private readonly ai: AIController | null;
  private readonly net: NetLink | null;
  private readonly controls: ControlFrame[] = [];
  private phase: Phase = 'intro';
  private phaseT = 0;
  private flags = new Set<string>();
  private round = 1;
  /** rounds won per side: arcade/versus [mech0, mech1]; co-op [the players, the boss] */
  private wins = [0, 0];
  private timeLeft = ROUND_TIME;
  private timeScale = 1;
  private roundWinner = -1;
  private finishKind: 'ko' | 'time' = 'ko';
  /** mechs destroyed by the round's final blow: the screen flashes when they blow up */
  private boomWatch: Mech[] = [];
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

  // ---- co-op
  /** the boss re-picks its target every few seconds */
  private retargetT = 0;
  /** each player's damage dealt when the boss last re-picked (it goes after whoever hurts it) */
  private aggroMark = [0, 0];

  // ---- versus
  private leaveEl: HTMLDivElement | null = null;
  private leaveIdx = 0;
  private wantRematch = false;
  private rivalRematch = false;
  private rivalGone = false;
  /** versus: the link dropped and is trying to come back — the match is frozen meanwhile */
  private reconnectEl: HTMLDivElement | null = null;
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
    const local = setup.local;
    this.mode = local ? (local.mode === 'coop' ? 'coop' : 'local') : setup.net ? setup.net.role : 'cpu';
    this.split = !!local;
    this.net = setup.net?.link ?? null;
    this.localIdx = this.mode === 'guest' ? 1 : 0;
    const n = this.split ? 2 : 1;
    const cams = Array.from({ length: n }, () => new ChaseCamera(app.renderer.viewAspect(n), this.split));
    this.world = new World(setup.stage, cams[0].cam);
    this.world.cameras = cams.map((c) => c.cam);

    const human = (i: number) => this.split || this.localIdx === i;
    const m0 = new Mech(setup.mech0, setup.palette0, human(0));
    const m1 = new Mech(setup.mech1, setup.palette1, human(1));
    if (local?.mode === 'coop') {
      const base = local.boss.spec;
      const quick = (w: WeaponDef) => ({ ...w, regen: w.regen * BOSS.regen });
      const spec: MechSpec = {
        ...base,
        hp: Math.round(base.hp * BOSS.armor),
        weapons: { lw: quick(base.weapons.lw), rw: quick(base.weapons.rw), cw: quick(base.weapons.cw) },
      };
      const boss = new Mech(spec, local.boss.palette, false);
      boss.power = BOSS.power;
      boss.poise = BOSS.poise;
      this.world.add(m0, 0);
      this.world.add(m1, 0);
      this.world.add(boss, 1);
      m0.target = m1.target = boss;
      boss.target = m0;
      this.boss = boss;
      this.mechs = [m0, m1, boss];
    } else {
      m0.target = m1;
      m1.target = m0;
      this.world.add(m0);
      this.world.add(m1);
      this.mechs = [m0, m1];
    }

    const stageName = STAGES[setup.stage].name;
    for (let i = 0; i < n; i++) {
      const mech = this.split ? this.mechs[i] : this.mechs[this.localIdx];
      const foe = this.boss ?? (mech === m0 ? m1 : m0);
      const ally = this.boss ? this.mechs[1 - i] : null;
      let box: HTMLDivElement | null = null;
      if (this.split) {
        box = document.createElement('div');
        box.className = `hud-view v${i}`;
        app.ui.appendChild(box);
      }
      const hud = new HUD(box ?? app.ui, mech.spec, foe.spec, stageName, 1, this.tags(i), {
        split: this.split,
        ally: ally ? { tag: i === 0 ? '2P' : '1P', spec: ally.spec } : undefined,
      });
      this.views.push({ mech, foe, ally, follow: mech, cam: cams[i], hud, box, device: local?.devices[i] ?? null, gen: local?.gens[i] ?? 0, orbitAngle: 0 });
    }
    this.local = this.views[0].mech;
    this.remote = this.views[0].foe;
    // the CPU sharpens along the ladder, reaching the same edge on the last stage however long it is
    const ramp = setup.stageCount > 1 ? (setup.stageNo / (setup.stageCount - 1)) * 0.6 : 0;
    this.ai =
      this.mode === 'cpu'
        ? new AIController(setup.difficulty, ramp)
        : this.mode === 'coop'
          ? new AIController(setup.difficulty, ramp + BOSS.edge)
          : null;
    this.flashEl = document.createElement('div');
    this.flashEl.className = 'screen-flash';
    app.ui.appendChild(this.flashEl);
    this.world.onDamageCb = (m, dmg) => {
      for (const v of this.views) if (v.mech === m) v.hud.damageFlash(dmg >= 80);
    };
    this.offResize = app.renderer.onResize(() => this.fitViews());
    this.fitViews();
    this.resetRound();
    this.world.fx.density = app.fxDensity;
    // build every projectile/effect up front and compile all shaders now, during the transition,
    // instead of hitching the first time something explodes
    this.world.projectiles.prewarm([...new Set(this.mechs.map((m) => m.palette.beam))]);
    const v0 = this.views[0];
    v0.cam.chase(0, v0.mech, v0.foe, 0);
    try {
      app.renderer.gl.compile(this.world.scene, v0.cam.cam);
      this.world.arena.previewFaded(true);
      app.renderer.gl.compile(this.world.scene, v0.cam.cam);
      this.world.arena.previewFaded(false);
    } catch (err) {
      console.warn('[virtual-off] shader prewarm failed', err);
    }
    if (this.net) this.attachNet(this.net);
    audio.playMusic(setup.stage === 'harbor' ? 'stageA' : 'stageB');
    this.enter('intro');
  }

  /** HUD name tags for view `i`: [this pilot, their opponent]. */
  private tags(i: number): [string, string] {
    switch (this.mode) {
      case 'cpu':
        return ['1P', 'CPU'];
      case 'local':
        return i === 0 ? ['1P', '2P'] : ['2P', '1P'];
      case 'coop':
        return [i === 0 ? '1P' : '2P', 'BOSS'];
      default:
        return ['YOU', 'RIVAL'];
    }
  }

  /** Match each view's camera and HUD to its share of the screen. */
  private fitViews() {
    const n = this.views.length;
    for (const v of this.views) {
      v.cam.setAspect(this.app.renderer.viewAspect(n));
      v.hud.setViewport(window.innerWidth, window.innerHeight / n, this.split);
    }
  }

  /** You can pause a fight that runs only on this device (vs CPU, split screen). */
  private get pausable() {
    return this.mode === 'cpu' || this.mode === 'local' || this.mode === 'coop';
  }

  /** Page hidden / window blurred / gamepad unplugged. */
  suspend() {
    if (this.pausable) {
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
    if (this.boss) {
      // the players start side by side on one pad, the boss on the other
      rightOf(sp[0].yaw, _v);
      this.mechs[0].reset(_a.copy(sp[0].pos).addScaledVector(_v, -COOP_SPREAD), sp[0].yaw);
      this.mechs[1].reset(_a.copy(sp[0].pos).addScaledVector(_v, COOP_SPREAD), sp[0].yaw);
      this.boss.reset(sp[1].pos, sp[1].yaw);
      this.boss.target = this.mechs[Math.random() < 0.5 ? 0 : 1];
      this.retargetT = rand(3, 5);
      this.aggroMark = [0, 0];
    } else {
      this.mechs[0].reset(sp[0].pos, sp[0].yaw);
      this.mechs[1].reset(sp[1].pos, sp[1].yaw);
    }
    for (const m of this.mechs) m.controlsEnabled = false;
    this.world.live = false;
    this.world.projectiles.clear();
    this.world.fx.clear();
    this.timeLeft = ROUND_TIME;
    this.timeScale = 1;
    this.alarmT = 0;
    for (const v of this.views) {
      v.follow = v.mech;
      v.cam.snap(v.mech);
      v.hud.setWins(this.viewWins(v));
      v.hud.setTimer(this.timeLeft);
    }
  }

  /** Which side of the score a view's pilot is on (co-op: both players are side 0). */
  private sideOf(v: View) {
    return this.boss ? 0 : this.mechs.indexOf(v.mech);
  }

  /** [this view's wins, its opponent's]. */
  private viewWins(v: View) {
    const s = this.sideOf(v);
    return [this.wins[s], this.wins[1 - s]];
  }

  private finish(r: BattleResult) {
    if (this.finished) return;
    this.finished = true;
    this.done(r);
  }

  // ------------------------------------------------------------------ frame

  update(dt: number) {
    if (this.finished) return;
    this.app.touch?.setBattleActive(!this.split && this.phase === 'fight' && !this.paused && !this.leaveEl && !this.reconnectEl);
    if (this.reconnectEl) {
      this.updateReconnect();
      return;
    }
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
    else if (this.phase === 'fight' && (input.menu.pause || this.missingDevice())) {
      if (this.pausable) this.setPaused(true);
      else this.openLeave();
      return;
    }
    if (this.phase === 'result') this.updateResult(dt);

    let sdt = dt * this.timeScale;
    if (this.world.hitStopT > 0) {
      this.world.hitStopT -= dt;
      sdt *= 0.06;
    }
    this.phaseT += this.phase === 'fight' ? dt : ceremony(dt);
    this.netClock += dt;
    this.updatePhase(dt);
    this.gatherControls(sdt);
    this.world.viewportHeight = this.app.renderer.height / this.views.length;
    this.world.update(sdt, this.controls);
    if (this.mode === 'host') {
      this.remoteEdges = 0;
      this.sendSnapshot();
    }
    this.updateCamera(dt);
    this.updateHud(dt);
    if (this.phase === 'fight') this.totals.time += dt;
  }

  /** This frame's controls for every mech, in world order. */
  private gatherControls(sdt: number) {
    const c = this.controls;
    const [m0, m1] = this.mechs;
    switch (this.mode) {
      case 'cpu':
        c[0] = this.leaveEl ? NEUTRAL : this.app.input.controls;
        c[1] = this.ai!.update(sdt, m1, m0, this.world);
        break;
      case 'host':
        c[0] = this.leaveEl ? NEUTRAL : this.app.input.controls;
        c[1] = this.takeRemoteInput();
        break;
      default:
        c[0] = this.deviceControls(this.views[0]);
        c[1] = this.deviceControls(this.views[1]);
        if (this.boss) c[2] = this.ai!.update(sdt, this.boss, this.bossTarget(sdt), this.world);
    }
  }

  /** Split screen: what this view's player is pressing on their own controller. */
  private deviceControls(v: View): ControlFrame {
    return (!this.lost(v) && this.app.input.device(v.device!)?.controls) || NEUTRAL;
  }

  /**
   * Split screen: this view's controller has gone (unplugged, flat battery, switched off) — or went and
   * came back, when the slot may now hold the other player's pad, so it has to be claimed again.
   */
  private lost(v: View) {
    if (!v.device) return false;
    const d = this.app.input.device(v.device);
    return !d || !d.connected || d.generation !== v.gen;
  }

  /** Split screen: the first player (1P before 2P) whose controller is lost. */
  private missingDevice(): View | null {
    if (!this.split) return null;
    for (const v of this.views) if (this.lost(v)) return v;
    return null;
  }

  /** Co-op: the boss picks which player to fight — whoever is near, or whoever has been hurting it. */
  private bossTarget(dt: number): Mech {
    const boss = this.boss!;
    const [p1, p2] = this.mechs;
    let cur = boss.target;
    const other = cur === p1 ? p2 : p1;
    this.retargetT -= dt;
    if (!cur.alive && other.alive) {
      cur = other;
      this.retargetT = rand(3, 5);
    } else if (this.retargetT <= 0 && other.alive) {
      this.retargetT = rand(2.5, 5);
      const dealt = (m: Mech) => m.stats.damage - this.aggroMark[m === p1 ? 0 : 1];
      const near = hdist(boss.pos, other.pos) < hdist(boss.pos, cur.pos) * 0.7;
      const angry = dealt(other) > dealt(cur) * 1.5 + 40;
      if (near || angry || Math.random() < 0.25) cur = other;
      this.aggroMark = [p1.stats.damage, p2.stats.damage];
    }
    boss.target = cur;
    return cur;
  }

  private updatePhase(dt: number) {
    const t = this.phaseT;
    this.presentPhase();
    switch (this.phase) {
      case 'intro':
        if (t > 3.2 || (t > 0.6 && this.pausable && this.app.input.menu.confirm)) {
          for (const v of this.views) {
            v.hud.showBanner(false);
            v.cam.snap(v.mech);
            v.cam.blendFromCurrent(0.9);
          }
          this.enter('ready');
        }
        break;
      case 'ready':
        if (this.once('round')) this.ui('round', this.round);
        if (t > 1.3 && this.once('ready')) this.ui('ready');
        if (t > 2.7) {
          this.ui('go');
          this.world.live = true;
          for (const m of this.mechs) m.controlsEnabled = true;
          this.app.input.flush();
          this.enter('fight');
        }
        break;
      case 'fight': {
        this.timeLeft -= dt;
        const [d0, d1] = this.sidesDown();
        if (d0 || d1) {
          this.finishKind = 'ko';
          this.roundWinner = d0 && d1 ? 2 : d0 ? 1 : 0;
          this.endFight();
        } else if (this.timeLeft <= 0) {
          this.timeLeft = 0;
          this.finishKind = 'time';
          const [f0, f1] = this.sideHealth();
          this.roundWinner = Math.abs(f0 - f1) < 0.005 ? 2 : f0 > f1 ? 0 : 1;
          this.endFight();
        }
        break;
      }
      case 'finish':
        if (this.finishKind === 'ko') this.timeScale = t < 1.3 ? 0.3 : Math.min(1, this.timeScale + dt * 0.8);
        if (!this.flags.has('boom') && this.boomWatch.some((m) => m.exploded)) {
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

  /** Is each side out of the round? (co-op: the players only when both are down) */
  private sidesDown(): [boolean, boolean] {
    const [m0, m1] = this.mechs;
    if (this.boss) return [!m0.alive && !m1.alive, !this.boss.alive];
    return [!m0.alive, !m1.alive];
  }

  /** Armor left per side, for a time-up decision (co-op: the players' average). */
  private sideHealth(): [number, number] {
    const [m0, m1] = this.mechs;
    if (this.boss) return [(m0.hpFrac + m1.hpFrac) / 2, this.boss.hpFrac];
    return [m0.hpFrac, m1.hpFrac];
  }

  /** Per-frame presentation that depends only on phase and phase time (host and guest alike). */
  private presentPhase() {
    const t = this.phaseT;
    for (const { hud } of this.views) {
      if (this.phase === 'intro') {
        hud.showBanner(t > 0.2 && t < 3.0);
        hud.setVisible(t > 0.2);
      } else if (this.phase !== 'result') {
        hud.showBanner(false);
        hud.setVisible(true);
      }
    }
    if (this.phase === 'fight') {
      if (t > 1.0 && this.once('clear')) for (const v of this.views) v.hud.clearAnnounce();
      if (t > 10 && this.once('hint')) for (const v of this.views) v.hud.showHint(false);
    }
  }

  private endFight() {
    for (const m of this.mechs) m.controlsEnabled = false;
    this.world.live = false;
    this.boomWatch = this.mechs.filter((m) => !m.alive && !m.exploded);
    const scorers = this.boss ? this.mechs.filter((m) => m !== this.boss) : [this.local];
    for (const s of scorers) {
      this.totals.damage += s.stats.damage;
      this.totals.shots += s.stats.shots;
      s.stats.damage = s.stats.shots = 0;
    }
    this.enter('finish');
    this.ui('fin', this.finishKind === 'ko' ? 0 : 1);
  }

  /** A presentational beat (announcer, results): played here and mirrored to a versus guest. */
  private ui(name: string, ...args: number[]) {
    if (this.mode === 'host') this.outEvents.push(['u', name, ...args]);
    this.applyUi(name, args);
  }

  private announceAll(text: string, cls: string) {
    for (const v of this.views) v.hud.announce(text, cls);
  }

  private applyUi(name: string, a: number[]) {
    switch (name) {
      case 'round':
        this.announceAll(`ROUND ${a[0]}`, 'round');
        audio.play('announceRound');
        audio.speak(`Round ${NUMBERS[a[0] - 1] ?? a[0]}`);
        break;
      case 'ready':
        this.announceAll('GET READY', 'ready');
        audio.play('announceReady');
        audio.speak('Get ready');
        break;
      case 'go':
        this.announceAll('GO!!', 'go');
        audio.play('announceGo');
        audio.speak('Go!');
        if (this.mode === 'cpu' && this.round === 1 && this.setup.stageNo === 0) this.views[0].hud.showHint(true);
        break;
      case 'fin':
        if (a[0] === 0) {
          this.announceAll('FINISH!!', 'finish');
          audio.play('announceFinish');
          audio.speak('Finish');
        } else {
          this.announceAll('TIME UP', 'timeup');
          audio.play('announceTimeUp');
          audio.speak('Time up');
        }
        break;
      case 'flash':
        this.screenFlash();
        break;
      case 'rres': {
        for (const v of this.views) v.hud.showHint(false);
        const winner = a[0];
        if (this.mode === 'guest') this.wins = [a[1], a[2]];
        if (winner === 2) {
          this.announceAll('DRAW', 'draw');
          audio.speak('Draw');
        } else if (this.mode === 'local') {
          // one screen, two players: each half gets its own verdict
          for (const v of this.views) {
            const won = this.sideOf(v) === winner;
            v.hud.announce(won ? 'YOU WIN' : 'YOU LOSE', won ? 'win' : 'lose');
          }
          audio.play('announceWin');
          audio.speak(winner === 0 ? 'Player one wins' : 'Player two wins');
        } else if (winner === this.sideOf(this.views[0])) {
          this.announceAll('YOU WIN', 'win');
          audio.play('announceWin');
          audio.speak('You win');
        } else {
          this.announceAll('YOU LOSE', 'lose');
          audio.play('announceLose');
          audio.speak('You lose');
        }
        for (const v of this.views) v.hud.setWins(this.viewWins(v));
        break;
      }
      case 'next':
        for (const v of this.views) {
          v.hud.setRoundLabel(a[0]);
          v.hud.clearAnnounce();
          v.cam.snap(v.mech);
          v.cam.blendFromCurrent(0.7);
        }
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
      else if (st === 'reconnecting') this.setReconnecting(true);
      else if (st === 'connected') this.setReconnecting(false);
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
      link.attach(this, {
        onStatus,
        onLobby,
        onSnap: (m) => this.receiveSnap(m),
        // one-shot events of fast-channel snapshots arrive separately (and reliably), in order
        onEvents: (m) => {
          for (const e of m.e) this.pending.push({ ht: m.ht, e });
        },
      });
    }
  }

  /** Freeze the match while the link tries to come back (both sides), and resume where it stopped. */
  private setReconnecting(on: boolean) {
    if (on === !!this.reconnectEl || this.finished) return;
    if (on) {
      if (this.rivalGone) return;
      const el = document.createElement('div');
      el.className = 'overlay pause reconnect';
      el.innerHTML = `<div class="ov-title small">CONNECTION LOST</div><div class="ov-hint">reconnecting… <b class="rc-left"></b><br>the match resumes on its own · pause to leave</div>`;
      this.app.ui.appendChild(el);
      this.reconnectEl = el;
      this.updateReconnect();
    } else {
      this.reconnectEl?.remove();
      this.reconnectEl = null;
      // the gap would otherwise read as jitter and inflate the guest's buffering
      this.lastArrival = 0;
      this.app.input.flush();
      audio.play('lockOn');
    }
  }

  private updateReconnect() {
    const left = Math.max(0, Math.ceil(((this.net?.reconnectDeadline ?? 0) - performance.now()) / 1000));
    const t = this.reconnectEl?.querySelector('.rc-left');
    if (t) t.textContent = `${left}`;
    if (this.leaveEl) this.updateLeave();
    else if (this.app.input.menu.pause) this.openLeave();
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
    // send on any change or press, plus a 20 Hz heartbeat: it tells the host we're here, and on the
    // lossy fast channel it re-delivers (with the last few inputs) anything a dropped packet carried
    if (edges || key !== this.lastInputKey || now - this.lastInputAt > 50) {
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
    this.reconnectEl?.remove();
    this.reconnectEl = null;
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
    for (let i = 0; i < this.views.length; i++) {
      const v = this.views[i];
      const shake = this.world.shakes[i];
      const ph = this.phase;
      let focus = v.follow;
      if (ph === 'intro') {
        const t = this.phaseT;
        focus = v.foe;
        // co-op: both halves circle the boss, from different sides
        const side = i > 0 && this.views[0].foe === focus ? 2.2 : 0;
        v.cam.orbit(dt, focus.pos, 15 + t * 2.2, 2.6 + t * 0.6, focus.yaw + 1.0 - t * 0.5 + side, 4.6);
      } else if (ph === 'finish' && this.finishKind === 'ko' && this.phaseT > 0.3) {
        focus = this.koFocus(v);
        if (this.once(KO_CAM[i])) {
          v.cam.blendFromCurrent(0.6);
          v.orbitAngle = Math.atan2(v.cam.cam.position.x - focus.pos.x, v.cam.cam.position.z - focus.pos.z);
        }
        v.orbitAngle += dt * 0.3;
        v.cam.orbit(dt, focus.pos, 28, 10, v.orbitAngle, 3, shake);
      } else if (ph === 'roundEnd' || ph === 'result') {
        focus = this.winFocus(v);
        if (this.once(WIN_CAM[i])) {
          v.cam.blendFromCurrent(0.8);
          // split-screen versus: both halves show the winner, the second from another front angle
          v.orbitAngle = focus.yaw + 0.6 + (i > 0 && this.winFocus(this.views[0]) === focus ? 1.3 : 0);
        }
        v.orbitAngle += dt * 0.25;
        v.cam.orbit(dt, focus.pos, 13, 3.2, v.orbitAngle, 4.6);
      } else {
        this.updateFollow(v);
        focus = v.follow;
        v.cam.chase(dt, v.follow, v.follow.target, shake);
      }
      // fade blocks that hide the mech the camera is looking at
      _a.set(focus.pos.x, focus.pos.y + 2.5, focus.pos.z);
      _b.set(focus.pos.x, focus.pos.y + focus.spec.height, focus.pos.z);
      this.world.arena.updateOcclusion(v.cam.cam.position, [_a, _b], dt, i);
    }
  }

  /** Co-op: once a destroyed player's wreck has burned a moment, their camera rides with the partner. */
  private updateFollow(v: View) {
    const want = !v.mech.alive && v.mech.deathT > WATCH_WRECK && v.ally?.alive ? v.ally : v.mech;
    if (want === v.follow) return;
    v.follow = want;
    // snap first: snapping ends any blend, so blending first would make this a hard cut
    v.cam.snap(want);
    v.cam.blendFromCurrent(0.7);
  }

  /** The round's KO shot: whoever just lost it (a draw shows the view's opponent). */
  private koFocus(v: View): Mech {
    const w = this.roundWinner;
    if (this.boss) {
      if (w !== 1) return this.boss;
      // the players lost: show the one who fell last
      const [p1, p2] = this.mechs;
      return p1.deathT <= p2.deathT ? p1 : p2;
    }
    return w === 0 ? this.mechs[1] : w === 1 ? this.mechs[0] : v.foe;
  }

  /** The round's victory pose (co-op win: each player circles their own VR, or their partner's). */
  private winFocus(v: View): Mech {
    const w = this.roundWinner;
    if (this.boss) {
      if (w === 1) return this.boss;
      return v.mech.alive || !v.ally ? v.mech : v.ally;
    }
    return w === 1 ? this.mechs[1] : w === 0 ? this.mechs[0] : v.mech;
  }

  private updateHud(dt: number) {
    let danger = false;
    for (const v of this.views) {
      const hud = v.hud;
      const me = v.mech;
      const foe = v.foe;
      hud.setHP(0, me.hpFrac);
      hud.setHP(1, foe.hpFrac);
      if (v.ally) hud.setAllyHP(v.ally.hpFrac);
      hud.setTimer(this.timeLeft);
      const w = me.spec.weapons;
      hud.setGauges(me.gauges, { lw: w.lw.cost, rw: w.rw.cost, cw: w.cw.cost });
      hud.setEN(me.en, me.enEmpty);

      // the lock-on reticle belongs to whoever the camera rides with
      const pilot = v.follow;
      const showRet = (this.phase === 'fight' || this.phase === 'ready') && foe.alive && pilot.alive;
      if (showRet) {
        foe.centerInto(_v).project(v.cam.cam);
        const behind = _v.z > 1;
        if (!behind && Math.abs(_v.x) < 0.94 && Math.abs(_v.y) < 0.92) {
          const x = ((_v.x + 1) / 2) * hud.viewW;
          const y = ((1 - _v.y) / 2) * hud.viewH;
          hud.setReticle(x, y, pilot.lockedOn, pilot.pos.distanceTo(foe.pos));
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
        if (!me.alive) hud.setStatus(v.follow !== me ? 'PARTNER CAM' : 'DESTROYED', 'down');
        else if (me.state === 'down' || me.state === 'getup') hud.setStatus('DOWN', 'down');
        else if (me.snareT > 0) hud.setStatus('SNARED', 'danger');
        else if (me.state === 'guard') hud.setStatus('GUARD', 'guard');
        else if (me.hpFrac < 0.25) hud.setStatus('WARNING', 'danger');
        else hud.setStatus('');
        if (me.hpFrac < 0.25 && me.alive) danger = true;
      } else hud.setStatus('');
    }
    if (danger) {
      this.alarmT -= dt;
      if (this.alarmT <= 0) {
        this.alarmT = 2.2;
        audio.play('alarm', { volume: 0.45 });
      }
    }
  }

  // ------------------------------------------------------------------ pause (vs CPU and split screen)

  private setPaused(on: boolean) {
    this.paused = on;
    if (on) {
      audio.play('uiSelect');
      this.pauseIdx = 0;
      const el = document.createElement('div');
      el.className = 'overlay pause';
      el.innerHTML = `<div class="ov-title">PAUSE</div><div class="ov-hint pause-note"></div><div class="menu"><div class="item" data-i="0">RESUME</div><div class="item" data-i="1">RETIRE</div></div><div class="ov-hint">${this.split ? 'START / ESC to resume' : 'ESC to resume'}</div>${IS_XBOX ? `<div class="ov-hint xbox-note">${XBOX_REFOCUS}</div>` : ''}`;
      el.querySelectorAll<HTMLDivElement>('.item').forEach((it) => {
        it.addEventListener('click', () => {
          this.pauseIdx = Number(it.dataset.i);
          this.activatePause();
        });
      });
      this.app.ui.appendChild(el);
      this.pauseEl = el;
      this.renderMenu(el, this.pauseIdx);
      this.refreshPauseNote();
    } else {
      this.pauseEl?.remove();
      this.pauseEl = null;
      this.app.input.flush();
    }
  }

  /** Split screen: say whose controller dropped out, and how to carry on (kept current every frame). */
  private refreshPauseNote() {
    const note = this.pauseEl?.querySelector('.pause-note');
    if (!note) return;
    const lost = this.missingDevice();
    const text = lost ? `${lost === this.views[0] ? '1P' : '2P'} CONTROLLER LOST · press A (or ENTER) on the controller ${lost === this.views[0] ? '1P' : '2P'} will use` : '';
    if (note.textContent === text) return;
    note.textContent = text;
    note.classList.toggle('alert', !!lost);
  }

  private activatePause() {
    if (this.pauseIdx === 0) {
      if (this.missingDevice()) {
        audio.play('empty');
        return;
      }
      this.setPaused(false);
    } else {
      audio.play('uiBack');
      this.finish('quit');
    }
  }

  private updatePause() {
    const m = this.app.input.menu;
    const lost = this.missingDevice();
    // the press that claims a controller does only that — it doesn't also resume or retire
    if (lost && this.adoptDevice(lost)) return;
    this.refreshPauseNote();
    if (m.up || m.down) {
      this.pauseIdx = 1 - this.pauseIdx;
      audio.play('uiMove');
      if (this.pauseEl) this.renderMenu(this.pauseEl, this.pauseIdx);
    }
    if (m.pause || m.back) {
      this.pauseIdx = 0;
      if (this.pauseEl) this.renderMenu(this.pauseEl, this.pauseIdx);
      this.activatePause();
    } else if (m.confirm) this.activatePause();
  }

  /**
   * Split screen: a lost player is taken over by the first controller to press A / START (or the keyboard's
   * ENTER) that no other player is using — their own pad once it's back, or any other. Lost players are
   * claimed in order, 1P first, so two pads that both dropped can't come back swapped.
   */
  private adoptDevice(v: View) {
    const i = this.views.indexOf(v);
    for (const d of this.app.input.devices()) {
      if (!d.menu.confirm || this.views.some((x) => x !== v && x.device === d.id && !this.lost(x))) continue;
      v.device = d.id;
      v.gen = d.generation;
      // the flow's pick shares these lists, so a rematch (or VR select) keeps the new controller
      if (this.setup.local) {
        this.setup.local.devices[i] = d.id;
        this.setup.local.gens[i] = d.generation;
      }
      audio.play('lockOn');
      this.refreshPauseNote();
      console.info(`[virtual-off] ${i === 0 ? '1P' : '2P'} now on ${deviceLabel(d.id)}`);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ results

  private showResult() {
    if (this.resultEl || this.rivalGone) return;
    this.enter('result');
    const side = this.sideOf(this.views[0]);
    const mine = this.wins[side];
    const theirs = this.wins[1 - side];
    this.matchWon = mine > theirs;
    this.resultT = 0;
    this.resultIdx = 0;
    this.continueT = 10;
    for (const v of this.views) {
      v.hud.clearAnnounce();
      v.hud.setVisible(false);
    }
    audio.playMusic(this.matchWon || this.mode === 'local' ? 'victory' : 'defeat');
    const el = document.createElement('div');
    el.className = `overlay result ${this.matchWon || this.mode === 'local' ? 'won' : 'lost'}`;
    const [m0, m1] = this.mechs;
    if (this.mode === 'local') {
      const [w0, w1] = this.wins;
      el.innerHTML = `
        <div class="ov-kicker">SPLIT SCREEN · ${m0.spec.name} VS ${m1.spec.name}</div>
        <div class="ov-title">${w0 === w1 ? 'DRAW GAME' : w0 > w1 ? '1P WINS!!' : '2P WINS!!'}</div>
        <div class="stats"><div><span>ROUNDS · 1P - 2P</span><b>${w0} - ${w1}</b></div></div>
        <div class="menu"><div class="item" data-i="0">REMATCH</div><div class="item" data-i="1">VR SELECT</div><div class="item" data-i="2">QUIT</div></div>`;
      this.bindResultMenu(el, () => this.activateLocalResult());
    } else if (this.mode === 'host' || this.mode === 'guest') {
      el.innerHTML = `
        <div class="ov-kicker">VERSUS · ${this.local.spec.name} VS ${this.remote.spec.name}</div>
        <div class="ov-title">${mine === theirs ? 'DRAW GAME' : this.matchWon ? 'YOU WIN!!' : 'YOU LOSE'}</div>
        <div class="stats"><div><span>ROUNDS</span><b>${mine} - ${theirs}</b></div></div>
        <div class="menu"><div class="item" data-i="0">REMATCH</div><div class="item" data-i="1">QUIT</div></div>
        <div class="ov-hint vs-wait"></div>`;
      this.bindResultMenu(el, () => this.activateVersusResult());
    } else if (this.matchWon) {
      const last = this.setup.stageNo + 1 >= this.setup.stageCount;
      const t = Math.round(this.totals.time);
      el.innerHTML = `
        <div class="ov-kicker">${this.boss ? 'CO-OP · ' : ''}STAGE ${this.setup.stageNo + 1} / ${this.setup.stageCount}</div>
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
        <div class="ov-hint">START to continue · ${this.split ? 'B / ESC' : 'ESC'} to skip</div>`;
      el.addEventListener('click', () => this.resultConfirm());
    }
    this.app.ui.appendChild(el);
    this.resultEl = el;
  }

  private bindResultMenu(el: HTMLElement, activate: () => void) {
    el.querySelectorAll<HTMLDivElement>('.item').forEach((it) =>
      it.addEventListener('click', (e) => {
        e.stopPropagation();
        this.resultIdx = Number(it.dataset.i);
        activate();
      }),
    );
    this.renderMenu(el, this.resultIdx);
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

  private activateLocalResult() {
    if (this.resultT < 0.8) return;
    if (this.resultIdx === 2) {
      audio.play('uiBack');
      this.finish('quit');
    } else {
      audio.play('uiConfirmBig');
      this.finish(this.resultIdx === 0 ? 'rematch' : 'select');
    }
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
    this.resultT += ceremony(dt);
    const m = this.app.input.menu;
    if (this.rivalGone) {
      if (this.resultT > 0.5 && (m.confirm || m.back)) this.finish('quit');
      return;
    }
    if (this.mode === 'host' || this.mode === 'guest' || this.mode === 'local') {
      if (!this.resultEl) return;
      const count = this.mode === 'local' ? 3 : 2;
      if ((m.up || m.down) && !this.wantRematch) {
        this.resultIdx = (this.resultIdx + (m.down ? 1 : count - 1)) % count;
        audio.play('uiMove');
        this.renderMenu(this.resultEl, this.resultIdx);
      }
      if (m.confirm) {
        if (this.mode === 'local') this.activateLocalResult();
        else this.activateVersusResult();
      }
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
    const r = this.app.renderer;
    if (!this.split) {
      r.render(this.world.scene, this.views[0].cam.cam);
      return;
    }
    // one scene, two cameras: each view gets its own sky center, block fades and particle sizing
    const h = Math.floor(r.height / 2);
    try {
      for (let i = 0; i < this.views.length; i++) {
        this.world.prepareView(i, h);
        r.renderView(this.world.scene, this.views[i].cam.cam, i, 2);
      }
    } finally {
      r.endViews();
    }
  }

  dispose() {
    this.app.touch?.setBattleActive(false);
    this.net?.detach(this);
    this.offResize();
    this.world.dispose();
    for (const v of this.views) {
      v.hud.dispose();
      v.box?.remove();
    }
    this.flashEl.remove();
    this.pauseEl?.remove();
    this.resultEl?.remove();
    this.leaveEl?.remove();
  }
}
