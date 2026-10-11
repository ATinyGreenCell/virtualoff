import * as THREE from 'three';
import { clamp, damp, dampAngle, rand, smoothstep } from '../core/math';
import { reducedMotion } from '../core/settings';
import type { Mech } from './mech';

const _bp = new THREE.Vector3();
const _bl = new THREE.Vector3();

/** Chase framing, relative to the mech: distance behind, height above, look-ahead and look height. */
interface Framing {
  dist: number;
  height: number;
  ahead: number;
  lookY: number;
  /** how far the view tilts toward an opponent above or below you, and the most it will */
  tilt: number;
  tiltMax: number;
  /** orbit shots (intro, KO, winner) pull back by this much */
  orbitMul: number;
}

const FULL: Framing = { dist: 15.5, height: 9.4, ahead: 26, lookY: 2.4, tilt: 0.45, tiltMax: 12, orbitMul: 1 };
/** split screen: a wide, short view — sit further back and look down more, so the whole mech fits
 *  above the gauges with the opponent still in sight over its head */
const SPLIT: Framing = { dist: 26, height: 10.5, ahead: 26, lookY: -0.2, tilt: 0.36, tiltMax: 11, orbitMul: 1.6 };

/** Vertical field of view that gives a view this wide the horizontal coverage `hDeg` (within limits). */
function fovFor(aspect: number, hDeg: number, max: number) {
  const half = THREE.MathUtils.degToRad(hDeg) / 2;
  return clamp(THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(half) / aspect)), 30, max);
}

/** Virtual-On style chase camera: locked behind the mech, tilting toward an airborne opponent. */
export class ChaseCamera {
  readonly cam: THREE.PerspectiveCamera;
  private yaw = 0;
  private fy = 0;
  private fov = 62;
  /** resting field of view for chasing and for orbit shots */
  private chaseFov = 62;
  private orbitFov = 55;
  private readonly frame: Framing;
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private blendT = 1;
  private blendDur = 1;
  private readonly fromPos = new THREE.Vector3();
  private readonly fromLook = new THREE.Vector3();

  /** `split`: one of two views stacked on one screen (each much wider than tall). */
  constructor(aspect: number, split = false) {
    this.frame = split ? SPLIT : FULL;
    this.cam = new THREE.PerspectiveCamera(62, aspect, 0.3, 2400);
    this.setAspect(aspect);
    this.fov = this.chaseFov;
  }

  setAspect(aspect: number) {
    if (this.frame === SPLIT) {
      // keep roughly a full screen's sideways view rather than a ~130° fisheye strip
      this.chaseFov = fovFor(aspect, 100, 62);
      this.orbitFov = fovFor(aspect, 96, 55);
    }
    this.cam.aspect = aspect;
    this.cam.updateProjectionMatrix();
  }

  snap(m: Mech) {
    this.yaw = m.yaw;
    this.fy = m.pos.y;
    this.blendT = 1;
  }

  /** Smoothly hand over from wherever the camera currently is. */
  blendFromCurrent(dur: number) {
    this.fromPos.copy(this.cam.position);
    this.cam.getWorldDirection(this.fromLook).multiplyScalar(20).add(this.cam.position);
    this.blendT = 0;
    this.blendDur = dur;
  }

  /**
   * High behind-the-back framing: your VR fills the lower half of the screen and the
   * opponent stays visible above its head. Blocks in the way fade out instead of
   * pushing the camera in (see Arena.updateOcclusion).
   */
  chase(dt: number, m: Mech, t: Mech, shake: number) {
    const f = this.frame;
    this.yaw = dampAngle(this.yaw, m.yaw, 18, dt);
    this.fy = damp(this.fy, m.pos.y, m.pos.y > this.fy ? 5 : 9, dt);
    const sx = Math.sin(this.yaw);
    const sz = Math.cos(this.yaw);
    this.pos.set(m.pos.x - sx * f.dist, this.fy + f.height, m.pos.z - sz * f.dist);
    const dy = clamp((t.pos.y - this.fy) * f.tilt, -4, f.tiltMax);
    this.look.set(m.pos.x + sx * f.ahead, this.fy + f.lookY + dy, m.pos.z + sz * f.ahead);
    // the faster you're actually moving, the wider the lens: bursts and boost-jumps feel fast
    const hs = Math.hypot(m.vel.x, m.vel.z);
    const speed = clamp((hs - m.spec.walkSpeed) / (m.spec.qbSpeed - m.spec.walkSpeed), 0, 1);
    const base = this.chaseFov;
    this.fov = damp(this.fov, reducedMotion ? base : base * (1 + (10 / 62) * speed), 6, dt);
    this.apply(dt, shake);
  }

  orbit(dt: number, center: THREE.Vector3, radius: number, height: number, angle: number, lookY: number, shake = 0) {
    const k = this.frame.orbitMul;
    this.pos.set(center.x + Math.sin(angle) * radius * k, center.y + height * k, center.z + Math.cos(angle) * radius * k);
    this.look.set(center.x, center.y + lookY, center.z);
    this.fov = damp(this.fov, this.orbitFov, 4, dt);
    this.apply(dt, shake);
  }

  private apply(dt: number, shake: number) {
    let p: THREE.Vector3 = this.pos;
    let l: THREE.Vector3 = this.look;
    if (this.blendT < 1) {
      this.blendT = Math.min(1, this.blendT + dt / this.blendDur);
      const k = smoothstep(0, 1, this.blendT);
      p = _bp.lerpVectors(this.fromPos, this.pos, k);
      l = _bl.lerpVectors(this.fromLook, this.look, k);
    }
    this.cam.position.copy(p);
    if (shake > 0.001) {
      const s = shake * 0.55;
      this.cam.position.x += rand(-s, s);
      this.cam.position.y += rand(-s, s);
      this.cam.position.z += rand(-s, s);
    }
    if (Math.abs(this.cam.fov - this.fov) > 0.01) {
      this.cam.fov = this.fov;
      this.cam.updateProjectionMatrix();
    }
    this.cam.lookAt(l);
    this.cam.updateMatrixWorld();
  }
}
