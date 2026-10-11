import * as THREE from 'three';
import { makeControls, resetControls, type ControlFrame } from '../core/input';
import { approachAngle, clamp, damp, forwardOf, hdist, rand, rightOf, wrapAngle, yawBetween } from '../core/math';
import { POSES, SLOTS as NET_SLOTS, STATES, r1, r2, r3, type MechSnap } from '../net/protocol';
import { MechModel, makePose } from './mechModel';
import type { MechSpec, Palette, Slot } from './specs';
import { makeFireAction, makeMeleeAction, type Action, type Hit, type Variant } from './weapons';
import type { World } from './world';

export type MechState = 'ground' | 'dash' | 'air' | 'airdash' | 'land' | 'guard' | 'stagger' | 'down' | 'getup' | 'dead';

const SLOTS: Slot[] = ['lw', 'rw', 'cw'];
const NEUTRAL = makeControls();
/** what a snared pilot still gets through: turning, guarding and firing — no moving, boosting or jumping */
const PINNED = makeControls();
const STAGGER_TIME = 0.36;
const DOWN_TIME = 1.35;
const GETUP_TIME = 0.55;
/** accumulated damage that forces a knockdown */
const DOWN_THRESHOLD = 160;
/** how long a jump/dash/fire press is remembered while the mech is busy */
const BUFFER = 0.15;
/** a quick-boost press made during the gap after a burst still comes out when the gap ends */
const DASH_BUFFER = 0.25;
/** quick boost: length of the burst, and the shortest gap between two bursts */
const QB_TIME = 0.14;
const QB_GAP = 0.22;
/** EN: refill starts this long after the last spend; running dry locks boosting for at least
 *  EN_OUT_TIME and until the gauge is back to EN_RESUME */
const EN_DELAY = 0.35;
const EN_OUT_TIME = 1.1;
const EN_RESUME = 0.3;
/** EN per second while thrusting up / boosting in the air */
const EN_THRUST = 0.3;
const EN_AIRBOOST = 0.3;
/** thrust fades out between these heights above the arena floor (not above whatever block you stand
 *  on — the tallest pillars are 34 high), so fights stay in frame */
const CEIL_START = 26;
const CEIL = 36;
/** speed above the boost that a quick-boost burst sheds per second once it's over (u/s²) */
const QB_SHED = 140;
/** a fall this much faster than a plain jump lands with a short crouch; anything softer touches down at full speed */
const HARD_LANDING = 1.25;

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();

export class Mech {
  readonly model: MechModel;
  readonly pose = makePose();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly gauges: Record<Slot, number> = { lw: 1, rw: 1, cw: 1 };
  readonly stats = { shots: 0, hits: 0, damage: 0 };
  yaw = 0;
  hp: number;
  state: MechState = 'ground';
  stateT = 0;
  target!: Mech;
  /** mechs on the same team can't hurt each other (set by World.add) */
  team = 0;
  /** damage multiplier on everything this mech hits with (co-op bosses hit harder) */
  power = 1;
  /** co-op boss: light hits don't stagger it, and it takes this many times the punishment before
   *  going down — two players can't stun-lock it between them */
  poise = 1;
  /** caught in a snare net: pinned in place for this long */
  snareT = 0;
  action: Action | null = null;
  invuln = 0;
  downValue = 0;
  beamYaw = 0;
  controlsEnabled = false;
  deathT = 0;
  exploded = false;
  groundY = 0;

  /** boost energy 0..1: quick boosts, thrusting and air boosting spend it; it refills when you ease off */
  en = 1;
  private overheat = false;
  private overheatT = 0;
  private enIdle = 9;
  /** quick-boost burst: direction, time left, gap before the next one */
  private qbDir = new THREE.Vector3();
  private qbT = 0;
  private qbGap = 0;
  private thrusting = false;
  /** DASH held last frame (landing while held keeps the boost going) */
  private dashHeld = false;
  /** lean of the boost pose, from the actual direction of travel relative to facing */
  private dashF = 1;
  private dashS = 0;
  private dashShot = false;
  private landTime = 0.15;
  private dustT = 0;
  private fxT = 0;
  private prevY = 0;
  private wWalk = 0;
  private wAir = 0;
  private wDash = 0;
  private wCrouch = 0;
  private mf = 0;
  private ms = 0;
  // input buffers: a jump/dash/fire pressed during an action's recovery comes out as soon as it's free
  private bufJump = 0;
  private bufDash = 0;
  private bufSlot: Slot | null = null;
  private bufFireT = 0;
  /** keeps the gun arm up between consecutive shots */
  private aimHold = 0;

  constructor(
    readonly spec: MechSpec,
    readonly palette: Palette,
    readonly isPlayer: boolean,
  ) {
    this.model = new MechModel(spec, palette);
    this.hp = spec.hp;
  }

  get alive() {
    return this.state !== 'dead';
  }

  get hittable() {
    return this.invuln <= 0 && this.state !== 'down' && this.state !== 'getup' && this.state !== 'dead';
  }

  /** Target within the forward lock-on cone. */
  get lockedOn() {
    return Math.abs(wrapAngle(yawBetween(this.pos, this.target.pos) - this.yaw)) < 1.05 && this.target.alive;
  }

  get hpFrac() {
    return this.hp / this.spec.hp;
  }

  /** EN ran dry: no quick boosts or flight until it recovers */
  get enEmpty() {
    return this.overheat;
  }

  centerInto(out: THREE.Vector3) {
    const k = this.state === 'down' || this.state === 'dead' ? 0.15 : 0.55;
    return out.set(this.pos.x, this.pos.y + this.spec.height * k + (k < 0.5 ? 0.8 : 0), this.pos.z);
  }

  /** Vertical hit capsule axis. */
  axis(a: THREE.Vector3, b: THREE.Vector3) {
    a.set(this.pos.x, this.pos.y + 0.8, this.pos.z);
    b.set(this.pos.x, this.pos.y + this.spec.height - 0.6, this.pos.z);
  }

  reset(pos: THREE.Vector3, yaw: number) {
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.hp = this.spec.hp;
    this.gauges.lw = this.gauges.rw = this.gauges.cw = 1;
    this.state = 'ground';
    this.stateT = 0;
    this.action = null;
    this.invuln = 0;
    this.downValue = 0;
    this.deathT = 0;
    this.exploded = false;
    this.groundY = 0;
    this.prevY = pos.y;
    this.bufJump = this.bufDash = this.bufFireT = this.aimHold = 0;
    this.bufSlot = null;
    this.en = 1;
    this.overheat = false;
    this.enIdle = 9;
    this.qbT = this.qbGap = 0;
    this.thrusting = this.dashHeld = false;
    this.snareT = 0;
    this.model.root.visible = true;
    this.model.root.position.copy(pos);
    this.model.root.rotation.y = yaw;
  }

  private setState(s: MechState) {
    this.state = s;
    this.stateT = 0;
  }

  private get onGround() {
    return this.pos.y <= this.groundY + 0.02 && this.vel.y <= 0;
  }

  private friction(dt: number, k: number) {
    const f = Math.max(0, 1 - k * dt);
    this.vel.x *= f;
    this.vel.z *= f;
  }

  /** True when a new move may interrupt the current action. */
  private canCancel() {
    const a = this.action;
    return !a || (a.cancelAfterEvents && a.events.every((e) => e.done));
  }

  cancelAction(w: World) {
    if (this.action?.pose === 'beam') w.projectiles.stopBeamsOf(this);
    this.action = null;
  }

  // ------------------------------------------------------------------ frame update

  update(dt: number, input: ControlFrame, w: World) {
    let c = this.controlsEnabled && this.alive ? input : NEUTRAL;
    if (this.snareT > 0) {
      this.snareT = Math.max(0, this.snareT - dt);
      c = pinned(c);
      // a dash or jump pressed just before the net hit doesn't get to fire once it's on
      this.bufJump = this.bufDash = 0;
      // pinned: whatever speed you had dies away fast, and a burst in progress is over
      const k = Math.max(0, 1 - 9 * dt);
      this.vel.x *= k;
      this.vel.z *= k;
      if (this.vel.y > 0) this.vel.y *= k;
      this.qbT = 0;
    }
    this.stateT += dt;
    if (this.invuln > 0) this.invuln -= dt;
    this.downValue = Math.max(0, this.downValue - 50 * dt);
    if (this.qbT > 0) this.qbT -= dt;
    if (this.qbGap > 0) this.qbGap -= dt;
    this.updateEN(dt);
    this.thrusting = false;
    for (const s of SLOTS) {
      if (!(this.action && this.action.slot === s)) this.gauges[s] = Math.min(1, this.gauges[s] + this.spec.weapons[s].regen * dt);
    }
    this.prevY = this.pos.y;
    this.bufJump = c.jumpPressed ? BUFFER : Math.max(0, this.bufJump - dt);
    this.bufDash = c.dashPressed ? DASH_BUFFER : Math.max(0, this.bufDash - dt);
    const pressed: Slot | null = c.fireCW ? 'cw' : c.fireRW ? 'rw' : c.fireLW ? 'lw' : null;
    if (pressed) {
      if (pressed === 'cw') this.upgradeToCW();
      this.bufSlot = pressed;
      this.bufFireT = BUFFER;
    } else if (this.bufFireT > 0) {
      this.bufFireT -= dt;
      if (this.bufFireT <= 0) this.bufSlot = null;
    }

    switch (this.state) {
      case 'ground':
        this.updateGround(dt, c, w);
        break;
      case 'dash':
        this.updateBoost(dt, c, w);
        break;
      case 'air':
        this.updateAir(dt, c, w);
        break;
      case 'airdash':
        this.updateAirBoost(dt, c, w);
        break;
      case 'land':
        // a hard landing: crouch for a beat, skidding on the speed you came in with
        this.drive(0, 0, 0, this.spec.grip * 0.6, 0, dt);
        if (this.stateT >= this.landTime) this.setState(c.dash ? 'dash' : 'ground');
        break;
      case 'guard':
        this.friction(dt, 12);
        if (!c.guard) this.setState('ground');
        break;
      case 'stagger':
        this.friction(dt, 4);
        if (this.stateT > STAGGER_TIME) this.setState(this.onGround ? 'ground' : 'air');
        break;
      case 'down':
        if (this.onGround) this.friction(dt, 3.5);
        if (this.stateT > DOWN_TIME && this.onGround) this.setState('getup');
        break;
      case 'getup':
        this.friction(dt, 10);
        if (this.stateT > GETUP_TIME) {
          this.setState('ground');
          this.invuln = 0.5;
        }
        break;
      case 'dead':
        if (this.onGround) this.friction(dt, 2.5);
        break;
    }
    this.dashHeld = c.dash;

    this.updateFacing(dt, c);
    if (this.action) this.advanceAction(dt, w);
    this.integrate(dt, w);
    this.updatePose(dt, w);
    this.model.root.position.copy(this.pos);
    this.model.root.rotation.y = this.yaw;
    this.model.update(this.pose, dt);
    this.model.root.updateMatrixWorld(true);
    if (this.action) this.runActionEvents(w);
    this.ambientFx(dt, w);
  }

  // ------------------------------------------------------------------ states

  private updateGround(dt: number, c: ControlFrame, w: World) {
    const free = this.canCancel();
    if (free && c.guard) {
      this.cancelAction(w);
      this.setState('guard');
      return;
    }
    if (free && this.bufJump > 0) {
      this.bufJump = 0;
      this.cancelAction(w);
      this.jump(w);
      return;
    }
    if (free && this.bufDash > 0 && this.qbGap <= 0) {
      this.bufDash = 0;
      this.cancelAction(w);
      this.quickBoost(c, w, false);
      return;
    }
    if (free && c.dash && !this.action) {
      // DASH still held (e.g. through a landing): straight back into the boost
      this.setState('dash');
      this.dashShot = false;
      return;
    }
    this.tryAttack(w, 'ground');
    const a = this.action;
    if (a?.lunge) return;
    // walking shots keep you moving; planted shots let your momentum slide out instead of stopping dead
    if (a && a.moveMul <= 0) this.friction(dt, a.slide ?? 4);
    else this.walk(dt, c, a ? a.moveMul : 1, a ? 0.55 : 1);
  }

  /** Stick direction in world space (unit, or zero when the stick is at rest). */
  private stickWorld(c: ControlFrame, out: THREE.Vector3) {
    const m = Math.hypot(c.moveX, c.moveY);
    if (m < 0.2) return out.set(0, 0, 0);
    forwardOf(this.yaw, _f);
    rightOf(this.yaw, _r);
    const k = 1 / m;
    return out.set((_f.x * c.moveY + _r.x * c.moveX) * k, 0, (_f.z * c.moveY + _r.z * c.moveX) * k);
  }

  private walk(dt: number, c: ControlFrame, mul: number, accelMul: number) {
    const speed = (c.moveY < -0.2 ? this.spec.backSpeed : this.spec.walkSpeed) * mul * Math.min(1, Math.hypot(c.moveX, c.moveY));
    this.stickWorld(c, _v);
    // a burst's surplus goes quickly; boost speed slides off over a moment — faster if you let go
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const dec = hs > this.spec.boostSpeed ? QB_SHED : _v.lengthSq() > 0 ? this.spec.grip : this.spec.grip * 1.3;
    this.drive(_v.x * speed, _v.z * speed, this.spec.accel * accelMul, dec, this.spec.carve, dt);
  }

  /**
   * Steer horizontal velocity toward (tx, tz) like a heavy frame: speed up at `acc`, shed excess
   * speed at `dec`, and bend a moving line at most `carve` u/s² sideways — so momentum carries,
   * and a direction change at speed draws an arc instead of snapping.
   */
  private drive(tx: number, tz: number, acc: number, dec: number, carve: number, dt: number) {
    const vx = this.vel.x;
    const vz = this.vel.z;
    const s = Math.hypot(vx, vz);
    const ts = Math.hypot(tx, tz);
    if (ts < 1e-3) {
      // no input: coast down
      if (s > 1e-4) {
        const k = Math.max(0, s - dec * dt) / s;
        this.vel.x = vx * k;
        this.vel.z = vz * k;
      }
      return;
    }
    const ux = tx / ts;
    const uz = tz / ts;
    if (s < 0.5) {
      const ns = Math.min(ts, s + acc * dt);
      this.vel.x = ux * ns;
      this.vel.z = uz * ns;
      return;
    }
    let dx = vx / s;
    let dz = vz / s;
    const dot = dx * ux + dz * uz;
    let ns: number;
    if (dot < -0.2) {
      // reversing: brake hard, then turn round
      ns = Math.max(0, s - (acc + dec) * dt);
      if (ns < 2) {
        dx = ux;
        dz = uz;
      }
    } else {
      // lateral acceleration is capped, so the turn rate falls as speed rises
      const ang = Math.atan2(dx * uz - dz * ux, dot);
      const turn = clamp(ang, -(carve / Math.max(s, 4)) * dt, (carve / Math.max(s, 4)) * dt);
      const cs = Math.cos(turn);
      const sn = Math.sin(turn);
      const nx = dx * cs - dz * sn;
      dz = dx * sn + dz * cs;
      dx = nx;
      ns = s < ts ? Math.min(ts, s + acc * dt) : Math.max(ts, s - dec * dt);
    }
    this.vel.x = dx * ns;
    this.vel.z = dz * ns;
  }

  // ------------------------------------------------------------------ EN

  private updateEN(dt: number) {
    this.enIdle += dt;
    if (this.enIdle > EN_DELAY) this.en = Math.min(1, this.en + this.spec.enRegen * dt);
    if (this.overheat) {
      this.overheatT -= dt;
      if (this.overheatT <= 0 && this.en >= EN_RESUME) this.overheat = false;
    }
  }

  /** Pay a lump of EN (quick boost); false when there isn't enough or the gauge is locked out. */
  private spend(cost: number) {
    if (this.overheat || this.en < cost - 1e-4) return false;
    this.en -= cost;
    this.enIdle = 0;
    if (this.en <= 1e-3) this.burnOut();
    return true;
  }

  /** Spend EN continuously (thrust, air boost); false once it runs dry. */
  private drain(rate: number, dt: number) {
    if (this.overheat) return false;
    this.en -= rate * dt;
    this.enIdle = 0;
    if (this.en > 0) return true;
    this.burnOut();
    return false;
  }

  private burnOut() {
    this.en = 0;
    this.overheat = true;
    this.overheatT = EN_OUT_TIME;
  }

  // ------------------------------------------------------------------ boosting

  /**
   * Tap DASH: a sharp burst toward the stick (forward when it's at rest) that keeps half your
   * sideways momentum, so bursts chain into curves. Holding DASH flows on into the boost.
   */
  private quickBoost(c: ControlFrame, w: World, air: boolean) {
    this.stickWorld(c, _v);
    if (_v.lengthSq() === 0) forwardOf(this.yaw, _v);
    this.dashShot = false;
    if (!this.spend(this.spec.qbCost)) {
      // out of EN: the ground boost itself is free, the burst isn't
      if (this.isPlayer) w.sound('empty', this.pos, 0.5);
      if (!air) this.setState('dash');
      return;
    }
    this.setState(air ? 'airdash' : 'dash');
    this.qbDir.copy(_v);
    this.qbT = QB_TIME;
    this.qbGap = QB_GAP;
    const along = this.vel.x * _v.x + this.vel.z * _v.z;
    const sx = this.vel.x - _v.x * along;
    const sz = this.vel.z - _v.z * along;
    const sp = Math.max(along, this.spec.qbSpeed);
    this.vel.x = _v.x * sp + sx * 0.5;
    this.vel.z = _v.z * sp + sz * 0.5;
    if (air) {
      this.vel.y = Math.max(0, this.vel.y * 0.4);
      w.sound('airDash', this.pos);
    } else {
      w.sound('dash', this.pos);
      w.fx.dust(this.pos, 8, w.dustColor, 1.5);
    }
  }

  /** Ground boost (state 'dash'): DASH held after the burst — a fast, steerable glide that costs no EN. */
  private updateBoost(dt: number, c: ControlFrame, w: World) {
    const free = this.canCancel();
    if (free && c.guard) {
      // guard straight out of a boost: you skid into the stance
      this.cancelAction(w);
      this.setState('guard');
      return;
    }
    if (free && this.bufJump > 0) {
      // boost-jump: every bit of speed goes up with you
      this.bufJump = 0;
      this.cancelAction(w);
      this.jump(w);
      return;
    }
    if (free && this.bufDash > 0 && this.qbGap <= 0) {
      this.bufDash = 0;
      this.cancelAction(w);
      this.quickBoost(c, w, false);
    }
    if (!this.dashShot && this.tryAttack(w, 'dash')) {
      this.dashShot = true;
      if (this.state !== 'dash') return;
    }
    const steer = !this.action || this.action.keepDash;
    if (!c.dash && this.qbT <= 0 && steer) {
      // let go: the speed carries on into the walk and bleeds off from there
      this.setState('ground');
      return;
    }
    if (steer) this.boostDrive(dt, c, this.spec.boostSpeed, 1);
    this.dustT -= dt;
    if (this.dustT <= 0) {
      this.dustT = 0.045;
      _p.set(this.pos.x - this.vel.x * 0.05, this.pos.y, this.pos.z - this.vel.z * 0.05);
      w.fx.dust(_p, 1, w.dustColor, 1.2, 2.2);
    }
  }

  /** Boost steering shared by ground and air: the burst is committed, the glide follows the stick. */
  private boostDrive(dt: number, c: ControlFrame, speed: number, grip: number) {
    const sp = this.spec;
    if (this.qbT > 0) {
      this.drive(this.qbDir.x * sp.qbSpeed, this.qbDir.z * sp.qbSpeed, sp.accel * 3, 25, sp.carve * 0.25, dt);
      return;
    }
    this.stickWorld(c, _v);
    if (_v.lengthSq() === 0) {
      // stick at rest: hold the current line
      const s = Math.hypot(this.vel.x, this.vel.z);
      if (s > 1) _v.set(this.vel.x / s, 0, this.vel.z / s);
      else forwardOf(this.yaw, _v);
    }
    // the burst's surplus speed drops off quickly; the glide itself is held
    this.drive(_v.x * speed, _v.z * speed, sp.accel * grip, QB_SHED * grip, sp.carve * grip, dt);
  }

  private jump(w: World) {
    this.setState('air');
    this.vel.y = Math.max(this.vel.y, this.spec.jumpVel);
    w.sound('jump', this.pos);
    w.fx.dust(this.pos, 10, w.dustColor, 1.5);
  }

  /** Hold JUMP in the air: thrusters hold a steady climb (EN), fading out toward the ceiling. */
  private thrust(dt: number, c: ControlFrame) {
    if (!c.jump || this.stateT < 0.08 || this.vel.y >= this.spec.ascendSpeed || this.action?.dive) return;
    const room = clamp((CEIL - this.pos.y) / (CEIL - CEIL_START), 0, 1);
    if (room <= 0 || !this.drain(EN_THRUST * this.spec.airEN, dt)) return;
    this.vel.y += (this.spec.ascendSpeed * room - this.vel.y) * Math.min(1, 9 * dt);
    this.thrusting = true;
  }

  private updateAir(dt: number, c: ControlFrame, w: World) {
    this.thrust(dt, c);
    // airborne you mostly ride your momentum: weak steering, almost no drag
    this.stickWorld(c, _v);
    const sp = this.spec.walkSpeed;
    this.drive(_v.x * sp, _v.z * sp, 30, 6, 42, dt);
    const free = this.canCancel();
    if (free && this.bufDash > 0 && this.qbGap <= 0 && !this.overheat) {
      this.bufDash = 0;
      this.cancelAction(w);
      this.quickBoost(c, w, true);
      return;
    }
    if (free && c.dash && !this.action && !this.overheat && this.en > 0.05) {
      // DASH held through the jump: keep boosting in the air
      this.setState('airdash');
      this.dashShot = false;
      return;
    }
    this.tryAttack(w, 'air');
  }

  /** Air boost (state 'airdash'): DASH held in the air — a hover-glide that spends EN. */
  private updateAirBoost(dt: number, c: ControlFrame, w: World) {
    const free = this.canCancel();
    if (free && this.bufDash > 0 && this.qbGap <= 0) {
      this.bufDash = 0;
      this.cancelAction(w);
      this.quickBoost(c, w, true);
    }
    if (!this.dashShot && this.tryAttack(w, 'air')) this.dashShot = true;
    // the burst is already paid for; the glide after it runs on EN
    const fuel = this.qbT > 0 || this.drain(EN_AIRBOOST * this.spec.airEN, dt);
    if ((!c.dash && this.qbT <= 0) || !fuel) {
      this.setState('air');
      return;
    }
    this.thrust(dt, c);
    // hovering: the fall levels off into a slow sink (not in a committed dive)
    if (!this.thrusting && !this.action?.dive && this.vel.y < -2) this.vel.y += (-2 - this.vel.y) * Math.min(1, 5 * dt);
    if (!this.action || this.action.keepDash || this.action.hover) this.boostDrive(dt, c, this.spec.airBoostSpeed, 0.8);
    this.dustT -= dt;
    if (this.dustT <= 0) {
      this.dustT = 0.04;
      _p.set(this.pos.x - this.vel.x * 0.06, this.pos.y + 3, this.pos.z - this.vel.z * 0.06);
      w.fx.trail(_p, this.palette.flame, 2.2, 0.25, 0.5);
    }
  }

  // ------------------------------------------------------------------ facing

  private updateFacing(dt: number, c: ControlFrame) {
    if (!this.alive) return;
    const st = this.state;
    if (st === 'stagger' || st === 'down' || st === 'getup') return;
    const a = this.action;
    if (a && a.pose === 'beam' && a.charge && a.t > a.charge[1]) {
      this.yaw = wrapAngle(approachAngle(this.yaw, this.beamYaw, 4 * dt));
      return;
    }
    if (a?.lunge) return;
    let mul = st === 'air' || st === 'airdash' ? 0.8 : st === 'land' ? 0.4 : 1;
    if (a) mul *= a.turnMul;
    if (mul <= 0) return;
    if (Math.abs(c.turn) > 0.15) {
      this.yaw -= c.turn * this.spec.quickTurn * Math.min(1, mul + 0.3) * dt;
    } else {
      const want = yawBetween(this.pos, this.target.pos);
      this.yaw = approachAngle(this.yaw, want, this.spec.turnRate * mul * dt);
    }
    this.yaw = wrapAngle(this.yaw);
  }

  // ------------------------------------------------------------------ attacks

  /** Second trigger landed just after the first: swap the shot that just started for the center weapon. */
  private upgradeToCW() {
    const a = this.action;
    if (!a || a.kind !== 'fire' || a.slot === 'cw' || a.t > 0.12 || a.events.some((e) => e.done)) return;
    if (this.gauges.cw < this.spec.weapons.cw.cost - 1e-4) return;
    this.gauges[a.slot] = Math.min(1, this.gauges[a.slot] + this.spec.weapons[a.slot].cost);
    this.action = null;
  }

  private tryAttack(w: World, variant: Variant) {
    if (this.action) return false;
    const slot = this.bufSlot;
    if (!slot) return false;
    this.bufSlot = null;
    this.bufFireT = 0;
    const tgt = this.target;
    const dist = hdist(this.pos, tgt.pos);
    if (
      (this.state === 'ground' || this.state === 'dash') &&
      !(slot === 'cw' && this.spec.closeCW) &&
      dist < this.spec.meleeRange &&
      Math.abs(tgt.pos.y - this.pos.y) < 4 &&
      tgt.hittable &&
      this.lockedOn
    ) {
      this.action = makeMeleeAction(this, slot);
      if (this.state === 'dash') this.setState('ground');
      return true;
    }
    const def = this.spec.weapons[slot];
    if (this.gauges[slot] < def.cost - 1e-4) {
      if (this.isPlayer) w.sound('empty', this.pos, 0.6);
      return false;
    }
    this.gauges[slot] -= def.cost;
    this.action = makeFireAction(this, slot, variant);
    this.action.moving = variant === 'ground' && Math.hypot(this.vel.x, this.vel.z) > 4;
    if (this.state === 'dash' && !this.action.keepDash) this.setState('ground');
    return true;
  }

  private advanceAction(dt: number, w: World) {
    const a = this.action!;
    a.t += dt;
    if (a.lunge) {
      if (a.t < a.lunge.until) {
        const tgt = this.target;
        _v.set(tgt.pos.x - this.pos.x, 0, tgt.pos.z - this.pos.z);
        const d = _v.length();
        const stopAt = this.spec.radius + tgt.spec.radius + 1.0;
        if (d > 0.01) _v.divideScalar(d);
        // a snared mech swings where it stands: no lunging out of the net
        const sp = d > stopAt && this.snareT <= 0 ? a.lunge.speed : 0;
        this.vel.x = _v.x * sp;
        this.vel.z = _v.z * sp;
        this.yaw = wrapAngle(approachAngle(this.yaw, Math.atan2(_v.x, _v.z), 10 * dt));
      } else {
        this.friction(dt, 10);
      }
    }
    if (a.hitWindow && !a.hasHit && a.t >= a.hitWindow[0] && a.t <= a.hitWindow[1]) {
      const tgt = this.target;
      const d = hdist(this.pos, tgt.pos);
      const reach = this.spec.radius + tgt.spec.radius + 3.6;
      forwardOf(this.yaw, _f);
      _v.set(tgt.pos.x - this.pos.x, 0, tgt.pos.z - this.pos.z).normalize();
      if (d < reach && _f.dot(_v) > 0.3 && Math.abs(tgt.pos.y - this.pos.y) < 5 && tgt.hittable) {
        a.hasHit = true;
        tgt.centerInto(_p);
        const ok = tgt.takeHit({ damage: a.hitDamage ?? this.spec.melee.damage, knock: 'down', dir: _v.clone(), source: this, pos: _p.clone(), heavy: true }, w);
        if (ok) {
          w.fx.flash(_p, 0xffffff, 12, 0.18, true);
          w.fx.spark(_p, 26, this.palette.beam, 34);
          w.sound('slash', _p);
          w.shake(0.6, _p);
          w.hitStop(0.07);
        }
      }
    }
  }

  private runActionEvents(w: World) {
    const a = this.action;
    if (!a) return;
    for (const e of a.events) {
      if (!e.done && a.t >= e.t) {
        e.done = true;
        e.run(this, w);
        if (this.action !== a) return;
      }
    }
    if (a.t >= a.duration) this.action = null;
  }

  // ------------------------------------------------------------------ physics

  private integrate(dt: number, w: World) {
    const airborne = this.pos.y > this.groundY + 0.01 || this.vel.y > 0;
    if (airborne) {
      let g = this.spec.gravity;
      if (this.state === 'airdash') g *= this.qbT > 0 ? 0.15 : 0.25;
      if (this.action?.hover && (this.state === 'air' || this.state === 'airdash')) {
        // air shots keep the jump arc going, with a brief hang instead of a dead stop
        g *= 0.3;
        if (this.vel.y < -5) this.vel.y += (-5 - this.vel.y) * Math.min(1, 6 * dt);
      }
      this.vel.y -= g * dt;
    } else if (this.vel.y < 0) {
      this.vel.y = 0;
    }
    this.pos.addScaledVector(this.vel, dt);

    _p.copy(this.pos);
    if (w.arena.resolve(this.pos, this.spec.radius, this.spec.height)) {
      _v.subVectors(this.pos, _p);
      _v.y = 0;
      const l = _v.length();
      if (l > 1e-5) {
        _v.divideScalar(l);
        const vn = this.vel.x * _v.x + this.vel.z * _v.z;
        if (vn < 0) {
          this.vel.x -= _v.x * vn;
          this.vel.z -= _v.z * vn;
        }
      }
    }

    const gy = w.arena.groundAt(this.pos.x, this.pos.z, this.spec.radius, Math.max(this.prevY, this.pos.y));
    this.groundY = gy;
    if (this.pos.y <= gy) {
      this.pos.y = gy;
      if (this.vel.y < 0) {
        const impact = -this.vel.y;
        this.vel.y = 0;
        this.onLand(w, impact);
      }
    } else if (this.state === 'ground' || this.state === 'dash' || this.state === 'land' || this.state === 'guard' || this.state === 'getup') {
      if (this.pos.y > gy + 0.4) {
        // ran off a ledge: momentum and all
        this.setState(this.state === 'dash' && this.dashHeld ? 'airdash' : 'air');
      } else {
        this.pos.y = gy;
      }
    }
  }

  private onLand(w: World, impact: number) {
    // an air slam lands its blow on touchdown
    const hook = this.action?.onLand;
    if (hook && this.action) {
      this.action.onLand = undefined;
      hook(this, w);
    }
    if (this.state === 'air' || this.state === 'airdash') {
      // touch down at full speed — only a hard fall costs a beat — and keep boosting if DASH is held
      const hard = impact > this.spec.jumpVel * HARD_LANDING;
      if (hard) {
        this.setState('land');
        this.landTime = 0.16;
      } else this.setState(this.dashHeld ? 'dash' : 'ground');
      w.sound('land', this.pos, hard ? 0.9 : 0.6);
      w.fx.dust(this.pos, hard ? 12 : 7, w.dustColor, 2);
      if (this.spec.heavy && hard) w.shake(0.15, this.pos);
    } else if ((this.state === 'down' || this.state === 'dead') && impact > 6) {
      w.fx.dust(this.pos, 14, w.dustColor, 3, 3);
      w.sound('land', this.pos, 1);
      w.shake(0.3, this.pos);
      this.vel.y = impact * 0.28;
    }
  }

  // ------------------------------------------------------------------ damage

  takeHit(h: Hit, w: World): boolean {
    // once the round is decided, stray shots, drones and mines can't change it
    if (!this.hittable || !w.live) return false;
    let dmg = h.damage * (h.source ? h.source.power : 1);
    forwardOf(this.yaw, _f);
    const frontal = -(h.dir.x * _f.x + h.dir.z * _f.z) > 0.2;
    const guarded = this.state === 'guard' && frontal;
    if (guarded) {
      dmg *= 0.25;
      w.sound('guardHit', h.pos);
      w.fx.flash(h.pos, 0x9fe8ff, 7, 0.12, true);
      this.vel.x += h.dir.x * 8;
      this.vel.z += h.dir.z * 8;
    } else {
      w.sound(h.heavy || dmg >= 80 ? 'hitHeavy' : 'hit', h.pos);
    }
    dmg = Math.max(1, Math.round(dmg));
    this.hp = Math.max(0, this.hp - dmg);
    this.model.hitFlash(guarded ? 0.4 : 1);
    if (h.source) h.source.stats.damage += dmg;
    w.onDamage(this, dmg, guarded);
    if (this.hp <= 0) {
      this.die(h, w);
      return true;
    }
    if (guarded) return true;
    // a heavy-poised frame (the co-op boss) shakes a net off sooner: two players can't pin it down for good
    if (h.snare) this.snareT = Math.max(this.snareT, h.snare / this.poise);
    this.downValue += h.knock === 'down' ? 1000 : dmg;
    if (this.downValue >= DOWN_THRESHOLD * this.poise) this.knockDown(h, w);
    // a brawler's armored lunge shrugs off light hits
    else if (h.knock === 'stagger' && this.poise <= 1 && !this.action?.armor) this.stagger(h);
    return true;
  }

  /** A hit takes the controls: any burst in progress is over. */
  private interrupt() {
    this.qbT = 0;
    this.thrusting = false;
  }

  private stagger(h: Hit) {
    this.action = null;
    this.interrupt();
    this.setState('stagger');
    this.vel.x = h.dir.x * 7;
    this.vel.z = h.dir.z * 7;
    if (this.pos.y > this.groundY + 0.5) this.vel.y = Math.max(this.vel.y, 2);
  }

  private knockDown(h: Hit, w: World) {
    this.cancelAction(w);
    this.interrupt();
    this.snareT = 0;
    this.setState('down');
    this.downValue = 0;
    this.vel.set(h.dir.x * 16, 9, h.dir.z * 16);
    w.sound('down', this.pos);
  }

  private die(h: Hit, w: World) {
    this.cancelAction(w);
    this.interrupt();
    this.snareT = 0;
    this.setState('dead');
    this.deathT = 0;
    this.fxT = 0;
    this.vel.set(h.dir.x * 14, 11, h.dir.z * 14);
  }

  // ------------------------------------------------------------------ visuals

  private updatePose(dt: number, w: World) {
    const p = this.pose;
    const st = this.state;
    const hs = Math.hypot(this.vel.x, this.vel.z);
    forwardOf(this.yaw, _f);
    rightOf(this.yaw, _r);
    const walking = st === 'ground' && (!this.action || !this.action.lunge);
    this.wWalk = damp(this.wWalk, walking ? clamp(hs / this.spec.walkSpeed, 0, 1) : 0, 10, dt);
    if (hs > 0.5) {
      this.mf = damp(this.mf, (this.vel.x * _f.x + this.vel.z * _f.z) / hs, 10, dt);
      this.ms = damp(this.ms, (this.vel.x * _r.x + this.vel.z * _r.z) / hs, 10, dt);
    }
    const prevPhase = p.walkPhase;
    if (walking) p.walkPhase += (hs / 7.2) * Math.PI * 2 * dt;
    if (Math.floor(p.walkPhase / Math.PI) !== Math.floor(prevPhase / Math.PI) && this.wWalk > 0.3) {
      w.visual(() => {
        w.sound('step', this.pos, this.spec.heavy ? 0.5 : 0.3);
        if (this.spec.heavy) w.shake(0.03, this.pos);
      });
    }
    p.walkAmt = this.wWalk;
    p.moveF = this.mf;
    p.moveS = this.ms;
    const airborne = st === 'air' || (st === 'stagger' && this.pos.y > this.groundY + 0.5);
    this.wAir = damp(this.wAir, airborne ? 1 : 0, 12, dt);
    this.wDash = damp(this.wDash, st === 'dash' || st === 'airdash' ? 1 : 0, 14, dt);
    if ((st === 'dash' || st === 'airdash') && hs > 2) {
      // lean into the actual line of travel, so drifts and carves read on the body
      this.dashF = damp(this.dashF, (this.vel.x * _f.x + this.vel.z * _f.z) / hs, 12, dt);
      this.dashS = damp(this.dashS, (this.vel.x * _r.x + this.vel.z * _r.z) / hs, 12, dt);
    }
    p.air = this.wAir;
    p.dash = this.wDash;
    p.dashF = this.dashF;
    p.dashS = this.dashS;

    const a = this.action;
    const grounded = st === 'ground' || st === 'land' || st === 'guard';
    let crouch = st === 'land' ? 1 : st === 'getup' ? 0.7 * (1 - this.stateT / GETUP_TIME) : 0;
    if (a && grounded && (a.pose === 'aimBoth' || a.pose === 'beam')) crouch = Math.max(crouch, 0.35);
    if (a && grounded && a.pose === 'missile') crouch = Math.max(crouch, 0.3);
    this.wCrouch = damp(this.wCrouch, crouch, 16, dt);
    p.crouch = this.wCrouch;
    p.guard = st === 'guard' ? 1 : 0;
    p.stagger = st === 'stagger' ? Math.max(0, 1 - this.stateT / STAGGER_TIME) : 0;
    p.down = st === 'down' || st === 'dead' ? 1 : st === 'getup' ? Math.max(0, 1 - this.stateT / 0.4) : 0;

    p.aimR = p.aimBoth = p.throwW = p.beam = p.meleeW = p.saber = p.charge = 0;
    p.punchW = p.slamW = p.ram = p.fistOut = 0;
    this.aimHold = a?.pose === 'aimR' ? 0.55 : Math.max(0, this.aimHold - dt);
    if (a) {
      const u = a.t / a.duration;
      const fade = u > 0.8 ? (1 - u) / 0.2 : 1;
      switch (a.pose) {
        case 'aimR':
          p.aimR = 1;
          break;
        case 'aimBoth':
          p.aimBoth = fade;
          break;
        case 'throwL':
          p.throwW = fade;
          p.throwL = u;
          break;
        case 'beam':
          p.beam = fade;
          break;
        case 'melee':
          p.meleeW = 1;
          p.melee = u;
          p.saber = this.spec.melee.style === 'slash' && u > 0.06 && u < 0.88 ? Math.min(1, (u - 0.06) * 12) : 0;
          break;
        case 'punchL':
          p.punchW = fade;
          p.punchL = u;
          // the fist leaves the arm when it fires (0.2 s in) and is back once the punch is over
          p.fistOut = a.t > 0.2 ? 1 : 0;
          break;
        case 'slam':
          p.slamW = fade;
          p.slam = u;
          break;
        case 'ram':
          p.ram = fade;
          break;
        default:
          break;
      }
      if (a.charge && a.t >= a.charge[0] && a.t <= a.charge[1]) p.charge = (a.t - a.charge[0]) / (a.charge[1] - a.charge[0]);
    }
    const canAim = st === 'ground' || st === 'air' || st === 'dash' || st === 'airdash' || st === 'land';
    if (canAim && a?.pose !== 'aimR') p.aimR = Math.max(p.aimR, Math.min(1, this.aimHold / 0.25));
    p.recoil = Math.max(0, p.recoil - dt * 6);
    const tgt = this.target;
    p.aimPitch = clamp(Math.atan2(tgt.pos.y - this.pos.y, Math.max(hdist(this.pos, tgt.pos), 1)), -0.6, 0.7);
    const err = wrapAngle(yawBetween(this.pos, tgt.pos) - this.yaw);
    const twistMax = (a && a.kind === 'fire') || this.aimHold > 0 ? 0.6 : 0.25;
    p.twist = damp(p.twist, this.alive && st !== 'down' && st !== 'getup' ? clamp(err, -twistMax, twistMax) : 0, 10, dt);
    const rising = st === 'air' && this.vel.y > 2;
    const hovering = !!a?.hover && st === 'air';
    p.thrust =
      this.qbT > 0 ? 1.7 : this.thrusting ? 1.1 : st === 'dash' || st === 'airdash' ? 0.9 : rising ? 0.7 : hovering ? 0.55 : st === 'air' ? 0.15 : 0;
  }

  private ambientFx(dt: number, w: World) {
    if (this.state === 'dead') {
      this.deathT += dt;
      if (this.exploded) return;
      this.fxT -= dt;
      if (this.fxT <= 0) {
        this.fxT = 0.16;
        _p.set(this.pos.x + rand(-2, 2), this.pos.y + rand(1, 4), this.pos.z + rand(-2, 2));
        w.fx.explosion(_p, rand(1.4, 2.4));
        w.sound('explosionSmall', _p, 0.8);
        w.shake(0.2, _p);
      }
      if (this.deathT > 1.3) {
        this.exploded = true;
        this.centerInto(_p);
        w.fx.explosion(_p, 6.5, 0xffb050);
        w.fx.ring(_p.setY(0.3), 9, 0xffd080, 0.8);
        this.centerInto(_p);
        w.fx.shatter(this.model.collectPieces(), _p);
        this.model.root.visible = false;
        w.sound('mechExplode', _p);
        w.shake(1.4, _p);
      }
      return;
    }
    w.visual(() => {
      this.lowArmorFx(dt, w);
      this.snareFx(w);
    });
  }

  /** Caught in a snare net: rings of light cinch around the frame (cosmetic — versus peers draw their own). */
  private snareFx(w: World) {
    if (this.snareT <= 0 || Math.random() > 0.35) return;
    _p.set(this.pos.x, this.pos.y + rand(0.8, this.spec.height - 0.6), this.pos.z);
    w.fx.ring(_p, this.spec.radius * 0.75, 0xe9b8ff, 0.22);
    if (Math.random() < 0.3) w.fx.spark(_p, 3, 0xe9b8ff, 10, 0.4, 0.25);
  }

  /** Battle damage: smoke and sparks at low armor (cosmetic — both versus peers draw their own). */
  private lowArmorFx(dt: number, w: World) {
    if (this.hpFrac >= 0.3) return;
    this.fxT -= dt;
    if (this.fxT <= 0) {
      this.fxT = 0.11;
      this.centerInto(_p);
      _p.y += 1;
      w.fx.smoke(_p, 1, 2, 0x2c2a2e, 1.2);
      if (Math.random() < 0.15) w.fx.spark(_p, 4, 0xffd27a, 14, 0.4, 0.3);
    }
  }

  // ------------------------------------------------------------------ versus

  /** Host: pack everything the guest needs to draw this mech (layout mirrored in readNet). */
  writeNet(): MechSnap {
    const a = this.action;
    return [
      r2(this.pos.x),
      r2(this.pos.y),
      r2(this.pos.z),
      r1(this.vel.x),
      r1(this.vel.y),
      r1(this.vel.z),
      r3(this.yaw),
      STATES.indexOf(this.state),
      r2(this.stateT),
      Math.round(this.hp),
      r2(this.gauges.lw),
      r2(this.gauges.rw),
      r2(this.gauges.cw),
      r2(this.dashF),
      r2(this.dashS),
      (this.exploded ? 1 : 0) | (this.model.root.visible ? 2 : 0),
      r2(this.pose.recoil),
      a ? NET_SLOTS.indexOf(a.slot) : -1,
      a?.kind === 'melee' ? 1 : 0,
      a ? POSES.indexOf(a.pose) : 0,
      a ? r2(a.t) : 0,
      a ? r2(a.duration) : 0,
      a?.charge ? r2(a.charge[0]) : -1,
      a?.charge ? r2(a.charge[1]) : -1,
      a ? (a.lunge ? 1 : 0) | (a.hover ? 2 : 0) : 0,
      r2(this.en),
      (this.overheat ? 1 : 0) | (this.qbT > 0 ? 2 : 0) | (this.thrusting ? 4 : 0),
      r2(this.snareT),
    ];
  }

  private netAction: Action = {
    kind: 'fire',
    slot: 'rw',
    variant: 'ground',
    pose: 'aimR',
    t: 0,
    duration: 1,
    moveMul: 1,
    turnMul: 1,
    hover: false,
    keepDash: false,
    cancelAfterEvents: true,
    events: [],
  };
  private netCharge: [number, number] = [0, 0];
  private netLunge = { until: 0, speed: 0 };
  private netExploded = false;

  /** Guest: adopt the host's state, interpolating continuous values between two snapshots. */
  readNet(a: MechSnap, b: MechSnap | null, k: number) {
    const L = (i: number) => (b ? a[i] + (b[i] - a[i]) * k : a[i]);
    this.pos.set(L(0), L(1), L(2));
    this.vel.set(L(3), L(4), L(5));
    this.yaw = b ? wrapAngle(a[6] + wrapAngle(b[6] - a[6]) * k) : a[6];
    const st = STATES[a[7]] ?? 'ground';
    this.state = st;
    this.stateT = b && b[7] === a[7] ? L(8) : a[8];
    this.hp = a[9];
    this.gauges.lw = a[10];
    this.gauges.rw = a[11];
    this.gauges.cw = a[12];
    this.dashF = a[13];
    this.dashS = a[14];
    this.netExploded = (a[15] & 1) !== 0;
    this.pose.recoil = Math.max(this.pose.recoil, a[16]);
    this.en = a[25] ?? 1;
    const fl = a[26] ?? 0;
    this.overheat = (fl & 1) !== 0;
    this.qbT = fl & 2 ? QB_TIME : 0;
    this.thrusting = (fl & 4) !== 0;
    this.snareT = a[27] ?? 0;
    if (a[17] < 0) {
      this.action = null;
      return;
    }
    const na = this.netAction;
    na.slot = NET_SLOTS[a[17]] ?? 'rw';
    na.kind = a[18] ? 'melee' : 'fire';
    na.pose = POSES[a[19]] ?? 'aimR';
    const sameAction = b && b[17] === a[17] && b[19] === a[19] && b[20] >= a[20];
    na.t = sameAction ? L(20) : a[20];
    na.duration = Math.max(0.01, a[21]);
    if (a[22] >= 0) {
      this.netCharge[0] = a[22];
      this.netCharge[1] = a[23];
      na.charge = this.netCharge;
    } else na.charge = undefined;
    na.lunge = a[24] & 1 ? this.netLunge : undefined;
    na.hover = (a[24] & 2) !== 0;
    this.action = na;
  }

  /** Guest: animate from the adopted state — no rules, no physics. */
  puppet(dt: number, w: World) {
    if (this.netExploded && !this.exploded) {
      this.exploded = true;
      this.centerInto(_p);
      w.fx.shatter(this.model.collectPieces(), _p);
      this.model.root.visible = false;
    } else if (!this.netExploded && this.exploded) {
      // a new round started
      this.exploded = false;
      this.model.root.visible = true;
    }
    this.updatePose(dt, w);
    this.model.root.position.copy(this.pos);
    this.model.root.rotation.y = this.yaw;
    this.model.update(this.pose, dt);
    this.model.root.updateMatrixWorld(true);
    if (this.state !== 'dead') {
      w.visual(() => {
        this.lowArmorFx(dt, w);
        this.snareFx(w);
      });
    }
  }
}

/** A snared pilot's controls: turning, guarding and firing get through; moving, boosting and jumping don't. */
function pinned(c: ControlFrame) {
  resetControls(PINNED);
  PINNED.turn = c.turn;
  PINNED.guard = c.guard;
  PINNED.fireLW = c.fireLW;
  PINNED.fireRW = c.fireRW;
  PINNED.fireCW = c.fireCW;
  return PINNED;
}
