import * as THREE from 'three';
import { makeControls, resetControls, type ControlFrame } from '../core/input';
import { chance, hdist, rand, randSign, rightOf } from '../core/math';
import type { Difficulty } from '../core/settings';
import type { Mech } from './mech';
import type { World } from './world';

interface Tuning {
  /** seconds between spotting a threat and reacting */
  reaction: number;
  /** probability of attempting to dodge a dangerous shot */
  dodge: number;
  fireRate: number;
  aggression: number;
  /** spontaneous center-weapon rate (per second) when the gauge is full */
  cwRate: number;
}

const TUNING: Record<Difficulty, Tuning> = {
  easy: { reaction: 0.45, dodge: 0.25, fireRate: 0.55, aggression: 0.55, cwRate: 0.08 },
  normal: { reaction: 0.28, dodge: 0.5, fireRate: 0.9, aggression: 0.85, cwRate: 0.16 },
  hard: { reaction: 0.15, dodge: 0.8, fireRate: 1.25, aggression: 1.1, cwRate: 0.26 },
};

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _vr = new THREE.Vector3();
const _r = new THREE.Vector3();

/** CPU pilot. Produces the same ControlFrame a human would, so it plays by the same rules. */
export class AIController {
  readonly ctl = makeControls();
  private readonly tune: Tuning;
  private strafe = randSign();
  private strafeT = 0;
  private fwdBias = 0;
  private fwdT = 0;
  private seen = new Set<number>();
  private dodge: { t: number; side: number; jump: boolean } | null = null;
  private dashHold = 0;
  private dashSide = 0;
  private dashFwd = 0;
  private guardHold = 0;
  private rushT = 0;
  private stuckT = 0;
  private cool = { rw: 0, lw: 0, cw: 0, dash: 1.5, jump: 2, melee: 0 };

  constructor(difficulty: Difficulty, boost = 0) {
    const t = TUNING[difficulty];
    this.tune = {
      reaction: t.reaction * (1 - boost * 0.25),
      dodge: Math.min(0.92, t.dodge + boost * 0.12),
      fireRate: t.fireRate * (1 + boost * 0.15),
      aggression: t.aggression * (1 + boost * 0.15),
      cwRate: t.cwRate * (1 + boost * 0.3),
    };
  }

  update(dt: number, me: Mech, foe: Mech, w: World): ControlFrame {
    const c = this.ctl;
    resetControls(c);
    if (!me.alive || !foe.alive || !me.controlsEnabled) return c;
    const T = this.tune;
    const cool = this.cool;
    cool.rw -= dt;
    cool.lw -= dt;
    cool.cw -= dt;
    cool.dash -= dt;
    cool.jump -= dt;
    cool.melee -= dt;
    const spec = me.spec;
    const dist = hdist(me.pos, foe.pos);
    const hints = spec.ai;
    const pref = hints.range;

    // ---- defense
    this.scanThreats(me, w);
    if (this.dodge) {
      this.dodge.t -= dt;
      if (this.dodge.t <= 0) {
        if (this.dodge.jump && me.state === 'ground') {
          c.jump = c.jumpPressed = true;
        } else {
          this.dashHold = rand(0.28, 0.45);
          this.dashSide = this.dodge.side;
          this.dashFwd = rand(-0.25, 0.35);
          c.dashPressed = true;
        }
        this.dodge = null;
      }
    }
    if (foe.action?.kind === 'melee' && dist < 16 && me.state === 'ground' && this.guardHold <= 0 && Math.random() < T.dodge * 0.5) {
      this.guardHold = 0.7;
    }
    if (this.guardHold > 0) {
      this.guardHold -= dt;
      c.guard = true;
      return c;
    }

    // ---- movement
    this.strafeT -= dt;
    if (this.strafeT <= 0) {
      if (Math.random() < 0.7) this.strafe = -this.strafe;
      this.strafeT = rand(0.9, 2.6);
    }
    this.fwdT -= dt;
    if (this.fwdT <= 0) {
      this.fwdT = rand(0.8, 2.0);
      this.fwdBias = rand(-0.4, 0.55) * T.aggression;
    }
    let my = this.fwdBias;
    if (dist > pref[1]) my = 1;
    else if (dist < pref[0]) my = -0.8;
    c.moveX = this.strafe;
    c.moveY = my;

    // ---- close in for a melee strike now and then (more often when the foe is stuck in recovery)
    // a snared foe is a sitting duck too
    const pinned = foe.snareT > 0.3;
    const foeRecovering = foe.state === 'land' || foe.state === 'stagger' || (foe.state === 'getup' && foe.stateT > 0.25) || pinned;
    const rushRate = hints.rush * T.aggression * (foeRecovering ? 4 : 1);
    if (this.rushT <= 0 && me.state === 'ground' && !me.action && dist < 65 && chance(rushRate, dt)) this.rushT = rand(1.4, 2.4);
    if (this.rushT > 0) {
      this.rushT -= dt;
      c.moveX = this.strafe * 0.25;
      c.moveY = 1;
      if (dist > spec.meleeRange * 1.8 && me.state === 'ground' && this.dashHold <= 0 && cool.dash <= 0) {
        this.dashHold = rand(0.35, 0.5);
        this.dashSide = this.strafe * 0.2;
        this.dashFwd = 1;
        c.dashPressed = c.dash = true;
        cool.dash = 0.5;
      }
      if (dist < spec.meleeRange * 0.9 && me.lockedOn && !me.action && foe.hittable) {
        c.fireRW = true;
        this.rushT = 0;
        cool.melee = 1.2;
      }
    }
    if (this.dashHold > 0) {
      this.dashHold -= dt;
      c.dash = true;
      c.moveX = this.dashSide;
      c.moveY = this.dashFwd;
    }
    const hs = Math.hypot(me.vel.x, me.vel.z);
    if (me.state === 'ground' && !me.action && hs < 3) {
      this.stuckT += dt;
      if (this.stuckT > 0.45) {
        this.stuckT = 0;
        this.strafe = -this.strafe;
        if (Math.random() < 0.4) c.jump = c.jumpPressed = true;
      }
    } else this.stuckT = 0;

    // ---- offense
    me.centerInto(_a);
    foe.centerInto(_b);
    const los = w.arena.lineOfSight(_a, _b);
    const free = me.lockedOn && !me.action;
    const foeOpen =
      foe.state === 'land' || foe.state === 'stagger' || (foe.state === 'getup' && foe.stateT > 0.3) || foe.action?.slot === 'cw' || pinned;
    if (free && me.state !== 'dash') {
      if (dist < spec.meleeRange * 0.9 && foe.hittable && cool.melee <= 0 && chance(3 * T.aggression, dt)) {
        c.fireRW = true;
        cool.melee = 1.4;
      } else if (me.gauges.cw >= 1 && cool.cw <= 0 && los && dist >= hints.cw[0] && dist <= hints.cw[1] && chance(foeOpen ? 3 : T.cwRate, dt)) {
        c.fireCW = true;
        cool.cw = 3;
      } else if (me.gauges.rw >= spec.weapons.rw.cost + 0.05 && cool.rw <= 0 && los && dist <= hints.rw && chance((foeOpen ? 4 : 1.6) * T.fireRate, dt)) {
        c.fireRW = true;
        cool.rw = rand(0.35, 0.9) / T.fireRate;
      } else if (me.gauges.lw >= spec.weapons.lw.cost && cool.lw <= 0 && chance((pinned ? 4 : los ? 0.35 : 0.9) * hints.lw * T.fireRate, dt)) {
        c.fireLW = true;
        cool.lw = rand(1.4, 3);
      }
    }
    // dash in with a dash attack now and then
    if (me.state === 'ground' && !me.action && cool.dash <= 0 && this.dashHold <= 0 && chance(0.4 * T.aggression, dt)) {
      this.dashHold = rand(0.3, 0.55);
      this.dashSide = randSign() * rand(0.5, 1);
      this.dashFwd = dist > pref[0] ? rand(0.1, 0.8) : rand(-0.7, 0.1);
      c.dashPressed = c.dash = true;
      c.moveX = this.dashSide;
      c.moveY = this.dashFwd;
      cool.dash = rand(1.1, 2.6) / T.aggression;
    }
    // a dash attack — or, for a VR whose boosting RW is a charge, a ram: only from a forward dash in range
    const [ram0, ram1] = hints.dashRW;
    const ramOk = dist >= ram0 && dist <= ram1 && (ram1 > 900 || this.dashFwd > 0.3);
    if (me.state === 'dash' && me.stateT > 0.1 && me.stateT < 0.2 && me.lockedOn && los && ramOk && me.gauges.rw >= spec.weapons.rw.cost && chance(4 * T.fireRate, dt)) {
      c.fireRW = true;
    }
    if (me.state === 'ground' && !me.action && cool.jump <= 0 && chance(hints.jump, dt)) {
      c.jump = c.jumpPressed = true;
      cool.jump = rand(2, 5);
    }
    if (me.state === 'air' && Math.abs(me.vel.y) < 5 && me.lockedOn && los && dist <= hints.rw && !me.action && me.gauges.rw >= spec.weapons.rw.cost && chance(2 * T.fireRate, dt)) {
      c.fireRW = true;
    }
    return c;
  }

  /** Dodge incoming shots from any enemy (co-op: either player). */
  private scanThreats(me: Mech, w: World) {
    if (this.seen.size > 300) this.seen.clear();
    if (this.dodge || this.dashHold > 0) return;
    if (me.state !== 'ground' && me.state !== 'air') return;
    me.centerInto(_a);
    for (const p of w.projectiles.list) {
      if (p.owner.team === me.team || this.seen.has(p.id)) continue;
      _rel.subVectors(_a, p.pos);
      _vr.subVectors(p.vel, me.vel);
      const v2 = _vr.lengthSq();
      if (v2 < 1) continue;
      const tca = _rel.dot(_vr) / v2;
      if (tca < 0 || tca > 0.85) continue;
      // offset from the projectile's path to me at closest approach
      _rel.addScaledVector(_vr, -tca);
      const miss = _rel.length();
      if (miss > me.spec.radius + p.radius + 2.5) continue;
      this.seen.add(p.id);
      if (Math.random() > this.tune.dodge) continue;
      rightOf(me.yaw, _r);
      const lateral = _rel.dot(_r);
      const side = Math.abs(lateral) < 0.5 ? randSign() : Math.sign(lateral);
      this.dodge = {
        t: this.tune.reaction * rand(0.7, 1.3),
        side,
        jump: p.kind === 'bomb' ? Math.random() < 0.5 : Math.random() < 0.12,
      };
      return;
    }
    for (const b of w.projectiles.beams) {
      if (b.active && b.owner.team !== me.team && Math.random() < this.tune.dodge * 0.08) {
        this.dodge = { t: this.tune.reaction, side: randSign(), jump: false };
        return;
      }
    }
  }
}
