import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, forwardOf, hdist, rand, rotateToward, segSegDist2 } from '../core/math';
import { glowTexture } from '../render/textures';
import { POSES, PROJ_KINDS, r1, r2, r3, type BeamSnap, type ProjSnap } from '../net/protocol';
import { HALF } from './arena';
import type { Mech } from './mech';
import type { MechId, Slot } from './specs';
import type { World } from './world';

export type Knock = 'none' | 'stagger' | 'down';

export interface Hit {
  damage: number;
  knock: Knock;
  /** horizontal push direction (unit) */
  dir: THREE.Vector3;
  source: Mech | null;
  pos: THREE.Vector3;
  heavy?: boolean;
  /** pins the target in place this long (a snare net) */
  snare?: number;
}

export type Variant = 'ground' | 'dash' | 'air';
export type PoseKind = (typeof POSES)[number];

export interface ActionEvent {
  t: number;
  run: (m: Mech, w: World) => void;
  done?: boolean;
}

/** A timed weapon/melee animation with scheduled events (projectile spawns, hit checks). */
export interface Action {
  kind: 'fire' | 'melee';
  slot: Slot;
  variant: Variant;
  pose: PoseKind;
  t: number;
  duration: number;
  /** fraction of walk speed you can keep walking at while grounded (walking shots ~0.9, 0 = planted) */
  moveMul: number;
  /** while planted (moveMul 0), how fast existing momentum bleeds off — low values slide further */
  slide?: number;
  /** fraction of auto-turn rate */
  turnMul: number;
  /** lighter gravity while airborne: the jump arc carries on with a brief hang at the shot */
  hover: boolean;
  /** let an ongoing dash keep its speed */
  keepDash: boolean;
  /** dash/jump may cancel the action once all its events have fired */
  cancelAfterEvents: boolean;
  /** charge glow window */
  charge?: [number, number];
  lunge?: { until: number; speed: number };
  hitWindow?: [number, number];
  hasHit?: boolean;
  /** what the hit window deals (melee: the VR's melee damage) */
  hitDamage?: number;
  /** light hits don't stagger the mech out of this action (a brawler's lunge) */
  armor?: boolean;
  /** a committed plunge: thrusters and hovering can't slow the fall */
  dive?: boolean;
  /** runs once if the mech touches down while this action is on (an air slam lands its blow) */
  onLand?: (m: Mech, w: World) => void;
  /** who the attack went for, fixed when it starts: a co-op boss switching targets doesn't swing a lunge or a beam already under way */
  target?: Mech;
  /** fired while walking: the mech keeps moving but the shot guides less than a planted shot */
  moving?: boolean;
  events: ActionEvent[];
}

// ------------------------------------------------------------------ projectiles

export type ProjKind = (typeof PROJ_KINDS)[number];

export interface Projectile {
  id: number;
  kind: ProjKind;
  owner: Mech;
  /** what it homes on: whoever its owner was targeting when it was fired (the owner's current one once that's down) */
  target: Mech;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  radius: number;
  damage: number;
  knock: Knock;
  homing: number;
  homingDelay: number;
  gravity: number;
  accel: number;
  maxSpeed: number;
  life: number;
  age: number;
  splash: number;
  power: number;
  color: number;
  obj: THREE.Object3D;
  alive: boolean;
  trail: number;
  /** cosmetic clock (blinking, spin) — advanced by the visual pass on host and guest alike */
  vt: number;
  /** keeps steering at the target even after flying past it (hunter drones circle back) */
  chase: boolean;
  /** lands and stays put instead of bursting on whatever it hits (a mine) */
  stick: boolean;
  stuck: boolean;
  /** age when it dug in */
  stuckAt: number;
  /** a planted mine goes off when an enemy comes this close, once it has been down `arm` seconds */
  trigger: number;
  arm: number;
  snare: number;
}

export interface SpawnOpts {
  kind: ProjKind;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  radius: number;
  damage: number;
  knock: Knock;
  homing?: number;
  homingDelay?: number;
  gravity?: number;
  accel?: number;
  maxSpeed?: number;
  life?: number;
  splash?: number;
  color?: number;
  chase?: boolean;
  stick?: boolean;
  trigger?: number;
  arm?: number;
  snare?: number;
  /** most of this kind one mech can have out at once: the oldest goes when another is fired */
  cap?: number;
}

/** clash strength: big shots erase small ones (hunter drones out-muscle bullets: they shield their owner) */
const POWER: Record<ProjKind, number> = { bolt: 1, shell: 1, missile: 1, bomb: 2, hyper: 3, orb: 2, mine: 2, fist: 2, net: 2 };

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _want = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _blast = new THREE.Vector3();
const _sightA = new THREE.Vector3();
const _sightB = new THREE.Vector3();

/** Can a blast at `from` (raised by `lift`) reach mech `m`? Walls and blocks shield whatever is behind them. */
function exposed(from: THREE.Vector3, lift: number, m: Mech, w: World) {
  _sightA.set(from.x, from.y + lift, from.z);
  if (w.arena.lineOfSight(_sightA, m.centerInto(_sightB))) return true;
  // a head showing over a low block is enough
  _sightB.set(m.pos.x, m.pos.y + m.spec.height - 0.6, m.pos.z);
  return w.arena.lineOfSight(_sightA, _sightB);
}
const UP = new THREE.Vector3(0, 1, 0);

let nextId = 1;

function additive(color: number, opacity = 1) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
}

function glowSprite(color: number, size: number) {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture(),
      color,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false,
    }),
  );
  s.scale.set(size, size, 1);
  return s;
}

/** Owns every projectile and beam in flight. */
export class Projectiles {
  readonly list: Projectile[] = [];
  readonly beams: Beam[] = [];
  private pools = new Map<string, THREE.Object3D[]>();
  private geos: THREE.BufferGeometry[] = [];
  private mats = new Set<THREE.Material>();
  private readonly shapes = new Map<string, THREE.BufferGeometry>();
  private readonly looks = new Map<string, THREE.Material>();

  constructor(private readonly scene: THREE.Scene) {}

  /**
   * Build one visual of every projectile kind (and a beam) up front, so their shaders get compiled
   * with the rest of the scene instead of stalling the first time someone fires.
   */
  prewarm(colors: number[]) {
    const kinds: [ProjKind, number[]][] = [
      ['bolt', colors],
      ['shell', colors],
      ['hyper', colors],
      ['bomb', [0xff4a3a]],
      ['missile', [0xffb04a]],
      ['orb', colors.slice(0, 1)],
      ['mine', colors.slice(0, 1)],
      ['fist', colors.slice(0, 1)],
      ['net', colors.slice(0, 1)],
    ];
    for (const [kind, cs] of kinds) {
      for (const c of cs) {
        const key = `${kind}:${c}`;
        const pool = this.pools.get(key) ?? [];
        this.pools.set(key, pool);
        const obj = this.makeVisual(kind, c);
        obj.userData.pool = key;
        obj.visible = false;
        this.scene.add(obj);
        pool.push(obj);
      }
    }
    if (!this.beams.length) this.beams.push(new Beam(this.scene));
  }

  private geo<T extends THREE.BufferGeometry>(g: T) {
    this.geos.push(g);
    return g;
  }

  /** One geometry per shape, shared by every pooled visual (uploaded once, not once per shot). */
  private shape(key: string, make: () => THREE.BufferGeometry) {
    let g = this.shapes.get(key);
    if (!g) {
      g = this.geo(make());
      this.shapes.set(key, g);
    }
    return g;
  }

  /** One material per look (kind of surface and color), shared the same way. */
  private look<M extends THREE.Material>(key: string, make: () => M): M {
    let m = this.looks.get(key) as M | undefined;
    if (!m) {
      m = make();
      this.looks.set(key, m);
    }
    return m;
  }

  private makeVisual(kind: ProjKind, color: number): THREE.Object3D {
    const g = new THREE.Group();
    const add = (c: number, opacity = 1) => this.look(`add:${c}:${opacity}`, () => additive(c, opacity));
    const lam = (c: number) => this.look(`lam:${c}`, () => new THREE.MeshLambertMaterial({ color: c, flatShading: true }));
    const glow = (c: number, size: number) => {
      const sp = new THREE.Sprite(
        this.look(
          `glow:${c}`,
          () => new THREE.SpriteMaterial({ map: glowTexture(), color: c, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }),
        ),
      );
      sp.scale.set(size, size, 1);
      return sp;
    };
    switch (kind) {
      case 'bolt': {
        const core = new THREE.Mesh(this.shape('bolt-core', () => new THREE.CylinderGeometry(0.16, 0.16, 3.4, 6).rotateX(Math.PI / 2)), add(0xffffff));
        const halo = new THREE.Mesh(this.shape('bolt-halo', () => new THREE.CylinderGeometry(0.42, 0.2, 4.6, 8).rotateX(Math.PI / 2)), add(color, 0.75));
        g.add(core, halo, glow(color, 3.2));
        break;
      }
      case 'shell': {
        g.add(new THREE.Mesh(this.shape('shell', () => new THREE.SphereGeometry(0.55, 8, 6)), add(0xfff0c0)));
        const tail = new THREE.Mesh(this.shape('shell-tail', () => new THREE.ConeGeometry(0.5, 3, 8).rotateX(-Math.PI / 2).translate(0, 0, -1.5)), add(color, 0.6));
        g.add(tail, glow(color, 4.2));
        break;
      }
      case 'bomb': {
        g.add(new THREE.Mesh(this.shape('bomb', () => new THREE.IcosahedronGeometry(0.75, 0)), lam(0x30343f)));
        const blink = glow(color, 3.2);
        blink.name = 'blink';
        g.add(blink);
        break;
      }
      case 'hyper': {
        g.add(new THREE.Mesh(this.shape('hyper-core', () => new THREE.IcosahedronGeometry(1.0, 1)), add(0xffffff)));
        g.add(new THREE.Mesh(this.shape('hyper-shell', () => new THREE.IcosahedronGeometry(1.9, 1)), add(color, 0.55)));
        const ring = new THREE.Mesh(this.shape('hyper-ring', () => new THREE.TorusGeometry(2.4, 0.18, 6, 24)), add(color, 0.8));
        ring.name = 'ring';
        g.add(ring, glow(color, 10));
        break;
      }
      case 'missile': {
        g.add(new THREE.Mesh(this.shape('missile', () => new THREE.CylinderGeometry(0.22, 0.28, 1.6, 6).rotateX(Math.PI / 2)), lam(0xe8e4d8)));
        g.add(new THREE.Mesh(this.shape('missile-tip', () => new THREE.ConeGeometry(0.22, 0.6, 6).rotateX(Math.PI / 2).translate(0, 0, 1.1)), lam(0xd8382c)));
        const flame = glow(color, 2.4);
        flame.position.z = -1.1;
        g.add(flame);
        break;
      }
      case 'orb': {
        // hunter drone: a bright core in a shell, a spinning ring around it
        g.add(new THREE.Mesh(this.shape('orb-core', () => new THREE.IcosahedronGeometry(0.45, 0)), add(0xffffff)));
        g.add(new THREE.Mesh(this.shape('orb-shell', () => new THREE.IcosahedronGeometry(0.85, 0)), add(color, 0.55)));
        const ring = new THREE.Mesh(this.shape('orb-ring', () => new THREE.TorusGeometry(1.15, 0.08, 4, 16)), add(color, 0.85));
        ring.name = 'ring';
        g.add(ring, glow(color, 3));
        break;
      }
      case 'mine': {
        // a squat disc with three claws (one mesh) and a blinking light
        g.add(new THREE.Mesh(this.shape('mine', () => new THREE.CylinderGeometry(0.95, 1.1, 0.35, 8)), lam(0x2a2c34)));
        const claws = this.shape('mine-claws', () =>
          mergeGeometries([0, 1, 2].map((i) => new THREE.BoxGeometry(0.18, 0.12, 0.9).translate(0, -0.05, 0.95).rotateY((i / 3) * Math.PI * 2))),
        );
        g.add(new THREE.Mesh(claws, lam(0x4a4d58)));
        const blink = glow(color, 2.6);
        blink.position.y = 0.35;
        blink.name = 'blink';
        g.add(blink);
        break;
      }
      case 'fist': {
        // rocket fist: knuckles first, a flame behind
        g.add(new THREE.Mesh(this.shape('fist', () => new THREE.BoxGeometry(1.25, 1.15, 1.4)), lam(0x3c3f4a)));
        g.add(new THREE.Mesh(this.shape('fist-knuckles', () => new THREE.BoxGeometry(1.3, 0.5, 0.4).translate(0, 0.15, 0.75)), lam(color)));
        const flame = glow(0xffb04a, 3);
        flame.position.z = -1.2;
        g.add(flame);
        break;
      }
      case 'net': {
        // snare net: a spinning hexagon strung across with glowing strands (one mesh)
        const hex = new THREE.Mesh(this.shape('net', () => new THREE.TorusGeometry(1.9, 0.12, 4, 6)), add(color, 0.9));
        hex.name = 'ring';
        const strands = this.shape('net-strands', () => mergeGeometries([0, 1, 2].map((i) => new THREE.BoxGeometry(3.6, 0.08, 0.08).rotateZ((i / 3) * Math.PI))));
        hex.add(new THREE.Mesh(strands, add(color, 0.7)));
        g.add(hex, glow(color, 4.5));
        break;
      }
    }
    g.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m && !Array.isArray(m)) this.mats.add(m);
    });
    return g;
  }

  spawn(owner: Mech, o: SpawnOpts) {
    if (o.cap) {
      // the list is in firing order, so the first one found is the oldest
      let n = 0;
      let oldest: Projectile | null = null;
      for (const q of this.list) {
        if (!q.alive || q.owner !== owner || q.kind !== o.kind) continue;
        n++;
        oldest ??= q;
      }
      if (oldest && n >= o.cap) this.release(oldest);
    }
    const color = o.color ?? owner.palette.beam;
    const key = `${o.kind}:${color}`;
    const pool = this.pools.get(key) ?? [];
    this.pools.set(key, pool);
    const obj = pool.pop() ?? this.makeVisual(o.kind, color);
    obj.userData.pool = key;
    obj.visible = true;
    this.scene.add(obj);
    // a mech backed against the arena's edge has its gun poking through it: fire from just inside, or
    // the shot would start beyond the barrier, never cross it, and sail off into the scenery
    const lim = HALF - 0.3;
    o.pos.x = clamp(o.pos.x, -lim, lim);
    o.pos.z = clamp(o.pos.z, -lim, lim);
    const p: Projectile = {
      id: nextId++,
      kind: o.kind,
      owner,
      target: owner.target,
      pos: o.pos.clone(),
      prev: o.pos.clone(),
      vel: o.vel.clone(),
      radius: o.radius,
      damage: o.damage,
      knock: o.knock,
      homing: o.homing ?? 0,
      homingDelay: o.homingDelay ?? 0,
      gravity: o.gravity ?? 0,
      accel: o.accel ?? 0,
      maxSpeed: o.maxSpeed ?? 0,
      life: o.life ?? 2.5,
      age: 0,
      splash: o.splash ?? 0,
      power: POWER[o.kind],
      color,
      obj,
      alive: true,
      trail: 0,
      vt: 0,
      chase: o.chase ?? false,
      stick: o.stick ?? false,
      stuck: false,
      stuckAt: 0,
      trigger: o.trigger ?? 0,
      arm: o.arm ?? 0,
      snare: o.snare ?? 0,
    };
    obj.position.copy(p.pos);
    obj.lookAt(_a.copy(p.pos).add(p.vel));
    this.list.push(p);
    owner.stats.shots++;
    return p;
  }

  /** Is one of `owner`'s projectiles of this kind still out? (a launched rocket fist is off the arm) */
  inFlight(owner: Mech, kind: ProjKind) {
    for (const p of this.list) if (p.alive && p.owner === owner && p.kind === kind) return true;
    return false;
  }

  /** Versus host: every live projectile, compactly. */
  writeNet(mechs: Mech[]): ProjSnap[] {
    const out: ProjSnap[] = [];
    for (const p of this.list) {
      if (!p.alive) continue;
      out.push([p.id, PROJ_KINDS.indexOf(p.kind), mechs.indexOf(p.owner), r2(p.pos.x), r2(p.pos.y), r2(p.pos.z), r1(p.vel.x), r1(p.vel.y), r1(p.vel.z), p.color]);
    }
    return out;
  }

  /** Versus host: active beams. */
  writeBeams(mechs: Mech[]): BeamSnap[] {
    const out: BeamSnap[] = [];
    for (const b of this.beams) if (b.active) out.push(b.writeNet(mechs.indexOf(b.owner)));
    return out;
  }

  /** Versus guest: mirror the host's projectiles (already interpolated to the render time). */
  applyNet(states: ProjSnap[], mechs: Mech[]) {
    for (const p of this.list) p.alive = false;
    for (const st of states) {
      const owner = mechs[st[2]];
      if (!owner) continue;
      let p = this.list.find((q) => q.id === st[0]);
      if (!p) {
        const kind = PROJ_KINDS[st[1]] ?? 'bolt';
        const key = `${kind}:${st[9]}`;
        const pool = this.pools.get(key) ?? [];
        this.pools.set(key, pool);
        const obj = pool.pop() ?? this.makeVisual(kind, st[9]);
        obj.userData.pool = key;
        obj.visible = true;
        this.scene.add(obj);
        p = {
          id: st[0],
          kind,
          owner,
          target: owner.target,
          pos: new THREE.Vector3(),
          prev: new THREE.Vector3(),
          vel: new THREE.Vector3(),
          radius: 0,
          damage: 0,
          knock: 'none',
          homing: 0,
          homingDelay: 0,
          gravity: 0,
          accel: 0,
          maxSpeed: 0,
          life: 0,
          age: 0,
          splash: 0,
          power: 0,
          color: st[9],
          obj,
          alive: true,
          trail: 0,
          vt: 0,
          chase: false,
          stick: false,
          stuck: false,
          stuckAt: 0,
          trigger: 0,
          arm: 0,
          snare: 0,
        };
        this.list.push(p);
      }
      p.alive = true;
      p.pos.set(st[3], st[4], st[5]);
      p.vel.set(st[6], st[7], st[8]);
    }
    let k = 0;
    for (const p of this.list) {
      if (p.alive) this.list[k++] = p;
      else {
        p.alive = true;
        this.release(p);
      }
    }
    this.list.length = k;
  }

  /** Versus guest: mirror the host's beams. */
  applyBeams(states: BeamSnap[], mechs: Mech[]) {
    const used = new Set<Beam>();
    for (const st of states) {
      const owner = mechs[st[0]];
      if (!owner) continue;
      let b = this.beams.find((x) => x.active && x.owner === owner && !used.has(x)) ?? this.beams.find((x) => !x.active && !used.has(x));
      if (!b) {
        b = new Beam(this.scene);
        this.beams.push(b);
      }
      used.add(b);
      b.readNet(owner, st);
    }
    for (const b of this.beams) if (b.active && !used.has(b)) b.stop();
  }

  private release(p: Projectile) {
    p.alive = false;
    this.scene.remove(p.obj);
    const key = p.obj.userData.pool as string;
    this.pools.get(key)?.push(p.obj);
  }

  startBeam(owner: Mech, duration: number, width: number, dps: number) {
    let b = this.beams.find((x) => !x.active);
    if (!b) {
      b = new Beam(this.scene);
      this.beams.push(b);
    }
    b.start(owner, duration, width, dps);
    return b;
  }

  /** The match froze (pause, a dropped link): silence the laser roar until the beams are drawn again. */
  hushLoops() {
    for (const b of this.beams) b.hush();
  }

  stopBeamsOf(owner: Mech) {
    for (const b of this.beams) if (b.active && b.owner === owner) b.stop();
  }

  update(dt: number, w: World) {
    for (const p of this.list) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.stuck) {
        // a planted mine: armed a moment after it lands, it goes off when an enemy comes close (or at the end of its life)
        if ((p.age - p.stuckAt > p.arm && this.enemyNear(p, w)) || p.age > p.life) this.impact(p, w, null);
        continue;
      }
      p.prev.copy(p.pos);
      const tgt = p.target.alive ? p.target : p.owner.target;
      if (p.homing > 0 && p.age > p.homingDelay && tgt.alive) {
        const speed = p.vel.length();
        _dir.copy(p.vel).divideScalar(speed || 1);
        tgt.centerInto(_want).sub(p.pos);
        // stop guiding once the projectile has passed the target (hunter drones turn round instead)
        if (p.chase || _want.dot(_dir) > 0) {
          _want.normalize();
          rotateToward(_dir, _want, p.homing * dt);
          p.vel.copy(_dir).multiplyScalar(speed);
        }
      }
      if (p.accel > 0) {
        const s = p.vel.length();
        const ns = Math.min(p.maxSpeed, s + p.accel * dt);
        p.vel.multiplyScalar(ns / (s || 1));
      }
      if (p.gravity) p.vel.y -= p.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);

      // world collision
      const tw = w.arena.raycast(p.prev, p.pos, p.kind === 'hyper' ? 0.6 : 0);
      // mech collision
      let hitMech: Mech | null = null;
      for (const m of w.mechs) {
        if (m.team === p.owner.team || !m.alive || !m.hittable) continue;
        m.axis(_b, _c);
        const r = m.spec.radius * 0.85 + p.radius;
        if (segSegDist2(p.prev, p.pos, _b, _c) < r * r) {
          hitMech = m;
          break;
        }
      }
      if (hitMech) {
        this.impact(p, w, hitMech);
      } else if (p.stick && p.vel.x === 0 && p.vel.z === 0) {
        // a mine that glanced off a wall falls straight down beside it, onto the floor or a block top
        const gy = w.arena.groundAt(p.pos.x, p.pos.z, 0.5, p.prev.y + 0.3);
        if (p.pos.y <= gy) {
          p.pos.y = gy;
          this.plant(p, w);
        }
      } else if (tw >= 0) {
        p.pos.lerpVectors(p.prev, p.pos, tw);
        if (p.stick) {
          if (p.pos.y - w.arena.groundAt(p.pos.x, p.pos.z, 0.5, p.pos.y + 0.3) < 0.6) {
            this.plant(p, w);
          } else {
            // glanced off a wall (or the arena's edge): back off it and drop straight down
            _dir.set(p.vel.x, 0, p.vel.z).normalize();
            p.pos.addScaledVector(_dir, -0.4);
            p.vel.set(0, Math.min(0, p.vel.y), 0);
          }
        } else this.impact(p, w, null);
      }
      // nothing outlives its life, whatever it is caught on
      if (p.alive && !p.stuck && p.age > p.life) {
        if (p.splash > 0) this.impact(p, w, null);
        else this.release(p);
      }
    }

    // opposing projectiles cancel each other — big shots erase small ones (a mine dug into the ground
    // is out of it: shots pass over it rather than vanishing into it)
    for (let i = 0; i < this.list.length; i++) {
      const a = this.list[i];
      if (!a.alive || a.stuck) continue;
      for (let j = i + 1; j < this.list.length; j++) {
        const b = this.list[j];
        if (!b.alive || b.stuck || b.owner.team === a.owner.team) continue;
        const r = a.radius + b.radius;
        if (a.pos.distanceToSquared(b.pos) > r * r) continue;
        w.fx.flash(_d.addVectors(a.pos, b.pos).multiplyScalar(0.5), 0xffffff, 4, 0.15, true);
        w.fx.spark(_d, 8, 0xfff0b0, 20);
        w.sound('hit', _d, 0.5);
        if (a.power <= b.power) this.release(a);
        if (b.power <= a.power) this.release(b);
        if (!a.alive) break;
      }
    }

    // compact
    let k = 0;
    for (const p of this.list) if (p.alive) this.list[k++] = p;
    this.list.length = k;

    for (const b of this.beams) if (b.active) b.simulate(dt, w);
    // trails, spin and beam visuals are cosmetic: the versus guest draws its own
    w.visual(() => this.updateVisuals(dt, w));
  }

  /** A mine digs in where it lands. */
  private plant(p: Projectile, w: World) {
    p.stuck = true;
    p.stuckAt = p.age;
    p.vel.set(0, 0, 0);
    p.pos.y += 0.2;
    w.fx.dust(p.pos, 4, w.dustColor, 1, 1.4);
  }

  /** An enemy close enough to set this mine off. */
  private enemyNear(p: Projectile, w: World) {
    for (const m of w.mechs) {
      if (m.team === p.owner.team || !m.alive || !m.hittable) continue;
      m.axis(_b, _c);
      const r = p.trigger + m.spec.radius * 0.8;
      // close enough, and not behind a wall
      if (segSegDist2(p.pos, p.pos, _b, _c) < r * r && exposed(p.pos, 1, m, w)) return true;
    }
    return false;
  }

  /** Placement, spin, blinking and trails — everything the eye sees but the rules don't care about. */
  updateVisuals(dt: number, w: World) {
    for (const p of this.list) if (p.alive) this.visualStep(p, dt, w);
    for (const b of this.beams) if (b.active) b.render(w);
  }

  private visualStep(p: Projectile, dt: number, w: World) {
    p.vt += dt;
    p.obj.position.copy(p.pos);
    p.trail -= dt;
    if (p.kind === 'mine') {
      // planted (it has stopped: the versus guest only sees the velocity): flat on the ground, blinking
      const planted = p.vel.lengthSq() < 0.01;
      if (planted) p.obj.rotation.set(0, p.obj.rotation.y, 0);
      else p.obj.rotation.set(p.vt * 9, p.vt * 4, 0);
      const blink = p.obj.getObjectByName('blink');
      if (blink) blink.visible = Math.floor(p.vt * (planted ? 3 : 12)) % 2 === 0;
      return;
    }
    p.obj.lookAt(_a.copy(p.pos).add(p.vel));
    if (p.kind === 'missile' && p.trail <= 0) {
      p.trail = 0.03;
      w.fx.smoke(p.pos, 1, 1.1, 0xd8d4d0, 0.7);
      w.fx.trail(p.pos, p.color, 1.6, 0.18);
    } else if (p.kind === 'hyper') {
      const ring = p.obj.getObjectByName('ring');
      if (ring) ring.rotation.z += dt * 9;
      if (p.trail <= 0) {
        p.trail = 0.02;
        w.fx.trail(p.pos, p.color, 3.4, 0.3, 0.6);
      }
    } else if (p.kind === 'bomb') {
      const blink = p.obj.getObjectByName('blink');
      if (blink) blink.visible = Math.floor(p.vt * 12) % 2 === 0;
      p.obj.rotation.x += dt * 8;
    } else if (p.kind === 'bolt' && p.trail <= 0) {
      p.trail = 0.025;
      w.fx.trail(p.pos, p.color, 1.3, 0.12, 0.5);
    } else if (p.kind === 'shell' && p.trail <= 0) {
      p.trail = 0.03;
      w.fx.trail(p.pos, p.color, 1.6, 0.15, 0.5);
    } else if (p.kind === 'orb') {
      const ring = p.obj.getObjectByName('ring');
      if (ring) {
        ring.rotation.z += dt * 7;
        ring.rotation.x = Math.sin(p.vt * 3) * 0.6;
      }
      if (p.trail <= 0) {
        p.trail = 0.05;
        w.fx.trail(p.pos, p.color, 1.2, 0.25, 0.5);
      }
    } else if (p.kind === 'net') {
      const ring = p.obj.getObjectByName('ring');
      if (ring) ring.rotation.z += dt * 11;
      if (p.trail <= 0) {
        p.trail = 0.03;
        w.fx.trail(p.pos, p.color, 2.2, 0.2, 0.5);
      }
    } else if (p.kind === 'fist' && p.trail <= 0) {
      p.trail = 0.03;
      w.fx.smoke(p.pos, 1, 1.4, 0x8a8480, 0.6);
      w.fx.trail(p.pos, 0xffb04a, 1.8, 0.16);
    }
  }

  private impact(p: Projectile, w: World, mech: Mech | null) {
    const pos = p.pos;
    if (p.splash > 0) {
      // the blast's center, nudged back off whatever surface it burst on, so walls shield what's behind them
      _blast.subVectors(p.prev, pos);
      const back = _blast.length();
      _blast.multiplyScalar(back > 1e-4 ? Math.min(0.5, back) / back : 0).add(pos);
      const sz = p.kind === 'hyper' ? 4 : 3;
      w.fx.explosion(pos, sz, p.kind === 'hyper' ? p.color : 0xffa040);
      w.sound(p.kind === 'hyper' ? 'explosionBig' : 'explosionSmall', pos);
      w.shake(p.kind === 'hyper' ? 0.6 : 0.35, pos);
      for (const m of w.mechs) {
        if (m.team === p.owner.team || !m.alive || !m.hittable) continue;
        m.axis(_b, _c);
        // distance from blast center to the mech's axis
        const seg = _d.subVectors(_c, _b);
        const tt = clamp(_a.subVectors(pos, _b).dot(seg) / seg.lengthSq(), 0, 1);
        const closest = _a.copy(_b).addScaledVector(seg, tt);
        const dist = closest.distanceTo(pos) - m.spec.radius * 0.8;
        if (m === mech || (dist < p.splash && exposed(_blast, 0.3, m, w))) {
          const f = m === mech ? 1 : clamp(1 - Math.max(0, dist) / p.splash, 0.45, 1);
          const dir = new THREE.Vector3(m.pos.x - pos.x, 0, m.pos.z - pos.z);
          if (dir.lengthSq() < 1e-4) dir.set(p.vel.x, 0, p.vel.z);
          dir.normalize();
          m.takeHit({ damage: p.damage * f, knock: f > 0.6 ? p.knock : 'stagger', dir, source: p.owner, pos: pos.clone(), heavy: true }, w);
        }
      }
    } else if (mech) {
      const dir = new THREE.Vector3(p.vel.x, 0, p.vel.z).normalize();
      const heavy = p.kind === 'fist';
      const landed = mech.takeHit({ damage: p.damage, knock: p.knock, dir, source: p.owner, pos: pos.clone(), heavy, snare: p.snare || undefined }, w);
      w.fx.flash(pos, landed ? 0xffffff : 0x9ad8ff, p.kind === 'hyper' ? 8 : 4, 0.12, true);
      w.fx.spark(pos, landed ? 14 : 6, p.color, 26);
      if (p.kind === 'missile' || p.kind === 'shell' || p.kind === 'fist') {
        w.fx.explosion(pos, p.kind === 'fist' ? 2.4 : 1.6, 0xffa040);
        w.sound('explosionSmall', pos, 0.7);
      }
      if (p.kind === 'fist') w.shake(0.4, pos);
      if (p.kind === 'net') w.fx.ring(pos, 2.2, p.color, 0.4);
    } else {
      // hit the floor or a block
      w.fx.flash(pos, p.color, p.kind === 'hyper' ? 9 : 3.5, 0.12, true);
      w.fx.spark(pos, 8, p.color, 18);
      if (p.kind === 'missile' || p.kind === 'shell' || p.kind === 'fist') {
        w.fx.explosion(pos, p.kind === 'fist' ? 2.2 : 1.5, 0xffa040);
        w.sound('explosionSmall', pos, 0.5);
      } else if (p.kind === 'hyper') {
        w.fx.explosion(pos, 3.5, p.color);
        w.sound('explosionBig', pos, 0.8);
      }
      if (pos.y < 0.6) w.fx.dust(pos, 3, 0xd8d0c0, 0.5, 1.6);
    }
    this.release(p);
  }

  clear() {
    for (const p of this.list) if (p.alive) this.release(p);
    this.list.length = 0;
    for (const b of this.beams) if (b.active) b.stop();
  }

  dispose() {
    this.clear();
    for (const b of this.beams) b.dispose();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const pool of this.pools.values()) for (const o of pool) this.scene.remove(o);
  }
}

// ------------------------------------------------------------------ sustained beam (gale laser)

export class Beam {
  active = false;
  owner!: Mech;
  readonly dir = new THREE.Vector3();
  private readonly group = new THREE.Group();
  private readonly body: THREE.Mesh;
  private readonly outer: THREE.Mesh;
  private readonly inner: THREE.Mesh;
  private readonly endFlare: THREE.Sprite;
  private readonly startFlare: THREE.Sprite;
  private t = 0;
  private duration = 1;
  private width = 1;
  private dps = 200;
  private tick = 0;
  private length = 10;
  private readonly origin = new THREE.Vector3();
  private readonly end = new THREE.Vector3();
  private loop: { set(p: { volume?: number; pan?: number }): void; stop(f?: number): void } | null = null;

  constructor(private readonly scene: THREE.Scene) {
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true).translate(0, 0.5, 0);
    // an opaque-ish colored body keeps the beam readable over bright skies and floors
    this.body = new THREE.Mesh(
      cyl,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false, fog: false, side: THREE.DoubleSide }),
    );
    this.outer = new THREE.Mesh(cyl, additive(0xffffff, 0.6));
    this.inner = new THREE.Mesh(cyl, additive(0xffffff, 1));
    this.body.renderOrder = 22;
    this.outer.renderOrder = 23;
    this.inner.renderOrder = 24;
    this.group.add(this.body, this.outer, this.inner);
    this.endFlare = glowSprite(0xffffff, 10);
    this.startFlare = glowSprite(0xffffff, 7);
    this.group.visible = false;
    this.endFlare.visible = this.startFlare.visible = false;
    scene.add(this.group, this.endFlare, this.startFlare);
  }

  start(owner: Mech, duration: number, width: number, dps: number) {
    this.begin(owner, duration, width);
    this.dps = dps;
    this.tick = 0;
    owner.model.chest.getWorldPosition(this.origin);
    owner.target.centerInto(this.dir).sub(this.origin).normalize();
  }

  private begin(owner: Mech, duration: number, width: number) {
    this.owner = owner;
    this.active = true;
    this.t = 0;
    this.duration = duration;
    this.width = width;
    const c = owner.palette.beam;
    (this.outer.material as THREE.MeshBasicMaterial).color.setHex(c);
    (this.body.material as THREE.MeshBasicMaterial).color.setHex(c).multiplyScalar(0.8);
    (this.endFlare.material as THREE.SpriteMaterial).color.setHex(c);
    (this.startFlare.material as THREE.SpriteMaterial).color.setHex(0xffffff);
    this.group.visible = this.endFlare.visible = this.startFlare.visible = true;
  }

  stop() {
    this.active = false;
    this.group.visible = this.endFlare.visible = this.startFlare.visible = false;
    this.loop?.stop(0.15);
    this.loop = null;
  }

  writeNet(ownerIdx: number): BeamSnap {
    const o = this.origin;
    const d = this.dir;
    return [ownerIdx, r2(o.x), r2(o.y), r2(o.z), r3(d.x), r3(d.y), r3(d.z), r2(this.length), r2(this.t), r2(this.duration), r2(this.width)];
  }

  /** Versus guest: take the beam's geometry from the host. */
  readNet(owner: Mech, st: BeamSnap) {
    if (!this.active || this.owner !== owner) this.begin(owner, st[9], st[10]);
    this.origin.set(st[1], st[2], st[3]);
    this.dir.set(st[4], st[5], st[6]).normalize();
    this.length = st[7];
    this.t = st[8];
    this.duration = st[9];
    this.width = st[10];
    this.end.copy(this.origin).addScaledVector(this.dir, this.length);
  }

  /** Rules side: tracking, length and damage ticks (host / single player only). */
  simulate(dt: number, w: World) {
    const m = this.owner;
    this.t += dt;
    if (this.t >= this.duration || !m.alive || !m.action || m.action.pose !== 'beam') {
      this.stop();
      return;
    }
    m.model.chest.getWorldPosition(this.origin);
    // track the target slowly — dodge sideways and it sweeps after you
    const tgt = m.action.target ?? m.target;
    tgt.centerInto(_want).sub(this.origin).normalize();
    rotateToward(this.dir, _want, 0.42 * dt);
    m.beamYaw = Math.atan2(this.dir.x, this.dir.z);
    const range = 280;
    this.end.copy(this.origin).addScaledVector(this.dir, range);
    const th = w.arena.raycast(this.origin, this.end, 0);
    this.length = th >= 0 ? range * th : range;
    this.end.copy(this.origin).addScaledVector(this.dir, this.length);

    this.tick -= dt;
    if (this.tick > 0) return;
    // the beam burns every enemy in its path (co-op: both players can be caught in one sweep)
    let hit = false;
    for (const e of w.mechs) {
      if (e.team === m.team || !e.alive || !e.hittable) continue;
      e.axis(_b, _c);
      const r = this.width * 0.55 + e.spec.radius * 0.8;
      if (segSegDist2(this.origin, this.end, _b, _c) >= r * r) continue;
      hit = true;
      const dir = new THREE.Vector3(this.dir.x, 0, this.dir.z).normalize();
      e.centerInto(_a);
      e.takeHit({ damage: this.dps * 0.1, knock: 'stagger', dir, source: m, pos: _a.clone() }, w);
      w.fx.spray(_a, _d.copy(this.dir).negate(), 6, 0xffe0a0, 30);
    }
    if (hit) this.tick = 0.1;
  }

  hush() {
    this.loop?.set({ volume: 0 });
  }

  /** Cosmetic side: geometry, flares, sparks, rumble and the looping roar. */
  render(w: World) {
    if (!this.active) return;
    if (!this.loop) this.loop = w.loopSound('laser');
    const fl = 0.85 + Math.random() * 0.3;
    const grow = Math.min(1, this.t / 0.12) * (this.t > this.duration - 0.2 ? Math.max(0, this.duration - this.t) / 0.2 : 1);
    const wdt = this.width * 0.85 * grow * fl;
    this.group.position.copy(this.origin);
    this.group.quaternion.setFromUnitVectors(UP, this.dir);
    this.body.scale.set(wdt * 0.75, this.length, wdt * 0.75);
    this.outer.scale.set(wdt * 1.35, this.length, wdt * 1.35);
    this.inner.scale.set(wdt * 0.38, this.length, wdt * 0.38);
    this.endFlare.position.copy(this.end);
    this.endFlare.scale.setScalar(this.width * 6 * fl * grow);
    this.startFlare.position.copy(this.origin);
    this.startFlare.scale.setScalar(this.width * 4.5 * fl * grow);
    if (Math.random() < 0.6) w.fx.spark(this.end, 2, this.owner.palette.beam, 24, 0.9, 0.3);
    if (Math.random() < 0.25) w.fx.smoke(this.end, 1, 2.5, 0x4a4040, 1.0);
    w.shake(0.05, this.origin);
    const s = w.soundParams(this.origin, 1);
    this.loop.set({ volume: s.volume, pan: s.pan });
  }

  dispose() {
    this.stop();
    this.scene.remove(this.group, this.endFlare, this.startFlare);
    this.outer.geometry.dispose();
    (this.body.material as THREE.Material).dispose();
    (this.outer.material as THREE.Material).dispose();
    (this.inner.material as THREE.Material).dispose();
    this.endFlare.material.dispose();
    this.startFlare.material.dispose();
  }
}

// ------------------------------------------------------------------ weapon behaviors

/** Direction from `from` toward the target (with partial lead), or straight ahead when not locked on. */
export function aimDir(m: Mech, from: THREE.Vector3, speed: number, lead: number, out: THREE.Vector3) {
  if (!m.lockedOn) {
    forwardOf(m.yaw, out);
    return out;
  }
  const t = m.target;
  t.centerInto(_c);
  const time = from.distanceTo(_c) / speed;
  _c.x += t.vel.x * time * lead;
  _c.z += t.vel.z * time * lead;
  _c.y += t.vel.y * time * lead * 0.4;
  out.subVectors(_c, from);
  // the target's center right at the muzzle (pressed up against it): straight ahead, never a dead stop
  return out.lengthSq() > 1e-6 ? out.normalize() : forwardOf(m.yaw, out);
}

/** Spread a direction sideways by `angle` radians around the vertical axis. */
function yawed(dir: THREE.Vector3, angle: number, out: THREE.Vector3) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return out.set(dir.x * c + dir.z * s, dir.y, -dir.x * s + dir.z * c);
}

function action(o: Partial<Action> & Pick<Action, 'kind' | 'slot' | 'variant' | 'pose' | 'duration' | 'events'>): Action {
  return {
    t: 0,
    moveMul: 0,
    turnMul: 1,
    hover: false,
    keepDash: false,
    cancelAfterEvents: true,
    ...o,
  };
}

const mz = new THREE.Vector3();
const dv = new THREE.Vector3();

function jebeRifle(variant: Variant): Action {
  const shoot = (spread: number, dmg: number, homing: number) => (m: Mech, w: World) => {
    if (m.action?.moving) homing *= 0.55;
    m.model.muzzleR.getWorldPosition(mz);
    aimDir(m, mz, 165, 0.45, dv);
    yawed(dv, spread, _dir);
    w.projectiles.spawn(m, {
      kind: 'bolt',
      pos: mz,
      vel: _dir.multiplyScalar(165),
      radius: 0.7,
      damage: dmg,
      knock: 'stagger',
      homing,
      homingDelay: 0.05,
      life: 1.8,
    });
    w.fx.flash(mz, m.palette.beam, 3.5, 0.08, true);
    m.pose.recoil = 1;
  };
  if (variant === 'dash') {
    return action({
      kind: 'fire',
      slot: 'rw',
      variant,
      pose: 'aimR',
      duration: 0.34,
      keepDash: true,
      turnMul: 1,
      events: [
        {
          t: 0.06,
          run: (m, w) => {
            for (const s of [-0.09, 0, 0.09]) shoot(s, 30, 0.4)(m, w);
            w.sound('rifleDash', mz);
          },
        },
      ],
    });
  }
  return action({
    kind: 'fire',
    slot: 'rw',
    variant,
    pose: 'aimR',
    duration: 0.32,
    moveMul: 0.92,
    hover: variant === 'air',
    events: [
      {
        t: 0.08,
        run: (m, w) => {
          shoot(0, 45, variant === 'air' ? 1.2 : 0.8)(m, w);
          w.sound('rifle', mz);
        },
      },
    ],
  });
}

function jebeBomb(variant: Variant): Action {
  return action({
    kind: 'fire',
    slot: 'lw',
    variant,
    pose: 'throwL',
    duration: 0.55,
    moveMul: 0.6,
    keepDash: variant === 'dash',
    hover: variant === 'air',
    events: [
      {
        t: 0.26,
        run: (m, w) => {
          m.model.muzzleL.getWorldPosition(mz);
          const g = 42;
          const tgt = m.target;
          tgt.centerInto(_c);
          _c.y = Math.max(0, tgt.pos.y);
          const dist = Math.hypot(_c.x - mz.x, _c.z - mz.z);
          const T = variant === 'air' ? clamp(dist / 60, 0.45, 0.9) : variant === 'dash' ? clamp(dist / 75, 0.5, 1.0) : clamp(dist / 50, 0.6, 1.35);
          if (m.lockedOn) {
            _c.x += tgt.vel.x * T * 0.5;
            _c.z += tgt.vel.z * T * 0.5;
          } else {
            forwardOf(m.yaw, _d);
            _c.copy(mz).addScaledVector(_d, 45);
            _c.y = 0;
          }
          dv.set((_c.x - mz.x) / T, (_c.y - mz.y) / T + 0.5 * g * T, (_c.z - mz.z) / T);
          w.projectiles.spawn(m, {
            kind: 'bomb',
            pos: mz,
            vel: dv,
            radius: 0.9,
            damage: 85,
            knock: 'down',
            gravity: g,
            splash: 7,
            life: 3,
            color: 0xff4a3a,
          });
          w.sound('bombThrow', mz);
        },
      },
    ],
  });
}

function jebeHyper(variant: Variant): Action {
  const chargeT = variant === 'dash' ? 0.26 : variant === 'air' ? 0.32 : 0.45;
  const speed = variant === 'dash' ? 110 : 88;
  return action({
    kind: 'fire',
    slot: 'cw',
    variant,
    pose: 'aimBoth',
    duration: chargeT + 0.5,
    moveMul: 0,
    slide: 3,
    turnMul: 0.7,
    hover: variant === 'air',
    cancelAfterEvents: false,
    charge: [0, chargeT],
    events: [
      { t: 0, run: (m, w) => w.sound('hyperCharge', m.pos) },
      {
        t: chargeT,
        run: (m, w) => {
          m.model.muzzleR.getWorldPosition(mz);
          aimDir(m, mz, speed, 0.35, dv);
          w.projectiles.spawn(m, {
            kind: 'hyper',
            pos: mz,
            vel: dv.multiplyScalar(speed),
            radius: variant === 'dash' ? 1.8 : 2.3,
            damage: variant === 'ground' ? 170 : 145,
            knock: 'down',
            homing: 0.55,
            homingDelay: 0.1,
            life: 3,
          });
          w.fx.flash(mz, m.palette.beam, 9, 0.2, true);
          w.sound('hyperShot', mz);
          w.shake(0.3, mz);
          m.pose.recoil = 1.6;
        },
      },
    ],
  });
}

function fujinCannon(variant: Variant): Action {
  const shots = variant === 'dash' ? [0.04, 0.12, 0.2, 0.28] : [0.1, 0.27];
  const dmg = variant === 'dash' ? 26 : 38;
  return action({
    kind: 'fire',
    slot: 'rw',
    variant,
    pose: 'cannon',
    duration: variant === 'dash' ? 0.42 : 0.5,
    moveMul: 0.8,
    keepDash: variant === 'dash',
    hover: variant === 'air',
    events: shots.map((t, i) => ({
      t,
      run: (m: Mech, w: World) => {
        const muzzle = m.model.cannons[i % 2];
        muzzle.getWorldPosition(mz);
        aimDir(m, mz, 125, 0.35, dv);
        w.projectiles.spawn(m, {
          kind: 'shell',
          pos: mz,
          vel: dv.multiplyScalar(125),
          radius: 1.0,
          damage: dmg,
          knock: 'stagger',
          homing: m.action?.moving ? 0.28 : 0.5,
          life: 2.2,
        });
        w.fx.flash(mz, m.palette.beam, 4.5, 0.1, true);
        w.fx.smoke(mz, 1, 1.4, 0x6a6460, 0.6);
        w.sound('cannon', mz);
        m.pose.recoil = 1;
      },
    })),
  });
}

function fujinMissiles(variant: Variant): Action {
  const count = variant === 'dash' ? 3 : 4;
  const events: ActionEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push({
      t: 0.1 + i * 0.07,
      run: (m, w) => {
        const pod = m.model.missilePods[i % 2];
        pod.getWorldPosition(mz);
        forwardOf(m.yaw, _d);
        const side = i % 2 === 0 ? 1 : -1;
        // pop upward and outward, then the seeker takes over
        dv.set(0, 24, 0)
          .addScaledVector(_d, 8)
          .add(_a.set(_d.z * side * 9 + rand(-2, 2), rand(-2, 2), -_d.x * side * 9));
        w.projectiles.spawn(m, {
          kind: 'missile',
          pos: mz,
          vel: dv,
          radius: 0.8,
          damage: 30,
          knock: 'stagger',
          homing: 2.4,
          homingDelay: 0.28,
          accel: 70,
          maxSpeed: 78,
          life: 3.2,
          color: 0xffb04a,
        });
        w.fx.flash(mz, 0xffd080, 2.5, 0.08);
        w.sound('missileLaunch', mz, 0.7);
      },
    });
  }
  return action({
    kind: 'fire',
    slot: 'lw',
    variant,
    pose: 'missile',
    duration: 0.62,
    moveMul: 0.55,
    keepDash: variant === 'dash',
    hover: variant === 'air',
    events,
  });
}

function fujinLaser(variant: Variant): Action {
  const air = variant === 'air';
  const chargeT = air ? 0.6 : 0.85;
  const beamT = air ? 1.0 : 1.4;
  return action({
    kind: 'fire',
    slot: 'cw',
    variant: air ? 'air' : 'ground',
    pose: 'beam',
    duration: chargeT + beamT + 0.4,
    moveMul: 0,
    slide: 2.2,
    turnMul: 0.6,
    hover: air,
    cancelAfterEvents: false,
    charge: [0, chargeT],
    events: [
      { t: 0, run: (m, w) => w.sound('laserCharge', m.pos) },
      {
        t: chargeT,
        run: (m, w) => {
          w.projectiles.startBeam(m, beamT, 2.4, 260);
          w.sound('hyperShot', m.pos, 0.8);
          w.shake(0.4, m.pos);
        },
      },
    ],
  });
}

// ------------------------------------------------------------------ KESTREL

/** NEEDLE LASER: a quick three-needle burst (two side by side out of a boost). */
function kestrelNeedles(variant: Variant): Action {
  const needle = (spread: number, dmg: number, knock: Knock, homing: number) => (m: Mech, w: World) => {
    if (m.action?.moving) homing *= 0.6;
    m.model.muzzleR.getWorldPosition(mz);
    aimDir(m, mz, 205, 0.5, dv);
    yawed(dv, spread, _dir);
    w.projectiles.spawn(m, { kind: 'bolt', pos: mz, vel: _dir.multiplyScalar(205), radius: 0.5, damage: dmg, knock, homing, homingDelay: 0.04, life: 1.5 });
    w.fx.flash(mz, m.palette.beam, 2.4, 0.06, true);
    w.sound('rifle', mz, 0.7, 1.45);
    m.pose.recoil = 0.6;
  };
  if (variant === 'dash') {
    return action({
      kind: 'fire',
      slot: 'rw',
      variant,
      pose: 'aimR',
      duration: 0.3,
      keepDash: true,
      turnMul: 1,
      events: [
        {
          t: 0.05,
          run: (m, w) => {
            needle(-0.05, 18, 'stagger', 0.5)(m, w);
            needle(0.05, 18, 'stagger', 0.5)(m, w);
          },
        },
      ],
    });
  }
  const homing = variant === 'air' ? 1.1 : 0.7;
  return action({
    kind: 'fire',
    slot: 'rw',
    variant,
    pose: 'aimR',
    duration: 0.36,
    moveMul: 0.95,
    hover: variant === 'air',
    // only the last needle of the burst staggers
    events: [0.05, 0.11, 0.17].map((t, i) => ({ t, run: needle(0, 15, i === 2 ? 'stagger' : 'none', homing) })),
  });
}

/** SWARM DARTS: six micro-missiles fanning out of the wing pods, quick to turn. */
function kestrelDarts(variant: Variant): Action {
  const events: ActionEvent[] = [];
  for (let i = 0; i < 6; i++) {
    events.push({
      t: 0.08 + i * 0.035,
      run: (m, w) => {
        m.model.missilePods[i % 2].getWorldPosition(mz);
        forwardOf(m.yaw, _d);
        const side = i % 2 === 0 ? 1 : -1;
        // each pair flares out wider than the last
        const fan = 6 + (i >> 1) * 4;
        dv.set(0, 10 + (i >> 1) * 3, 0)
          .addScaledVector(_d, 18)
          .add(_a.set(_d.z * side * fan, 0, -_d.x * side * fan));
        w.projectiles.spawn(m, {
          kind: 'missile',
          pos: mz,
          vel: dv,
          radius: 0.6,
          damage: 12,
          knock: 'stagger',
          homing: 3.4,
          homingDelay: 0.16,
          accel: 100,
          maxSpeed: 100,
          life: 2.0,
          color: m.palette.flame,
        });
        w.sound('missileLaunch', mz, 0.45, 1.5);
      },
    });
  }
  return action({ kind: 'fire', slot: 'lw', variant, pose: 'missile', duration: 0.5, moveMul: 0.7, keepDash: variant === 'dash', hover: variant === 'air', events });
}

/** RAIL LANCE: a short charge, then a near-instant straight shot that knocks down. */
function kestrelLance(variant: Variant): Action {
  const chargeT = variant === 'dash' ? 0.26 : variant === 'air' ? 0.3 : 0.38;
  const speed = 240;
  return action({
    kind: 'fire',
    slot: 'cw',
    variant,
    pose: 'aimBoth',
    duration: chargeT + 0.42,
    moveMul: 0,
    slide: 3,
    turnMul: 0.8,
    hover: variant === 'air',
    cancelAfterEvents: false,
    charge: [0, chargeT],
    events: [
      { t: 0, run: (m, w) => w.sound('hyperCharge', m.pos, 0.8, 1.3) },
      {
        t: chargeT,
        run: (m, w) => {
          m.model.muzzleR.getWorldPosition(mz);
          aimDir(m, mz, speed, 0.6, dv);
          w.projectiles.spawn(m, {
            kind: 'hyper',
            pos: mz,
            vel: dv.multiplyScalar(speed),
            radius: 1.2,
            damage: variant === 'ground' ? 110 : 95,
            knock: 'down',
            homing: 0.12,
            homingDelay: 0.05,
            life: 1.4,
          });
          w.fx.flash(mz, m.palette.beam, 7, 0.16, true);
          w.sound('hyperShot', mz, 0.9, 1.5);
          w.shake(0.25, mz);
          m.pose.recoil = 1.4;
        },
      },
    ],
  });
}

// ------------------------------------------------------------------ KONGO

/** SCATTER GUN: seven pellets in a wide cone that fade out past mid range. */
function kongoScatter(variant: Variant): Action {
  return action({
    kind: 'fire',
    slot: 'rw',
    variant,
    pose: 'aimR',
    duration: 0.5,
    moveMul: 0.85,
    hover: variant === 'air',
    events: [
      {
        t: 0.1,
        run: (m, w) => {
          m.model.muzzleR.getWorldPosition(mz);
          aimDir(m, mz, 150, 0.2, dv);
          for (let i = -3; i <= 3; i++) {
            yawed(dv, i * 0.07 + rand(-0.015, 0.015), _dir);
            _dir.y += rand(-0.04, 0.04);
            w.projectiles.spawn(m, { kind: 'shell', pos: mz, vel: _dir.normalize().multiplyScalar(150), radius: 0.55, damage: 16, knock: 'stagger', life: 0.4 });
          }
          w.fx.flash(mz, m.palette.beam, 6, 0.1, true);
          w.fx.smoke(mz, 2, 1.6, 0x6a6460, 0.5);
          w.sound('cannon', mz, 1, 1.3);
          w.shake(0.12, mz);
          m.pose.recoil = 1.2;
        },
      },
    ],
  });
}

/** SHOULDER RAM (the scatter gun's boost variant): a long armored charge that knocks down. */
function kongoRam(): Action {
  return action({
    kind: 'melee',
    slot: 'rw',
    variant: 'dash',
    pose: 'ram',
    duration: 0.62,
    moveMul: 0,
    turnMul: 0,
    cancelAfterEvents: false,
    lunge: { until: 0.48, speed: 70 },
    hitWindow: [0.06, 0.5],
    hitDamage: 105,
    armor: true,
    events: [{ t: 0, run: (m, w) => w.sound('dash', m.pos, 1, 0.8) }],
  });
}

/** ROCKET FIST: the left fist flies off, homing, and floors whatever it reaches. */
function kongoFist(variant: Variant): Action {
  return action({
    kind: 'fire',
    slot: 'lw',
    variant,
    pose: 'punchL',
    duration: 0.62,
    moveMul: 0.5,
    keepDash: variant === 'dash',
    hover: variant === 'air',
    events: [
      {
        t: 0.2,
        run: (m, w) => {
          m.model.muzzleL.getWorldPosition(mz);
          aimDir(m, mz, 90, 0.4, dv);
          w.projectiles.spawn(m, {
            kind: 'fist',
            pos: mz,
            vel: dv.multiplyScalar(60),
            radius: 1.4,
            damage: 80,
            knock: 'down',
            homing: 2.1,
            homingDelay: 0.12,
            accel: 120,
            maxSpeed: 115,
            life: 2.4,
            color: m.palette.accent,
          });
          w.fx.flash(mz, 0xffd080, 4, 0.1, true);
          w.sound('missileLaunch', mz, 1, 0.7);
          m.pose.recoil = 1;
        },
      },
    ],
  });
}

/**
 * QUAKE SLAM: on the ground, both fists overhead and hammered down — a shockwave along the floor. In the
 * air, a committed straight-down dive (no thrusters, no hover) that lands the blow when it touches down;
 * if it hasn't landed by the end, it fizzles.
 */
function kongoSlam(variant: Variant): Action {
  if (variant === 'air') {
    return action({
      kind: 'fire',
      slot: 'cw',
      variant,
      pose: 'slam',
      duration: 1.3,
      moveMul: 0,
      turnMul: 0.3,
      cancelAfterEvents: false,
      charge: [0, 0.3],
      dive: true,
      armor: true,
      onLand: quake,
      events: [
        {
          t: 0.12,
          run: (m, w) => {
            m.vel.set(0, Math.min(m.vel.y, -62), 0);
            w.sound('airDash', m.pos, 1, 0.7);
          },
        },
      ],
    });
  }
  return action({
    kind: 'fire',
    slot: 'cw',
    variant,
    pose: 'slam',
    duration: 1.0,
    moveMul: 0,
    slide: 2.5,
    turnMul: 0.3,
    cancelAfterEvents: false,
    charge: [0, 0.42],
    armor: true,
    events: [
      {
        t: 0.48,
        run: (m, w) => {
          // slid off a ledge mid-slam: come straight down and land the blow, like the air slam
          if (m.pos.y > m.groundY + 0.5 && m.action) {
            m.action.dive = true;
            m.action.onLand = quake;
            m.vel.set(0, Math.min(m.vel.y, -62), 0);
          } else quake(m, w);
        },
      },
    ],
  });
}

const QUAKE_RADIUS = 18;

/** The slam's shockwave: hits everything on the ground nearby, hardest at the center. */
function quake(m: Mech, w: World) {
  for (const e of w.mechs) {
    if (e.team === m.team || !e.alive || !e.hittable) continue;
    const d = hdist(m.pos, e.pos);
    // it runs along the ground: jump and it passes under you
    if (d > QUAKE_RADIUS + e.spec.radius || Math.abs(e.pos.y - m.pos.y) > 7) continue;
    // and a wall in between stops it
    _a.set(m.pos.x, m.pos.y + 1, m.pos.z);
    _b.set(e.pos.x, e.pos.y + 1, e.pos.z);
    if (!w.arena.lineOfSight(_a, _b)) continue;
    const dir = new THREE.Vector3(e.pos.x - m.pos.x, 0, e.pos.z - m.pos.z);
    if (dir.lengthSq() < 1e-4) forwardOf(m.yaw, dir);
    dir.normalize();
    const f = 1 - 0.45 * clamp(d / QUAKE_RADIUS, 0, 1);
    e.takeHit({ damage: 150 * f, knock: 'down', dir, source: m, pos: e.centerInto(new THREE.Vector3()), heavy: true }, w);
  }
  _c.set(m.pos.x, m.pos.y + 0.3, m.pos.z);
  w.fx.ring(_c, QUAKE_RADIUS / 2.2, m.palette.beam, 0.6);
  w.fx.ring(_c, QUAKE_RADIUS / 3.5, 0xffd080, 0.4);
  w.fx.explosion(_c, 3.2, 0xffa040);
  w.fx.dust(m.pos, 26, w.dustColor, 6, 3.4);
  w.sound('explosionBig', m.pos, 1, 0.7);
  w.shake(1.1, m.pos);
  w.hitStop(0.06);
}

// ------------------------------------------------------------------ ARACHNE

/** HUNTER DRONES: slow orbs that keep circling back at the target until they burn out. */
function arachneDrones(variant: Variant): Action {
  const count = variant === 'dash' ? 1 : 2;
  const events: ActionEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push({
      t: 0.12 + i * 0.1,
      run: (m, w) => {
        m.model.missilePods[i % 2].getWorldPosition(mz);
        forwardOf(m.yaw, _d);
        const side = i % 2 === 0 ? 1 : -1;
        dv.set(0, 12, 0)
          .addScaledVector(_d, 10)
          .add(_a.set(_d.z * side * 10, 0, -_d.x * side * 10));
        w.projectiles.spawn(m, {
          kind: 'orb',
          pos: mz,
          vel: dv,
          radius: 0.9,
          damage: 34,
          knock: 'stagger',
          homing: 2.1,
          homingDelay: 0.35,
          accel: 45,
          maxSpeed: 50,
          life: 4.5,
          chase: true,
          cap: 6,
        });
        w.fx.flash(mz, m.palette.beam, 2.5, 0.08);
        w.sound('missileLaunch', mz, 0.5, 1.7);
      },
    });
  }
  return action({ kind: 'fire', slot: 'rw', variant, pose: 'missile', duration: 0.5, moveMul: 0.75, keepDash: variant === 'dash', hover: variant === 'air', events });
}

/** WEB MINES: three mines lobbed across the target's path; they dig in and wait. */
function arachneMines(variant: Variant): Action {
  return action({
    kind: 'fire',
    slot: 'lw',
    variant,
    pose: 'throwL',
    duration: 0.6,
    moveMul: 0.6,
    keepDash: variant === 'dash',
    hover: variant === 'air',
    events: [
      {
        t: 0.26,
        run: (m, w) => {
          m.model.muzzleL.getWorldPosition(mz);
          const g = 42;
          const tgt = m.target;
          // someone already close: ring yourself with the mines instead, so a rusher runs into them
          const close = tgt.alive && hdist(m.pos, tgt.pos) < 22;
          if (close) _c.set(m.pos.x, m.groundY, m.pos.z);
          else if (m.lockedOn) _c.set(tgt.pos.x, Math.max(0, tgt.pos.y), tgt.pos.z);
          else {
            forwardOf(m.yaw, _d);
            _c.copy(mz).addScaledVector(_d, 40);
            _c.y = 0;
          }
          const dist = Math.hypot(_c.x - mz.x, _c.z - mz.z);
          const T = close ? 0.5 : clamp(dist / 55, 0.6, 1.4);
          if (m.lockedOn && !close) {
            _c.x += tgt.vel.x * T * 0.8;
            _c.z += tgt.vel.z * T * 0.8;
          }
          // spread across the line of the throw, or around you at close quarters
          _d.set(_c.z - mz.z, 0, mz.x - _c.x).normalize();
          for (let k = 0; k < 3; k++) {
            if (close) {
              // one toward the threat, one to each side of it
              const ang = Math.atan2(tgt.pos.x - m.pos.x, tgt.pos.z - m.pos.z) + (k - 1) * 1.6;
              _e.set(_c.x + Math.sin(ang) * 7.5, _c.y, _c.z + Math.cos(ang) * 7.5);
            } else _e.copy(_c).addScaledVector(_d, (k - 1) * 9);
            dv.set((_e.x - mz.x) / T, (_e.y - mz.y) / T + 0.5 * g * T, (_e.z - mz.z) / T);
            w.projectiles.spawn(m, {
              kind: 'mine',
              pos: mz,
              vel: dv,
              radius: 0.9,
              damage: 80,
              knock: 'down',
              gravity: g,
              splash: 7.5,
              life: 10,
              stick: true,
              trigger: 6.5,
              arm: 0.35,
              cap: 6,
            });
          }
          w.sound('bombThrow', mz, 1, 1.15);
        },
      },
    ],
  });
}

/** SNARE NET: a slow homing net that pins whatever it catches for a moment (a frontal guard blocks it). */
function arachneNet(variant: Variant): Action {
  const chargeT = variant === 'ground' ? 0.3 : 0.24;
  return action({
    kind: 'fire',
    slot: 'cw',
    variant,
    pose: 'aimBoth',
    duration: chargeT + 0.45,
    moveMul: 0,
    slide: 3,
    turnMul: 0.8,
    hover: variant === 'air',
    cancelAfterEvents: false,
    charge: [0, chargeT],
    events: [
      { t: 0, run: (m, w) => w.sound('laserCharge', m.pos, 0.6, 1.6) },
      {
        t: chargeT,
        run: (m, w) => {
          m.model.muzzleR.getWorldPosition(mz);
          aimDir(m, mz, 95, 0.5, dv);
          w.projectiles.spawn(m, {
            kind: 'net',
            pos: mz,
            vel: dv.multiplyScalar(95),
            radius: 2.6,
            damage: 50,
            knock: 'none',
            snare: 2.4,
            homing: 1.6,
            homingDelay: 0.05,
            life: 2.4,
          });
          w.fx.flash(mz, m.palette.beam, 6, 0.14, true);
          w.sound('hyperShot', mz, 0.7, 1.35);
          m.pose.recoil = 1;
        },
      },
    ],
  });
}

// ------------------------------------------------------------------ dispatch

type Arsenal = Record<Slot, (variant: Variant, m: Mech) => Action>;

const ARSENAL: Record<MechId, Arsenal> = {
  jebe: { rw: jebeRifle, lw: jebeBomb, cw: jebeHyper },
  fujin: { rw: fujinCannon, lw: fujinMissiles, cw: fujinLaser },
  kestrel: { rw: kestrelNeedles, lw: kestrelDarts, cw: kestrelLance },
  // the ram charges a locked-on target, like any melee; boosting with nobody ahead fires the scatter gun
  kongo: { rw: (v, m) => (v === 'dash' && m.lockedOn ? kongoRam() : kongoScatter(v)), lw: kongoFist, cw: kongoSlam },
  arachne: { rw: arachneDrones, lw: arachneMines, cw: arachneNet },
};

export function makeFireAction(m: Mech, slot: Slot, variant: Variant): Action {
  return ARSENAL[m.spec.id][slot](variant, m);
}

export function makeMeleeAction(m: Mech, slot: Slot): Action {
  const d = m.spec.melee;
  return action({
    kind: 'melee',
    slot,
    variant: 'ground',
    pose: 'melee',
    duration: d.duration,
    moveMul: 0,
    turnMul: 0,
    cancelAfterEvents: false,
    lunge: d.lunge,
    hitWindow: d.hit,
    armor: d.armor,
    events: [{ t: d.swing, run: (mm, w) => w.sound('swing', mm.pos, 1, d.pitch ?? 1) }],
  });
}
