import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { damp, lerp, saturate } from '../core/math';
import { part, pivot, prism, taperBox } from '../render/geometry';
import { glowTexture } from '../render/textures';
import type { MechSpec, Palette } from './specs';

/** Everything the animation rig needs to know about what the mech is doing this frame. */
export interface MechPose {
  walkPhase: number;
  walkAmt: number;
  /** local travel direction (forward / strafe-right), roughly unit length while walking */
  moveF: number;
  moveS: number;
  air: number;
  dash: number;
  dashF: number;
  dashS: number;
  crouch: number;
  guard: number;
  aimR: number;
  aimBoth: number;
  aimPitch: number;
  /** left-arm throw progress 0..1 (only while throwW > 0) */
  throwL: number;
  throwW: number;
  beam: number;
  /** melee progress 0..1 (only while meleeW > 0) */
  melee: number;
  meleeW: number;
  saber: number;
  /** left straight punch (rocket fist) progress 0..1 (only while punchW > 0) */
  punchL: number;
  punchW: number;
  /** overhead two-fisted slam progress 0..1 (only while slamW > 0) */
  slam: number;
  slamW: number;
  /** shoulder-first charge */
  ram: number;
  /** the left fist is away (launched) */
  fistOut: number;
  stagger: number;
  down: number;
  charge: number;
  thrust: number;
  twist: number;
  recoil: number;
}

export function makePose(): MechPose {
  return {
    walkPhase: 0,
    walkAmt: 0,
    moveF: 0,
    moveS: 0,
    air: 0,
    dash: 0,
    dashF: 0,
    dashS: 0,
    crouch: 0,
    guard: 0,
    aimR: 0,
    aimBoth: 0,
    aimPitch: 0,
    throwL: 0,
    throwW: 0,
    beam: 0,
    melee: 0,
    meleeW: 0,
    saber: 0,
    punchL: 0,
    punchW: 0,
    slam: 0,
    slamW: 0,
    ram: 0,
    fistOut: 0,
    stagger: 0,
    down: 0,
    charge: 0,
    thrust: 0,
    twist: 0,
    recoil: 0,
  };
}

const CHANNELS = [
  'hipsX',
  'hipsZ',
  'waistX',
  'waistY',
  'waistZ',
  'headX',
  'headY',
  'shLX',
  'shLZ',
  'shRX',
  'shRZ',
  'elL',
  'elR',
  'thLX',
  'thLZ',
  'thRX',
  'thRZ',
  'knL',
  'knR',
] as const;
type Channel = (typeof CHANNELS)[number];
type JointPose = Record<Channel, number>;

function zeroJoints(): JointPose {
  const p = {} as JointPose;
  for (const c of CHANNELS) p[c] = 0;
  return p;
}

interface Frame {
  ankleH: number;
  shin: number;
  thigh: number;
  hipDrop: number;
  armRestX: number;
  armRestZ: number;
  elbowRest: number;
}

/** What sets one VR's rig apart: proportions, builder, and a few animation traits. */
interface Rig {
  frame: Frame;
  build: () => void;
  /** where the center weapon's charge glow gathers */
  charge: () => THREE.Object3D;
  /** charge glow size at rest and at full charge */
  chargeSize: [number, number];
  /** a gun on the right arm that kicks back when it fires */
  gunArm: boolean;
  /** right shoulder's sideways set while aiming the right arm */
  aimRZ: number;
}

interface Mats {
  primary: THREE.MeshLambertMaterial;
  secondary: THREE.MeshLambertMaterial;
  accent: THREE.MeshLambertMaterial;
  joint: THREE.MeshLambertMaterial;
  trim: THREE.MeshLambertMaterial;
  eye: THREE.MeshBasicMaterial;
  glow: THREE.MeshBasicMaterial;
  flame: THREE.MeshBasicMaterial;
  flameCore: THREE.MeshBasicMaterial;
  saber: THREE.MeshBasicMaterial;
  saberCore: THREE.MeshBasicMaterial;
}

function makeMats(p: Palette): Mats {
  const lam = (c: number) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });
  // additive glow: order-free, so both faces go in one pass (three draws double-sided transparents twice otherwise)
  const add = (c: number, opacity = 1) =>
    new THREE.MeshBasicMaterial({
      color: c,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
      fog: false,
    });
  return {
    primary: lam(p.primary),
    secondary: lam(p.secondary),
    accent: lam(p.accent),
    joint: lam(p.joint),
    trim: lam(p.trim),
    eye: new THREE.MeshBasicMaterial({ color: p.eye }),
    glow: new THREE.MeshBasicMaterial({ color: p.beam }),
    flame: add(p.flame, 0.75),
    flameCore: add(0xffffff, 0.9),
    saber: add(p.beam, 0.85),
    saberCore: add(0xffffff, 1),
  };
}

/**
 * Procedural low-poly Virtuaroid-style mech with a joint hierarchy and a procedural animation rig.
 * Local space: +Z forward, +Y up, the mech's right hand side is -X.
 */
export class MechModel {
  readonly root = new THREE.Group();
  readonly hips: THREE.Group;
  readonly waist: THREE.Group;
  head!: THREE.Group;
  shL!: THREE.Group;
  shR!: THREE.Group;
  elL!: THREE.Group;
  elR!: THREE.Group;
  thL!: THREE.Group;
  thR!: THREE.Group;
  knL!: THREE.Group;
  knR!: THREE.Group;
  anL!: THREE.Group;
  anR!: THREE.Group;

  /** hardpoints (world positions are read from these when firing) */
  muzzleR = new THREE.Object3D();
  muzzleL = new THREE.Object3D();
  chest = new THREE.Object3D();
  cannons: THREE.Object3D[] = [];
  missilePods: THREE.Object3D[] = [];
  fist = new THREE.Object3D();
  /** a left fist that can leave the arm (rocket fist) */
  fistL: THREE.Object3D | null = null;
  saber: THREE.Object3D | null = null;
  chargeGlow: THREE.Sprite;

  readonly mats: Mats;
  readonly frame: Frame;
  private readonly rig: Rig;
  readonly flames: THREE.Object3D[] = [];
  readonly hipBase: number;
  private cur = zeroJoints();
  /** the knockdown weight as the hips feel it: eased like the joints, so a fall doesn't drop the body into the floor */
  private downW = 0;
  private tgt = zeroJoints();
  private flash = 0;
  private time = Math.random() * 10;
  private chargeAnchor: THREE.Object3D;
  /** after baking, every lit part shares one vertex-colored material (and every glow part another) */
  private lit!: THREE.MeshLambertMaterial;
  private glowMat!: THREE.MeshBasicMaterial;

  constructor(
    readonly spec: MechSpec,
    readonly palette: Palette,
  ) {
    this.mats = makeMats(palette);
    this.rig = this.rigFor(spec);
    this.frame = this.rig.frame;
    const F = this.frame;
    this.hipBase = F.ankleH + F.shin + F.thigh + F.hipDrop;
    this.hips = pivot(this.root, 0, this.hipBase, 0, 'hips');
    this.waist = pivot(this.hips, 0, 0.35, 0, 'waist');
    this.rig.build();
    this.bake();
    this.chargeAnchor = this.rig.charge();
    this.chargeGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture(),
        color: palette.beam,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        fog: false,
      }),
    );
    this.chargeGlow.visible = false;
    this.chargeAnchor.add(this.chargeGlow);
    this.root.traverse((o) => {
      o.matrixAutoUpdate = true;
    });
  }

  private rigFor(spec: MechSpec): Rig {
    switch (spec.id) {
      case 'jebe':
        return {
          frame: { ankleH: 0.55, shin: 1.85, thigh: 1.65, hipDrop: 0.15, armRestX: -0.28, armRestZ: 0.14, elbowRest: -0.75 },
          build: () => this.buildJebe(),
          charge: () => this.muzzleR,
          chargeSize: [0.6, 3.2],
          gunArm: true,
          aimRZ: 0.06,
        };
      case 'fujin':
        return {
          frame: { ankleH: 0.7, shin: 1.6, thigh: 1.3, hipDrop: 0.2, armRestX: -0.12, armRestZ: 0.2, elbowRest: -0.45 },
          build: () => this.buildFujin(),
          charge: () => this.chest,
          chargeSize: [1.0, 4.2],
          gunArm: false,
          aimRZ: -0.1,
        };
      case 'kestrel':
        return {
          frame: { ankleH: 0.5, shin: 1.95, thigh: 1.7, hipDrop: 0.12, armRestX: -0.25, armRestZ: 0.18, elbowRest: -0.7 },
          build: () => this.buildKestrel(),
          charge: () => this.muzzleR,
          chargeSize: [0.5, 2.8],
          gunArm: true,
          aimRZ: 0.06,
        };
      case 'kongo':
        return {
          frame: { ankleH: 0.7, shin: 1.45, thigh: 1.25, hipDrop: 0.22, armRestX: -0.1, armRestZ: 0.26, elbowRest: -0.5 },
          build: () => this.buildKongo(),
          charge: () => this.fist,
          chargeSize: [0.8, 3.6],
          gunArm: false,
          aimRZ: -0.12,
        };
      case 'arachne':
        return {
          frame: { ankleH: 0.6, shin: 1.7, thigh: 1.45, hipDrop: 0.18, armRestX: -0.18, armRestZ: 0.22, elbowRest: -0.6 },
          build: () => this.buildArachne(),
          charge: () => this.muzzleR,
          chargeSize: [0.7, 3.4],
          gunArm: true,
          aimRZ: 0,
        };
    }
  }

  /** Lambert materials that react to the white hit flash. */
  get litMaterials() {
    return [this.lit];
  }

  /**
   * Merge each joint's lit parts (and glow parts) into a single vertex-colored mesh, so a mech costs
   * ~20 draw calls instead of ~60 while every joint still animates independently.
   */
  private bake() {
    const M = this.mats;
    const litSet = new Set<THREE.Material>([M.primary, M.secondary, M.accent, M.joint, M.trim]);
    const glowSet = new Set<THREE.Material>([M.eye, M.glow]);
    this.lit = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.glowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    const parents = new Set<THREE.Object3D>();
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh && o.parent && (litSet.has(o.material) || glowSet.has(o.material))) parents.add(o.parent);
    });
    const groups: [Set<THREE.Material>, THREE.Material][] = [
      [litSet, this.lit],
      [glowSet, this.glowMat],
    ];
    for (const p of parents) {
      for (const [set, mat] of groups) {
        const parts = p.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh && set.has(c.material as THREE.Material));
        if (!parts.length) continue;
        const geos = parts.map((part) => {
          part.updateMatrix();
          const g = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
          for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
          g.applyMatrix4(part.matrix);
          const c = (part.material as THREE.MeshLambertMaterial | THREE.MeshBasicMaterial).color;
          const n = g.getAttribute('position').count;
          const arr = new Float32Array(n * 3);
          for (let i = 0; i < n; i++) {
            arr[i * 3] = c.r;
            arr[i * 3 + 1] = c.g;
            arr[i * 3 + 2] = c.b;
          }
          g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
          return g;
        });
        const merged = mergeGeometries(geos, false);
        for (const g of geos) g.dispose();
        for (const part of parts) {
          p.remove(part);
          part.geometry.dispose();
        }
        if (merged) p.add(new THREE.Mesh(merged, mat));
      }
    }
  }

  hitFlash(amount = 1) {
    this.flash = Math.max(this.flash, amount);
  }

  // ---------------------------------------------------------------- builders

  private addFlame(parent: THREE.Object3D, radius: number, length: number) {
    const g = pivot(parent, 0, 0, 0, 'flame');
    const outer = new THREE.ConeGeometry(radius, length, 8, 1, true);
    outer.rotateX(Math.PI);
    outer.translate(0, -length / 2, 0);
    const inner = new THREE.ConeGeometry(radius * 0.5, length * 0.6, 6, 1, true);
    inner.rotateX(Math.PI);
    inner.translate(0, (-length * 0.6) / 2, 0);
    part(g, outer, this.mats.flame);
    part(g, inner, this.mats.flameCore);
    g.visible = false;
    this.flames.push(g);
  }

  private buildLeg(side: 1 | -1, hipX: number, build: (th: THREE.Group, kn: THREE.Group, an: THREE.Group) => void) {
    const F = this.frame;
    const th = pivot(this.hips, side * hipX, -F.hipDrop, 0, 'thigh');
    const kn = pivot(th, 0, -F.thigh, 0, 'knee');
    const an = pivot(kn, 0, -F.shin, 0, 'ankle');
    build(th, kn, an);
    if (side === 1) {
      this.thL = th;
      this.knL = kn;
      this.anL = an;
    } else {
      this.thR = th;
      this.knR = kn;
      this.anR = an;
    }
  }

  private buildJebe() {
    const M = this.mats;
    const hips = this.hips;
    const waist = this.waist;

    // pelvis: V-shaped crotch block, red codpiece, white side skirts
    part(hips, taperBox(1.45, 0.62, 1.0, { bottom: [0.6, 0.8] }), M.secondary, { pos: [0, -0.1, 0] });
    part(hips, taperBox(0.55, 0.52, 0.2, { bottom: [0.55, 1] }), M.trim, { pos: [0, -0.16, 0.5], rot: [-0.1, 0, 0] });
    for (const sx of [-1, 1]) {
      part(hips, taperBox(0.24, 0.85, 0.95, { bottom: [1, 0.8] }), M.primary, {
        pos: [sx * 0.84, -0.22, 0],
        rot: [0, 0, sx * 0.14],
      });
    }
    part(hips, taperBox(1.0, 0.5, 0.25, { bottom: [0.8, 1] }), M.primary, { pos: [0, -0.15, -0.55], rot: [0.15, 0, 0] });

    // abdomen + chest
    part(waist, taperBox(0.92, 0.62, 0.74, { top: [1.2, 1.1] }), M.joint, { pos: [0, 0.18, 0] });
    part(waist, taperBox(2.1, 1.35, 1.32, { bottom: [0.6, 0.78], top: [1, 0.86], shiftTop: [0, -0.04] }), M.primary, {
      pos: [0, 1.05, 0],
    });
    part(waist, taperBox(1.46, 0.78, 0.26, { bottom: [0.66, 1] }), M.secondary, { pos: [0, 1.18, 0.6], rot: [-0.14, 0, 0] });
    for (const sx of [-1, 1]) {
      part(waist, taperBox(0.4, 0.2, 0.12), M.accent, { pos: [sx * 0.44, 1.34, 0.78], rot: [-0.14, 0, sx * -0.1] });
    }
    part(waist, taperBox(0.34, 0.3, 0.14, { top: [0.55, 1] }), M.trim, { pos: [0, 0.9, 0.72] });
    part(waist, taperBox(0.95, 0.26, 0.85, { top: [0.75, 0.75] }), M.joint, { pos: [0, 1.82, -0.05] });

    // backpack with fins and twin thrusters
    const back = pivot(waist, 0, 1.12, -0.78);
    part(back, taperBox(1.45, 1.3, 0.7, { top: [1.12, 0.9] }), M.secondary);
    part(back, taperBox(0.9, 0.18, 0.72), M.accent, { pos: [0, 0.35, 0] });
    for (const sx of [-1, 1]) {
      part(back, taperBox(0.12, 1.5, 0.75, { top: [1, 0.35], shiftTop: [sx * 0.45, -0.35] }), M.primary, {
        pos: [sx * 0.82, 0.55, -0.12],
        rot: [0, 0, sx * -0.42],
      });
      const noz = pivot(back, sx * 0.42, -0.6, -0.18);
      noz.rotation.x = 0.55;
      part(noz, prism(0.2, 0.3, 0.5, 8), M.joint, { pos: [0, -0.18, 0] });
      const fl = pivot(noz, 0, -0.42, 0);
      this.addFlame(fl, 0.3, 2.6);
    }

    // head: helmet, visor, chin, V-fin crest, forehead gem
    this.head = pivot(waist, 0, 1.92, 0.06, 'head');
    const head = this.head;
    part(head, taperBox(0.62, 0.62, 0.72, { top: [0.82, 0.78] }), M.primary, { pos: [0, 0.32, 0] });
    part(head, taperBox(0.54, 0.15, 0.08), M.eye, { pos: [0, 0.38, 0.37] });
    part(head, taperBox(0.32, 0.26, 0.3, { top: [0.6, 0.8] }), M.secondary, { pos: [0, 0.1, 0.24] });
    for (const sx of [-1, 1]) {
      part(head, taperBox(0.1, 0.95, 0.08, { top: [0.25, 1] }), M.accent, { pos: [sx * 0.24, 0.9, 0.3], rot: [-0.25, 0, sx * -0.6] });
      part(head, taperBox(0.12, 0.32, 0.3, { top: [0.6, 0.7] }), M.secondary, { pos: [sx * 0.36, 0.3, 0.02] });
    }
    part(head, taperBox(0.18, 0.2, 0.1), M.trim, { pos: [0, 0.64, 0.36] });

    // arms
    for (const side of [1, -1] as const) {
      const sh = pivot(waist, side * 1.45, 1.36, 0, 'shoulder');
      part(sh, taperBox(0.95, 0.78, 1.15, { bottom: [1.12, 1.05], top: [0.82, 0.84] }), M.secondary, { pos: [side * 0.2, 0.14, 0] });
      part(sh, taperBox(1.07, 0.15, 1.21), M.accent, { pos: [side * 0.2, -0.2, 0] });
      part(sh, taperBox(0.5, 1.25, 0.55, { anchor: 'top', bottom: [0.9, 0.9] }), M.primary, { pos: [0, -0.18, 0] });
      const el = pivot(sh, 0, -1.48, 0, 'elbow');
      part(el, prism(0.25, 0.25, 0.52, 6), M.joint, { rot: [0, 0, Math.PI / 2] });
      part(el, taperBox(0.66, 1.35, 0.72, { anchor: 'top', bottom: [0.86, 0.86] }), M.secondary, { pos: [0, -0.04, 0] });
      part(el, taperBox(0.68, 0.14, 0.74), M.accent, { pos: [0, -0.55, 0] });
      part(el, taperBox(0.4, 0.38, 0.46), M.joint, { pos: [0, -1.56, 0.04] });
      if (side === -1) {
        // right hand: long beam rifle along the forearm axis; the beam saber extends from the muzzle
        const rifle = pivot(el, 0, -1.5, 0.3, 'rifle');
        part(rifle, taperBox(0.34, 1.55, 0.52, { bottom: [0.8, 0.8] }), M.primary, { pos: [0, -0.35, 0] });
        part(rifle, taperBox(0.2, 0.7, 0.26), M.secondary, { pos: [0, -0.3, 0.32] });
        part(rifle, prism(0.11, 0.11, 2.3, 6), M.joint, { pos: [0, -2.15, 0.06] });
        part(rifle, prism(0.17, 0.17, 0.3, 6), M.accent, { pos: [0, -3.2, 0.06] });
        rifle.add(this.muzzleR);
        this.muzzleR.position.set(0, -3.4, 0.06);
        const saber = pivot(this.muzzleR, 0, 0, 0, 'saber');
        part(saber, taperBox(0.55, 4.8, 0.55, { anchor: 'top', bottom: [0.35, 0.35] }), M.saber);
        part(saber, taperBox(0.12, 4.3, 0.12, { anchor: 'top', bottom: [0.4, 0.4] }), M.saberCore);
        saber.visible = false;
        this.saber = saber;
        this.shR = sh;
        this.elR = el;
      } else {
        // left forearm: bomb launcher pod
        part(el, prism(0.52, 0.52, 0.28, 10), M.primary, { pos: [0.42, -0.72, 0], rot: [0, 0, Math.PI / 2] });
        part(el, prism(0.3, 0.3, 0.3, 10), M.trim, { pos: [0.46, -0.72, 0], rot: [0, 0, Math.PI / 2] });
        el.add(this.muzzleL);
        this.muzzleL.position.set(0, -1.75, 0.15);
        this.shL = sh;
        this.elL = el;
      }
    }
    this.fist = this.muzzleR;

    // legs
    for (const side of [1, -1] as const) {
      this.buildLeg(side, 0.6, (th, kn, an) => {
        part(th, prism(0.3, 0.3, 0.6, 8), M.joint, { rot: [0, 0, Math.PI / 2] });
        part(th, taperBox(0.6, 1.65, 0.7, { anchor: 'top', bottom: [0.85, 0.9] }), M.joint);
        part(th, taperBox(0.64, 1.05, 0.2, { bottom: [0.8, 1] }), M.primary, { pos: [0, -0.75, 0.36] });
        part(th, taperBox(0.2, 1.0, 0.6), M.primary, { pos: [side * 0.34, -0.65, 0] });
        part(kn, taperBox(0.62, 0.64, 0.4, { top: [0.82, 1] }), M.secondary, { pos: [0, -0.04, 0.42], rot: [0.28, 0, 0] });
        part(kn, taperBox(0.8, 1.85, 0.96, { anchor: 'top', bottom: [0.82, 0.78] }), M.primary, { pos: [0, 0.05, 0] });
        part(kn, taperBox(0.82, 0.16, 0.98), M.secondary, { pos: [0, -0.62, 0] });
        part(kn, taperBox(0.3, 0.8, 0.2), M.accent, { pos: [side * 0.38, -1.05, 0.12] });
        part(an, taperBox(0.82, 0.5, 1.75, { top: [0.72, 0.6], shiftTop: [0, -0.18] }), M.secondary, { pos: [0, -0.3, 0.26] });
        part(an, taperBox(0.6, 0.24, 0.42, { top: [0.8, 0.6] }), M.accent, { pos: [0, -0.43, 1.02] });
        part(an, taperBox(0.6, 0.3, 0.5), M.joint, { pos: [0, -0.38, -0.55] });
      });
    }
  }

  private buildFujin() {
    const M = this.mats;
    const hips = this.hips;
    const waist = this.waist;

    // pelvis + armored skirt
    part(hips, taperBox(2.0, 0.72, 1.3, { bottom: [0.7, 0.85] }), M.secondary, { pos: [0, -0.1, 0] });
    part(hips, taperBox(1.1, 0.75, 0.22, { bottom: [0.75, 1] }), M.primary, { pos: [0, -0.3, 0.68], rot: [-0.18, 0, 0] });
    for (const sx of [-1, 1]) {
      part(hips, taperBox(0.26, 1.0, 1.25, { bottom: [1, 0.85] }), M.primary, { pos: [sx * 1.1, -0.35, 0], rot: [0, 0, sx * 0.18] });
      part(hips, taperBox(0.28, 0.2, 1.27), M.accent, { pos: [sx * 1.1, 0.05, 0], rot: [0, 0, sx * 0.18] });
    }

    // torso: massive barrel chest with gale-laser lens
    part(waist, taperBox(1.4, 0.65, 1.1, { top: [1.15, 1.1] }), M.joint, { pos: [0, 0.2, 0] });
    part(waist, taperBox(3.0, 1.85, 1.9, { bottom: [0.7, 0.84], top: [0.94, 0.86] }), M.primary, { pos: [0, 1.25, 0] });
    for (const sx of [-1, 1]) {
      part(waist, taperBox(1.05, 1.1, 0.3, { bottom: [0.8, 1] }), M.secondary, { pos: [sx * 0.72, 1.32, 0.86], rot: [-0.1, sx * 0.18, 0] });
      part(waist, taperBox(0.22, 0.9, 0.24), M.accent, { pos: [sx * 1.32, 1.3, 0.72] });
    }
    part(waist, prism(0.55, 0.62, 0.36, 12, 'z'), M.joint, { pos: [0, 1.2, 0.98] });
    part(waist, prism(0.42, 0.42, 0.12, 12, 'z'), M.glow, { pos: [0, 1.2, 1.16] });
    waist.add(this.chest);
    this.chest.position.set(0, 1.2, 1.3);
    part(waist, taperBox(1.6, 0.35, 1.3, { top: [0.75, 0.8] }), M.trim, { pos: [0, 2.28, -0.1] });

    // backpack: big block, missile pods on top, four thrusters
    const back = pivot(waist, 0, 1.25, -1.25);
    part(back, taperBox(2.3, 1.7, 0.95, { top: [1.05, 0.9], bottom: [0.9, 1] }), M.secondary);
    for (const sx of [-1, 1]) {
      const pod = pivot(back, sx * 0.62, 1.0, 0.05);
      part(pod, taperBox(0.8, 0.5, 0.9, { top: [0.85, 0.85] }), M.primary);
      part(pod, taperBox(0.6, 0.06, 0.7), M.accent, { pos: [0, 0.27, 0] });
      const launch = new THREE.Object3D();
      launch.position.set(0, 0.4, 0);
      pod.add(launch);
      this.missilePods.push(launch);
      for (const nx of [-0.32, 0.32]) {
        const noz = pivot(back, sx * 0.62 + nx, -0.8, -0.25);
        noz.rotation.x = 0.5;
        part(noz, prism(0.2, 0.28, 0.45, 8), M.joint, { pos: [0, -0.15, 0] });
        const fl = pivot(noz, 0, -0.38, 0);
        this.addFlame(fl, 0.26, 2.2);
      }
    }

    // head: small, sunk into the shoulders, red mono-eye slit, twin antennae
    this.head = pivot(waist, 0, 2.2, 0.3, 'head');
    const head = this.head;
    part(head, taperBox(0.8, 0.55, 0.8, { top: [0.8, 0.75] }), M.primary, { pos: [0, 0.27, 0] });
    part(head, taperBox(0.62, 0.12, 0.08), M.eye, { pos: [0, 0.3, 0.41] });
    part(head, taperBox(0.5, 0.2, 0.3), M.secondary, { pos: [0, 0.08, 0.3] });
    for (const sx of [-1, 1]) {
      part(head, taperBox(0.08, 0.7, 0.12, { top: [0.4, 1] }), M.accent, { pos: [sx * 0.32, 0.75, -0.1], rot: [-0.35, 0, sx * -0.3] });
    }

    // shoulder cannons (fixed to the torso so they always point forward)
    for (const sx of [-1, 1]) {
      const cannon = pivot(waist, sx * 1.95, 2.55, 0.0, 'cannon');
      part(cannon, taperBox(0.75, 0.62, 1.7, { top: [0.85, 0.9] }), M.secondary);
      part(cannon, taperBox(0.77, 0.12, 1.2), M.accent, { pos: [0, 0.2, -0.1] });
      part(cannon, prism(0.17, 0.17, 2.3, 8, 'z'), M.joint, { pos: [0, 0.02, 1.6] });
      part(cannon, prism(0.25, 0.25, 0.32, 8, 'z'), M.joint, { pos: [0, 0.02, 2.6] });
      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0.02, 2.85);
      cannon.add(muzzle);
      this.cannons.push(muzzle);
    }

    // arms: thick upper arms, huge forearms and fists
    for (const side of [1, -1] as const) {
      const sh = pivot(waist, side * 2.0, 1.55, 0, 'shoulder');
      part(sh, taperBox(1.3, 1.05, 1.5, { bottom: [1.1, 1.05], top: [0.8, 0.82] }), M.primary, { pos: [side * 0.22, -0.02, 0] });
      part(sh, taperBox(1.42, 0.16, 1.6), M.accent, { pos: [side * 0.22, -0.42, 0] });
      part(sh, taperBox(0.72, 1.15, 0.78, { anchor: 'top', bottom: [0.9, 0.9] }), M.joint, { pos: [0, -0.35, 0] });
      const el = pivot(sh, 0, -1.55, 0, 'elbow');
      part(el, prism(0.34, 0.34, 0.7, 6), M.joint, { rot: [0, 0, Math.PI / 2] });
      part(el, taperBox(1.12, 1.45, 1.18, { anchor: 'top', top: [0.86, 0.86], bottom: [1.08, 1.06] }), M.primary, { pos: [0, -0.05, 0] });
      part(el, taperBox(1.24, 0.16, 1.3), M.secondary, { pos: [0, -1.05, 0] });
      part(el, taperBox(0.9, 0.8, 0.92, { bottom: [0.85, 0.9] }), M.secondary, { pos: [0, -1.85, 0.05] });
      if (side === -1) {
        this.shR = sh;
        this.elR = el;
        el.add(this.fist);
        this.fist.position.set(0, -2.0, 0.2);
        el.add(this.muzzleR);
        this.muzzleR.position.set(0, -2.0, 0.3);
      } else {
        this.shL = sh;
        this.elL = el;
        el.add(this.muzzleL);
        this.muzzleL.position.set(0, -2.0, 0.3);
      }
    }

    // legs: stocky, flared heavy boots
    for (const side of [1, -1] as const) {
      this.buildLeg(side, 0.85, (th, kn, an) => {
        part(th, prism(0.4, 0.4, 0.8, 8), M.joint, { rot: [0, 0, Math.PI / 2] });
        part(th, taperBox(0.95, 1.3, 1.0, { anchor: 'top', bottom: [0.9, 0.9] }), M.joint);
        part(th, taperBox(0.98, 0.8, 0.24), M.primary, { pos: [0, -0.62, 0.48] });
        part(kn, taperBox(0.9, 0.85, 0.5, { top: [0.8, 1] }), M.accent, { pos: [0, 0.0, 0.62], rot: [0.25, 0, 0] });
        part(kn, taperBox(1.22, 1.6, 1.4, { anchor: 'top', top: [0.9, 0.85], bottom: [1.12, 1.08] }), M.primary, { pos: [0, 0.05, 0] });
        part(kn, taperBox(1.36, 0.18, 1.52), M.secondary, { pos: [0, -1.25, 0] });
        part(kn, taperBox(0.3, 0.7, 0.9), M.secondary, { pos: [side * 0.66, -0.7, 0] });
        part(an, taperBox(1.3, 0.72, 2.15, { top: [0.8, 0.62], shiftTop: [0, -0.2] }), M.secondary, { pos: [0, -0.34, 0.25] });
        part(an, taperBox(1.0, 0.3, 0.5, { top: [0.8, 0.6] }), M.accent, { pos: [0, -0.5, 1.25] });
      });
    }
  }

  /** KESTREL: a slim interceptor with long legs and a swept wing binder on its back. */
  private buildKestrel() {
    const M = this.mats;
    const hips = this.hips;
    const waist = this.waist;

    // pelvis: slim, with long side blades
    part(hips, taperBox(1.2, 0.52, 0.85, { bottom: [0.55, 0.8] }), M.secondary, { pos: [0, -0.08, 0] });
    part(hips, taperBox(0.42, 0.46, 0.18, { bottom: [0.5, 1] }), M.accent, { pos: [0, -0.14, 0.44], rot: [-0.12, 0, 0] });
    for (const sx of [-1, 1]) {
      part(hips, taperBox(0.16, 0.9, 0.8, { bottom: [1, 0.6] }), M.primary, { pos: [sx * 0.7, -0.26, 0], rot: [0, 0, sx * 0.12] });
    }
    part(hips, taperBox(0.8, 0.42, 0.2, { bottom: [0.7, 1] }), M.primary, { pos: [0, -0.12, -0.45], rot: [0.2, 0, 0] });

    // abdomen + narrow chest with an air intake
    part(waist, taperBox(0.74, 0.58, 0.6, { top: [1.2, 1.1] }), M.joint, { pos: [0, 0.18, 0] });
    part(waist, taperBox(1.75, 1.15, 1.12, { bottom: [0.6, 0.8], top: [1, 0.86], shiftTop: [0, -0.06] }), M.primary, { pos: [0, 0.98, 0] });
    part(waist, taperBox(1.1, 0.5, 0.24, { bottom: [0.7, 1] }), M.secondary, { pos: [0, 1.0, 0.52], rot: [-0.16, 0, 0] });
    part(waist, taperBox(0.6, 0.16, 0.1), M.trim, { pos: [0, 0.82, 0.64], rot: [-0.16, 0, 0] });
    for (const sx of [-1, 1]) {
      part(waist, taperBox(0.34, 0.14, 0.1), M.accent, { pos: [sx * 0.42, 1.28, 0.62], rot: [-0.16, 0, sx * -0.12] });
    }
    part(waist, taperBox(0.8, 0.24, 0.7, { top: [0.75, 0.75] }), M.joint, { pos: [0, 1.66, -0.04] });

    // wing binder: a spine with two swept main wings, two short lower fins, dart pods and thrusters
    const back = pivot(waist, 0, 1.15, -0.62);
    part(back, taperBox(0.8, 1.2, 0.55, { top: [1.1, 0.9] }), M.secondary);
    for (const sx of [-1, 1]) {
      const wing = pivot(back, sx * 0.35, 0.35, -0.15);
      wing.rotation.set(-0.35, sx * -0.25, sx * -1.05);
      part(wing, taperBox(0.12, 2.9, 1.25, { anchor: 'bottom', top: [1, 0.35], shiftTop: [0, -0.55] }), M.primary);
      part(wing, taperBox(0.14, 2.7, 0.18, { anchor: 'bottom', top: [1, 0.6], shiftTop: [0, -0.5] }), M.accent, { pos: [0, 0.05, 0.62] });
      const fin = pivot(back, sx * 0.3, -0.35, -0.1);
      fin.rotation.set(-0.5, 0, sx * -2.1);
      part(fin, taperBox(0.1, 1.3, 0.7, { anchor: 'bottom', top: [1, 0.3], shiftTop: [0, -0.3] }), M.secondary);
      const pod = pivot(back, sx * 0.5, 0.62, 0.05);
      part(pod, taperBox(0.36, 0.3, 0.7, { top: [0.8, 0.8] }), M.joint);
      part(pod, taperBox(0.38, 0.06, 0.5), M.accent, { pos: [0, 0.17, 0] });
      const launch = new THREE.Object3D();
      launch.position.set(0, 0.25, 0.1);
      pod.add(launch);
      this.missilePods.push(launch);
      const noz = pivot(back, sx * 0.3, -0.62, -0.15);
      noz.rotation.x = 0.6;
      part(noz, prism(0.16, 0.26, 0.5, 8), M.joint, { pos: [0, -0.18, 0] });
      const fl = pivot(noz, 0, -0.42, 0);
      this.addFlame(fl, 0.26, 3.2);
    }

    // head: narrow and pointed, a wide visor, one swept crest
    this.head = pivot(waist, 0, 1.78, 0.04, 'head');
    const head = this.head;
    part(head, taperBox(0.5, 0.52, 0.74, { top: [0.72, 0.62], shiftTop: [0, -0.06] }), M.primary, { pos: [0, 0.28, 0] });
    part(head, taperBox(0.48, 0.12, 0.08), M.eye, { pos: [0, 0.33, 0.36] });
    part(head, taperBox(0.28, 0.22, 0.32, { top: [0.6, 0.8] }), M.secondary, { pos: [0, 0.08, 0.22] });
    part(head, taperBox(0.08, 0.85, 0.6, { anchor: 'bottom', top: [1, 0.25], shiftTop: [0, -0.5] }), M.accent, { pos: [0, 0.5, 0.05] });
    for (const sx of [-1, 1]) {
      part(head, taperBox(0.1, 0.3, 0.4, { top: [0.6, 0.6] }), M.secondary, { pos: [sx * 0.29, 0.26, -0.02] });
    }

    // arms: slim; the right carries the needle laser (its blade is the wing edge), the left a buckler
    for (const side of [1, -1] as const) {
      const sh = pivot(waist, side * 1.18, 1.22, 0, 'shoulder');
      part(sh, taperBox(0.72, 0.6, 0.92, { bottom: [1.1, 1.05], top: [0.8, 0.82] }), M.secondary, { pos: [side * 0.14, 0.1, 0] });
      part(sh, taperBox(0.8, 0.12, 0.98), M.accent, { pos: [side * 0.14, -0.18, 0] });
      part(sh, taperBox(0.42, 1.15, 0.48, { anchor: 'top', bottom: [0.9, 0.9] }), M.primary, { pos: [0, -0.14, 0] });
      const el = pivot(sh, 0, -1.34, 0, 'elbow');
      part(el, prism(0.21, 0.21, 0.44, 6), M.joint, { rot: [0, 0, Math.PI / 2] });
      part(el, taperBox(0.56, 1.25, 0.62, { anchor: 'top', bottom: [0.84, 0.84] }), M.secondary, { pos: [0, -0.04, 0] });
      part(el, taperBox(0.34, 0.32, 0.4), M.joint, { pos: [0, -1.42, 0.04] });
      if (side === -1) {
        const gun = pivot(el, 0, -1.32, 0.26, 'needle');
        part(gun, taperBox(0.28, 1.15, 0.42, { bottom: [0.8, 0.8] }), M.primary, { pos: [0, -0.28, 0] });
        part(gun, taperBox(0.16, 0.5, 0.2), M.accent, { pos: [0, -0.2, 0.26] });
        part(gun, prism(0.07, 0.07, 1.8, 6), M.joint, { pos: [0, -1.65, 0.04] });
        part(gun, prism(0.12, 0.12, 0.22, 6), M.accent, { pos: [0, -2.5, 0.04] });
        gun.add(this.muzzleR);
        this.muzzleR.position.set(0, -2.65, 0.04);
        const blade = pivot(this.muzzleR, 0, 0, 0, 'saber');
        part(blade, taperBox(0.45, 3.4, 0.45, { anchor: 'top', bottom: [0.3, 0.3] }), M.saber);
        part(blade, taperBox(0.1, 3.0, 0.1, { anchor: 'top', bottom: [0.4, 0.4] }), M.saberCore);
        blade.visible = false;
        this.saber = blade;
        this.shR = sh;
        this.elR = el;
      } else {
        part(el, prism(0.5, 0.5, 0.12, 8), M.primary, { pos: [0.34, -0.7, 0], rot: [0, 0, Math.PI / 2] });
        part(el, prism(0.24, 0.24, 0.14, 8), M.accent, { pos: [0.38, -0.7, 0], rot: [0, 0, Math.PI / 2] });
        el.add(this.muzzleL);
        this.muzzleL.position.set(0, -1.6, 0.12);
        this.shL = sh;
        this.elL = el;
      }
    }
    this.fist = this.muzzleR;

    // legs: long and thin, with calf fins and pointed feet
    for (const side of [1, -1] as const) {
      this.buildLeg(side, 0.5, (th, kn, an) => {
        part(th, prism(0.26, 0.26, 0.5, 8), M.joint, { rot: [0, 0, Math.PI / 2] });
        part(th, taperBox(0.5, 1.7, 0.58, { anchor: 'top', bottom: [0.85, 0.9] }), M.joint);
        part(th, taperBox(0.54, 1.1, 0.18, { bottom: [0.8, 1] }), M.primary, { pos: [0, -0.8, 0.3] });
        part(kn, taperBox(0.5, 0.56, 0.36, { top: [0.82, 1] }), M.secondary, { pos: [0, -0.04, 0.36], rot: [0.28, 0, 0] });
        part(kn, taperBox(0.64, 1.95, 0.8, { anchor: 'top', bottom: [0.72, 0.7] }), M.primary, { pos: [0, 0.05, 0] });
        part(kn, taperBox(0.66, 0.14, 0.82), M.secondary, { pos: [0, -0.7, 0] });
        part(kn, taperBox(0.1, 1.0, 0.6, { top: [1, 0.4], shiftTop: [0, -0.25] }), M.accent, { pos: [0, -0.8, -0.45], rot: [-0.25, 0, 0] });
        part(an, taperBox(0.6, 0.42, 1.6, { top: [0.7, 0.55], shiftTop: [0, -0.18] }), M.secondary, { pos: [0, -0.26, 0.28] });
        part(an, taperBox(0.4, 0.2, 0.5, { top: [0.6, 0.4] }), M.accent, { pos: [0, -0.36, 1.14] });
      });
    }
  }

  /** KONGO: a wedge of armor on short legs, with huge pauldrons and oversized fists. */
  private buildKongo() {
    const M = this.mats;
    const hips = this.hips;
    const waist = this.waist;

    // pelvis: broad, with a heavy front plate
    part(hips, taperBox(2.0, 0.75, 1.3, { bottom: [0.7, 0.85] }), M.secondary, { pos: [0, -0.1, 0] });
    part(hips, taperBox(1.0, 0.7, 0.24, { bottom: [0.7, 1] }), M.primary, { pos: [0, -0.26, 0.68], rot: [-0.15, 0, 0] });
    part(hips, taperBox(0.5, 0.18, 0.1), M.accent, { pos: [0, -0.05, 0.82] });
    for (const sx of [-1, 1]) {
      part(hips, taperBox(0.3, 0.95, 1.2, { bottom: [1, 0.8] }), M.primary, { pos: [sx * 1.08, -0.32, 0], rot: [0, 0, sx * 0.2] });
    }

    // torso: wide at the shoulders, a grill over the chest
    part(waist, taperBox(1.3, 0.62, 1.0, { top: [1.2, 1.1] }), M.joint, { pos: [0, 0.2, 0] });
    part(waist, taperBox(3.2, 1.85, 1.75, { bottom: [0.58, 0.78], top: [1, 0.9] }), M.primary, { pos: [0, 1.25, 0] });
    for (const sx of [-1, 1]) {
      part(waist, taperBox(1.1, 0.9, 0.3, { bottom: [0.8, 1] }), M.secondary, { pos: [sx * 0.7, 1.4, 0.82], rot: [-0.12, sx * 0.15, 0] });
    }
    part(waist, taperBox(0.7, 0.5, 0.16), M.trim, { pos: [0, 0.98, 0.84], rot: [-0.12, 0, 0] });
    for (let i = 0; i < 3; i++) part(waist, taperBox(0.62, 0.06, 0.06), M.joint, { pos: [0, 0.86 + i * 0.12, 0.93], rot: [-0.12, 0, 0] });
    part(waist, taperBox(1.4, 0.32, 1.1, { top: [0.75, 0.8] }), M.joint, { pos: [0, 2.26, -0.05] });

    // back: a compact power pack with twin exhaust stacks
    const back = pivot(waist, 0, 1.25, -1.1);
    part(back, taperBox(2.0, 1.5, 0.8, { top: [1.05, 0.9] }), M.secondary);
    for (const sx of [-1, 1]) {
      part(back, prism(0.28, 0.34, 1.4, 8), M.joint, { pos: [sx * 0.65, 1.05, -0.1], rot: [-0.3, 0, 0] });
      part(back, prism(0.3, 0.3, 0.1, 8), M.accent, { pos: [sx * 0.65, 1.72, -0.3], rot: [-0.3, 0, 0] });
      const noz = pivot(back, sx * 0.5, -0.7, -0.2);
      noz.rotation.x = 0.5;
      part(noz, prism(0.22, 0.3, 0.45, 8), M.joint, { pos: [0, -0.15, 0] });
      const fl = pivot(noz, 0, -0.38, 0);
      this.addFlame(fl, 0.3, 2.4);
    }

    // head: low, a horned helmet over a visor
    this.head = pivot(waist, 0, 2.2, 0.32, 'head');
    const head = this.head;
    part(head, taperBox(0.78, 0.52, 0.78, { top: [0.82, 0.75] }), M.primary, { pos: [0, 0.26, 0] });
    part(head, taperBox(0.6, 0.12, 0.08), M.eye, { pos: [0, 0.28, 0.4] });
    part(head, taperBox(0.56, 0.22, 0.3, { bottom: [0.7, 1] }), M.trim, { pos: [0, 0.06, 0.3] });
    for (const sx of [-1, 1]) {
      part(head, taperBox(0.12, 0.75, 0.14, { anchor: 'bottom', top: [0.3, 0.3], shiftTop: [sx * 0.15, 0.3] }), M.accent, {
        pos: [sx * 0.3, 0.45, 0.2],
        rot: [0.5, 0, sx * -0.45],
      });
    }

    // arms: huge pauldrons, piston forearms, oversized fists; the left fist can be fired off
    for (const side of [1, -1] as const) {
      const sh = pivot(waist, side * 2.05, 1.6, 0, 'shoulder');
      part(sh, taperBox(1.55, 1.15, 1.6, { bottom: [1.05, 1.05], top: [0.7, 0.75] }), M.secondary, { pos: [side * 0.25, 0.08, 0] });
      part(sh, taperBox(1.62, 0.16, 1.68), M.accent, { pos: [side * 0.25, -0.42, 0] });
      part(sh, taperBox(0.14, 0.7, 0.5, { anchor: 'bottom', top: [1, 0.3] }), M.accent, { pos: [side * 0.55, 0.6, 0], rot: [0, 0, side * -0.4] });
      part(sh, taperBox(0.7, 1.1, 0.76, { anchor: 'top', bottom: [0.9, 0.9] }), M.joint, { pos: [0, -0.35, 0] });
      const el = pivot(sh, 0, -1.5, 0, 'elbow');
      part(el, prism(0.34, 0.34, 0.7, 6), M.joint, { rot: [0, 0, Math.PI / 2] });
      part(el, taperBox(1.15, 1.4, 1.2, { anchor: 'top', top: [0.86, 0.86], bottom: [1.1, 1.08] }), M.primary, { pos: [0, -0.05, 0] });
      part(el, taperBox(1.27, 0.16, 1.32), M.secondary, { pos: [0, -1.0, 0] });
      const fist = pivot(el, 0, -1.95, 0.08, side === 1 ? 'fistL' : 'fistR');
      part(fist, taperBox(1.12, 1.0, 1.2, { bottom: [0.9, 0.9] }), M.secondary);
      part(fist, taperBox(1.14, 0.36, 0.3), M.accent, { pos: [0, 0.12, 0.5] });
      if (side === -1) {
        // scatter gun: a stubby triple barrel along the right forearm
        for (const bx of [-0.25, 0, 0.25]) part(el, prism(0.11, 0.11, 0.9, 6, 'z'), M.joint, { pos: [bx, -1.35, 0.72] });
        el.add(this.muzzleR);
        this.muzzleR.position.set(0, -1.35, 1.2);
        fist.add(this.fist);
        this.fist.position.set(0, 0, 0.6);
        this.shR = sh;
        this.elR = el;
      } else {
        fist.add(this.muzzleL);
        this.muzzleL.position.set(0, 0, 0.4);
        this.fistL = fist;
        this.shL = sh;
        this.elL = el;
      }
    }

    // legs: short and stocky, with broad feet
    for (const side of [1, -1] as const) {
      this.buildLeg(side, 0.88, (th, kn, an) => {
        part(th, prism(0.42, 0.42, 0.8, 8), M.joint, { rot: [0, 0, Math.PI / 2] });
        part(th, taperBox(0.95, 1.25, 1.0, { anchor: 'top', bottom: [0.9, 0.9] }), M.joint);
        part(th, taperBox(1.0, 0.8, 0.24), M.primary, { pos: [0, -0.6, 0.5] });
        part(kn, taperBox(0.95, 0.8, 0.55, { top: [0.8, 1] }), M.accent, { pos: [0, 0, 0.62], rot: [0.25, 0, 0] });
        part(kn, taperBox(1.28, 1.45, 1.42, { anchor: 'top', top: [0.88, 0.85], bottom: [1.12, 1.1] }), M.primary, { pos: [0, 0.05, 0] });
        part(kn, taperBox(1.4, 0.18, 1.55), M.secondary, { pos: [0, -1.12, 0] });
        part(an, taperBox(1.42, 0.72, 2.2, { top: [0.8, 0.62], shiftTop: [0, -0.2] }), M.secondary, { pos: [0, -0.34, 0.25] });
        part(an, taperBox(1.1, 0.3, 0.5, { top: [0.8, 0.6] }), M.accent, { pos: [0, -0.5, 1.28] });
      });
    }
  }

  /** ARACHNE: a hunched trapper with a drone hive on its back and four spider legs. */
  private buildArachne() {
    const M = this.mats;
    const hips = this.hips;
    const waist = this.waist;

    part(hips, taperBox(1.6, 0.62, 1.1, { bottom: [0.65, 0.85] }), M.secondary, { pos: [0, -0.1, 0] });
    part(hips, taperBox(0.7, 0.6, 0.2, { bottom: [0.6, 1] }), M.primary, { pos: [0, -0.2, 0.56], rot: [-0.15, 0, 0] });
    for (const sx of [-1, 1]) {
      part(hips, taperBox(0.22, 0.85, 1.0, { bottom: [1, 0.75] }), M.primary, { pos: [sx * 0.9, -0.28, 0], rot: [0, 0, sx * 0.16] });
    }

    // torso: hunched forward, chest plates edged in the accent color
    part(waist, taperBox(1.0, 0.6, 0.8, { top: [1.2, 1.1] }), M.joint, { pos: [0, 0.18, 0] });
    part(waist, taperBox(2.3, 1.4, 1.5, { bottom: [0.62, 0.8], top: [0.95, 0.88], shiftTop: [0, 0.12] }), M.primary, { pos: [0, 1.05, 0] });
    for (const sx of [-1, 1]) {
      part(waist, taperBox(0.95, 0.8, 0.24, { bottom: [0.8, 1] }), M.secondary, { pos: [sx * 0.55, 1.12, 0.8], rot: [-0.05, sx * 0.18, 0] });
      part(waist, taperBox(0.95, 0.06, 0.26), M.accent, { pos: [sx * 0.55, 1.54, 0.8], rot: [-0.05, sx * 0.18, 0] });
    }
    part(waist, taperBox(1.1, 0.3, 1.0, { top: [0.75, 0.8] }), M.joint, { pos: [0, 1.86, 0.02] });

    // back: the drone hive, two launch ports, four spider legs and the thrusters
    const back = pivot(waist, 0, 1.2, -0.85);
    part(back, taperBox(1.9, 1.5, 1.7, { top: [0.72, 0.62], bottom: [0.8, 0.7] }), M.secondary, { pos: [0, 0.1, -0.5], rot: [-0.35, 0, 0] });
    part(back, taperBox(1.5, 0.12, 1.2), M.accent, { pos: [0, 0.55, -0.55], rot: [-0.35, 0, 0] });
    for (const sx of [-1, 1]) {
      const port = pivot(back, sx * 0.45, 0.85, -0.3);
      part(port, prism(0.26, 0.3, 0.35, 8), M.joint);
      part(port, prism(0.18, 0.18, 0.06, 8), M.glow, { pos: [0, 0.2, 0] });
      const launch = new THREE.Object3D();
      launch.position.set(0, 0.35, 0);
      port.add(launch);
      this.missilePods.push(launch);
      for (const k of [0, 1]) {
        const leg = pivot(back, sx * 0.75, 0.4 - k * 0.5, -0.3 - k * 0.4);
        leg.rotation.set(-0.3 - k * 0.35, 0, sx * -(0.9 + k * 0.25));
        part(leg, taperBox(0.16, 1.9, 0.2, { anchor: 'bottom', top: [0.7, 0.7] }), M.primary);
        // the tip bends back out and down, like a spider's leg over its back
        const tip = pivot(leg, 0, 1.9, 0);
        tip.rotation.z = sx * -1.4;
        part(tip, taperBox(0.13, 1.6, 0.16, { anchor: 'bottom', top: [0.2, 0.2] }), M.joint);
        part(tip, taperBox(0.15, 0.3, 0.18), M.accent, { pos: [0, 0.1, 0] });
      }
      const noz = pivot(back, sx * 0.4, -0.65, -0.35);
      noz.rotation.x = 0.55;
      part(noz, prism(0.18, 0.26, 0.42, 8), M.joint, { pos: [0, -0.15, 0] });
      const fl = pivot(noz, 0, -0.36, 0);
      this.addFlame(fl, 0.26, 2.3);
    }

    // head: low and wide, a cluster of four eyes over two fangs
    this.head = pivot(waist, 0, 1.95, 0.24, 'head');
    const head = this.head;
    part(head, taperBox(0.92, 0.46, 0.78, { top: [0.82, 0.72] }), M.primary, { pos: [0, 0.24, 0] });
    for (const [ex, ey] of [
      [-0.2, 0.34],
      [0.2, 0.34],
      [-0.13, 0.19],
      [0.13, 0.19],
    ]) {
      part(head, taperBox(0.16, 0.09, 0.06), M.eye, { pos: [ex, ey, 0.4] });
    }
    for (const sx of [-1, 1]) {
      part(head, taperBox(0.1, 0.32, 0.12, { top: [0.3, 0.3] }), M.trim, { pos: [sx * 0.16, -0.05, 0.36], rot: [0.2, 0, sx * 0.2] });
    }
    part(head, taperBox(0.5, 0.1, 0.5), M.accent, { pos: [0, 0.5, -0.05] });

    // arms: the right holds the net launcher, the left a mine drum
    for (const side of [1, -1] as const) {
      const sh = pivot(waist, side * 1.55, 1.3, 0, 'shoulder');
      part(sh, taperBox(1.0, 0.82, 1.1, { bottom: [1.1, 1.05], top: [0.78, 0.8] }), M.secondary, { pos: [side * 0.18, 0.1, 0] });
      part(sh, taperBox(1.1, 0.12, 1.18), M.accent, { pos: [side * 0.18, -0.28, 0] });
      part(sh, taperBox(0.5, 1.2, 0.56, { anchor: 'top', bottom: [0.9, 0.9] }), M.primary, { pos: [0, -0.2, 0] });
      const el = pivot(sh, 0, -1.45, 0, 'elbow');
      part(el, prism(0.25, 0.25, 0.52, 6), M.joint, { rot: [0, 0, Math.PI / 2] });
      part(el, taperBox(0.7, 1.3, 0.74, { anchor: 'top', bottom: [0.9, 0.9] }), M.secondary, { pos: [0, -0.04, 0] });
      part(el, taperBox(0.4, 0.38, 0.46), M.joint, { pos: [0, -1.5, 0.04] });
      if (side === -1) {
        const launcher = pivot(el, 0, -1.2, 0.3, 'launcher');
        part(launcher, taperBox(0.62, 1.0, 0.7, { bottom: [0.9, 0.9] }), M.primary, { pos: [0, -0.3, 0] });
        part(launcher, prism(0.36, 0.36, 0.14, 8), M.accent, { pos: [0, -0.88, 0] });
        part(launcher, prism(0.22, 0.22, 0.16, 8), M.glow, { pos: [0, -0.96, 0] });
        launcher.add(this.muzzleR);
        this.muzzleR.position.set(0, -1.1, 0);
        this.shR = sh;
        this.elR = el;
      } else {
        part(el, prism(0.46, 0.46, 0.5, 8), M.primary, { pos: [0.45, -0.75, 0], rot: [0, 0, Math.PI / 2] });
        for (const rx of [0.2, 0.7]) part(el, prism(0.48, 0.48, 0.06, 8), M.accent, { pos: [rx, -0.75, 0], rot: [0, 0, Math.PI / 2] });
        el.add(this.muzzleL);
        this.muzzleL.position.set(0, -1.75, 0.15);
        this.shL = sh;
        this.elL = el;
      }
    }
    this.fist = this.muzzleR;

    // legs: armored, with spiked knees
    for (const side of [1, -1] as const) {
      this.buildLeg(side, 0.7, (th, kn, an) => {
        part(th, prism(0.32, 0.32, 0.62, 8), M.joint, { rot: [0, 0, Math.PI / 2] });
        part(th, taperBox(0.7, 1.45, 0.78, { anchor: 'top', bottom: [0.85, 0.9] }), M.joint);
        part(th, taperBox(0.74, 0.9, 0.2), M.primary, { pos: [0, -0.68, 0.4] });
        part(kn, taperBox(0.2, 0.75, 0.2, { anchor: 'bottom', top: [0.2, 0.2], shiftTop: [0, 0.2] }), M.accent, { pos: [0, 0.05, 0.42], rot: [0.9, 0, 0] });
        part(kn, taperBox(0.92, 1.7, 1.0, { anchor: 'top', bottom: [0.86, 0.82] }), M.primary, { pos: [0, 0.05, 0] });
        part(kn, taperBox(0.94, 0.14, 1.02), M.secondary, { pos: [0, -0.62, 0] });
        part(kn, taperBox(0.26, 0.8, 0.22), M.accent, { pos: [side * 0.42, -1.0, 0.1] });
        part(an, taperBox(0.95, 0.5, 1.8, { top: [0.75, 0.6], shiftTop: [0, -0.18] }), M.secondary, { pos: [0, -0.3, 0.24] });
        part(an, taperBox(0.6, 0.24, 0.42, { top: [0.8, 0.6] }), M.accent, { pos: [0, -0.43, 1.05] });
      });
    }
  }

  // ---------------------------------------------------------------- animation

  update(p: MechPose, dt: number) {
    this.time += dt;
    const F = this.frame;
    const t = this.tgt;

    // locomotion
    const walk = p.walkAmt;
    const s = Math.sin(p.walkPhase);
    const c = Math.cos(p.walkPhase);
    const f = p.moveF;
    const st = p.moveS;
    t.thLX = -s * 0.52 * walk * f;
    t.thRX = s * 0.52 * walk * f;
    t.thLZ = -0.3 * walk * st * Math.max(0, -s);
    t.thRZ = -0.3 * walk * st * Math.max(0, s);
    t.knL = walk * (0.12 + 0.75 * Math.max(0, c) * Math.abs(f) + 0.45 * Math.max(0, -s) * Math.abs(st));
    t.knR = walk * (0.12 + 0.75 * Math.max(0, -c) * Math.abs(f) + 0.45 * Math.max(0, s) * Math.abs(st));
    const breathe = Math.sin(this.time * 2.1) * 0.025 * (1 - walk);
    t.hipsX = 0.07 * walk * f;
    t.hipsZ = 0.08 * walk * st;
    t.waistX = breathe;
    t.waistY = s * 0.1 * walk * f + p.twist;
    t.waistZ = 0;
    t.headX = -breathe;
    t.headY = p.twist * 0.6;
    t.shLX = F.armRestX + s * 0.25 * walk * f;
    t.shRX = F.armRestX - s * 0.25 * walk * f;
    t.shLZ = F.armRestZ;
    t.shRZ = -F.armRestZ;
    t.elL = F.elbowRest;
    t.elR = F.elbowRest;

    // airborne: tuck the legs
    const a = p.air;
    if (a > 0) {
      t.thLX = lerp(t.thLX, -0.8, a);
      t.thRX = lerp(t.thRX, -0.32, a);
      t.thLZ = lerp(t.thLZ, 0.05, a);
      t.thRZ = lerp(t.thRZ, -0.05, a);
      t.knL = lerp(t.knL, 1.35, a);
      t.knR = lerp(t.knR, 0.75, a);
      t.shLZ = lerp(t.shLZ, 0.42, a);
      t.shRZ = lerp(t.shRZ, -0.42, a);
      t.shLX = lerp(t.shLX, -0.35, a);
      t.shRX = lerp(t.shRX, -0.35, a);
    }

    // dash: lean into the direction of travel, legs trail
    const d = p.dash;
    if (d > 0) {
      t.hipsX = lerp(t.hipsX, 0.45 * p.dashF, d);
      t.hipsZ = lerp(t.hipsZ, 0.42 * p.dashS, d);
      const legBack = 0.42 * p.dashF - 0.05;
      t.thLX = lerp(t.thLX, legBack, d);
      t.thRX = lerp(t.thRX, legBack + 0.12, d);
      t.thLZ = lerp(t.thLZ, 0.22 * p.dashS + 0.06, d);
      t.thRZ = lerp(t.thRZ, 0.22 * p.dashS - 0.06, d);
      t.knL = lerp(t.knL, 0.65 + 0.35 * Math.abs(p.dashF), d);
      t.knR = lerp(t.knR, 0.85 + 0.35 * Math.abs(p.dashF), d);
      t.shLX = lerp(t.shLX, 0.55 * p.dashF - 0.1, d);
      t.shRX = lerp(t.shRX, 0.55 * p.dashF - 0.1, d);
      t.shLZ = lerp(t.shLZ, 0.35 + 0.35 * Math.max(0, p.dashS), d);
      t.shRZ = lerp(t.shRZ, -0.35 - 0.35 * Math.max(0, -p.dashS), d);
    }

    // crouch (landing, guard, charging)
    const k = Math.max(p.crouch, p.guard * 0.55);
    if (k > 0) {
      t.thLX = lerp(t.thLX, -0.85, k);
      t.thRX = lerp(t.thRX, -0.7, k);
      t.knL = lerp(t.knL, 1.55, k);
      t.knR = lerp(t.knR, 1.35, k);
      t.hipsX = lerp(t.hipsX, 0.22, k);
    }

    // guard: arms crossed in front
    if (p.guard > 0) {
      const g = p.guard;
      t.shLX = lerp(t.shLX, -1.2, g);
      t.shLZ = lerp(t.shLZ, -0.5, g);
      t.elL = lerp(t.elL, -1.5, g);
      t.shRX = lerp(t.shRX, -1.3, g);
      t.shRZ = lerp(t.shRZ, 0.5, g);
      t.elR = lerp(t.elR, -1.4, g);
      t.headX = lerp(t.headX, 0.2, g);
    }

    // weapon poses
    const pitch = p.aimPitch;
    if (p.aimR > 0) {
      const r = p.aimR;
      t.shRX = lerp(t.shRX, -1.5 - pitch, r);
      t.shRZ = lerp(t.shRZ, this.rig.aimRZ, r);
      t.elR = lerp(t.elR, -0.04, r);
      t.waistY += 0.12 * r;
    }
    if (p.aimBoth > 0) {
      const b = p.aimBoth;
      t.shRX = lerp(t.shRX, -1.48 - pitch, b);
      t.shRZ = lerp(t.shRZ, 0.12, b);
      t.elR = lerp(t.elR, -0.05, b);
      t.shLX = lerp(t.shLX, -1.25 - pitch, b);
      t.shLZ = lerp(t.shLZ, -0.62, b);
      t.elL = lerp(t.elL, -0.55, b);
      t.waistY += 0.25 * b;
    }
    if (p.throwW > 0) {
      const w = p.throwW;
      const tp = p.throwL;
      const up = tp < 0.35 ? lerp(-0.6, -2.75, tp / 0.35) : lerp(-2.75, -1.0, saturate((tp - 0.35) / 0.4));
      const elb = tp < 0.35 ? -1.3 : lerp(-1.3, -0.15, saturate((tp - 0.35) / 0.3));
      t.shLX = lerp(t.shLX, up, w);
      t.shLZ = lerp(t.shLZ, 0.15, w);
      t.elL = lerp(t.elL, elb, w);
      t.waistY += (tp < 0.35 ? 0.3 : -0.25) * w;
    }
    if (p.beam > 0) {
      const b = p.beam;
      t.shLX = lerp(t.shLX, -0.55, b);
      t.shRX = lerp(t.shRX, -0.55, b);
      t.shLZ = lerp(t.shLZ, 1.05, b);
      t.shRZ = lerp(t.shRZ, -1.05, b);
      t.elL = lerp(t.elL, -1.0, b);
      t.elR = lerp(t.elR, -1.0, b);
      t.waistX = lerp(t.waistX, -0.08 - pitch * 0.6, b);
      t.hipsX = lerp(t.hipsX, -0.1, b);
      t.thLX = lerp(t.thLX, -0.45, b);
      t.thRX = lerp(t.thRX, 0.3, b);
      t.knL = lerp(t.knL, 0.6, b);
      t.knR = lerp(t.knR, 0.35, b);
    }
    if (p.punchW > 0) {
      // rocket fist: cock the left arm back, then drive it straight out
      const w = p.punchW;
      const u = p.punchL;
      const cocked = u < 0.3;
      t.shLX = lerp(t.shLX, cocked ? lerp(-0.2, 0.55, u / 0.3) : -1.55 - pitch, w);
      t.shLZ = lerp(t.shLZ, 0.08, w);
      t.elL = lerp(t.elL, cocked ? -1.75 : lerp(-1.75, 0, saturate((u - 0.3) / 0.12)), w);
      t.waistY += (cocked ? -0.45 : 0.4) * w;
      t.hipsX = lerp(t.hipsX, 0.12, w);
    }
    if (p.slamW > 0) {
      // quake slam: both fists overhead, then hammered into the ground
      const w = p.slamW;
      const u = p.slam;
      const raised = u < 0.42;
      const sx = raised ? lerp(-0.5, -2.95, saturate(u / 0.28)) : lerp(-2.95, -0.3, saturate((u - 0.42) / 0.07));
      t.shLX = lerp(t.shLX, sx, w);
      t.shRX = lerp(t.shRX, sx, w);
      t.shLZ = lerp(t.shLZ, raised ? -0.2 : 0.25, w);
      t.shRZ = lerp(t.shRZ, raised ? 0.2 : -0.25, w);
      t.elL = lerp(t.elL, -0.3, w);
      t.elR = lerp(t.elR, -0.3, w);
      t.hipsX = lerp(t.hipsX, raised ? -0.1 : 0.55, w);
      t.waistX = lerp(t.waistX, raised ? -0.22 : 0.4, w);
      t.headX = lerp(t.headX, raised ? -0.2 : 0.3, w);
    }
    if (p.ram > 0) {
      // shoulder ram: right shoulder first, head down, arms tucked
      const r = p.ram;
      t.hipsX = lerp(t.hipsX, 0.5, r);
      t.waistY = lerp(t.waistY, 0.7, r);
      t.shRX = lerp(t.shRX, -0.2, r);
      t.shRZ = lerp(t.shRZ, -0.45, r);
      t.elR = lerp(t.elR, -1.5, r);
      t.shLX = lerp(t.shLX, -0.9, r);
      t.shLZ = lerp(t.shLZ, -0.2, r);
      t.elL = lerp(t.elL, -1.7, r);
      t.headX = lerp(t.headX, 0.3, r);
    }
    if (p.meleeW > 0) this.meleePose(p.melee, p.meleeW);

    // reactions
    if (p.stagger > 0) {
      const g = p.stagger;
      const j = Math.sin(this.time * 60) * 0.06 * g;
      t.hipsX = lerp(t.hipsX, -0.32 + j, g);
      t.waistX = lerp(t.waistX, -0.28, g);
      t.shLZ = lerp(t.shLZ, 0.9, g);
      t.shRZ = lerp(t.shRZ, -0.9, g);
      t.shLX = lerp(t.shLX, -0.7, g);
      t.shRX = lerp(t.shRX, -0.7, g);
      t.headX = lerp(t.headX, -0.4, g);
    }
    if (p.down > 0) {
      const g = p.down;
      t.hipsX = lerp(t.hipsX, -1.42, g);
      t.hipsZ = lerp(t.hipsZ, 0, g);
      t.thLX = lerp(t.thLX, -0.25, g);
      t.thRX = lerp(t.thRX, -0.05, g);
      t.knL = lerp(t.knL, 0.7, g);
      t.knR = lerp(t.knR, 0.25, g);
      t.shLZ = lerp(t.shLZ, 1.1, g);
      t.shRZ = lerp(t.shRZ, -1.1, g);
      t.shLX = lerp(t.shLX, -0.3, g);
      t.shRX = lerp(t.shRX, -0.3, g);
      t.waistY = lerp(t.waistY, 0, g);
      t.headX = lerp(t.headX, 0.35, g);
    }
    if (p.recoil > 0) {
      t.waistX -= p.recoil * 0.12;
      if (this.rig.gunArm) t.shRX -= p.recoil * 0.3;
    }

    // smooth all channels toward their targets
    const cur = this.cur;
    const lambda = p.meleeW > 0 ? 30 : 18;
    for (const ch of CHANNELS) cur[ch] = damp(cur[ch], t[ch], lambda, dt);

    // plant the feet: hip height follows the straighter (supporting) leg
    const extL = F.thigh * Math.cos(cur.thLX) * Math.cos(cur.thLZ) + F.shin * Math.cos(cur.thLX + cur.knL) * Math.cos(cur.thLZ);
    const extR = F.thigh * Math.cos(cur.thRX) * Math.cos(cur.thRZ) + F.shin * Math.cos(cur.thRX + cur.knR) * Math.cos(cur.thRZ);
    const planted = F.ankleH + F.hipDrop + Math.max(extL, extR);
    const g = (1 - a) * (1 - d);
    let hipY = lerp(this.hipBase + 0.45 * d - 0.15 * a, planted, g);
    this.downW = damp(this.downW, p.down, lambda, dt);
    hipY = lerp(hipY, 1.0, this.downW);

    this.hips.position.y = hipY;
    this.hips.rotation.set(cur.hipsX, 0, cur.hipsZ);
    this.waist.rotation.set(cur.waistX, cur.waistY, cur.waistZ);
    this.head.rotation.set(cur.headX, cur.headY, 0);
    this.shL.rotation.set(cur.shLX, 0, cur.shLZ);
    this.shR.rotation.set(cur.shRX, 0, cur.shRZ);
    this.elL.rotation.x = cur.elL;
    this.elR.rotation.x = cur.elR;
    this.thL.rotation.set(cur.thLX, 0, cur.thLZ);
    this.thR.rotation.set(cur.thRX, 0, cur.thRZ);
    this.knL.rotation.x = cur.knL;
    this.knR.rotation.x = cur.knR;
    // keep soles flat on the ground, point toes in the air
    this.anL.rotation.x = lerp(0.4, -(cur.thLX + cur.knL), g);
    this.anR.rotation.x = lerp(0.4, -(cur.thRX + cur.knR), g);
    this.anL.rotation.z = -cur.thLZ * g;
    this.anR.rotation.z = -cur.thRZ * g;

    // thrusters
    const th = p.thrust;
    for (const fl of this.flames) {
      fl.visible = th > 0.03;
      if (fl.visible) {
        const flick = 0.8 + Math.random() * 0.4;
        fl.scale.set(0.7 + th * 0.4, th * flick, 0.7 + th * 0.4);
      }
    }

    // a launched rocket fist leaves the arm until the punch is over
    if (this.fistL) this.fistL.visible = p.fistOut < 0.5;

    // saber
    if (this.saber) {
      this.saber.visible = p.saber > 0.02;
      this.saber.scale.set(1, Math.max(0.01, p.saber), 1);
    }

    // charge glow
    this.chargeGlow.visible = p.charge > 0.01;
    if (this.chargeGlow.visible) {
      const [rest, full] = this.rig.chargeSize;
      const sz = rest + p.charge * full * (0.85 + Math.random() * 0.3);
      this.chargeGlow.scale.set(sz, sz, 1);
    }

    // hit flash
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 7);
      const v = this.flash * 0.9;
      for (const m of this.litMaterials) m.emissive.setRGB(v, v, v);
    }
  }

  private meleePose(mp: number, w: number) {
    const t = this.tgt;
    if (this.spec.melee.style === 'slash') {
      // overhead wind-up, then a diagonal slash across the body
      let shX: number;
      let shZ: number;
      let wy: number;
      let el: number;
      if (mp < 0.32) {
        const u = mp / 0.32;
        shX = lerp(-0.4, -2.8, u);
        shZ = lerp(0, -0.35, u);
        wy = lerp(0, -0.55, u);
        el = lerp(-0.6, -0.9, u);
      } else if (mp < 0.55) {
        const u = (mp - 0.32) / 0.23;
        shX = lerp(-2.8, -0.55, u);
        shZ = lerp(-0.35, 0.85, u);
        wy = lerp(-0.55, 0.7, u);
        el = lerp(-0.9, -0.1, u);
      } else {
        const u = (mp - 0.55) / 0.45;
        shX = lerp(-0.55, -0.6, u);
        shZ = lerp(0.85, 0.5, u);
        wy = lerp(0.7, 0.35, u);
        el = -0.1;
      }
      t.shRX = lerp(t.shRX, shX, w);
      t.shRZ = lerp(t.shRZ, shZ, w);
      t.elR = lerp(t.elR, el, w);
      t.waistY = lerp(t.waistY, wy, w);
      t.hipsX = lerp(t.hipsX, 0.25, w);
      t.shLX = lerp(t.shLX, 0.3, w);
      t.shLZ = lerp(t.shLZ, 0.5, w);
      t.thLX = lerp(t.thLX, -0.7, w);
      t.knL = lerp(t.knL, 0.9, w);
      t.thRX = lerp(t.thRX, 0.45, w);
      t.knR = lerp(t.knR, 0.5, w);
    } else {
      // heavy straight punch
      let shX: number;
      let el: number;
      let wy: number;
      if (mp < 0.35) {
        const u = mp / 0.35;
        shX = lerp(-0.2, 0.55, u);
        el = lerp(-0.45, -1.7, u);
        wy = lerp(0, -0.6, u);
      } else if (mp < 0.52) {
        const u = (mp - 0.35) / 0.17;
        shX = lerp(0.55, -1.62, u);
        el = lerp(-1.7, 0, u);
        wy = lerp(-0.6, 0.45, u);
      } else {
        shX = -1.62;
        el = 0;
        wy = 0.45;
      }
      t.shRX = lerp(t.shRX, shX, w);
      t.shRZ = lerp(t.shRZ, 0.1, w);
      t.elR = lerp(t.elR, el, w);
      t.waistY = lerp(t.waistY, wy, w);
      t.hipsX = lerp(t.hipsX, 0.2, w);
      t.shLX = lerp(t.shLX, 0.4, w);
      t.elL = lerp(t.elL, -1.2, w);
      t.thLX = lerp(t.thLX, -0.6, w);
      t.knL = lerp(t.knL, 0.7, w);
      t.thRX = lerp(t.thRX, 0.4, w);
      t.knR = lerp(t.knR, 0.35, w);
    }
  }

  /** Collect world-space copies of every mesh — used to blow the mech apart on defeat. */
  collectPieces(): { mesh: THREE.Mesh; world: THREE.Matrix4 }[] {
    this.root.updateMatrixWorld(true);
    const out: { mesh: THREE.Mesh; world: THREE.Matrix4 }[] = [];
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh && o.visible) {
        const mat = o.material as THREE.Material;
        if (mat.blending === THREE.AdditiveBlending) return;
        let visible = true;
        o.traverseAncestors((p) => {
          if (!p.visible) visible = false;
        });
        if (visible) out.push({ mesh: o, world: o.matrixWorld.clone() });
      }
    });
    return out;
  }

  dispose() {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const m of Object.values(this.mats)) m.dispose();
    this.lit.dispose();
    this.glowMat.dispose();
    (this.chargeGlow.material as THREE.SpriteMaterial).dispose();
  }
}
