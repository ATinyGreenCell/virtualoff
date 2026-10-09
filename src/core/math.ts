import * as THREE from 'three';

export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const saturate = (v: number) => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
export const randSign = () => (Math.random() < 0.5 ? -1 : 1);
export const chance = (perSecond: number, dt: number) => Math.random() < perSecond * dt;

export function smoothstep(e0: number, e1: number, x: number) {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent smoothing factor for exponential decay toward a target. */
export const dampFactor = (lambda: number, dt: number) => 1 - Math.exp(-lambda * dt);
export const damp = (a: number, b: number, lambda: number, dt: number) => lerp(a, b, dampFactor(lambda, dt));

export function approach(v: number, target: number, maxDelta: number) {
  if (v < target) return Math.min(v + maxDelta, target);
  return Math.max(v - maxDelta, target);
}

/** Wrap to (-PI, PI]. */
export function wrapAngle(a: number) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

export function approachAngle(a: number, b: number, maxDelta: number) {
  const d = wrapAngle(b - a);
  if (Math.abs(d) <= maxDelta) return a + d;
  return a + Math.sign(d) * maxDelta;
}

export const dampAngle = (a: number, b: number, lambda: number, dt: number) =>
  a + wrapAngle(b - a) * dampFactor(lambda, dt);

/** Yaw convention: yaw 0 faces +Z, forward = (sin yaw, 0, cos yaw), right = (-cos yaw, 0, sin yaw). */
export const yawBetween = (from: THREE.Vector3, to: THREE.Vector3) => Math.atan2(to.x - from.x, to.z - from.z);

export function forwardOf(yaw: number, out: THREE.Vector3) {
  return out.set(Math.sin(yaw), 0, Math.cos(yaw));
}

export function rightOf(yaw: number, out: THREE.Vector3) {
  return out.set(-Math.cos(yaw), 0, Math.sin(yaw));
}

export const hdist = (a: THREE.Vector3, b: THREE.Vector3) => Math.hypot(b.x - a.x, b.z - a.z);

const _d1 = new THREE.Vector3();
const _d2 = new THREE.Vector3();
const _r = new THREE.Vector3();
const _c1 = new THREE.Vector3();
const _c2 = new THREE.Vector3();

/** Squared distance between segments p1-q1 and p2-q2 (Ericson, Real-Time Collision Detection 5.1.9). */
export function segSegDist2(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3) {
  const d1 = _d1.subVectors(q1, p1);
  const d2 = _d2.subVectors(q2, p2);
  const r = _r.subVectors(p1, p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  const EPS = 1e-9;
  let s: number;
  let t: number;
  if (a <= EPS && e <= EPS) return r.dot(r);
  if (a <= EPS) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = d1.dot(r);
    if (e <= EPS) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }
  _c1.copy(p1).addScaledVector(d1, s);
  _c2.copy(p2).addScaledVector(d2, t);
  return _c1.distanceToSquared(_c2);
}

/**
 * Segment p->q against an AABB inflated by `pad`.
 * Returns the parametric t in [0,1] of the first hit, or -1 when there is none.
 */
export function segAABB(p: THREE.Vector3, q: THREE.Vector3, min: THREE.Vector3, max: THREE.Vector3, pad: number) {
  let tmin = 0;
  let tmax = 1;
  for (let i = 0; i < 3; i++) {
    const pi = p.getComponent(i);
    const d = q.getComponent(i) - pi;
    const lo = min.getComponent(i) - pad;
    const hi = max.getComponent(i) + pad;
    if (Math.abs(d) < 1e-9) {
      if (pi < lo || pi > hi) return -1;
    } else {
      let t1 = (lo - pi) / d;
      let t2 = (hi - pi) / d;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}

/** Rotate unit vector `dir` toward unit vector `want` by at most `maxAngle` radians (in place). */
export function rotateToward(dir: THREE.Vector3, want: THREE.Vector3, maxAngle: number) {
  const dot = clamp(dir.dot(want), -1, 1);
  const angle = Math.acos(dot);
  if (angle < 1e-5) return dir;
  if (angle <= maxAngle) return dir.copy(want);
  const t = maxAngle / angle;
  // slerp between dir and want
  const sinA = Math.sin(angle);
  const w1 = Math.sin((1 - t) * angle) / sinA;
  const w2 = Math.sin(t * angle) / sinA;
  dir.multiplyScalar(w1).addScaledVector(want, w2);
  return dir.normalize();
}
