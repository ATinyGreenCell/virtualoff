import * as THREE from 'three';
import { makeControls, type ControlFrame } from '../core/input';
import { approachAngle, clamp, damp, forwardOf, hdist, rand, rightOf, wrapAngle, yawBetween } from '../core/math';
import { POSES, SLOTS as NET_SLOTS, STATES, r1, r2, r3, type MechSnap } from '../net/protocol';
import { MechModel, makePose } from './mechModel';
import type { MechSpec, Palette, Slot } from './specs';
import { makeFireAction, makeMeleeAction, type Action, type Hit, type Variant } from './weapons';
import type { World } from './world';

export type MechState = 'ground' | 'dash' | 'air' | 'airdash' | 'land' | 'guard' | 'stagger' | 'down' | 'getup' | 'dead';

const SLOTS: Slot[] = ['lw', 'rw', 'cw'];
const NEUTRAL = makeControls();
const STAGGER_TIME = 0.36;
const DOWN_TIME = 1.35;
const GETUP_TIME = 0.55;
/** accumulated damage that forces a knockdown */
const DOWN_THRESHOLD = 160;
/** how long a jump/dash/fire press is remembered while the mech is busy */
const BUFFER = 0.15;

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
  action: Action | null = null;
  invuln = 0;
  downValue = 0;
  beamYaw = 0;
  controlsEnabled = false;
  deathT = 0;
  exploded = false;
  groundY = 0;

  private dashDir = new THREE.Vector3();
  private dashF = 1;
  private dashS = 0;
  private dashShot = false;
  private dashCooldown = 0;
  private airDashUsed = false;
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
  /** post-dash skid: less ground grip so the dash's momentum carries into the next move */
  private slideT = 0;
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
    this.bufJump = this.bufDash = this.bufFireT = this.slideT = this.aimHold = 0;
    this.bufSlot = null;
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
    const c = this.controlsEnabled && this.alive ? input : NEUTRAL;
    this.stateT += dt;
    if (this.invuln > 0) this.invuln -= dt;
    this.downValue = Math.max(0, this.downValue - 50 * dt);
    if (this.dashCooldown > 0) this.dashCooldown -= dt;
    for (const s of SLOTS) {
      if (!(this.action && this.action.slot === s)) this.gauges[s] = Math.min(1, this.gauges[s] + this.spec.weapons[s].regen * dt);
    }
    this.prevY = this.pos.y;
    this.bufJump = c.jumpPressed ? BUFFER : Math.max(0, this.bufJump - dt);
    this.bufDash = c.dashPressed ? BUFFER : Math.max(0, this.bufDash - dt);
    const pressed: Slot | null = c.fireCW ? 'cw' : c.fireRW ? 'rw' : c.fireLW ? 'lw' : null;
    if (pressed) {
      if (pressed === 'cw') this.upgradeToCW();
      this.bufSlot = pressed;
      this.bufFireT = BUFFER;
    } else if (this.bufFireT > 0) {
      this.bufFireT -= dt;
      if (this.bufFireT <= 0) this.bufSlot = null;
    }
    if (this.slideT > 0) this.slideT -= dt;

    switch (this.state) {
      case 'ground':
        this.updateGround(dt, c, w);
        break;
      case 'dash':
        this.updateDash(dt, c, w);
        break;
      case 'air':
        this.updateAir(dt, c, w);
        break;
      case 'airdash':
        this.updateAirDash(dt, w);
        break;
      case 'land':
        this.friction(dt, 8);
        if (this.stateT >= this.landTime) this.setState('ground');
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
      this.jump(w, false);
      return;
    }
    if (free && this.bufDash > 0 && this.dashCooldown <= 0) {
      this.bufDash = 0;
      this.cancelAction(w);
      this.startDash(c, w, false);
      return;
    }
    this.tryAttack(w, 'ground');
    const a = this.action;
    if (a?.lunge) return;
    // walking shots keep you moving; planted shots let your momentum slide out instead of stopping dead
    if (a && a.moveMul <= 0) this.friction(dt, a.slide ?? 4);
    else this.walk(dt, c, a ? a.moveMul : 1, a ? 60 : this.slideT > 0 ? 75 : 110);
  }

  private walk(dt: number, c: ControlFrame, mul: number, accelRate: number) {
    let mx = c.moveX;
    let my = c.moveY;
    const m = Math.hypot(mx, my);
    if (m > 1) {
      mx /= m;
      my /= m;
    }
    const speed = (my < -0.2 ? this.spec.backSpeed : this.spec.walkSpeed) * mul;
    forwardOf(this.yaw, _f);
    rightOf(this.yaw, _r);
    const tx = (_f.x * my + _r.x * mx) * speed;
    const tz = (_f.z * my + _r.z * mx) * speed;
    const accel = accelRate * dt;
    let dx = tx - this.vel.x;
    let dz = tz - this.vel.z;
    const dl = Math.hypot(dx, dz);
    if (dl > accel) {
      dx *= accel / dl;
      dz *= accel / dl;
    }
    this.vel.x += dx;
    this.vel.z += dz;
  }

  private startDash(c: ControlFrame, w: World, air: boolean) {
    let mx = c.moveX;
    let my = c.moveY;
    let m = Math.hypot(mx, my);
    if (m < 0.3) {
      mx = 0;
      my = 1;
      m = 1;
    }
    mx /= m;
    my /= m;
    forwardOf(this.yaw, _f);
    rightOf(this.yaw, _r);
    this.dashDir.set(_f.x * my + _r.x * mx, 0, _f.z * my + _r.z * mx).normalize();
    this.dashF = my;
    this.dashS = mx;
    this.dashShot = false;
    this.dustT = 0;
    if (air) {
      this.setState('airdash');
      this.airDashUsed = true;
      this.vel.y = Math.max(0, this.vel.y * 0.2);
      w.sound('airDash', this.pos);
    } else {
      this.setState('dash');
      w.sound('dash', this.pos);
      w.fx.dust(this.pos, 8, w.dustColor, 1.5);
    }
  }

  private updateDash(dt: number, c: ControlFrame, w: World) {
    const t = this.stateT;
    if (!this.action || this.action.keepDash) {
      const sp = this.spec.dashSpeed * Math.min(1, 0.45 + t / 0.08);
      this.vel.x = this.dashDir.x * sp;
      this.vel.z = this.dashDir.z * sp;
    }
    if (!this.action && this.bufJump > 0) {
      this.bufJump = 0;
      this.jump(w, true);
      return;
    }
    if (!this.dashShot && this.tryAttack(w, 'dash')) {
      this.dashShot = true;
      if (this.state !== 'dash') return;
    }
    const over = (t > this.spec.dashMin && !c.dash) || t > this.spec.dashMax;
    if (over && (!this.action || this.action.keepDash)) {
      this.setState('ground');
      this.dashCooldown = 0.1;
      // carry the dash into a short skid instead of stopping dead
      this.vel.x *= 0.75;
      this.vel.z *= 0.75;
      this.slideT = 0.18;
      return;
    }
    this.dustT -= dt;
    if (this.dustT <= 0) {
      this.dustT = 0.045;
      _p.copy(this.pos).addScaledVector(this.dashDir, -2);
      w.fx.dust(_p, 1, w.dustColor, 1.2, 2.2);
    }
  }

  private jump(w: World, fromDash: boolean) {
    this.setState('air');
    this.vel.y = this.spec.jumpVel;
    this.airDashUsed = false;
    const k = fromDash ? 0.75 : 0.9;
    this.vel.x *= k;
    this.vel.z *= k;
    w.sound('jump', this.pos);
    w.fx.dust(this.pos, 10, w.dustColor, 1.5);
  }

  private updateAir(dt: number, c: ControlFrame, w: World) {
    forwardOf(this.yaw, _f);
    rightOf(this.yaw, _r);
    const sp = this.spec.walkSpeed * 0.8;
    const tx = (_f.x * c.moveY + _r.x * c.moveX) * sp;
    const tz = (_f.z * c.moveY + _r.z * c.moveX) * sp;
    if (Math.abs(c.moveX) + Math.abs(c.moveY) > 0.1) {
      const a = 20 * dt;
      this.vel.x += clamp(tx - this.vel.x, -a, a);
      this.vel.z += clamp(tz - this.vel.z, -a, a);
    }
    if (this.bufDash > 0 && !this.airDashUsed && this.canCancel()) {
      this.bufDash = 0;
      this.cancelAction(w);
      this.startDash(c, w, true);
      return;
    }
    this.tryAttack(w, 'air');
  }

  private updateAirDash(dt: number, w: World) {
    const t = this.stateT;
    if (!this.action || this.action.keepDash) {
      const sp = this.spec.airDashSpeed * Math.min(1, 0.45 + t / 0.07);
      this.vel.x = this.dashDir.x * sp;
      this.vel.z = this.dashDir.z * sp;
    }
    if (!this.dashShot && this.tryAttack(w, 'air')) this.dashShot = true;
    if (t > this.spec.airDashTime) {
      this.setState('air');
      this.vel.x *= 0.7;
      this.vel.z *= 0.7;
    }
    this.dustT -= dt;
    if (this.dustT <= 0) {
      this.dustT = 0.04;
      _p.copy(this.pos);
      _p.y += 3;
      w.fx.trail(_p.addScaledVector(this.dashDir, -2.5), this.palette.flame, 2.2, 0.25, 0.5);
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
        const sp = d > stopAt ? a.lunge.speed : 0;
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
        const ok = tgt.takeHit({ damage: this.spec.melee.damage, knock: 'down', dir: _v.clone(), source: this, pos: _p.clone(), heavy: true }, w);
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
      if (this.state === 'airdash') g = 8;
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
        // walked off a ledge
        this.setState('air');
        this.airDashUsed = false;
      } else {
        this.pos.y = gy;
      }
    }
  }

  private onLand(w: World, impact: number) {
    if (this.state === 'air' || this.state === 'airdash') {
      this.setState('land');
      this.landTime = this.airDashUsed ? 0.3 : 0.15;
      this.vel.x *= 0.5;
      this.vel.z *= 0.5;
      w.sound('land', this.pos, 0.8);
      w.fx.dust(this.pos, 10, w.dustColor, 2);
      if (this.spec.id === 'fujin') w.shake(0.15, this.pos);
    } else if ((this.state === 'down' || this.state === 'dead') && impact > 6) {
      w.fx.dust(this.pos, 14, w.dustColor, 3, 3);
      w.sound('land', this.pos, 1);
      w.shake(0.3, this.pos);
      this.vel.y = impact * 0.28;
    }
  }

  // ------------------------------------------------------------------ damage

  takeHit(h: Hit, w: World): boolean {
    if (!this.hittable) return false;
    let dmg = h.damage;
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
    this.downValue += h.knock === 'down' ? 1000 : dmg;
    if (this.downValue >= DOWN_THRESHOLD) this.knockDown(h, w);
    else if (h.knock === 'stagger') this.stagger(h);
    return true;
  }

  private stagger(h: Hit) {
    this.action = null;
    this.setState('stagger');
    this.vel.x = h.dir.x * 7;
    this.vel.z = h.dir.z * 7;
    if (this.pos.y > this.groundY + 0.5) this.vel.y = Math.max(this.vel.y, 2);
  }

  private knockDown(h: Hit, w: World) {
    this.cancelAction(w);
    this.setState('down');
    this.downValue = 0;
    this.vel.set(h.dir.x * 16, 9, h.dir.z * 16);
    w.sound('down', this.pos);
  }

  private die(h: Hit, w: World) {
    this.cancelAction(w);
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
        w.sound('step', this.pos, this.spec.id === 'fujin' ? 0.5 : 0.3);
        if (this.spec.id === 'fujin') w.shake(0.03, this.pos);
      });
    }
    p.walkAmt = this.wWalk;
    p.moveF = this.mf;
    p.moveS = this.ms;
    const airborne = st === 'air' || (st === 'stagger' && this.pos.y > this.groundY + 0.5);
    this.wAir = damp(this.wAir, airborne ? 1 : 0, 12, dt);
    this.wDash = damp(this.wDash, st === 'dash' || st === 'airdash' ? 1 : 0, 14, dt);
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
          p.saber = this.spec.id === 'jebe' && u > 0.06 && u < 0.88 ? Math.min(1, (u - 0.06) * 12) : 0;
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
    p.thrust = st === 'dash' || st === 'airdash' ? 1 : rising ? 0.7 : hovering ? 0.55 : st === 'air' ? 0.15 : 0;
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
    w.visual(() => this.lowArmorFx(dt, w));
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
    if (this.state !== 'dead') w.visual(() => this.lowArmorFx(dt, w));
  }
}
