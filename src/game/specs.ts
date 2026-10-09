export type MechId = 'jebe' | 'fujin';
export type Slot = 'lw' | 'rw' | 'cw';
export type StageId = 'harbor' | 'foundry';

export interface Palette {
  primary: number;
  secondary: number;
  accent: number;
  joint: number;
  trim: number;
  /** emissive: eyes/visor */
  eye: number;
  /** thruster flame tint */
  flame: number;
  /** weapon energy color */
  beam: number;
}

export interface WeaponDef {
  name: string;
  /** gauge fraction consumed per use */
  cost: number;
  /** gauge refilled per second */
  regen: number;
}

export interface MechSpec {
  id: MechId;
  name: string;
  code: string;
  blurb: string;
  hp: number;
  walkSpeed: number;
  backSpeed: number;
  dashSpeed: number;
  dashMin: number;
  dashMax: number;
  airDashSpeed: number;
  airDashTime: number;
  jumpVel: number;
  gravity: number;
  /** auto-facing turn rate, rad/s */
  turnRate: number;
  /** manual quick-turn rate, rad/s */
  quickTurn: number;
  radius: number;
  height: number;
  meleeRange: number;
  weapons: Record<Slot, WeaponDef>;
  melee: { name: string; damage: number };
  stats: { armor: number; speed: number; power: number; range: number };
  palette: Palette;
  altPalette: Palette;
  homeStage: StageId;
}

export const JEBE: MechSpec = {
  id: 'jebe',
  name: 'JEBE',
  code: 'MBV-04 / LIGHT ASSAULT',
  blurb: 'All-round assault frame. Long beam rifle doubles as a beam saber at close range.',
  hp: 1000,
  walkSpeed: 17,
  backSpeed: 14,
  dashSpeed: 54,
  dashMin: 0.3,
  dashMax: 0.7,
  airDashSpeed: 46,
  airDashTime: 0.42,
  jumpVel: 30,
  gravity: 34,
  turnRate: 2.7,
  quickTurn: 4.2,
  radius: 1.9,
  height: 7.4,
  meleeRange: 11,
  weapons: {
    lw: { name: 'PULSE BOMB', cost: 0.5, regen: 0.22 },
    rw: { name: 'BEAM RIFLE', cost: 0.2, regen: 0.4 },
    cw: { name: 'HYPER BEAM', cost: 1, regen: 0.14 },
  },
  melee: { name: 'BEAM SABER', damage: 140 },
  stats: { armor: 3, speed: 4, power: 3, range: 4 },
  palette: {
    primary: 0xeef1f7,
    secondary: 0x2a5bd7,
    accent: 0xffc51f,
    joint: 0x343947,
    trim: 0xe0303c,
    eye: 0x7dfcff,
    flame: 0x8fd8ff,
    beam: 0x5ae6ff,
  },
  altPalette: {
    primary: 0x34363f,
    secondary: 0xb51c2e,
    accent: 0xffae1f,
    joint: 0x17181d,
    trim: 0xeef1f7,
    eye: 0xff5a3a,
    flame: 0xff9a7a,
    beam: 0xff5a78,
  },
  homeStage: 'harbor',
};

export const FUJIN: MechSpec = {
  id: 'fujin',
  name: 'FUJIN',
  code: 'HBV-12 / HEAVY ARTILLERY',
  blurb: 'Siege frame with shoulder cannons, cluster missiles and a chest-mounted gale laser.',
  hp: 1250,
  walkSpeed: 13.5,
  backSpeed: 11,
  dashSpeed: 45,
  dashMin: 0.32,
  dashMax: 0.68,
  airDashSpeed: 37,
  airDashTime: 0.38,
  jumpVel: 26,
  gravity: 36,
  turnRate: 2.15,
  quickTurn: 3.4,
  radius: 2.4,
  height: 7.6,
  meleeRange: 10,
  weapons: {
    lw: { name: 'CLUSTER MISSILE', cost: 0.5, regen: 0.2 },
    rw: { name: 'SHOULDER CANNON', cost: 0.25, regen: 0.34 },
    cw: { name: 'GALE LASER', cost: 1, regen: 0.11 },
  },
  melee: { name: 'HAMMER KNUCKLE', damage: 160 },
  stats: { armor: 5, speed: 2, power: 5, range: 3 },
  palette: {
    primary: 0x3f8f6c,
    secondary: 0x3c4150,
    accent: 0xff9a1c,
    joint: 0x23262e,
    trim: 0xe6dfcb,
    eye: 0xff3b30,
    flame: 0xffb04a,
    beam: 0xffc94a,
  },
  altPalette: {
    primary: 0xdde1ea,
    secondary: 0x5b3fbf,
    accent: 0x22e0c0,
    joint: 0x2a2440,
    trim: 0x22e0c0,
    eye: 0x58ffea,
    flame: 0x8affef,
    beam: 0x9a7dff,
  },
  homeStage: 'foundry',
};

export const ROSTER: MechSpec[] = [JEBE, FUJIN];
