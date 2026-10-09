import * as THREE from 'three';
import { rand } from '../core/math';
import { flareTexture, glowTexture } from '../render/textures';

const _c = new THREE.Color();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const r2 = (v: number) => Math.round(v * 100) / 100;

/** A recorded effect call: name followed by its arguments (mirrored host -> guest in versus). */
export type FxEvent = (string | number)[];

const VERT = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
uniform float uScale;
varying vec4 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(0.5, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec4 vColor;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a * vColor.a;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor.rgb, a);
}`;

/** Pooled point-sprite particles with per-particle velocity, drag, gravity, size ramp and fade. */
class ParticleLayer {
  readonly points: THREE.Points;
  private readonly mat: THREE.ShaderMaterial;
  private readonly geo: THREE.BufferGeometry;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly s0: Float32Array;
  private readonly s1: Float32Array;
  private readonly a0: Float32Array;
  private readonly drag: Float32Array;
  private readonly grav: Float32Array;
  private count = 0;
  private uploaded = 0;

  constructor(
    private readonly max: number,
    blending: THREE.Blending,
  ) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 300 }, uMap: { value: glowTexture() } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = blending === THREE.AdditiveBlending ? 20 : 10;
  }

  spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    color: number,
    alpha: number,
    size0: number,
    size1: number,
    life: number,
    drag = 0,
    gravity = 0,
  ) {
    let i = this.count;
    if (i >= this.max) i = Math.floor(Math.random() * this.max);
    else this.count++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    _c.setHex(color);
    this.col[i * 4] = _c.r;
    this.col[i * 4 + 1] = _c.g;
    this.col[i * 4 + 2] = _c.b;
    this.col[i * 4 + 3] = alpha;
    this.a0[i] = alpha;
    this.size[i] = size0;
    this.s0[i] = size0;
    this.s1[i] = size1;
    this.life[i] = 0;
    this.maxLife[i] = life;
    this.drag[i] = drag;
    this.grav[i] = gravity;
  }

  update(dt: number, scale: number) {
    this.mat.uniforms.uScale.value = scale;
    let i = 0;
    while (i < this.count) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) {
        this.kill(i);
        continue;
      }
      const t = this.life[i] / this.maxLife[i];
      const k = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < 0.05 && this.grav[i] > 0) {
        this.pos[i * 3 + 1] = 0.05;
        this.vel[i * 3 + 1] *= -0.3;
      }
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      this.col[i * 4 + 3] = this.a0[i] * (1 - t) * (1 - t * 0.3);
      i++;
    }
    this.geo.setDrawRange(0, this.count);
    // upload only the live slice of each buffer (nothing at all when the layer is idle)
    const n = this.count;
    if (n === 0 && this.uploaded === 0) return;
    this.uploaded = n;
    if (n === 0) return;
    for (const name of ['position', 'aColor', 'aSize']) {
      const attr = this.geo.getAttribute(name) as THREE.BufferAttribute;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * attr.itemSize);
      attr.needsUpdate = true;
    }
  }

  private kill(i: number) {
    const last = --this.count;
    if (i === last) return;
    this.pos.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.vel.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.col.copyWithin(i * 4, last * 4, last * 4 + 4);
    this.size[i] = this.size[last];
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.s0[i] = this.s0[last];
    this.s1[i] = this.s1[last];
    this.a0[i] = this.a0[last];
    this.drag[i] = this.drag[last];
    this.grav[i] = this.grav[last];
  }

  clear() {
    this.count = 0;
    this.uploaded = 0;
    this.geo.setDrawRange(0, 0);
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}

const fadeLinear = (u: number) => 1 - u;
const growLinear = (u: number) => u;
const fadeBall = (u: number) => Math.pow(1 - u, 1.6);
const growCubic = (u: number) => 1 - Math.pow(1 - u, 3);
const growQuad = (u: number) => 1 - Math.pow(1 - u, 2);

interface Timed {
  obj: THREE.Object3D;
  mat: THREE.Material & { opacity: number };
  life: number;
  max: number;
  s0: number;
  s1: number;
  a0: number;
  active: boolean;
}

interface Debris {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
  smoke: number;
}

/** All transient visual effects for a battle scene. */
export class Effects {
  private add: ParticleLayer;
  private smokeLayer: ParticleLayer;
  private sprites: Timed[] = [];
  private balls: Timed[] = [];
  private rings: Timed[] = [];
  private debris: Debris[] = [];
  private ballGeo = new THREE.IcosahedronGeometry(1, 1);
  private ringGeo = new THREE.RingGeometry(0.82, 1, 40).rotateX(-Math.PI / 2);
  /** particle-count multiplier (lowered on weak devices) */
  density = 1;
  /** Versus host: every top-level effect call is mirrored here so the guest can replay it. */
  tap: ((e: FxEvent) => void) | null = null;
  private nest = 0;

  constructor(private readonly scene: THREE.Scene) {
    this.add = new ParticleLayer(3000, THREE.AdditiveBlending);
    this.smokeLayer = new ParticleLayer(900, THREE.NormalBlending);
    scene.add(this.smokeLayer.points, this.add.points);
    this.prewarm();
  }

  /** Build the effect pools up front so no materials are created (or shaders compiled) mid-fight. */
  private prewarm() {
    const p = new THREE.Vector3(0, -1000, 0);
    for (let i = 0; i < 16; i++) this.flash(p, 0xffffff, 1, 0.001, i % 2 === 0);
    for (let i = 0; i < 10; i++) this.fireball(p, 0xffffff, 1, 0.001);
    for (let i = 0; i < 6; i++) this.ring(p, 1, 0xffffff, 0.001);
    for (const pool of [this.sprites, this.balls, this.rings]) {
      for (const t of pool) {
        t.active = false;
        t.obj.visible = false;
      }
    }
  }

  private n(count: number) {
    return Math.max(1, Math.round(count * this.density));
  }

  private rec(e: FxEvent) {
    if (this.tap && this.nest === 0) this.tap(e);
  }

  /** Versus guest: re-run an effect the host recorded. */
  replay(e: FxEvent) {
    const n = (i: number) => e[i] as number;
    const at = (i: number) => _p.set(n(i), n(i + 1), n(i + 2));
    switch (e[0]) {
      case 'fl':
        this.flash(at(1), n(4), n(5), n(6), n(7) === 1);
        break;
      case 'rg':
        this.ring(at(1), n(4), n(5), n(6));
        break;
      case 'sp':
        this.spark(at(1), n(4), n(5), n(6), n(7), n(8));
        break;
      case 'sy':
        this.spray(at(1), _q.set(n(4), n(5), n(6)), n(7), n(8), n(9), n(10));
        break;
      case 'tr':
        this.trail(at(1), n(4), n(5), n(6), n(7));
        break;
      case 'sm':
        this.smoke(at(1), n(4), n(5), n(6), n(7));
        break;
      case 'du':
        this.dust(at(1), n(4), n(5), n(6), n(7));
        break;
      case 'ex':
        this.explosion(at(1), n(4), n(5));
        break;
    }
  }

  private take(pool: Timed[], make: () => Timed) {
    for (const t of pool) if (!t.active) return t;
    const t = make();
    pool.push(t);
    this.scene.add(t.obj);
    return t;
  }

  private start(t: Timed, pos: THREE.Vector3, color: number, life: number, s0: number, s1: number, alpha: number) {
    t.active = true;
    t.obj.visible = true;
    t.obj.position.copy(pos);
    t.obj.scale.setScalar(s0);
    (t.mat as unknown as { color: THREE.Color }).color.setHex(color);
    t.mat.opacity = alpha;
    t.life = 0;
    t.max = life;
    t.s0 = s0;
    t.s1 = s1;
    t.a0 = alpha;
  }

  /** Billboard glow flash. */
  flash(pos: THREE.Vector3, color: number, size: number, life = 0.12, star = false) {
    this.rec(['fl', r2(pos.x), r2(pos.y), r2(pos.z), color, r2(size), r2(life), star ? 1 : 0]);
    const t = this.take(this.sprites, () => {
      const mat = new THREE.SpriteMaterial({
        map: glowTexture(),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        fog: false,
      });
      const s = new THREE.Sprite(mat);
      s.renderOrder = 25;
      return { obj: s, mat, life: 0, max: 1, s0: 1, s1: 1, a0: 1, active: false };
    });
    (t.mat as THREE.SpriteMaterial).map = star ? flareTexture() : glowTexture();
    this.start(t, pos, color, life, size, size * 1.6, 1);
  }

  private fireball(pos: THREE.Vector3, color: number, size: number, life: number) {
    const t = this.take(this.balls, () => {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      const m = new THREE.Mesh(this.ballGeo, mat);
      m.renderOrder = 22;
      return { obj: m, mat, life: 0, max: 1, s0: 1, s1: 1, a0: 1, active: false };
    });
    this.start(t, pos, color, life, size * 0.3, size, 0.95);
    t.obj.rotation.set(rand(0, 6), rand(0, 6), 0);
  }

  ring(pos: THREE.Vector3, size: number, color: number, life = 0.45) {
    this.rec(['rg', r2(pos.x), r2(pos.y), r2(pos.z), r2(size), color, r2(life)]);
    const t = this.take(this.rings, () => {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const m = new THREE.Mesh(this.ringGeo, mat);
      m.renderOrder = 21;
      return { obj: m, mat, life: 0, max: 1, s0: 1, s1: 1, a0: 1, active: false };
    });
    this.start(t, pos, color, life, size * 0.25, size * 2.2, 0.9);
    t.obj.position.y = Math.max(0.15, pos.y);
  }

  spark(pos: THREE.Vector3, count: number, color: number, speed = 30, size = 0.6, life = 0.35) {
    this.rec(['sp', r2(pos.x), r2(pos.y), r2(pos.z), count, color, r2(speed), r2(size), r2(life)]);
    count = this.n(count);
    for (let i = 0; i < count; i++) {
      const u = rand(-1, 1);
      const th = rand(0, Math.PI * 2);
      const r = Math.sqrt(1 - u * u);
      const sp = speed * rand(0.35, 1);
      this.add.spawn(pos.x, pos.y, pos.z, r * Math.cos(th) * sp, u * sp + speed * 0.2, r * Math.sin(th) * sp, color, 1, size, size * 0.2, life * rand(0.6, 1.2), 2.5, 25);
    }
  }

  /** Directed spray (e.g. sparks off a hit surface). */
  spray(pos: THREE.Vector3, dir: THREE.Vector3, count: number, color: number, speed = 30, spread = 0.6) {
    this.rec(['sy', r2(pos.x), r2(pos.y), r2(pos.z), r2(dir.x), r2(dir.y), r2(dir.z), count, color, r2(speed), r2(spread)]);
    count = this.n(count);
    for (let i = 0; i < count; i++) {
      const sp = speed * rand(0.4, 1);
      this.add.spawn(
        pos.x,
        pos.y,
        pos.z,
        (dir.x + rand(-spread, spread)) * sp,
        (dir.y + rand(-spread, spread)) * sp + 4,
        (dir.z + rand(-spread, spread)) * sp,
        color,
        1,
        0.55,
        0.1,
        rand(0.2, 0.45),
        2,
        30,
      );
    }
  }

  trail(pos: THREE.Vector3, color: number, size: number, life: number, alpha = 0.8) {
    this.rec(['tr', r2(pos.x), r2(pos.y), r2(pos.z), color, r2(size), r2(life), r2(alpha)]);
    this.add.spawn(pos.x, pos.y, pos.z, 0, 0, 0, color, alpha, size, size * 0.3, life);
  }

  smoke(pos: THREE.Vector3, count: number, size = 3, color = 0x3a3a40, life = 1.4) {
    this.rec(['sm', r2(pos.x), r2(pos.y), r2(pos.z), count, r2(size), color, r2(life)]);
    count = this.n(count);
    for (let i = 0; i < count; i++) {
      this.smokeLayer.spawn(
        pos.x + rand(-1, 1),
        pos.y + rand(-0.5, 1),
        pos.z + rand(-1, 1),
        rand(-3, 3),
        rand(2, 6),
        rand(-3, 3),
        color,
        0.55,
        size * rand(0.6, 1),
        size * rand(1.8, 2.6),
        life * rand(0.7, 1.2),
        1.2,
        -1,
      );
    }
  }

  dust(pos: THREE.Vector3, count: number, color = 0xd8d0c0, spread = 2, size = 2.4) {
    this.rec(['du', r2(pos.x), r2(pos.y), r2(pos.z), count, color, r2(spread), r2(size)]);
    count = this.n(count);
    for (let i = 0; i < count; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(4, 12);
      this.smokeLayer.spawn(
        pos.x + Math.cos(a) * spread,
        0.4,
        pos.z + Math.sin(a) * spread,
        Math.cos(a) * sp,
        rand(0.5, 3),
        Math.sin(a) * sp,
        color,
        0.38,
        size * 0.6,
        size * 1.8,
        rand(0.5, 0.9),
        3,
        0,
      );
    }
  }

  explosion(pos: THREE.Vector3, size: number, color = 0xffa040) {
    this.rec(['ex', r2(pos.x), r2(pos.y), r2(pos.z), r2(size), color]);
    this.nest++;
    try {
      this.flash(pos, 0xfff2c0, size * 3.2, 0.16, true);
      this.fireball(pos, color, size * 1.1, 0.42);
      this.fireball(pos, 0xffffff, size * 0.55, 0.22);
      if (pos.y < size * 1.5) this.ring(pos, size * 1.2, color, 0.5);
      this.spark(pos, Math.round(10 + size * 5), 0xffd27a, 18 + size * 6, 0.8, 0.6);
      this.smoke(pos, Math.round(3 + size), size * 0.9, 0x403a3a, 1.6);
    } finally {
      this.nest--;
    }
  }

  /** Blow a mech apart: clone its meshes into free-flying debris. */
  shatter(pieces: { mesh: THREE.Mesh; world: THREE.Matrix4 }[], center: THREE.Vector3) {
    for (const p of pieces) {
      const m = new THREE.Mesh(p.mesh.geometry, p.mesh.material);
      p.world.decompose(m.position, m.quaternion, m.scale);
      const out = m.position.clone().sub(center);
      out.y = Math.max(0.2, out.y * 0.3);
      out.normalize().multiplyScalar(rand(10, 28));
      out.y += rand(8, 22);
      this.debris.push({
        mesh: m,
        vel: out,
        spin: new THREE.Vector3(rand(-8, 8), rand(-8, 8), rand(-8, 8)),
        life: rand(2.5, 4),
        smoke: 0,
      });
      this.scene.add(m);
    }
  }

  update(dt: number, camera: THREE.PerspectiveCamera, viewportHeight: number) {
    const scale = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    this.add.update(dt, scale);
    this.smokeLayer.update(dt, scale);
    this.step(this.sprites, dt, fadeLinear, growLinear);
    this.step(this.balls, dt, fadeBall, growCubic);
    this.step(this.rings, dt, fadeLinear, growQuad);
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      d.vel.y -= 32 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
      if (d.mesh.position.y < 0.3) {
        d.mesh.position.y = 0.3;
        d.vel.y = Math.abs(d.vel.y) * 0.3;
        d.vel.x *= 0.6;
        d.vel.z *= 0.6;
        d.spin.multiplyScalar(0.6);
      }
      d.smoke -= dt;
      if (d.smoke <= 0 && d.life > 1) {
        d.smoke = 0.08;
        this.smoke(d.mesh.position, 1, 1.6, 0x2a2628, 1.0);
        if (Math.random() < 0.5) this.trail(d.mesh.position, 0xff8a3a, 1.6, 0.25);
      }
      if (d.life <= 0) {
        this.scene.remove(d.mesh);
        this.debris.splice(i, 1);
      } else if (d.life < 0.6) {
        d.mesh.scale.multiplyScalar(Math.max(0, 1 - dt * 4));
      }
    }
  }

  private step(pool: Timed[], dt: number, fade: (u: number) => number, grow: (u: number) => number) {
    for (const t of pool) {
      if (!t.active) continue;
      t.life += dt;
      if (t.life >= t.max) {
        t.active = false;
        t.obj.visible = false;
        continue;
      }
      const u = t.life / t.max;
      t.obj.scale.setScalar(t.s0 + (t.s1 - t.s0) * grow(u));
      t.mat.opacity = t.a0 * fade(u);
    }
  }

  clear() {
    this.add.clear();
    this.smokeLayer.clear();
    for (const pool of [this.sprites, this.balls, this.rings]) {
      for (const t of pool) {
        t.active = false;
        t.obj.visible = false;
      }
    }
    for (const d of this.debris) this.scene.remove(d.mesh);
    this.debris.length = 0;
  }

  dispose() {
    this.clear();
    this.add.dispose();
    this.smokeLayer.dispose();
    this.scene.remove(this.add.points, this.smokeLayer.points);
    for (const pool of [this.sprites, this.balls, this.rings]) {
      for (const t of pool) {
        this.scene.remove(t.obj);
        t.mat.dispose();
      }
    }
    this.ballGeo.dispose();
    this.ringGeo.dispose();
  }
}
