import * as THREE from 'three';
import { audio, type LoopHandle, type LoopName, type SfxName } from '../audio/audio';
import type { ControlFrame } from '../core/input';
import { clamp } from '../core/math';
import { reducedMotion } from '../core/settings';
import type { NetEvent } from '../net/protocol';
import { Arena } from './arena';
import { Effects } from './effects';
import type { Mech } from './mech';
import type { StageId } from './specs';
import { Projectiles } from './weapons';

const _v = new THREE.Vector3();
const _e = new THREE.Vector3();
const r2 = (v: number) => Math.round(v * 100) / 100;

/** One battle's simulation: arena, mechs, projectiles and effects. */
export class World {
  readonly scene = new THREE.Scene();
  readonly arena: Arena;
  readonly fx: Effects;
  readonly projectiles: Projectiles;
  readonly mechs: Mech[] = [];
  readonly dustColor: number;
  /** every camera the world is watched through — split screen has one per view; [0] is the main one */
  cameras: THREE.PerspectiveCamera[];
  /** screen shake per camera */
  readonly shakes = [0, 0];
  time = 0;
  hitStopT = 0;
  viewportHeight = 400;
  onDamageCb: ((m: Mech, dmg: number) => void) | null = null;
  /** versus host: sounds, shakes, hits and effects are mirrored here for the guest */
  private sink: ((e: NetEvent) => void) | null = null;
  /** >0 while running purely cosmetic code that the guest reproduces on its own */
  private quiet = 0;

  constructor(
    stage: StageId,
    readonly camera: THREE.PerspectiveCamera,
  ) {
    this.cameras = [camera];
    this.arena = new Arena(this.scene, stage);
    this.fx = new Effects(this.scene);
    this.projectiles = new Projectiles(this.scene);
    this.dustColor = stage === 'harbor' ? 0xdfe4ec : 0xc49a8a;
  }

  /** Screen shake of the main camera. */
  get shakeAmt() {
    return this.shakes[0];
  }

  /** Add a mech. Mechs on the same team can't hurt each other (one team each unless told otherwise). */
  add(m: Mech, team = this.mechs.length) {
    m.team = team;
    this.mechs.push(m);
    this.scene.add(m.model.root);
  }

  /** Split screen: set up the sky, block fades and particle sizes for view `i` before it's drawn. */
  prepareView(i: number, viewportHeight: number) {
    const cam = this.cameras[i];
    this.arena.setSkyCenter(cam.position);
    this.arena.applyFades(i);
    this.fx.setView(cam, viewportHeight);
  }

  /** Versus host: start (or stop, with null) mirroring every gameplay event. */
  recordTo(sink: ((e: NetEvent) => void) | null) {
    this.sink = sink;
    this.fx.tap = sink
      ? (e) => {
          if (this.quiet === 0) sink(e);
        }
      : null;
  }

  /** Run cosmetic-only code: the guest generates these effects itself, so they are not mirrored. */
  visual(fn: () => void) {
    this.quiet++;
    try {
      fn();
    } finally {
      this.quiet--;
    }
  }

  private emit(e: NetEvent) {
    if (this.sink && this.quiet === 0) this.sink(e);
  }

  update(dt: number, controls: ControlFrame[]) {
    this.time += dt;
    for (let i = 0; i < this.mechs.length; i++) this.mechs[i].update(dt, controls[i], this);
    this.separate();
    this.projectiles.update(dt, this);
    this.tick(dt);
  }

  /** Versus guest: no simulation — mechs, projectiles and beams follow the host's snapshots. */
  updatePuppet(dt: number) {
    this.time += dt;
    for (const m of this.mechs) m.puppet(dt, this);
    this.projectiles.updateVisuals(dt, this);
    this.tick(dt);
  }

  private tick(dt: number) {
    this.fx.update(dt, this.camera, this.viewportHeight);
    this.arena.update(this.time, this.camera.position);
    for (let i = 0; i < this.shakes.length; i++) this.shakes[i] = Math.max(0, this.shakes[i] - dt * 2.8);
  }

  /** Versus guest: play back something the host recorded. */
  replay(e: NetEvent) {
    switch (e[0]) {
      case 's':
        this.sound(e[1] as SfxName, _e.set(e[2] as number, e[3] as number, e[4] as number), e[5] as number);
        break;
      case 'k':
        this.shake(e[1] as number, e.length > 2 ? _e.set(e[2] as number, e[3] as number, e[4] as number) : undefined);
        break;
      case 'd': {
        const m = this.mechs[e[1] as number];
        if (m) {
          m.model.hitFlash(e[3] === 1 ? 0.4 : 1);
          this.onDamageCb?.(m, e[2] as number);
        }
        break;
      }
      default:
        this.fx.replay(e);
    }
  }

  /** Keep mechs from overlapping. */
  private separate() {
    const ms = this.mechs;
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        const a = ms[i];
        const b = ms[j];
        if (a.state === 'dead' || b.state === 'dead') continue;
        if (a.pos.y > b.pos.y + b.spec.height || b.pos.y > a.pos.y + a.spec.height) continue;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d = Math.hypot(dx, dz);
        const min = a.spec.radius + b.spec.radius;
        if (d >= min || d < 1e-4) continue;
        const push = (min - d) / 2;
        a.pos.x -= (dx / d) * push;
        a.pos.z -= (dz / d) * push;
        b.pos.x += (dx / d) * push;
        b.pos.z += (dz / d) * push;
      }
    }
  }

  soundParams(pos: THREE.Vector3, vol = 1) {
    // split screen: heard from whichever camera is closest, panned less (two players share the speakers)
    let cam = this.cameras[0];
    let d = cam.position.distanceTo(pos);
    for (let i = 1; i < this.cameras.length; i++) {
      const di = this.cameras[i].position.distanceTo(pos);
      if (di < d) {
        d = di;
        cam = this.cameras[i];
      }
    }
    const volume = vol * clamp(1.15 - d / 260, 0.12, 1);
    _v.copy(pos).applyMatrix4(cam.matrixWorldInverse);
    const pan = clamp(_v.x / Math.max(10, Math.abs(_v.z)), -1, 1) * (this.cameras.length > 1 ? 0.4 : 0.75);
    return { volume, pan };
  }

  sound(name: SfxName, pos: THREE.Vector3, vol = 1) {
    this.emit(['s', name, r2(pos.x), r2(pos.y), r2(pos.z), r2(vol)]);
    const s = this.soundParams(pos, vol);
    audio.play(name, { volume: s.volume, pan: s.pan });
  }

  loopSound(name: LoopName): LoopHandle {
    return audio.loop(name);
  }

  shake(amount: number, pos?: THREE.Vector3) {
    this.emit(pos ? ['k', r2(amount), r2(pos.x), r2(pos.y), r2(pos.z)] : ['k', r2(amount)]);
    if (reducedMotion) amount *= 0.35;
    for (let i = 0; i < this.cameras.length; i++) {
      const d = pos ? this.cameras[i].position.distanceTo(pos) : 0;
      const k = clamp(1.25 - d / 110, 0.15, 1);
      this.shakes[i] = Math.min(1.6, this.shakes[i] + amount * k);
    }
  }

  hitStop(t: number) {
    this.hitStopT = Math.max(this.hitStopT, t);
  }

  onDamage(m: Mech, dmg: number, guarded = false) {
    this.emit(['d', this.mechs.indexOf(m), Math.round(dmg), guarded ? 1 : 0]);
    this.onDamageCb?.(m, dmg);
  }

  dispose() {
    this.recordTo(null);
    this.projectiles.dispose();
    this.fx.dispose();
    this.arena.dispose();
    for (const m of this.mechs) {
      this.scene.remove(m.model.root);
      m.model.dispose();
    }
    this.mechs.length = 0;
  }
}
