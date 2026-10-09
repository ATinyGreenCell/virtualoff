import * as THREE from 'three';
import { clamp, damp, dampAngle, rand, smoothstep } from '../core/math';
import type { Mech } from './mech';

const _bp = new THREE.Vector3();
const _bl = new THREE.Vector3();

/** Virtual-On style chase camera: locked behind the mech, tilting toward an airborne opponent. */
export class ChaseCamera {
  readonly cam: THREE.PerspectiveCamera;
  private yaw = 0;
  private fy = 0;
  private fov = 62;
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private blendT = 1;
  private blendDur = 1;
  private readonly fromPos = new THREE.Vector3();
  private readonly fromLook = new THREE.Vector3();

  constructor(aspect: number) {
    this.cam = new THREE.PerspectiveCamera(62, aspect, 0.3, 2400);
  }

  setAspect(aspect: number) {
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
    this.yaw = dampAngle(this.yaw, m.yaw, 18, dt);
    this.fy = damp(this.fy, m.pos.y, m.pos.y > this.fy ? 5 : 9, dt);
    const dist = 15.5;
    const height = 9.4;
    const sx = Math.sin(this.yaw);
    const sz = Math.cos(this.yaw);
    this.pos.set(m.pos.x - sx * dist, this.fy + height, m.pos.z - sz * dist);
    const dy = clamp((t.pos.y - this.fy) * 0.45, -4, 12);
    this.look.set(m.pos.x + sx * 26, this.fy + 2.4 + dy, m.pos.z + sz * 26);
    const dashing = m.state === 'dash' || m.state === 'airdash';
    this.fov = damp(this.fov, dashing ? 69 : 62, 5, dt);
    this.apply(dt, shake);
  }

  orbit(dt: number, center: THREE.Vector3, radius: number, height: number, angle: number, lookY: number, shake = 0) {
    this.pos.set(center.x + Math.sin(angle) * radius, center.y + height, center.z + Math.cos(angle) * radius);
    this.look.set(center.x, center.y + lookY, center.z);
    this.fov = damp(this.fov, 55, 4, dt);
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
