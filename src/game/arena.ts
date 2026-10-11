import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, segAABB } from '../core/math';
import {
  blockTexture,
  canvasTexture,
  floorTexture,
  hazardTexture,
  mulberry32,
  shade,
  skyTexture,
  textTexture,
  type FloorStyle,
  type SkyStyle,
} from '../render/textures';
import type { StageId } from './specs';

export interface Box {
  min: THREE.Vector3;
  max: THREE.Vector3;
}

export interface StageTheme {
  id: StageId;
  name: string;
  sky: SkyStyle;
  fog: number;
  fogNear: number;
  fogFar: number;
  floor: FloorStyle;
  mark: number;
  mark2: number;
  blockA: number;
  blockB: number;
  blockCap: number;
  blockGlow: number;
  wall: number;
  hazardA: number;
  hazardB: number;
  barrier: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  sun: number;
  sunIntensity: number;
  sunDir: [number, number, number];
  outer: number;
}

export const STAGES: Record<StageId, StageTheme> = {
  harbor: {
    id: 'harbor',
    name: 'AQUA HARBOR',
    sky: {
      top: 0x1554cc,
      mid: 0x3d9cf0,
      horizon: 0xd2f1fb,
      below: 0xb8e2f4,
      clouds: 0xffffff,
      cloudAlpha: 0.6,
      sun: 0xfffbea,
      sunU: 0.62,
      sunV: 0.16,
      sunSize: 12,
      stars: false,
      seed: 11,
    },
    fog: 0xb8e2f4,
    fogNear: 150,
    fogFar: 560,
    floor: { a: 0xc9ced8, b: 0xb7bfcc, line: 0x46536e, seed: 3 },
    mark: 0xffc21a,
    mark2: 0x2a63d8,
    blockA: 0xf2f4f8,
    blockB: 0x6fa8dc,
    blockCap: 0xff8a1c,
    blockGlow: 0x7ff3ff,
    wall: 0x2b3550,
    hazardA: 0xffc21a,
    hazardB: 0x1b1f2b,
    barrier: 0x55d8ff,
    hemiSky: 0xe4f2ff,
    hemiGround: 0xa89c8c,
    hemiIntensity: 2.0,
    sun: 0xfff3e0,
    sunIntensity: 2.2,
    sunDir: [0.45, 1, 0.35],
    outer: 0x2f8fd0,
  },
  foundry: {
    id: 'foundry',
    name: 'DUSK FOUNDRY',
    sky: {
      top: 0x1c1340,
      mid: 0x8d3a83,
      horizon: 0xffa65c,
      below: 0xd77a5c,
      clouds: 0xff9f7a,
      cloudAlpha: 0.45,
      sun: 0xffe7a8,
      sunU: 0.25,
      sunV: 0.46,
      sunSize: 34,
      stars: true,
      seed: 23,
    },
    fog: 0xd98068,
    fogNear: 120,
    fogFar: 500,
    floor: { a: 0x8c7f86, b: 0x7a6e78, line: 0x2b1f33, seed: 9 },
    mark: 0xff7a2a,
    mark2: 0x35e0d0,
    blockA: 0x5e5468,
    blockB: 0xb24a3c,
    blockCap: 0xffb43c,
    blockGlow: 0xff7a2a,
    wall: 0x231a2e,
    hazardA: 0xff9a1c,
    hazardB: 0x1a1220,
    barrier: 0xff6a4a,
    hemiSky: 0xffd2bc,
    hemiGround: 0x54406a,
    hemiIntensity: 2.3,
    sun: 0xffc48a,
    sunIntensity: 2.5,
    sunDir: [-0.7, 0.55, -0.45],
    outer: 0x4a3040,
  },
};

/** half-extent of the square arena floor */
export const HALF = 108;

interface StageTextures {
  sky: THREE.CanvasTexture;
  floor: THREE.CanvasTexture;
  name: THREE.CanvasTexture;
  vr: THREE.CanvasTexture;
}
const stageTexCache = new Map<StageId, StageTextures>();

/** Canvas-painted textures are expensive to generate and upload, so they live for the whole session. */
function stageTextures(id: StageId): StageTextures {
  let t = stageTexCache.get(id);
  if (!t) {
    const T = STAGES[id];
    const font = '900 italic 150px "Russo One", "Arial Black", sans-serif';
    const floor = floorTexture(T.floor);
    floor.repeat.set((HALF * 2) / 24, (HALF * 2) / 24);
    t = {
      sky: skyTexture(T.sky),
      floor,
      name: textTexture(T.name, 0xffffff, font, 2048, 256),
      vr: textTexture('VR ARENA', 0xffffff, font, 2048, 256),
    };
    stageTexCache.set(id, t);
  }
  return t;
}

const _col = new THREE.Color();

type BoxDef = [x: number, z: number, w: number, h: number, d: number, kind: 'tower' | 'block' | 'wall' | 'pillar'];

const LAYOUTS: Record<StageId, BoxDef[]> = {
  harbor: [
    [68, 68, 16, 30, 16, 'tower'],
    [-68, 68, 16, 30, 16, 'tower'],
    [68, -68, 16, 30, 16, 'tower'],
    [-68, -68, 16, 30, 16, 'tower'],
    [24, 24, 7, 14, 7, 'pillar'],
    [-24, 24, 7, 14, 7, 'pillar'],
    [24, -24, 7, 14, 7, 'pillar'],
    [-24, -24, 7, 14, 7, 'pillar'],
    [0, 46, 34, 6, 5, 'wall'],
    [0, -46, 34, 6, 5, 'wall'],
    [46, 0, 5, 6, 34, 'wall'],
    [-46, 0, 5, 6, 34, 'wall'],
    [80, 28, 10, 9, 10, 'block'],
    [-80, 28, 10, 9, 10, 'block'],
    [80, -28, 10, 9, 10, 'block'],
    [-80, -28, 10, 9, 10, 'block'],
    [32, 84, 10, 9, 10, 'block'],
    [-32, -84, 10, 9, 10, 'block'],
  ],
  foundry: [
    [0, 0, 16, 22, 16, 'tower'],
    [26, 45, 9, 11, 9, 'block'],
    [52, 0, 9, 11, 9, 'block'],
    [26, -45, 9, 11, 9, 'block'],
    [-26, -45, 9, 11, 9, 'block'],
    [-52, 0, 9, 11, 9, 'block'],
    [-26, 45, 9, 11, 9, 'block'],
    [82, 82, 12, 34, 12, 'tower'],
    [-82, 82, 12, 34, 12, 'tower'],
    [82, -82, 12, 34, 12, 'tower'],
    [-82, -82, 12, 34, 12, 'tower'],
    [62, 22, 22, 5, 5, 'wall'],
    [-62, -22, 22, 5, 5, 'wall'],
    [-62, 22, 22, 5, 5, 'wall'],
    [62, -22, 22, 5, 5, 'wall'],
  ],
};

/** Scale BoxGeometry UVs so the panel texture keeps a constant world size on every face. */
function worldUVBox(w: number, h: number, d: number, tile: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  // face order: +x, -x, +y, -y, +z, -z (4 verts each)
  const dims: [number, number][] = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, (uv.getX(i) * dims[f][0]) / tile, (uv.getY(i) * dims[f][1]) / tile);
    }
  }
  return g;
}

function barrierTexture() {
  return canvasTexture(
    128,
    128,
    (ctx, w, h) => {
      const fill = ctx.createLinearGradient(0, h, 0, 0);
      fill.addColorStop(0, 'rgba(255,255,255,0.5)');
      fill.addColorStop(0.3, 'rgba(255,255,255,0.12)');
      fill.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, w, h);
      const line = ctx.createLinearGradient(0, h, 0, 0);
      line.addColorStop(0, 'rgba(255,255,255,1)');
      line.addColorStop(0.5, 'rgba(255,255,255,0.4)');
      line.addColorStop(1, 'rgba(255,255,255,0.04)');
      ctx.fillStyle = line;
      for (let y = 0; y < h; y += 16) ctx.fillRect(0, y, w, 2);
      for (let x = 0; x < w; x += 32) ctx.fillRect(x, 0, 2, h);
    },
    true,
  );
}

function fadeMats(mats: (THREE.MeshLambertMaterial | THREE.MeshBasicMaterial)[], fade: number) {
  const solid = fade > 0.995;
  for (const m of mats) {
    if (m.transparent === solid) {
      // see-through is a different shader (the solid one forces alpha to 1): three only switches on
      // needsUpdate. Both are compiled at load, so this is a cache lookup, not a compile.
      m.transparent = !solid;
      m.depthWrite = solid;
      m.needsUpdate = true;
    }
    m.opacity = fade;
  }
}

export class Arena {
  readonly group = new THREE.Group();
  readonly boxes: Box[] = [];
  readonly half = HALF;
  readonly theme: StageTheme;
  readonly sky: THREE.Mesh;
  readonly spawns = [
    { pos: new THREE.Vector3(0, 0, 72), yaw: Math.PI },
    { pos: new THREE.Vector3(0, 0, -72), yaw: 0 },
  ];
  private animators: ((t: number) => void)[] = [];
  /** fadeable blocks; `fade` is kept per view (split screen fades a block for one player only) */
  private occluders: { box: Box; mats: (THREE.MeshLambertMaterial | THREE.MeshBasicMaterial)[]; fade: number[] }[] = [];
  private disposables: { dispose(): void }[] = [];

  constructor(
    readonly scene: THREE.Scene,
    stage: StageId,
  ) {
    const T = (this.theme = STAGES[stage]);
    scene.add(this.group);
    scene.fog = new THREE.Fog(T.fog, T.fogNear, T.fogFar);
    scene.background = new THREE.Color(T.fog);

    // lights
    const hemi = new THREE.HemisphereLight(T.hemiSky, T.hemiGround, T.hemiIntensity);
    const sun = new THREE.DirectionalLight(T.sun, T.sunIntensity);
    sun.position.set(...T.sunDir).multiplyScalar(100);
    this.group.add(hemi, sun);

    // sky dome (follows the camera). Drawn after all other opaque geometry so only the pixels
    // left uncovered get shaded — saves a full-screen textured pass.
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(900, 40, 20),
      new THREE.MeshBasicMaterial({ map: stageTextures(stage).sky, side: THREE.BackSide, fog: false, depthWrite: false }),
    );
    this.sky.renderOrder = 1000;
    this.sky.userData.dynamic = true;
    this.group.add(this.sky);
    this.track(this.sky.geometry, this.sky.material as THREE.Material);

    this.buildFloor();
    this.buildWalls();
    for (const def of LAYOUTS[stage]) this.buildBox(def);
    if (stage === 'harbor') this.buildHarborScenery();
    else this.buildFoundryScenery();
    this.batchStatic();
  }

  /**
   * Merge every static, untextured mesh into a handful of vertex-colored batches (one per material
   * kind, plus one set per fadeable block). Takes the arena from ~250 draw calls to ~60.
   */
  private batchStatic() {
    this.group.updateMatrixWorld(true);
    const buckets = new Map<string, { make: () => THREE.Material; geos: THREE.BufferGeometry[]; occ: number }>();
    const merged: THREE.Mesh[] = [];
    this.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || o.userData.dynamic || Array.isArray(o.material)) return;
      const m = o.material as THREE.Material;
      let kind: string | null = null;
      let make: (() => THREE.Material) | null = null;
      if (m instanceof THREE.MeshLambertMaterial && !m.map && !m.transparent) {
        kind = m.polygonOffset ? 'decal' : 'lam';
        make = m.polygonOffset
          ? () => new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })
          : () => new THREE.MeshLambertMaterial({ vertexColors: true });
      } else if (m instanceof THREE.MeshBasicMaterial && !m.map && !m.transparent && m.blending === THREE.NormalBlending) {
        kind = m.fog ? 'basic' : 'basicNoFog';
        const fog = m.fog;
        make = () => new THREE.MeshBasicMaterial({ vertexColors: true, fog });
      }
      if (!kind || !make) return;
      const occ = typeof o.userData.occluder === 'number' ? (o.userData.occluder as number) : -1;
      const key = `${occ}:${kind}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { make, geos: [], occ }));
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
      g.applyMatrix4(o.matrixWorld);
      _col.copy((m as THREE.MeshLambertMaterial | THREE.MeshBasicMaterial).color);
      const n = g.getAttribute('position').count;
      const cols = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        cols[i * 3] = _col.r;
        cols[i * 3 + 1] = _col.g;
        cols[i * 3 + 2] = _col.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      b.geos.push(g);
      merged.push(o);
    });
    for (const o of merged) o.parent?.remove(o);
    for (const b of buckets.values()) {
      const geo = mergeGeometries(b.geos, false);
      for (const g of b.geos) g.dispose();
      if (!geo) continue;
      const mat = b.make();
      const mesh = new THREE.Mesh(geo, mat);
      this.group.add(mesh);
      this.track(geo, mat);
      if (b.occ >= 0) this.occluders[b.occ].mats.push(mat as THREE.MeshLambertMaterial | THREE.MeshBasicMaterial);
    }
    // nothing static ever moves again: skip per-frame matrix recomputation
    this.group.traverse((o) => {
      if (o !== this.group && !o.userData.dynamic) {
        o.updateMatrix();
        o.matrixAutoUpdate = false;
      }
    });
    this.group.updateMatrixWorld(true);
  }

  private track(...items: { dispose(): void }[]) {
    this.disposables.push(...items);
  }

  private lambert(color: number, map?: THREE.Texture) {
    const m = new THREE.MeshLambertMaterial({ color, map: map ?? null });
    this.track(m);
    return m;
  }

  private basic(color: number, extra: THREE.MeshBasicMaterialParameters = {}) {
    const m = new THREE.MeshBasicMaterial({ color, ...extra });
    this.track(m);
    return m;
  }

  private mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    this.group.add(m);
    this.track(geo);
    return m;
  }

  private decal(geo: THREE.BufferGeometry, color: number, x: number, z: number, rotY = 0, map?: THREE.Texture) {
    const mat = new THREE.MeshLambertMaterial({
      color,
      map: map ?? null,
      transparent: !!map,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.track(mat);
    const m = this.mesh(geo, mat, x, 0.03, z);
    m.rotation.set(-Math.PI / 2, 0, rotY);
    return m;
  }

  private buildFloor() {
    const T = this.theme;
    const tex = stageTextures(T.id);
    const floor = this.mesh(new THREE.PlaneGeometry(HALF * 2, HALF * 2), this.lambert(0xffffff, tex.floor));
    floor.rotation.x = -Math.PI / 2;

    // outside ground / sea
    const outer = this.mesh(new THREE.PlaneGeometry(4000, 4000), this.lambert(T.outer), 0, -0.6, 0);
    outer.rotation.x = -Math.PI / 2;

    // painted markings
    this.decal(new THREE.RingGeometry(17, 19, 64), T.mark, 0, 0);
    this.decal(new THREE.RingGeometry(5.5, 6.5, 40), T.mark2, 0, 0);
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      this.decal(new THREE.PlaneGeometry(1.2, 10), T.mark2, Math.sin(a) * 12, Math.cos(a) * 12, a);
    }
    const inset = HALF - 7;
    for (const s of [-1, 1]) {
      this.decal(new THREE.PlaneGeometry(HALF * 2 - 14, 1.4), T.mark, 0, s * inset);
      this.decal(new THREE.PlaneGeometry(1.4, HALF * 2 - 14), T.mark, s * inset, 0);
    }
    // spawn chevrons
    for (const sp of this.spawns) {
      for (let k = 0; k < 3; k++) {
        const z = sp.pos.z + Math.sign(sp.pos.z) * (8 + k * 5);
        const chev = new THREE.ShapeGeometry(
          new THREE.Shape([
            new THREE.Vector2(-4, 0),
            new THREE.Vector2(0, 2.6),
            new THREE.Vector2(4, 0),
            new THREE.Vector2(4, 1.4),
            new THREE.Vector2(0, 4),
            new THREE.Vector2(-4, 1.4),
          ]),
        );
        this.decal(chev, T.mark, 0, z, sp.pos.z > 0 ? Math.PI : 0);
      }
    }
    // big stage lettering
    for (const s of [-1, 1]) {
      const m = this.decal(new THREE.PlaneGeometry(120, 15), shade(T.floor.line, 1.0), s * (HALF - 18), 0, s * (Math.PI / 2), tex.name);
      (m.material as THREE.MeshLambertMaterial).opacity = 0.75;
    }
    for (const s of [-1, 1]) {
      const m = this.decal(new THREE.PlaneGeometry(64, 8), T.mark2, 0, s * (HALF - 20), s > 0 ? Math.PI : 0, tex.vr);
      (m.material as THREE.MeshLambertMaterial).opacity = 0.85;
    }
  }

  private buildWalls() {
    const T = this.theme;
    const wallH = 4.5;
    const thick = 2;
    const wallMat = this.lambert(T.wall);
    const hz = hazardTexture(T.hazardA, T.hazardB);
    const hzTex = hz.clone();
    hzTex.repeat.set((HALF * 2) / 8, 1);
    hzTex.needsUpdate = true;
    this.track(hzTex);
    const hzMat = this.lambert(0xffffff, hzTex);
    const railMat = this.basic(T.barrier, { fog: false });
    const btex = barrierTexture();
    btex.repeat.set((HALF * 2) / 16, 1);
    this.track(btex);
    const barMat = this.basic(T.barrier, {
      map: btex,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
      fog: false,
    });
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      const nx = Math.sin(a);
      const nz = Math.cos(a);
      const len = HALF * 2 + thick * 2;
      const w = this.mesh(new THREE.BoxGeometry(len, wallH, thick), wallMat, nx * (HALF + thick / 2), wallH / 2, nz * (HALF + thick / 2));
      w.rotation.y = a;
      const band = this.mesh(new THREE.PlaneGeometry(HALF * 2, 1.6), hzMat, nx * (HALF - 0.02), 2.2, nz * (HALF - 0.02));
      band.rotation.y = a + Math.PI;
      const rail = this.mesh(new THREE.BoxGeometry(len, 0.35, 0.5), railMat, nx * (HALF + 0.2), wallH + 0.15, nz * (HALF + 0.2));
      rail.rotation.y = a;
      const bar = this.mesh(new THREE.PlaneGeometry(HALF * 2, 30), barMat, nx * (HALF + 0.3), wallH + 15, nz * (HALF + 0.3));
      bar.rotation.y = a + Math.PI;
      bar.renderOrder = 5;
    }
    btex.wrapT = THREE.ClampToEdgeWrapping;
    this.animators.push((t) => {
      btex.offset.x = (t * 0.01) % 1;
      barMat.opacity = 0.45 + Math.sin(t * 2.3) * 0.08;
    });
    // corner posts with beacons
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        this.mesh(new THREE.BoxGeometry(5, 12, 5), wallMat, sx * (HALF + 1), 6, sz * (HALF + 1));
        this.mesh(new THREE.BoxGeometry(5.4, 0.8, 5.4), railMat, sx * (HALF + 1), 12.4, sz * (HALF + 1));
      }
    }
  }

  private buildBox([x, z, w, h, d, kind]: BoxDef) {
    const T = this.theme;
    const firstChild = this.group.children.length;
    const box = {
      min: new THREE.Vector3(x - w / 2, 0, z - d / 2),
      max: new THREE.Vector3(x + w / 2, h, z + d / 2),
    };
    this.boxes.push(box);
    // every block gets its own materials so it can fade out when it hides the player from the camera
    const mats: (THREE.MeshLambertMaterial | THREE.MeshBasicMaterial)[] = [];
    const lam = (color: number, map?: THREE.Texture) => {
      const m = this.lambert(color, map);
      mats.push(m);
      return m;
    };
    const glowMat = () => {
      const m = this.basic(T.blockGlow);
      mats.push(m);
      return m;
    };
    const tex = blockTexture();
    const color = kind === 'tower' || kind === 'wall' ? T.blockA : T.blockB;
    this.mesh(worldUVBox(w, h, d, 8), lam(color, tex), x, h / 2, z);
    // dark plinth + colored cap — the classic arcade-arena block look
    this.mesh(new THREE.BoxGeometry(w + 0.3, 0.9, d + 0.3), lam(shade(color, 0.45)), x, 0.45, z);
    this.mesh(new THREE.BoxGeometry(w + 0.5, 0.7, d + 0.5), lam(T.blockCap), x, h + 0.05, z);
    if (kind === 'wall') {
      const hzTex = hazardTexture(T.hazardA, T.hazardB).clone();
      hzTex.repeat.set(Math.max(w, d) / 8, 1);
      hzTex.needsUpdate = true;
      this.track(hzTex);
      this.mesh(new THREE.BoxGeometry(w + 0.12, 1.2, d + 0.12), lam(0xffffff, hzTex), x, h - 1.4, z);
    }
    if (kind === 'tower') {
      const glow = glowMat();
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          this.mesh(new THREE.BoxGeometry(0.5, h * 0.75, 0.5), glow, x + sx * (w / 2 + 0.05), h * 0.45, z + sz * (d / 2 + 0.05));
        }
      }
      const band = lam(T.blockCap);
      for (let k = 1; k <= 3; k++) {
        this.mesh(new THREE.BoxGeometry(w + 0.2, 0.4, d + 0.2), band, x, (h * k) / 4, z);
      }
    }
    if (kind === 'pillar') {
      this.mesh(new THREE.BoxGeometry(w + 0.2, 1.0, d + 0.2), glowMat(), x, h * 0.55, z);
    }
    const idx = this.occluders.length;
    for (const c of this.group.children.slice(firstChild)) c.userData.occluder = idx;
    this.occluders.push({ box, mats, fade: [1, 1] });
  }

  private buildHarborScenery() {
    const rnd = mulberry32(42);
    // sea shimmer
    const seaTex = canvasTexture(
      256,
      256,
      (ctx, w, h) => {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        const r = mulberry32(5);
        for (let i = 0; i < 140; i++) {
          ctx.fillStyle = `rgba(255,255,255,${0.25 + r() * 0.5})`;
          ctx.fillRect(r() * w, r() * h, 6 + r() * 26, 2);
        }
      },
      true,
    );
    seaTex.repeat.set(60, 60);
    this.track(seaTex);
    const shimmer = this.mesh(
      new THREE.PlaneGeometry(3000, 3000),
      this.basic(0x9fdcff, { map: seaTex, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
      0,
      -0.5,
      0,
    );
    shimmer.rotation.x = -Math.PI / 2;
    this.animators.push((t) => {
      seaTex.offset.set((t * 0.004) % 1, (t * 0.011) % 1);
    });

    // dock apron around the arena
    this.mesh(new THREE.BoxGeometry(HALF * 2 + 70, 1.2, HALF * 2 + 70), this.lambert(0x8e96a6), 0, -0.62, 0);

    // gantry cranes
    const craneMat = this.lambert(0xe2392f);
    const craneMat2 = this.lambert(0xf2f2f2);
    const crane = (x: number, z: number, rot: number) => {
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      g.rotation.y = rot;
      const leg = new THREE.BoxGeometry(2.2, 46, 2.2);
      this.track(leg);
      for (const lx of [-9, 9]) for (const lz of [-7, 7]) g.add(new THREE.Mesh(leg, craneMat).translateX(lx).translateY(23).translateZ(lz));
      const beam = new THREE.BoxGeometry(24, 4, 18);
      const jib = new THREE.BoxGeometry(3, 2.5, 80);
      const cab = new THREE.BoxGeometry(5, 4, 5);
      this.track(beam, jib, cab);
      g.add(new THREE.Mesh(beam, craneMat2).translateY(47));
      g.add(new THREE.Mesh(jib, craneMat).translateY(50).translateZ(18));
      g.add(new THREE.Mesh(cab, craneMat2).translateY(44).translateZ(-12));
      this.group.add(g);
    };
    crane(-175, -40, 0.1);
    crane(-185, 60, -0.05);
    crane(190, -90, Math.PI + 0.2);
    crane(170, 120, Math.PI);

    // container stacks
    const conColors = [0xd4473a, 0x2f6fd1, 0xf0b52a, 0x3fa56b, 0xe8e8e8];
    const conGeo = new THREE.BoxGeometry(6, 3, 14);
    this.track(conGeo);
    const conMats = conColors.map((c) => this.lambert(c));
    for (let i = 0; i < 60; i++) {
      const side = Math.floor(rnd() * 4);
      const along = (rnd() - 0.5) * 240;
      const out = HALF + 18 + rnd() * 20;
      const x = side === 0 ? out : side === 1 ? -out : along;
      const z = side === 2 ? out : side === 3 ? -out : along;
      const stack = 1 + Math.floor(rnd() * 3);
      for (let s = 0; s < stack; s++) {
        const m = new THREE.Mesh(conGeo, conMats[Math.floor(rnd() * conMats.length)]);
        m.position.set(x, 1.5 + s * 3, z);
        m.rotation.y = side < 2 ? 0 : Math.PI / 2;
        this.group.add(m);
      }
    }

    // distant skyline across the bay
    const cityMat = this.lambert(0x8fb8d8);
    const winMat = this.basic(0xeaffff);
    for (let i = 0; i < 46; i++) {
      const a = -0.9 + (i / 46) * 1.8 + (rnd() - 0.5) * 0.03;
      const r = 520 + rnd() * 140;
      const w = 18 + rnd() * 30;
      const h = 30 + rnd() * 110;
      const b = this.mesh(new THREE.BoxGeometry(w, h, w), cityMat, Math.sin(a) * r, h / 2 - 1, -Math.cos(a) * r);
      b.rotation.y = rnd() * Math.PI;
      if (rnd() < 0.5) this.mesh(new THREE.BoxGeometry(w * 0.3, 2, w + 0.4), winMat, b.position.x, h * 0.7, b.position.z).rotation.y = b.rotation.y;
    }
    // lighthouse
    this.mesh(new THREE.CylinderGeometry(4, 6, 60, 10), this.lambert(0xffffff), 300, 30, 260);
    this.mesh(new THREE.CylinderGeometry(4.5, 4.5, 8, 10), this.lambert(0xe2392f), 300, 64, 260);
    const beacon = this.mesh(new THREE.SphereGeometry(3, 8, 6), this.basic(0xfff4b0, { fog: false }), 300, 70, 260);
    beacon.userData.dynamic = true;
    this.animators.push((t) => beacon.scale.setScalar(0.8 + Math.abs(Math.sin(t * 1.5)) * 0.6));
  }

  private buildFoundryScenery() {
    const rnd = mulberry32(7);
    this.mesh(new THREE.BoxGeometry(HALF * 2 + 60, 1.2, HALF * 2 + 60), this.lambert(0x4a3a4a), 0, -0.62, 0);
    const stackMat = this.lambert(0x5a4a5c);
    const glowMat = this.basic(0xff8a2a, { fog: false });
    const hotMat = this.basic(0xffd27a, { fog: false });
    // smokestacks
    for (let i = 0; i < 9; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 190 + rnd() * 220;
      const h = 70 + rnd() * 90;
      const rad = 4 + rnd() * 4;
      const x = Math.sin(a) * r;
      const z = Math.cos(a) * r;
      this.mesh(new THREE.CylinderGeometry(rad * 0.8, rad, h, 10), stackMat, x, h / 2, z);
      this.mesh(new THREE.CylinderGeometry(rad * 0.85, rad * 0.85, 2.5, 10), glowMat, x, h * 0.82, z);
      this.mesh(new THREE.CylinderGeometry(rad * 0.82, rad * 0.82, 1.5, 10), hotMat, x, h + 0.2, z);
    }
    // factory blocks with lit window bands
    const facMat = this.lambert(0x433548);
    for (let i = 0; i < 24; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 165 + rnd() * 160;
      const w = 30 + rnd() * 40;
      const d = 20 + rnd() * 30;
      const h = 14 + rnd() * 30;
      const x = Math.sin(a) * r;
      const z = Math.cos(a) * r;
      const b = this.mesh(new THREE.BoxGeometry(w, h, d), facMat, x, h / 2, z);
      b.rotation.y = a;
      const band = this.mesh(new THREE.BoxGeometry(w + 0.4, 1.4, d + 0.4), rnd() < 0.5 ? glowMat : hotMat, x, h * 0.65, z);
      band.rotation.y = a;
    }
    // distant mountains
    const mtnMat = this.lambert(0x5b3557);
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + rnd() * 0.2;
      const r = 700 + rnd() * 80;
      const h = 60 + rnd() * 120;
      const m = this.mesh(new THREE.ConeGeometry(90 + rnd() * 80, h, 5), mtnMat, Math.sin(a) * r, h / 2 - 2, Math.cos(a) * r);
      m.rotation.y = rnd() * 3;
    }
    // pipes along the outside of the walls
    const pipeMat = this.lambert(0x7d5f52);
    for (const s of [-1, 1]) {
      const p1 = this.mesh(new THREE.CylinderGeometry(1.6, 1.6, HALF * 2 + 40, 10), pipeMat, s * (HALF + 12), 3, 0);
      p1.rotation.x = Math.PI / 2;
      const p2 = this.mesh(new THREE.CylinderGeometry(1.6, 1.6, HALF * 2 + 40, 10), pipeMat, 0, 3, s * (HALF + 12));
      p2.rotation.z = Math.PI / 2;
    }
  }

  // ---------------------------------------------------------------- queries

  update(t: number, cameraPos: THREE.Vector3) {
    this.sky.position.copy(cameraPos);
    for (const a of this.animators) a(t);
  }

  /** Split screen: center the sky on the camera of the view about to be drawn. */
  setSkyCenter(cameraPos: THREE.Vector3) {
    this.sky.position.copy(cameraPos);
  }

  /** Height of the walkable surface under a footprint, considering only surfaces at or below `fromY`. */
  groundAt(x: number, z: number, r: number, fromY: number) {
    let g = 0;
    const rr = r * 0.55;
    for (const b of this.boxes) {
      if (b.max.y > fromY + 0.05) continue;
      if (x + rr > b.min.x && x - rr < b.max.x && z + rr > b.min.z && z - rr < b.max.z) g = Math.max(g, b.max.y);
    }
    return g;
  }

  /** Push a vertical cylinder out of blocks and arena walls. Returns true on contact. */
  resolve(pos: THREE.Vector3, r: number, h: number) {
    let hit = false;
    for (const b of this.boxes) {
      if (pos.y >= b.max.y - 0.05 || pos.y + h <= b.min.y) continue;
      const cx = clamp(pos.x, b.min.x, b.max.x);
      const cz = clamp(pos.z, b.min.z, b.max.z);
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      hit = true;
      if (d2 > 1e-8) {
        const dd = Math.sqrt(d2);
        pos.x += (dx / dd) * (r - dd);
        pos.z += (dz / dd) * (r - dd);
      } else {
        const pl = pos.x - b.min.x;
        const pr = b.max.x - pos.x;
        const pb = pos.z - b.min.z;
        const pf = b.max.z - pos.z;
        const m = Math.min(pl, pr, pb, pf);
        if (m === pl) pos.x = b.min.x - r;
        else if (m === pr) pos.x = b.max.x + r;
        else if (m === pb) pos.z = b.min.z - r;
        else pos.z = b.max.z + r;
      }
    }
    const lim = HALF - r;
    if (pos.x > lim) ((pos.x = lim), (hit = true));
    if (pos.x < -lim) ((pos.x = -lim), (hit = true));
    if (pos.z > lim) ((pos.z = lim), (hit = true));
    if (pos.z < -lim) ((pos.z = -lim), (hit = true));
    return hit;
  }

  /**
   * First solid hit along p->q (blocks inflated by `pad`, the floor, the arena barrier).
   * Returns t in [0,1] or -1.
   */
  raycast(p: THREE.Vector3, q: THREE.Vector3, pad = 0) {
    let best = 2;
    for (const b of this.boxes) {
      const t = segAABB(p, q, b.min, b.max, pad);
      if (t >= 0 && t < best) best = t;
    }
    if (q.y < 0 && p.y >= 0) best = Math.min(best, p.y / (p.y - q.y));
    const W = HALF;
    if (q.x > W && p.x <= W) best = Math.min(best, (W - p.x) / (q.x - p.x));
    if (q.x < -W && p.x >= -W) best = Math.min(best, (-W - p.x) / (q.x - p.x));
    if (q.z > W && p.z <= W) best = Math.min(best, (W - p.z) / (q.z - p.z));
    if (q.z < -W && p.z >= -W) best = Math.min(best, (-W - p.z) / (q.z - p.z));
    return best <= 1 ? best : -1;
  }

  /**
   * Switch every fadeable block to (or back from) its see-through variant. Used once at load so the
   * transparent shader variants get compiled up front instead of when a block first fades mid-fight.
   */
  previewFaded(on: boolean) {
    for (const o of this.occluders) {
      for (const m of o.mats) {
        m.transparent = on;
        m.depthWrite = !on;
        m.needsUpdate = true;
      }
    }
  }

  /**
   * Fade blocks that sit between the camera and any of the given points (the player's mech). Each
   * split-screen view keeps its own fades; view 0 applies them straight away, others via applyFades.
   */
  updateOcclusion(cam: THREE.Vector3, points: THREE.Vector3[], dt: number, view = 0) {
    const k = 1 - Math.exp(-12 * dt);
    for (const o of this.occluders) {
      const b = o.box;
      const inside = cam.x > b.min.x && cam.x < b.max.x && cam.z > b.min.z && cam.z < b.max.z && cam.y < b.max.y;
      let blocked = false;
      if (!inside) for (const p of points) if (segAABB(cam, p, b.min, b.max, 0.6) >= 0) blocked = true;
      const want = blocked ? 0.22 : 1;
      const cur = o.fade[view];
      if (Math.abs(cur - want) < 0.003) {
        if (cur === want) continue;
        o.fade[view] = want;
      } else o.fade[view] = cur + (want - cur) * k;
      if (view === 0) fadeMats(o.mats, o.fade[0]);
    }
  }

  /** Split screen: show every block the way view `view` sees it (call before drawing that view). */
  applyFades(view: number) {
    for (const o of this.occluders) fadeMats(o.mats, o.fade[view]);
  }

  lineOfSight(a: THREE.Vector3, b: THREE.Vector3) {
    return this.raycast(a, b, 0) < 0;
  }

  dispose() {
    this.scene.remove(this.group);
    for (const d of this.disposables) d.dispose();
    this.scene.fog = null;
  }
}
