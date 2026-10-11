export type MechId = 'jebe' | 'fujin' | 'kestrel' | 'kongo' | 'arachne';
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
  /** hold DASH on the ground: steerable high-speed glide (costs no EN) */
  boostSpeed: number;
  /** hold DASH in the air: hover-glide (costs EN) */
  airBoostSpeed: number;
  /** tap DASH: peak speed of the quick-boost burst */
  qbSpeed: number;
  /** EN spent per quick boost (the gauge is 0..1) */
  qbCost: number;
  /** EN refilled per second once you ease off */
  enRegen: number;
  /** hold JUMP: thruster climb rate */
  ascendSpeed: number;
  /** how hard the frame speeds up (u/s²) — lower = heavier */
  accel: number;
  /** sideways grip (u/s²): how tightly a fast line can bend — less grip, wider arcs */
  carve: number;
  /** ground braking (u/s²) when you let go — momentum above walking pace bleeds at half this while moving */
  grip: number;
  jumpVel: number;
  gravity: number;
  /** auto-facing turn rate, rad/s */
  turnRate: number;
  /** manual quick-turn rate, rad/s */
  quickTurn: number;
  radius: number;
  height: number;
  meleeRange: number;
  /** EN spent climbing and air boosting, relative to the standard frame (light fliers spend less) */
  airEN: number;
  /** a heavy frame: thudding footsteps, and hard landings shake the ground */
  heavy: boolean;
  /** the center weapon is a close-range attack of its own: it never turns into a melee strike up close */
  closeCW?: boolean;
  weapons: Record<Slot, WeaponDef>;
  /** a move worth listing beside the weapons on the select screen (e.g. what a button does while boosting) */
  special?: { label: string; name: string };
  melee: MeleeDef;
  stats: { armor: number; speed: number; power: number; range: number };
  /** how the CPU pilots this VR */
  ai: AiHints;
  palette: Palette;
  altPalette: Palette;
  homeStage: StageId;
}

export interface MeleeDef {
  name: string;
  damage: number;
  /** a blade swung across the body, or a punch */
  style: 'slash' | 'punch';
  duration: number;
  /** the lunge toward the target: how long it lasts and how fast it goes */
  lunge: { until: number; speed: number };
  /** when the blow can land */
  hit: [number, number];
  /** when the swing sound plays */
  swing: number;
  /** light hits don't stagger it out of the lunge */
  armor?: boolean;
  /** the swing sound, re-pitched */
  pitch?: number;
}

export interface AiHints {
  /** distance band the CPU tries to fight at */
  range: [number, number];
  /** how keen it is to rush in for a melee strike (per second) */
  rush: number;
  /** distance band it fires the center weapon in */
  cw: [number, number];
  /** furthest it bothers firing the right weapon from */
  rw: number;
  /** spontaneous jumps per second */
  jump: number;
  /** how readily it throws the left weapon (1 = the standard rate) */
  lw: number;
  /** distance band it fires the right weapon in while boosting — for a VR whose boosting RW is a
   *  charge rather than a shot, only from a forward dash */
  dashRW: [number, number];
}

export const JEBE: MechSpec = {
  id: 'jebe',
  name: 'JEBE',
  code: 'MBV-04 / LIGHT ASSAULT',
  blurb: 'All-round assault frame. Long beam rifle doubles as a beam saber at close range.',
  hp: 1000,
  walkSpeed: 17,
  backSpeed: 14,
  boostSpeed: 41,
  airBoostSpeed: 36,
  qbSpeed: 70,
  qbCost: 0.2,
  enRegen: 0.55,
  ascendSpeed: 15,
  accel: 110,
  carve: 100,
  grip: 62,
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
  airEN: 1,
  heavy: false,
  melee: { name: 'BEAM SABER', damage: 140, style: 'slash', duration: 0.74, lunge: { until: 0.28, speed: 42 }, hit: [0.26, 0.42], swing: 0.22 },
  stats: { armor: 3, speed: 4, power: 3, range: 4 },
  ai: { range: [26, 58], rush: 0.14, cw: [18, 999], rw: 999, jump: 0.13, lw: 1, dashRW: [0, 999] },
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
  boostSpeed: 34,
  airBoostSpeed: 29,
  qbSpeed: 59,
  qbCost: 0.24,
  enRegen: 0.45,
  ascendSpeed: 12,
  accel: 78,
  carve: 72,
  grip: 48,
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
  airEN: 1,
  heavy: true,
  melee: { name: 'HAMMER KNUCKLE', damage: 160, style: 'punch', duration: 0.82, lunge: { until: 0.32, speed: 34 }, hit: [0.3, 0.46], swing: 0.26 },
  stats: { armor: 5, speed: 2, power: 5, range: 3 },
  ai: { range: [42, 85], rush: 0.08, cw: [18, 999], rw: 999, jump: 0.13, lw: 1, dashRW: [0, 999] },
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

export const KESTREL: MechSpec = {
  id: 'kestrel',
  name: 'KESTREL',
  code: 'RFX-07 / AERIAL INTERCEPTOR',
  blurb: 'Featherweight interceptor that owns the sky: thrusters that sip EN, needle lasers, and a rail lance that hits like a train.',
  hp: 820,
  walkSpeed: 18.5,
  backSpeed: 15.5,
  boostSpeed: 45,
  airBoostSpeed: 44,
  qbSpeed: 76,
  qbCost: 0.18,
  enRegen: 0.6,
  ascendSpeed: 19,
  accel: 125,
  carve: 118,
  grip: 66,
  jumpVel: 32,
  gravity: 27,
  turnRate: 2.9,
  quickTurn: 4.6,
  radius: 1.7,
  height: 6.9,
  meleeRange: 10,
  airEN: 0.55,
  heavy: false,
  weapons: {
    lw: { name: 'SWARM DARTS', cost: 0.5, regen: 0.22 },
    rw: { name: 'NEEDLE LASER', cost: 0.25, regen: 0.42 },
    cw: { name: 'RAIL LANCE', cost: 1, regen: 0.15 },
  },
  melee: { name: 'WING EDGE', damage: 110, style: 'slash', duration: 0.62, lunge: { until: 0.22, speed: 52 }, hit: [0.2, 0.34], swing: 0.17, pitch: 1.2 },
  stats: { armor: 2, speed: 5, power: 2, range: 4 },
  ai: { range: [32, 72], rush: 0.09, cw: [28, 999], rw: 999, jump: 0.32, lw: 1, dashRW: [0, 999] },
  palette: {
    primary: 0xe9edf2,
    secondary: 0x179aa0,
    accent: 0xff7a1a,
    joint: 0x2f3440,
    trim: 0x1d2a3a,
    eye: 0x9dff5a,
    flame: 0x9ffcf0,
    beam: 0xb6ff3a,
  },
  altPalette: {
    primary: 0x2b2f38,
    secondary: 0xe0b020,
    accent: 0x3dffd2,
    joint: 0x15181e,
    trim: 0xe9edf2,
    eye: 0xff4a6a,
    flame: 0xffd27a,
    beam: 0x3dffd2,
  },
  homeStage: 'harbor',
};

export const KONGO: MechSpec = {
  id: 'kongo',
  name: 'KONGO',
  code: 'GBX-09 / CLOSE ASSAULT',
  blurb: 'Brawler built around a pair of oversized fists. Shoulders through fire, rams in and settles it up close.',
  hp: 1240,
  walkSpeed: 15,
  backSpeed: 12.5,
  boostSpeed: 46,
  airBoostSpeed: 30,
  qbSpeed: 80,
  qbCost: 0.2,
  enRegen: 0.5,
  ascendSpeed: 12,
  accel: 118,
  carve: 84,
  grip: 60,
  jumpVel: 26,
  gravity: 38,
  turnRate: 2.6,
  quickTurn: 3.9,
  radius: 2.3,
  height: 7.6,
  meleeRange: 14,
  airEN: 1.15,
  heavy: true,
  closeCW: true,
  weapons: {
    lw: { name: 'ROCKET FIST', cost: 0.5, regen: 0.24 },
    rw: { name: 'SCATTER GUN', cost: 0.25, regen: 0.45 },
    cw: { name: 'QUAKE SLAM', cost: 1, regen: 0.16 },
  },
  special: { label: 'BOOST RW', name: 'SHOULDER RAM' },
  melee: { name: 'RISING KNUCKLE', damage: 185, style: 'punch', duration: 0.86, lunge: { until: 0.34, speed: 46 }, hit: [0.3, 0.46], swing: 0.27, armor: true, pitch: 0.8 },
  stats: { armor: 4, speed: 3, power: 5, range: 1 },
  ai: { range: [6, 26], rush: 0.4, cw: [0, 15], rw: 48, jump: 0.08, lw: 1, dashRW: [15, 38] },
  palette: {
    primary: 0xd9661c,
    secondary: 0x2f3340,
    accent: 0xf2d23a,
    joint: 0x1c1d22,
    trim: 0xe8e2d0,
    eye: 0x5ad8ff,
    flame: 0x8ab4ff,
    beam: 0x7fb2ff,
  },
  altPalette: {
    primary: 0x3a4a6a,
    secondary: 0xd8d4c8,
    accent: 0xff4a3a,
    joint: 0x1a1c24,
    trim: 0x22262f,
    eye: 0xffd23a,
    flame: 0xffb04a,
    beam: 0xff9a3a,
  },
  homeStage: 'foundry',
};

export const ARACHNE: MechSpec = {
  id: 'arachne',
  name: 'ARACHNE',
  code: 'TRX-11 / AREA DENIAL',
  blurb: 'Trap layer. Seeds the ground with mines, sets hunter drones loose and nets anything that holds still.',
  hp: 1180,
  walkSpeed: 15,
  backSpeed: 13,
  boostSpeed: 39,
  airBoostSpeed: 33,
  qbSpeed: 63,
  qbCost: 0.23,
  enRegen: 0.52,
  ascendSpeed: 13,
  accel: 88,
  carve: 78,
  grip: 54,
  jumpVel: 28,
  gravity: 31,
  turnRate: 2.35,
  quickTurn: 3.7,
  radius: 2.1,
  height: 7.2,
  meleeRange: 10,
  airEN: 0.9,
  heavy: false,
  weapons: {
    lw: { name: 'WEB MINES', cost: 0.5, regen: 0.2 },
    rw: { name: 'HUNTER DRONES', cost: 0.3, regen: 0.3 },
    cw: { name: 'SNARE NET', cost: 1, regen: 0.15 },
  },
  melee: { name: 'STINGER', damage: 125, style: 'punch', duration: 0.74, lunge: { until: 0.28, speed: 40 }, hit: [0.26, 0.4], swing: 0.22, pitch: 1.1 },
  stats: { armor: 4, speed: 2, power: 3, range: 5 },
  ai: { range: [45, 85], rush: 0.05, cw: [8, 80], rw: 999, jump: 0.1, lw: 2.2, dashRW: [0, 999] },
  palette: {
    primary: 0x4a2f6e,
    secondary: 0x1f1d26,
    accent: 0x9aff3a,
    joint: 0x15141a,
    trim: 0xc8c2d8,
    eye: 0x9aff3a,
    flame: 0xd27aff,
    beam: 0xe04aff,
  },
  altPalette: {
    primary: 0xd8d2b8,
    secondary: 0x3a3328,
    accent: 0xff6a2a,
    joint: 0x1c1a16,
    trim: 0x6a5a40,
    eye: 0xff6a2a,
    flame: 0xffb06a,
    beam: 0x4aff9a,
  },
  homeStage: 'harbor',
};

export const ROSTER: MechSpec[] = [JEBE, FUJIN, KESTREL, KONGO, ARACHNE];

/** Every VR by id. */
export const SPECS = Object.fromEntries(ROSTER.map((m) => [m.id, m])) as Record<MechId, MechSpec>;
export const MECH_IDS = ROSTER.map((m) => m.id);

/**
 * Co-op bosses wear an ace's black with gold or crimson, so they never match either player (who may
 * both pick the boss's VR), and fire red/orange so their shots read apart from the players'.
 */
export const BOSS_PALETTES: Record<MechId, Palette> = {
  jebe: {
    primary: 0x2a2c34,
    secondary: 0xd4a21a,
    accent: 0xff4a2a,
    joint: 0x121318,
    trim: 0xd4a21a,
    eye: 0xff3030,
    flame: 0xffa040,
    beam: 0xff3a2a,
  },
  fujin: {
    primary: 0x2c2a2e,
    secondary: 0xb3122e,
    accent: 0xffd21a,
    joint: 0x141214,
    trim: 0xffd21a,
    eye: 0xffe040,
    flame: 0xffc050,
    beam: 0xff8a1a,
  },
  kestrel: {
    primary: 0x24272e,
    secondary: 0xd4a21a,
    accent: 0xb3122e,
    joint: 0x111216,
    trim: 0xd4a21a,
    eye: 0xff3030,
    flame: 0xffa040,
    beam: 0xff4a5a,
  },
  kongo: {
    primary: 0x2a2a2e,
    secondary: 0xb3122e,
    accent: 0xd4a21a,
    joint: 0x121214,
    trim: 0xd4a21a,
    eye: 0xffe040,
    flame: 0xffa040,
    beam: 0xff6a1a,
  },
  arachne: {
    primary: 0x26242b,
    secondary: 0xd4a21a,
    accent: 0xb3122e,
    joint: 0x111014,
    trim: 0xd4a21a,
    eye: 0xff3030,
    flame: 0xff7a5a,
    beam: 0xff2a6a,
  },
};
